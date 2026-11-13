// The driver and the car, for drawing them: how the body leans (suspension), where the driver looks and how
// their head moves with the forces, the shift paddles and how much the steering wheel shakes. It doesn't change how
// the car drives: it is only what is seen.
import { lineFrame, pointAt } from '../sim/lineframe.js';
import { stationAt } from '../sim/track.js';

// 1/s: how fast the steering wheel follows the steering
const PADDLE_TIME = 0.2; // s: how long the paddle pull lasts when shifting
const PADDLE_PULL = 0.018; // m: how far the driver pulls it
const BUZZ = 0.05; // rad: how much the steering wheel shakes on the grass (on the kerbs, half)
// the head leans with the same forces as the body, quite a bit more: outward in corners and forward
// under braking (times the suspension's roll and pitch)
const HEAD_ROLL = 6;
const HEAD_DIVE = 5;

// ---------- suspension: body roll and pitch ----------
// The body leans outward in corners (with the lateral acceleration) and the nose dips under braking
// (it rises a bit when accelerating). A damped spring follows it: it takes a moment to lean and to come back.
// An F1 car is very stiff, so it is very little.
const ROLL_MAX = 0.026; // rad (1.5°) at ROLL_G of lateral acceleration
const ROLL_G = 45; // m/s²
const DIVE_PER = 0.0004; // rad of pitch per m/s² of braking (full braking, ~1.1°)
const DIVE_MAX = 0.022; // rad
const SPRING = 90; // 1/s²: spring stiffness
const DAMPING = 14; // 1/s: damping (a bit less than critical: it barely bounces)

// b: { roll, dive, vRoll, vDive }; aLat: lateral acceleration (+ turning right), aLon: forward
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

// ---------- where each driver looks ----------
// In order: the car ahead if there is one close within ±10° of its heading; if not, the apex of the next corner;
// if there is no corner in sight, straight ahead. The head turns gradually and only up to a point.
const LOOK_CONE = (10 * Math.PI) / 180;
const LOOK_CAR = 60; // m: how far it follows a car
const LOOK_AHEAD = [8, 140]; // m ahead where it looks for the next corner
const LOOK_CORNER = 0.9; // a corner if the racing line there is below this fraction of the segment's top speed
const LOOK_MAX = 0.5; // rad: the most the head turns
const LOOK_RATE = 4; // 1/s

const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));

// angle (rad, + to the right) where the driver of car wants to look; cars: all cars (including itself);
// line: the track's racing line (racingline.js), to find the next corner
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
  // the slowest point of the racing line in the segment ahead; if it is a real apex, it looks there
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

// the paddles: on upshifts the driver pulls the right one and on downshifts, the left one; the pull goes and comes back
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

// how much the steering wheel shakes: on the grass, on the gravel and on the kerbs, more the faster it goes, and with
// the sausage kerb jump (changes every frame)
export const buzz = (c) =>
  ((c.rough ?? c.grass) * Math.min(1, Math.abs(c.speed) / 25) +
    (c.onKerb ? Math.min(1, Math.abs(c.speed) / 35) * 0.5 : 0) +
    (c.jolt ?? 0)) *
  BUZZ *
  (Math.random() * 2 - 1);

// the driver's head, tilted by the forces: [sideways, forward]
export const headTilt = (body) => [(body?.roll ?? 0) * HEAD_ROLL, (body?.dive ?? 0) * HEAD_DIVE];

export function turnHead(head = 0, target, dt) {
  target = Math.max(-LOOK_MAX, Math.min(LOOK_MAX, target));
  return head + (target - head) * Math.min(1, dt * LOOK_RATE);
}
