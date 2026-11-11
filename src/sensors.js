// Lo que "ve" la IA entrenada (rl/): un vector de números, siempre del mismo largo y en el mismo orden.
// Se usa igual para entrenar (en Node) y para manejar en el juego.
//
//   auto        velocidad, deslizamiento, giro, volante, pedales, marcha, rpm, agarre de cada eje, rebufo
//   su auto     cómo es respecto del auto medido (motor, punta, agarre, frenos, desgaste) y cómo están las gomas
//   posición    de qué lado de la pista va, hacia dónde apunta respecto de la pista, si pisa pasto o piano
//   pista       cuánto dobla la pista más adelante (a 20, 40… 450 m): lo que un piloto sabe de memoria. El primer punto,
//               respecto del auto; cada uno de los demás, respecto del anterior (cuánto dobla ese tramo)
//   rayos       distancia hasta el borde de la pista en 19 direcciones, de -90° a +90° (más juntos al frente)
//   rivales     los 6 más cercanos (hasta 120 m): posición y velocidad relativas y hacia dónde apuntan.
//               Los lugares sin rival quedan en cero (en la primera etapa, solo en pista, siempre)
//   ruedas      el agarre de cada rueda según lo que pisa (1 en el asfalto, menos en el pasto), así sabe de qué
//               lado se fue. Va al final: las redes de antes, que no lo tienen, leen sólo lo de adelante
//   límites     lo que la puesta a punto y el aire del circuito le cambian al auto (dynamics.js): agarre en curva
//               lenta y rápida, balance entre ejes en cada una (subvirante o sobrevirante) y velocidad punta,
//               respecto del auto con los alerones al medio a nivel del mar. También al final, por lo mismo
//   daños       cuánto tiene roto de cada pieza (damage.js: alerones, pontones, suspensiones, gomas) y el nivel de
//               daños de la carrera (0 no, 0,5 reducidos, 1 reales). Al final, por lo mismo
//   más rivales el 7.º y el 8.º más cercanos, con los mismos valores que los 6 primeros: en una grilla de 22, en la
//               largada suele haber más de 6 a menos de 120 m. Al final, por lo mismo
//   cómo van los rivales  de los mismos 8 y en el mismo orden: acelerador, freno y volante que están usando (sin
//               memoria, que el de adelante frena se notaba recién cuando ya se le acercaba), cuánto más motor y
//               agarre tiene su auto que el propio, cuánto tiene roto (la pieza más rota) y de qué lado de la pista
//               va. Al final, por lo mismo
//   semáforo    en la grilla: cuántas luces rojas hay prendidas, cuánto hace que se prendió la última y si ya se
//               apagaron (src/lights.js), para llevar el motor a las vueltas de largar. En carrera, apagadas. Al
//               final, por lo mismo
//   gomas y peso la temperatura y el desgaste de cada goma (DI, DD, TI, TD), la nafta que lleva encima y el reparto
//               de frenos de la puesta a punto: el agarre de las gomas frías, pasadas o gastadas se nota en el de cada
//               eje recién cuando ya se perdió; con esto lo ve venir. Al final, por lo mismo
//   riesgo      de los mismos 8 y en el mismo orden: si está en la zona de al lado (la misma que castiga el
//               entrenamiento, rl/herd.js) y si en los próximos RISK_HORIZON s, siguiendo cada uno con la misma
//               velocidad y el mismo giro, chocan: 1 - t / RISK_HORIZON (1 ya se tocan, 0 no chocan), en el
//               primero si el que pega es el propio auto (lo alcanza o se le tira encima) y en el segundo si es el
//               otro. Al final, por lo mismo
//   pista lejos los tramos que siguen hasta 1 km, cada uno más largo que el anterior, igual que los de más cerca:
//               cuánto dobla cada tramo. Al final, por lo mismo
//
// Todo va más o menos entre -1 y 1. Las distancias de la pista se miden en metros, así sirve en cualquier
// circuito sin importar el tamaño de sus celdas.

import { SETUP_KEYS, TEMP_HIGH, TEMP_LOW } from './car.js';
import { BRAKE_TUNE_MAX, carLimits, DEFAULT_TUNE, SEA_AIR } from './dynamics.js';
import { HALF_L, HALF_W } from './collision.js';
import { NO_DAMAGE } from './damage.js';
import { LIGHTS_OUT } from './lights.js';
import { halfWidthAt, sampleField, stationAt } from './track.js';

const RAY_ANGLES = [-90, -60, -40, -28, -18, -11, -6, -3, -1, 0, 1, 3, 6, 11, 18, 28, 40, 60, 90]
  .map((d) => (d * Math.PI) / 180);
