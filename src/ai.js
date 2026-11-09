// Rivales: cada uno es un auto con la misma física que el del jugador, manejado por un piloto automático.
// El piloto sigue la trazada ideal ("persiguiendo" un punto un poco más adelante sobre ella) y acelera o frena
// para ir a la velocidad que la trazada indica en cada punto, multiplicada por su ritmo (pace).
// Si alcanza a otro auto, se abre hacia el lado donde hay lugar para pasarlo; si no hay lugar, se queda detrás.

import { halfWidthAt } from './track.js';

const LOOK_BASE = 6; // distancia mínima al punto que persigue el volante (m)
const LOOK_TIME = 0.35; // más la distancia que recorre en este tiempo (s)
const BRAKE_LOOK = 0.12; // mira la velocidad objetivo un poco más adelante, para frenar a tiempo (s)
const MARGIN = 1.3; // distancia mínima al borde de la pista (m)
const PASS_GAP = 3.5; // separación lateral con la que pasa a otro auto (m)
const CAR_WIDTH = 2.8; // si dos autos están más cerca que esto de costado, uno tapa al otro (m)
const SEE_AHEAD = 30; // hasta dónde mira autos adelante (m)
const SHIFT_RATE = 3.5; // qué tan rápido se corre de costado para pasar (m/s)
const ALONGSIDE = 6; // a menos de esto (a lo largo de la pista) dos autos están a la par (m)
const YIELD_AHEAD = 2.5; // si el de al lado va más adelante que esto, el de atrás cede (m)
const FOLLOW_GAP = 8; // distancia a la que se queda detrás de un auto que no puede pasar (m)
const FOLLOW_K = 0.8; // por cada metro más de distancia, puede ir esto más rápido que el de adelante (m/s)
const STUCK_TIME = 1.5; // si está casi quieto este tiempo, se lo vuelve a poner en la pista (s)
const SLOW_CORNER = 45; // curvas donde la trazada pide menos de esto (m/s)...
const SLOW_PACE = 0.975; // ...se toman, como mucho, a esta fracción de su velocidad
// acelerando y doblando a la vez, la cola tiene que hacer las dos cosas: a la salida de una curva lenta, donde el
// motor puede más que las gomas, dosifica el acelerador según cuánto dobla (como mucho, hasta EXIT_THROTTLE); en las
// rápidas el motor no alcanza a hacer patinar la cola y va a fondo
const EXIT_THROTTLE = 0.35;
// y corrige el volante según cuánto gira el auto de más o de menos respecto de lo que quiere (contravolantea si la
// cola se abre)
const YAW_FIX = 0.8;
const MAX_YAW = 1.6; // igual que en car.js: giro máximo a baja velocidad (rad/s)

// Por cada celda de la línea central: el punto de la línea central y la normal hacia la derecha.
// (La trazada ideal está guardada como desplazamiento de costado respecto de esa línea.)
const frames = new WeakMap();
export function lineFrame(track) {
  if (frames.has(track)) return frames.get(track);
  const { n, x, y, st } = track.path;
  const L = Math.ceil(st[n]) + 1;
  const cx = new Float32Array(L), cy = new Float32Array(L), nx = new Float32Array(L), ny = new Float32Array(L);
  const wrap = (b) => ((b % n) + n) % n;
  let b = 0;
  for (let u = 0; u < L; u++) {
    while (b < n - 1 && st[b + 1] <= u) b++;
    const t = Math.min(1, Math.max(0, (u - st[b]) / (st[b + 1] - st[b] || 1)));
    const c = wrap(b + 1);
    cx[u] = x[b] + (x[c] - x[b]) * t;
    cy[u] = y[b] + (y[c] - y[b]) * t;
    const dx = x[wrap(b + 2)] - x[wrap(b - 2)], dy = y[wrap(b + 2)] - y[wrap(b - 2)];
    const len = Math.hypot(dx, dy) || 1;
    nx[u] = -dy / len;
    ny[u] = dx / len;
  }
  const f = { L, length: st[n], cx, cy, nx, ny };
  frames.set(track, f);
  return f;
}

