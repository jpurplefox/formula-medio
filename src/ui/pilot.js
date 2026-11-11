// El piloto y el auto, para dibujarlos: cómo se inclina la carrocería (suspensión), hacia dónde mira el piloto y
// cómo se le va la cabeza con las fuerzas, las levas de cambio y lo que tiembla el volante. No cambia cómo anda el
// auto: es sólo lo que se ve.
import { lineFrame, pointAt } from '../sim/lineframe.js';
import { stationAt } from '../sim/track.js';

// 1/s: qué tan rápido sigue el volante a la dirección
const PADDLE_TIME = 0.2; // s: lo que dura el tirón de la leva al cambiar
const PADDLE_PULL = 0.018; // m: cuánto la acerca el piloto
const BUZZ = 0.05; // rad: lo que tiembla el volante en el pasto (en los pianos, la mitad)
// la cabeza se inclina con las mismas fuerzas que la carrocería, bastante más: hacia afuera en las curvas y hacia
// adelante al frenar (veces el rolido y el cabeceo de la suspensión)
const HEAD_ROLL = 6;
const HEAD_DIVE = 5;

// ---------- suspensión: rolido y cabeceo de la carrocería ----------
// La carrocería se inclina hacia afuera en las curvas (según la aceleración de costado) y baja la trompa al frenar
// (la sube un poco al acelerar). La sigue un resorte amortiguado: tarda un instante en inclinarse y en volver.
// Un F1 es muy duro, así que es poquito.
const ROLL_MAX = 0.026; // rad (1,5°) con ROLL_G de aceleración de costado
const ROLL_G = 45; // m/s²
const DIVE_PER = 0.0004; // rad de cabeceo por cada m/s² de frenada (a fondo, ~1,1°)
const DIVE_MAX = 0.022; // rad
const SPRING = 90; // 1/s²: rigidez del resorte
const DAMPING = 14; // 1/s: amortiguación (un poco menos que la crítica: casi no rebota)

// b: { roll, dive, vRoll, vDive }; aLat: aceleración de costado (+ doblando a la derecha), aLon: hacia adelante
export function suspension(b, aLat, aLon, dt) {
  b ??= { roll: 0, dive: 0, vRoll: 0, vDive: 0 };
  const roll = Math.max(-1, Math.min(1, aLat / ROLL_G)) * ROLL_MAX;
  const dive = Math.max(-DIVE_MAX, Math.min(DIVE_MAX, -aLon * DIVE_PER));
  b.vRoll += (SPRING * (roll - b.roll) - DAMPING * b.vRoll) * dt;
  b.vDive += (SPRING * (dive - b.dive) - DAMPING * b.vDive) * dt;
  b.roll += b.vRoll * dt;
  b.dive += b.vDive * dt;
  return b;
}

// ---------- hacia dónde mira cada piloto ----------
// En orden: el auto de adelante si hay uno cerca dentro de ±10° de su rumbo; si no, el vértice de la próxima curva;
// si no hay curva a la vista, de frente. La cabeza gira de a poco y hasta cierto punto.
const LOOK_CONE = (10 * Math.PI) / 180;
const LOOK_CAR = 60; // m: hasta dónde sigue a un auto
const LOOK_AHEAD = [8, 140]; // m adelante donde busca la próxima curva
const LOOK_CORNER = 0.9; // es curva si la trazada va ahí a menos de esta fracción de lo más rápido del tramo
const LOOK_MAX = 0.5; // rad: lo más que gira la cabeza
const LOOK_RATE = 4; // 1/s

const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));

// ángulo (rad, + a la derecha) hacia donde quiere mirar el piloto de car; cars: todos los autos (incluido él);
// line: la trazada ideal del circuito (racingline.js), para encontrar la próxima curva
export function lookYaw(car, cars, track, line) {
  const M = track.meters;
  let best = Infinity,
    yaw = 0;
  for (const o of cars) {
    if (o === car) continue;
    const dx = o.x - car.x,
      dy = o.y - car.y,
      d = Math.hypot(dx, dy) * M;
    const rel = wrapAngle(Math.atan2(dy, dx) - car.angle);
    if (d < LOOK_CAR && d < best && Math.abs(rel) <= LOOK_CONE) {
      best = d;
      yaw = rel;
    }
  }
  if (best < Infinity) return yaw;
  const u = stationAt(track, car.x, car.y);
  if (!line || u < 0) return 0;
  // el punto más lento de la trazada en el tramo de adelante; si es un vértice de verdad, se mira ahí
  const L = line.speed.length,
    a = Math.round(u + LOOK_AHEAD[0] / M),
    b = Math.round(u + LOOK_AHEAD[1] / M);
  let lo = Infinity,
    hi = 0,
    at = a;
  for (let i = a; i <= b; i++) {
    const v = line.speed[((i % L) + L) % L];
    if (v < lo) {
      lo = v;
      at = i;
    }
    if (v > hi) hi = v;
  }
  if (at === a || lo > hi * LOOK_CORNER) return 0;
  const p = pointAt(lineFrame(track), at, line.offset[((at % L) + L) % L]);
  return wrapAngle(Math.atan2(p.y - car.y, p.x - car.x) - car.angle);
}

// las levas: al subir de marcha el piloto tira de la derecha y al bajar, de la izquierda; el tirón va y vuelve
export function paddles(p, gear, dt) {
  p ??= { gear, up: 0, down: 0 };
  if (gear > p.gear && p.gear > 0) p.up = PADDLE_TIME;
  else if (gear < p.gear && gear > 0) p.down = PADDLE_TIME;
  p.gear = gear;
  p.up = Math.max(0, p.up - dt);
  p.down = Math.max(0, p.down - dt);
  const pull = (t) => Math.sin((Math.PI * t) / PADDLE_TIME) * PADDLE_PULL;
  p.pull = [pull(p.down), pull(p.up)];
  return p;
}

// cuánto tiembla el volante: en el pasto, en la leca y en los pianos, más cuanto más rápido, y con el salto de la
// salchicha (cambia en cada cuadro)
export const buzz = (c) =>
  ((c.rough ?? c.grass) * Math.min(1, Math.abs(c.speed) / 25) +
    (c.onKerb ? Math.min(1, Math.abs(c.speed) / 35) * 0.5 : 0) +
    (c.jolt ?? 0)) *
  BUZZ *
  (Math.random() * 2 - 1);

// la cabeza del piloto, inclinada por las fuerzas: [hacia el costado, hacia adelante]
export const headTilt = (body) => [(body?.roll ?? 0) * HEAD_ROLL, (body?.dive ?? 0) * HEAD_DIVE];

export function turnHead(head = 0, target, dt) {
  target = Math.max(-LOOK_MAX, Math.min(LOOK_MAX, target));
  return head + (target - head) * Math.min(1, dt * LOOK_RATE);
}