export const LOOK_AHEAD = [20, 40, 70, 100, 140, 180, 230, 290, 360, 450]; // m
const OPPONENTS = 6;
const CAR_VALUES = 12;
export const SETUP_VALUES = SETUP_KEYS.length + 1; // la variación del auto y el desgaste de las gomas
export const SETUP_START = CAR_VALUES; // dónde empiezan (las redes viejas no los tienen)
// lo que se toma como ±1. Era 0,05 en motor, punta, agarre y frenos; con autos más distintos (hasta -15 % y +20 %,
// para poder subir la dificultad dándoles más agarre) pasó a 0,2 y los pesos de las redes ya entrenadas se
// reescalaron igual (rl/rescale_setup.py), así manejan exactamente como antes
export const SETUP_SPREAD = { power: 0.2, topSpeed: 0.2, grip: 0.2, brakes: 0.2, wear: 0.3 };
const POSITION_VALUES = 5;
const OPPONENT_VALUES = 7;
export const WHEEL_VALUES = 4;
export const LIMIT_VALUES = 5;
export const DAMAGE_VALUES = 15;
const MORE_OPPONENTS = 2; // el 7.º y el 8.º, al final
const RIVAL_VALUES = 7; // acelerador, freno, volante, motor, agarre, daño y lado de la pista de cada rival
const ALL_OPPONENTS = OPPONENTS + MORE_OPPONENTS;
export const OPPONENT_INPUT_SIZE = MORE_OPPONENTS * OPPONENT_VALUES + ALL_OPPONENTS * RIVAL_VALUES;
const AHEAD_START = CAR_VALUES + SETUP_VALUES + POSITION_VALUES; // dónde empiezan los puntos de LOOK_AHEAD
export const OPPONENT_START = CAR_VALUES + SETUP_VALUES + POSITION_VALUES + LOOK_AHEAD.length + RAY_ANGLES.length;
export const OPPONENT_SIZE = OPPONENTS * OPPONENT_VALUES; // dónde empiezan los rivales y cuántos valores son
export const OPPONENT_INPUT_START = OPPONENT_START + OPPONENT_SIZE + WHEEL_VALUES + LIMIT_VALUES + DAMAGE_VALUES;
export const START_VALUES = 3;
// salidas de la red: volante, pedal y, sólo con el semáforo en rojo, cuánto sube y cuánto baja las rpm (las redes de
// antes del semáforo tienen las dos primeras)
export const ACTIONS = 4;
export const START_INPUT_START = OPPONENT_INPUT_START + OPPONENT_INPUT_SIZE;
export const TYRE_VALUES = 10; // temperatura y desgaste de cada goma, nafta y reparto de frenos
const TYRE_INPUT_START = START_INPUT_START + START_VALUES;
const RISK_VALUES = 3; // por rival: zona de al lado, choque que pega el propio auto, choque que pega el otro
const RISK_INPUT_START = TYRE_INPUT_START + TYRE_VALUES;
export const RISK_INPUT_SIZE = ALL_OPPONENTS * RISK_VALUES;
export const FAR_AHEAD = [560, 690, 840, 1010]; // m: tramos de 110, 130, 150 y 170 m, siguiendo a los de LOOK_AHEAD
const FAR_INPUT_START = RISK_INPUT_START + RISK_INPUT_SIZE;
export const OBS_SIZE = FAR_INPUT_START + FAR_AHEAD.length;
const RISK_HORIZON = 5; // s
const RISK_STEP = 0.1; // s entre cada punto de la predicción
const RISK_POINTS = Math.round(RISK_HORIZON / RISK_STEP);
// la zona de al lado: el otro auto encimado a lo largo (centros a menos de un largo) y a menos de ZONE_MARGIN m de
// costado entre carrocerías, en el marco del auto
const ZONE_MARGIN = 0.5;
export const inZone = (ahead, side) => Math.abs(ahead) < 2 * HALF_L && Math.abs(side) < 2 * HALF_W + ZONE_MARGIN;
const TEMP_MID = (TEMP_LOW + TEMP_HIGH) / 2, TEMP_SCALE = 20; // °C: el medio de la ventana es 0, ±20 °C es ±1
const FUEL_SCALE = 50; // kg
const DAMAGE_LEVEL = { off: 0, reduced: 0.5, real: 1 };
const SLOW = 25, FAST = 70; // m/s: una curva lenta (90 km/h) y una rápida (250 km/h)

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
  const { meters, W } = track;
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
  // con el semáforo en rojo no ve las rpm: no las necesita (sus salidas de rpm las fijan) y el crítico, que en carrera
  // aprendió que más rpm es más velocidad, premiaba subirlas hasta el corte aunque así larga peor (v18)
  put(car.lights && !car.lights.out ? 0 : car.rpm / 12000);
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
  put(lat / halfWidthAt(track, u));
  put(Math.sin(rel));
  put(Math.cos(rel));
  put(car.grass ?? (car.onGrass ? 1 : 0)); // fracción de las ruedas en el pasto
  put(car.onKerb ? 1 : 0);

  // la pista más adelante: cuánto dobla cada tramo (el primero, respecto del auto)
  let heading = car.angle;
  for (const d of LOOK_AHEAD) {
    const h = trackHeading(track, u + d / meters);
    put(wrapAngle(h - heading) / Math.PI);
    heading = h;
  }

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
  const rival = (n) => {
    if (!n) {
      for (let j = 0; j < OPPONENT_VALUES; j++) put(0);
      return;
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
  };
  for (let k = 0; k < OPPONENTS; k++) rival(near[k]);

  // agarre de cada rueda: delantera izquierda, derecha, trasera izquierda, derecha
  for (const g of car.wheelGrip ?? [1, 1, 1, 1]) put(g);

  // límites del auto con su puesta a punto y el aire
  for (const x of limitValues(car)) put(x);

  // daños: alerón delantero, trasero y pontones (izquierda, derecha), suspensiones y gomas (DI, DD, TI, TD) y nivel
  const d = car.damage ?? NO_DAMAGE;
  for (const part of [d.frontWing, d.rearWing, d.sidepod, d.suspension, d.tyre]) for (const x of part) put(x);
  put(DAMAGE_LEVEL[car.damageLevel] ?? 0);

  // el 7.º y el 8.º rival
  for (let k = OPPONENTS; k < ALL_OPPONENTS; k++) rival(near[k]);

  // cómo van los 8: pedales, volante, su auto respecto del propio, lo roto y de qué lado de la pista
  const half = halfWidthAt(track, u);
  for (let k = 0; k < ALL_OPPONENTS; k++) {
    const o = near[k]?.[1];
    if (!o) {
      for (let j = 0; j < RIVAL_VALUES; j++) put(0);
      continue;
    }
    put(o.throttle);
    put(o.brake);
    put(o.steer);
    put(((o.setup?.power ?? 1) - (car.setup?.power ?? 1)) / SETUP_SPREAD.power);
    put(((o.setup?.grip ?? 1) - (car.setup?.grip ?? 1)) / SETUP_SPREAD.grip);
    const od = o.damage ?? NO_DAMAGE;
    put(Math.max(...od.frontWing, ...od.rearWing, ...od.sidepod, ...od.suspension, ...od.tyre));
    put(sampleField(track.lat, W, o.x, o.y) / half);
  }

  // semáforo: luces prendidas, segundos desde la última y si ya se largó
  const lights = car.lights ?? LIGHTS_OUT;
  put(lights.lit / 5);
  put(lights.since / 3);
  put(lights.out ? 1 : 0);

  // gomas y peso: temperatura y desgaste de cada goma, nafta y reparto de frenos (+: más adelante)
  for (const t of car.tyreTemp ?? [TEMP_MID, TEMP_MID, TEMP_MID, TEMP_MID]) put((t - TEMP_MID) / TEMP_SCALE);
  for (const w of car.tyreWear ?? [0, 0, 0, 0]) put(w);
  put((car.fuel ?? 0) / FUEL_SCALE);
  put((car.tune?.brake ?? 0) / BRAKE_TUNE_MAX);

  // riesgo con cada uno de los 8: zona de al lado y choque en los próximos segundos (quién pega)
  const mine = predict(car, meters, ownPath);
  for (let k = 0; k < ALL_OPPONENTS; k++) {
    const n = near[k];
    if (!n) {
      for (let j = 0; j < RISK_VALUES; j++) put(0);
      continue;
    }
    const [, o, dx, dy] = n;
    put(inZone(dx * ca + dy * sa, -dx * sa + dy * ca) ? 1 : 0);
    const [hit, striker] = crash(mine, predict(o, meters, otherPath));
    put(hit && striker ? hit : 0);
    put(hit && !striker ? hit : 0);
  }

  // la pista lejos: cuánto dobla cada tramo, siguiendo desde el último punto de cerca
  for (const d of FAR_AHEAD) {
    const h = trackHeading(track, u + d / meters);
    put(wrapAngle(h - heading) / Math.PI);
    heading = h;
  }
  return out;
}