// Punto de la pista a una posición sobre la línea central (celdas) y a un desplazamiento de costado (celdas)
export function pointAt(f, u, side) {
  const i = ((Math.round(u) % f.L) + f.L) % f.L;
  return { x: f.cx[i] + f.nx[i] * side, y: f.cy[i] + f.ny[i] * side, angle: Math.atan2(-f.nx[i], f.ny[i]) };
}

// Vuelve a poner un auto trabado en la pista, sobre la trazada y un poco más adelante (u: posición en celdas)
export function rescue(track, line, car, u) {
  const spot = pointAt(lineFrame(track), u + 4 / track.meters, line.offset[u | 0]);
  Object.assign(car, { x: spot.x, y: spot.y, angle: spot.angle, speed: 0, steer: 0, slip: 0, omega: 0 });
}

// Grilla de largada detrás de la línea: de a dos, alternando de costado, cada puesto 8 m más atrás
export function gridSlots(track, count) {
  const f = lineFrame(track), M = track.meters;
  const slots = [];
  for (let i = 0; i < count; i++) {
    const back = (12 + i * 8) / M;
    const side = ((i % 2 ? -1 : 1) * 3) / M;
    slots.push({ ...pointAt(f, f.length - back, side), back: back * M }); // back: metros detrás de la línea
  }
  return slots;
}

export class Driver {
  // pace: fracción de la velocidad de la trazada ideal a la que va (0..1); seed varía sus pequeños errores
  constructor(pace, seed) {
    this.pace = pace;
    this.phase = seed * 2.39;
    this.shift = 0; // cuánto se corrió de la trazada para pasar a alguien (m)
    this.stuck = 0;
    this.time = 0;
  }

