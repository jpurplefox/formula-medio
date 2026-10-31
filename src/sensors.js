// Lo que "ve" la IA entrenada (rl/): un vector de números, siempre del mismo largo y en el mismo orden.
// Se usa igual para entrenar (en Node) y para manejar en el juego.
//
//   auto        velocidad, deslizamiento, giro, volante, pedales, marcha, rpm, agarre de cada eje, rebufo
//   su auto     cómo es respecto del auto medido (motor, punta, agarre, frenos, desgaste) y cómo están las gomas
//   posición    de qué lado de la pista va, hacia dónde apunta respecto de la pista, si pisa pasto o piano
//   pista       cuánto dobla la pista más adelante (a 20, 40… 450 m): lo que un piloto sabe de memoria
//   rayos       distancia hasta el borde de la pista en 19 direcciones, de -90° a +90° (más juntos al frente)
//   rivales     los 6 más cercanos (hasta 120 m): posición y velocidad relativas y hacia dónde apuntan.
//               Los lugares sin rival quedan en cero (en la primera etapa, solo en pista, siempre)
//
// Todo va más o menos entre -1 y 1. Las distancias de la pista se miden en metros, así sirve en cualquier
// circuito sin importar el tamaño de sus celdas.

import { SETUP_KEYS } from './car.js';
import { sampleField, stationAt } from './track.js';

export const RAY_ANGLES = [-90, -60, -40, -28, -18, -11, -6, -3, -1, 0, 1, 3, 6, 11, 18, 28, 40, 60, 90]
  .map((d) => (d * Math.PI) / 180);
export const LOOK_AHEAD = [20, 40, 70, 100, 140, 180, 230, 290, 360, 450]; // m
export const OPPONENTS = 6;
const CAR_VALUES = 12;
export const SETUP_VALUES = SETUP_KEYS.length + 1; // la variación del auto y el desgaste de las gomas
export const SETUP_START = CAR_VALUES; // dónde empiezan (las redes viejas no los tienen)
const SETUP_SPREAD = { power: 0.05, topSpeed: 0.05, grip: 0.05, brakes: 0.05, wear: 0.3 }; // lo que se toma como ±1
const POSITION_VALUES = 5;
const OPPONENT_VALUES = 7;
export const OBS_SIZE = CAR_VALUES + SETUP_VALUES + POSITION_VALUES + LOOK_AHEAD.length + RAY_ANGLES.length + OPPONENTS * OPPONENT_VALUES;

const RAY_MAX = 200; // m
const OPPONENT_RANGE = 120; // m
const TOP = 90; // m/s, para normalizar velocidades

const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));

// Rumbo de la línea central en cada metro de la vuelta (se calcula una vez por circuito)
const headings = new WeakMap();
function centerHeading(track) {
  if (headings.has(track)) return headings.get(track);
  const { n, x, y, st } = track.path;
  const L = Math.ceil(st[n]);
  const out = new Float32Array(L + 1);
  let b = 0;
  for (let u = 0; u <= L; u++) {
    while (b < n - 1 && st[b + 1] < u) b++;
    const a = (b + n - 2) % n, c = (b + 2) % n;
    out[u] = Math.atan2(y[c] - y[a], x[c] - x[a]);
  }
  headings.set(track, out);
  return out;
}

// Rumbo de la pista en la posición u de la vuelta (en celdas, como track.station)
export function trackHeading(track, u) {
  const h = centerHeading(track);
  const L = h.length - 1;
  return h[Math.floor(((u % L) + L) % L)];
}

// Distancia (m) desde (x, y) hasta el borde de la pista en la dirección a, avanzando de a saltos
// tan largos como la distancia al borde (el campo sdf la da en cada celda)
function ray(track, x, y, a) {
  const { sdf, W, meters } = track;
  const dx = Math.cos(a), dy = Math.sin(a), max = RAY_MAX / meters;
  let t = 0;
  for (let k = 0; k < 64 && t < max; k++) {
    const d = sampleField(sdf, W, x + dx * t, y + dy * t);
    if (d < 0) return t * meters;
    t += Math.max(d, 0.4);
  }
  return Math.min(t, max) * meters;
}

// velocidad del auto en el mundo (m/s), con el deslizamiento de costado
function velocity(car) {
  const ca = Math.cos(car.angle), sa = Math.sin(car.angle);
  return [ca * car.speed - sa * car.slip, sa * car.speed + ca * car.slip];
}

// car: el auto (Car de car.js); u: su posición en la vuelta (track.station, celdas);
// others: los demás autos (Car) en el mismo circuito
export function observe(track, car, u, others = [], out = new Float32Array(OBS_SIZE)) {
  const { meters, halfWidth, W } = track;
  let i = 0;
  const put = (v) => { out[i++] = Number.isFinite(v) ? Math.max(-3, Math.min(3, v)) : 0; };

  // auto
  put(car.speed / TOP);
  put(car.slip / 10);
  put(car.omega / 2);
  put(car.steer);
  put(car.throttle);
  put(car.brake);
  put(car.gear / 8);
  put(car.rpm / 12000);
  put(car.grip?.[0] ?? 1);
  put(car.grip?.[1] ?? 1);
  put(car.aLon / 40);
  put(car.draft);

  // su auto
  for (const k of SETUP_KEYS) put(((car.setup?.[k] ?? 1) - 1) / SETUP_SPREAD[k]);
  put(car.wear ?? 0);

  // posición en la pista
  const lat = sampleField(track.lat, W, car.x, car.y);
  const rel = wrapAngle(car.angle - trackHeading(track, u));
  put(lat / halfWidth);
  put(Math.sin(rel));
  put(Math.cos(rel));
  put(car.onGrass ? 1 : 0);
  put(car.onKerb ? 1 : 0);

  // la pista más adelante: cuánto cambia su rumbo respecto del auto
  for (const d of LOOK_AHEAD) put(wrapAngle(trackHeading(track, u + d / meters) - car.angle) / Math.PI);

  // rayos hasta el borde
  for (const a of RAY_ANGLES) put(ray(track, car.x, car.y, car.angle + a) / RAY_MAX);

  // rivales más cercanos, en el marco del auto (x adelante, y a la derecha)
  const ca = Math.cos(car.angle), sa = Math.sin(car.angle);
  const [vx, vy] = velocity(car);
  const near = [];
  for (const o of others) {
    if (o === car) continue;
    const dx = (o.x - car.x) * meters, dy = (o.y - car.y) * meters;
    const d = Math.hypot(dx, dy);
    if (d < OPPONENT_RANGE) near.push([d, o, dx, dy]);
  }
  near.sort((a, b) => a[0] - b[0]);
  for (let k = 0; k < OPPONENTS; k++) {
    const n = near[k];
    if (!n) {
      for (let j = 0; j < OPPONENT_VALUES; j++) put(0);
      continue;
    }
    const [, o, dx, dy] = n;
    const [ox, oy] = velocity(o);
    const rvx = ox - vx, rvy = oy - vy;
    const oa = wrapAngle(o.angle - car.angle);
    put(1);
    put((dx * ca + dy * sa) / 50);
    put((-dx * sa + dy * ca) / 10);
    put((rvx * ca + rvy * sa) / 20);
    put((-rvx * sa + rvy * ca) / 10);
    put(Math.sin(oa));
    put(Math.cos(oa));
  }
  return out;
}

export { stationAt };