// Dónde va a estar un auto en los próximos RISK_HORIZON s si sigue con la misma velocidad (de frente y de costado,
// en su marco) y el mismo giro: cada RISK_STEP s, x, y (m), rumbo y velocidad en el mundo (m/s), desde ahora (t = 0)
const ownPath = new Float64Array((RISK_POINTS + 1) * 5), otherPath = new Float64Array((RISK_POINTS + 1) * 5);
function predict(car, meters, out) {
  let x = car.x * meters, y = car.y * meters, a = car.angle;
  const { speed, slip, omega } = car;
  for (let k = 0; k <= RISK_POINTS; k++) {
    const c = Math.cos(a), s = Math.sin(a), i = k * 5;
    out[i] = x;
    out[i + 1] = y;
    out[i + 2] = a;
    out[i + 3] = c * speed - s * slip;
    out[i + 4] = s * speed + c * slip;
    // con el rumbo del medio del intervalo, así en las curvas no se acumula error
    const am = a + (omega * RISK_STEP) / 2, cm = Math.cos(am), sm = Math.sin(am);
    x += (cm * speed - sm * slip) * RISK_STEP;
    y += (sm * speed + cm * slip) * RISK_STEP;
    a += omega * RISK_STEP;
  }
  return out;
}

// Si dos autos (rectángulos de 2·HALF_L × 2·HALF_W) con centro y rumbo se superponen (ejes separadores)
function overlap(ax, ay, aa, bx, by, ba) {
  const dx = bx - ax, dy = by - ay;
  if (dx * dx + dy * dy > 4 * (HALF_L * HALF_L + HALF_W * HALF_W)) return false;
  const ca = Math.cos(aa), sa = Math.sin(aa), cb = Math.cos(ba), sb = Math.sin(ba);
  for (const [ux, uy] of [[ca, sa], [-sa, ca], [cb, sb], [-sb, cb]]) {
    // la mitad de cada auto proyectada sobre el eje
    const ra = HALF_L * Math.abs(ca * ux + sa * uy) + HALF_W * Math.abs(-sa * ux + ca * uy);
    const rb = HALF_L * Math.abs(cb * ux + sb * uy) + HALF_W * Math.abs(-sb * ux + cb * uy);
    if (Math.abs(dx * ux + dy * uy) > ra + rb) return false;
  }
  return true;
}