  // Decide los pedales y el volante. me/others: { car, st, lat } con st y lat en celdas.
  drive(dt, track, line, me, others) {
    const { car } = me;
    const f = lineFrame(track), M = track.meters;
    const L = line.offset.length;
    const v = Math.max(0, car.speed);
    this.time += dt;

    // pequeñas imperfecciones: un poco más o menos de ritmo y de trazada según el momento
    const pace = this.pace * (1 + 0.015 * Math.sin(this.time * 0.37 + this.phase));
    const wobble = 0.25 * Math.sin(this.time * 0.5 + this.phase * 1.7);

    // tráfico: entre qué posiciones de costado puede ir sin tocar a nadie (lo, hi, en m)
    // y qué velocidad no tiene que pasar para no llevarse puesto al de adelante (cap)
    const u = me.st;
    const half = halfWidthAt(track, u) * M - MARGIN;
    const racing = line.offset[u | 0] * M + wobble; // por dónde va la trazada acá (m de costado)
    const myLat = me.lat * M;
    const lapM = f.length * M;
    let lo = -half, hi = half, cap = Infinity;
    let aheadAlongside = Infinity; // velocidad del auto a la par que va un poco adelante
    for (const o of others) {
      let ds = (o.st - u) * M;
      if (ds < -lapM / 2) ds += lapM;
      if (ds > lapM / 2) ds -= lapM;
      if (ds < -ALONGSIDE || ds > SEE_AHEAD) continue;
      const ol = o.lat * M, ov = Math.max(0, o.car.speed);
      if (ds < ALONGSIDE) {
        // a la par: cada uno se queda de su lado hasta que uno pase al otro
        if (myLat >= ol) lo = Math.max(lo, ol + PASS_GAP);
        else hi = Math.min(hi, ol - PASS_GAP);
        if (ds > 0) aheadAlongside = Math.min(aheadAlongside, ov);
        // si el otro le lleva más de media trompa y no lo está pasando (no viene más rápido), no pelea el lugar:
        // levanta y se ubica detrás
        if (ds > YIELD_AHEAD && v < ov + 1) cap = Math.min(cap, Math.max(0, ov - 2));
        continue;
      }
      // adelante y en el camino: si lo alcanza, se abre para pasarlo (del lado en que ya está, si hay lugar)
      if (Math.abs(ol - (racing + this.shift)) > CAR_WIDTH + 0.6) continue;
      if (ov < v + 3) {
        let side = Math.abs(myLat - ol) > 0.8 ? Math.sign(myLat - ol) : half - ol > ol + half ? 1 : -1;
        if ((side > 0 && ol + PASS_GAP > half) || (side < 0 && ol - PASS_GAP < -half)) side = -side;
        if (side > 0 && ol + PASS_GAP <= half) lo = Math.max(lo, ol + PASS_GAP);
        else if (side < 0 && ol - PASS_GAP >= -half) hi = Math.min(hi, ol - PASS_GAP);
      }
      // mientras lo tenga justo adelante, guarda distancia: más cerca, más parecida su velocidad
      if (Math.abs(ol - myLat) < CAR_WIDTH) cap = Math.min(cap, Math.max(0, ov + FOLLOW_K * (ds - FOLLOW_GAP)));
    }
    // si no hay lugar para ir a la par (lo > hi), el que va un poco atrás levanta y se ubica detrás
    let goal = Math.max(lo, Math.min(hi, racing));
    if (lo > hi) {
      goal = Math.max(-half, Math.min(half, (lo + hi) / 2));
      if (aheadAlongside < Infinity) cap = Math.min(cap, Math.max(0, aheadAlongside - 2));
    }
    const step = SHIFT_RATE * dt;
    this.shift += Math.max(-step, Math.min(step, goal - racing - this.shift));

    // volante: persigue un punto de su trazada más adelante (pure pursuit)
    const look = (LOOK_BASE + v * LOOK_TIME) / M;
    const ua = (u + look) % L;
    const sideAhead = Math.max(-half, Math.min(half, line.offset[ua | 0] * M + wobble + this.shift)) / M;
    const target = pointAt(f, ua, sideAhead);
    const dx = target.x - car.x, dy = target.y - car.y;
    const ca = Math.cos(car.angle), sa = Math.sin(car.angle);
    const fwd = dx * ca + dy * sa, right = -dx * sa + dy * ca;
    const dist = Math.hypot(dx, dy) * M || 1;
    const curv = (2 * Math.sin(Math.atan2(right, fwd))) / dist; // curvatura para llegar al punto (1/m)
    const grip = car.limits.lateral(v);
    const yawMax = Math.min(MAX_YAW, grip / Math.max(v, 1)) * Math.min(1, v / 4) || 0.01;
    const wantYaw = v * curv;
    const steer = Math.max(-1, Math.min(1, (wantYaw + YAW_FIX * (wantYaw - car.omega)) / yawMax));

    // pedales: la velocidad de la trazada un poco más adelante, por su ritmo
    const ub = (u + (v * BRAKE_LOOK) / M) % L;
    // en las curvas lentas no puede pasar de SLOW_PACE: más rápido se abre y se va afuera
    const lineV = line.speed[ub | 0];
    const wantV = Math.min(lineV * (lineV < SLOW_CORNER ? Math.min(pace, SLOW_PACE) : pace), cap);
    let throttle = v < wantV - 0.3;
    let brake = v > wantV + 0.8;
    // arrancando, a fondo aunque la trazada sea lenta
    if (v < 3 && wantV > 3) { throttle = true; brake = false; }

    // si se quedó trabado (contra un muro o un auto), vuelve a la pista sobre la trazada
    this.stuck = v < 1.5 ? this.stuck + dt : 0;
    if (this.stuck > STUCK_TIME) {
      rescue(track, line, car, u);
      this.stuck = 0;
      this.shift = 0;
    }
    // (need: qué parte de la tracción usa el motor a fondo; en el pasto, las de atrás patinan enseguida)
    const lim = car.limits, need = lim.thrust(v) / Math.max(lim.traction(v), 1e-3);
    const room = Math.sqrt(1 - Math.min(1, Math.abs(steer)) ** 2); // lo que les queda a las de atrás para empujar
    const dose = Math.min(1, Math.max(EXIT_THROTTLE, room / need)) * (1 - 0.6 * car.grass);
    return { throttle: throttle ? dose : 0, brake, steer };
  }
}