// El primer choque entre dos predicciones: [1 - t / RISK_HORIZON (0 si no chocan), si pega el primero]. Pega el que
// más va hacia el otro en el momento del choque: el que alcanza al de adelante o el que se le tira encima de costado
function crash(a, b) {
  for (let k = 0; k <= RISK_POINTS; k++) {
    const i = k * 5;
    if (!overlap(a[i], a[i + 1], a[i + 2], b[i], b[i + 1], b[i + 2])) continue;
    const dx = b[i] - a[i], dy = b[i + 1] - a[i + 1], d = Math.hypot(dx, dy) || 1;
    const towardB = (a[i + 3] * dx + a[i + 4] * dy) / d; // cuánto va el primero hacia el otro (m/s)
    const towardA = -(b[i + 3] * dx + b[i + 4] * dy) / d;
    return [1 - (k * RISK_STEP) / RISK_HORIZON, towardB >= towardA];
  }
  return [0, false];
}

// Para las redes de antes de los tramos (v21 y anteriores), que leían cada punto de LOOK_AHEAD respecto del auto: el
// giro de cada tramo sumado hasta ese punto, como lo veían ellas (devuelve una copia)
export function aheadFromCar(obs, out = new Float32Array(obs.length)) {
  out.set(obs);
  let turn = 0;
  for (let k = 0; k < LOOK_AHEAD.length; k++) {
    turn += obs[AHEAD_START + k] * Math.PI;
    out[AHEAD_START + k] = wrapAngle(turn) / Math.PI;
  }
  return out;
}

// Los límites del auto respecto del de referencia, más o menos entre -1 y 1 (se calculan una vez por límites)
const refs = new WeakMap(), summaries = new WeakMap();
function limitValues(car) {
  const lim = car.limits;
  if (summaries.has(lim)) return summaries.get(lim);
  if (!refs.has(car.profile)) refs.set(car.profile, carLimits(car.profile, DEFAULT_TUNE, SEA_AIR));
  const ref = refs.get(car.profile);
  const balance = (l, v) => { const [f, r] = l.axles(v); return f / r - 1; };
  const out = [
    (lim.lateral(SLOW) / ref.lateral(SLOW) - 1) / 0.2,
    (lim.lateral(FAST) / ref.lateral(FAST) - 1) / 0.2,
    (balance(lim, SLOW) - balance(ref, SLOW)) / 0.1,
    (balance(lim, FAST) - balance(ref, FAST)) / 0.1,
    (lim.topSpeed / ref.topSpeed - 1) / 0.1,
  ];
  summaries.set(lim, out);
  return out;
}

export { stationAt };
