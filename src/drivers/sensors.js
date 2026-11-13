// What the trained AI (rl/) "sees": a vector of numbers, always the same length and in the same order.
// It is used the same way for training (in Node) and for driving in the game.
//
//   car         speed, slip, yaw rate, steering, pedals, gear, rpm, grip of each axle, slipstream
//   its car     how it compares with the reference car (engine, top speed, grip, brakes, wear) and how the tyres are
//   position    which side of the track it is on, where it points relative to the track, whether it is on grass or
//               kerb
//   track       how much the track turns further ahead (at 20, 40… 450 m): what a driver knows by heart. The first
//               point, relative to the car; each of the others, relative to the previous one (how much that segment
//               turns)
//   rays        distance to the track edge in 19 directions, from -90° to +90° (closer together at the front)
//   rivals      the 6 nearest (up to 120 m): relative position and velocity and where they point.
//               Slots without a rival stay at zero (in the first stage, alone on track, always)
//   wheels      the grip of each wheel depending on what it is on (1 on asphalt, less on grass), so it knows which
//               side it went off. It goes at the end: older networks, which don't have it, read only the leading part
//   limits      what the setup and the track's air change in the car (dynamics.js): grip in slow and fast corners,
//               balance between axles in each (understeer or oversteer) and top speed, relative to the car with the
//               wings in the middle at sea level. Also at the end, for the same reason
//   damage      how broken each part is (damage.js: wings, sidepods, suspensions, tyres) and the race's damage level
//               (0 off, 0.5 reduced, 1 real). At the end, for the same reason
//   more rivals the 7th and 8th nearest, with the same values as the first 6: on a grid of 22, at the start there
//               are often more than 6 within 120 m. At the end, for the same reason
//   rival inputs  for the same 8 and in the same order: throttle, brake and steering they are using (without
//               memory, the car ahead braking was only noticed once it was already getting closer), how much more
//               engine and grip their car has than its own, how broken it is (the most broken part) and which side
//               of the track it is on. At the end, for the same reason
//   start lights on the grid: how many red lights are on, how long since the last one came on and whether they
//               already went out (src/sim/lights.js), to bring the engine to the launch revs. In the race, out. At
//               the end, for the same reason
//   tyres and weight  the temperature and wear of each tyre (FL, FR, RL, RR), the fuel on board and the setup's
//               brake bias: the grip of cold, overheated or worn tyres shows in each axle's grip only once it is
//               already lost; with this it sees it coming. At the end, for the same reason
//   risk        for the same 8 and in the same order: whether it is in the zone alongside (the same one training
//               penalizes, rl/herd.js) and whether in the next RISK_HORIZON s, each keeping the same speed and yaw
//               rate, they collide: 1 - t / RISK_HORIZON (1 already touching, 0 no collision), in the first value if
//               the one hitting is its own car (catches it or moves into it) and in the second if it is the other.
//               At the end, for the same reason
//   far track   the following segments up to 1 km, each longer than the previous, just like the nearer ones: how
//               much each segment turns. At the end, for the same reason
//
// Everything is roughly between -1 and 1. Track distances are measured in meters, so it works on any track
// regardless of its cell size.

import { SETUP_KEYS, TEMP_HIGH, TEMP_LOW } from '../sim/car.js';
import { BRAKE_TUNE_MAX, carLimits, DEFAULT_TUNE, SEA_AIR } from '../sim/dynamics.js';
import { HALF_L, HALF_W } from '../sim/collision.js';
import { NO_DAMAGE } from '../sim/damage.js';
import { LIGHTS_OUT } from '../sim/lights.js';
import { halfWidthAt, sampleField, stationAt } from '../sim/track.js';

const RAY_ANGLES = [-90, -60, -40, -28, -18, -11, -6, -3, -1, 0, 1, 3, 6, 11, 18, 28, 40, 60, 90].map(
  (d) => (d * Math.PI) / 180,
);
export const LOOK_AHEAD = [20, 40, 70, 100, 140, 180, 230, 290, 360, 450]; // m
const OPPONENTS = 6;
const CAR_VALUES = 12;
export const SETUP_VALUES = SETUP_KEYS.length + 1; // the car variation and the tyre wear
export const SETUP_START = CAR_VALUES; // where they start (old networks don't have them)
// what is taken as ±1. It was 0.05 for engine, top speed, grip and brakes; with more varied cars (down to -15 % and
// up to +20 %, to be able to raise the difficulty by giving them more grip) it became 0.2 and the weights of the
// already trained networks were rescaled the same way (rl/rescale_setup.py), so they drive exactly as before
export const SETUP_SPREAD = { power: 0.2, topSpeed: 0.2, grip: 0.2, brakes: 0.2, wear: 0.3 };
const POSITION_VALUES = 5;
const OPPONENT_VALUES = 7;
export const WHEEL_VALUES = 4;
export const LIMIT_VALUES = 5;
export const DAMAGE_VALUES = 15;
const MORE_OPPONENTS = 2; // the 7th and 8th, at the end
const RIVAL_VALUES = 7; // throttle, brake, steering, engine, grip, damage and track side of each rival
const ALL_OPPONENTS = OPPONENTS + MORE_OPPONENTS;
export const OPPONENT_INPUT_SIZE = MORE_OPPONENTS * OPPONENT_VALUES + ALL_OPPONENTS * RIVAL_VALUES;
const AHEAD_START = CAR_VALUES + SETUP_VALUES + POSITION_VALUES; // where the LOOK_AHEAD points start
export const OPPONENT_START = CAR_VALUES + SETUP_VALUES + POSITION_VALUES + LOOK_AHEAD.length + RAY_ANGLES.length;
export const OPPONENT_SIZE = OPPONENTS * OPPONENT_VALUES; // where the rivals start and how many values they are
export const OPPONENT_INPUT_START = OPPONENT_START + OPPONENT_SIZE + WHEEL_VALUES + LIMIT_VALUES + DAMAGE_VALUES;
export const START_VALUES = 3;
// network outputs: steering, pedal and, only with the start lights on red, how much it raises and lowers the rpm
// (networks from before the start lights have the first two)
export const ACTIONS = 4;
export const START_INPUT_START = OPPONENT_INPUT_START + OPPONENT_INPUT_SIZE;
export const TYRE_VALUES = 10; // temperature and wear of each tyre, fuel and brake bias
const TYRE_INPUT_START = START_INPUT_START + START_VALUES;
const RISK_VALUES = 3; // per rival: zone alongside, collision where its own car hits, collision where the other hits
const RISK_INPUT_START = TYRE_INPUT_START + TYRE_VALUES;
export const RISK_INPUT_SIZE = ALL_OPPONENTS * RISK_VALUES;
export const FAR_AHEAD = [560, 690, 840, 1010]; // m: segments of 110, 130, 150 and 170 m, following those of LOOK_AHEAD
const FAR_INPUT_START = RISK_INPUT_START + RISK_INPUT_SIZE;
export const OBS_SIZE = FAR_INPUT_START + FAR_AHEAD.length;
const RISK_HORIZON = 5; // s
const RISK_STEP = 0.1; // s between prediction points
const RISK_POINTS = Math.round(RISK_HORIZON / RISK_STEP);
// the zone alongside: the other car overlapping lengthwise (centers less than a car length apart) and less than
// ZONE_MARGIN m sideways between bodies, in the car's frame
const ZONE_MARGIN = 0.5;
export const inZone = (ahead, side) => Math.abs(ahead) < 2 * HALF_L && Math.abs(side) < 2 * HALF_W + ZONE_MARGIN;
const TEMP_MID = (TEMP_LOW + TEMP_HIGH) / 2,
  TEMP_SCALE = 20; // °C: the middle of the window is 0, ±20 °C is ±1
const FUEL_SCALE = 50; // kg
const DAMAGE_LEVEL = { off: 0, reduced: 0.5, real: 1 };
const SLOW = 25,
  FAST = 70; // m/s: a slow corner (90 km/h) and a fast one (250 km/h)

const RAY_MAX = 200; // m
const OPPONENT_RANGE = 120; // m
const TOP = 90; // m/s, to normalize speeds

const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));

// Heading of the centerline at each meter of the lap (computed once per track)
const headings = new WeakMap();
function centerHeading(track) {
  if (headings.has(track)) return headings.get(track);
  const { n, x, y, st } = track.path;
  const L = Math.ceil(st[n]);
  const out = new Float32Array(L + 1);
  let b = 0;
  for (let u = 0; u <= L; u++) {
    while (b < n - 1 && st[b + 1] < u) b++;
    const a = (b + n - 2) % n,
      c = (b + 2) % n;
    out[u] = Math.atan2(y[c] - y[a], x[c] - x[a]);
  }
  headings.set(track, out);
  return out;
}

// Heading of the track at position u of the lap (in cells, like track.station)
export function trackHeading(track, u) {
  const h = centerHeading(track);
  const L = h.length - 1;
  return h[Math.floor(((u % L) + L) % L)];
}

// Distance (m) from (x, y) to the track edge in direction a, advancing in jumps
// as long as the distance to the edge (the sdf field gives it at each cell)
function ray(track, x, y, a) {
  const { sdf, W, meters } = track;
  const dx = Math.cos(a),
    dy = Math.sin(a),
    max = RAY_MAX / meters;
  let t = 0;
  for (let k = 0; k < 64 && t < max; k++) {
    const d = sampleField(sdf, W, x + dx * t, y + dy * t);
    if (d < 0) return t * meters;
    t += Math.max(d, 0.4);
  }
  return Math.min(t, max) * meters;
}

// the car's velocity in the world (m/s), including sideways slip
function velocity(car) {
  const ca = Math.cos(car.angle),
    sa = Math.sin(car.angle);
  return [ca * car.speed - sa * car.slip, sa * car.speed + ca * car.slip];
}

// car: the car (Car from car.js); u: its position in the lap (track.station, cells);
// others: the other cars (Car) on the same track
export function observe(track, car, u, others = [], out = new Float32Array(OBS_SIZE)) {
  const { meters, W } = track;
  let i = 0;
  const put = (v) => {
    out[i++] = Number.isFinite(v) ? Math.max(-3, Math.min(3, v)) : 0;
  };

  // car
  put(car.speed / TOP);
  put(car.slip / 10);
  put(car.omega / 2);
  put(car.steer);
  put(car.throttle);
  put(car.brake);
  put(car.gear / 8);
  // with the start lights on red it doesn't see the rpm: it doesn't need them (its rpm outputs set them) and the
  // critic, which learned in the race that more rpm means more speed, rewarded raising them to the rev limiter even
  // though that makes a worse start (v18)
  put(car.lights && !car.lights.out ? 0 : car.rpm / 12000);
  put(car.grip?.[0] ?? 1);
  put(car.grip?.[1] ?? 1);
  put(car.aLon / 40);
  put(car.draft);

  // its car
  for (const k of SETUP_KEYS) put(((car.setup?.[k] ?? 1) - 1) / SETUP_SPREAD[k]);
  put(car.wear ?? 0);

  // position on the track
  const lat = sampleField(track.lat, W, car.x, car.y);
  const rel = wrapAngle(car.angle - trackHeading(track, u));
  put(lat / halfWidthAt(track, u));
  put(Math.sin(rel));
  put(Math.cos(rel));
  put(car.grass ?? (car.onGrass ? 1 : 0)); // fraction of the wheels on the grass
  put(car.onKerb ? 1 : 0);

  // the track further ahead: how much each segment turns (the first, relative to the car)
  let heading = car.angle;
  for (const d of LOOK_AHEAD) {
    const h = trackHeading(track, u + d / meters);
    put(wrapAngle(h - heading) / Math.PI);
    heading = h;
  }

  // rays to the edge
  for (const a of RAY_ANGLES) put(ray(track, car.x, car.y, car.angle + a) / RAY_MAX);

  // nearest rivals, in the car's frame (x forward, y to the right)
  const ca = Math.cos(car.angle),
    sa = Math.sin(car.angle);
  const [vx, vy] = velocity(car);
  const near = [];
  for (const o of others) {
    if (o === car) continue;
    const dx = (o.x - car.x) * meters,
      dy = (o.y - car.y) * meters;
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
    const rvx = ox - vx,
      rvy = oy - vy;
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

  // grip of each wheel: front left, right, rear left, right
  for (const g of car.wheelGrip ?? [1, 1, 1, 1]) put(g);

  // the car's limits with its setup and the air
  for (const x of limitValues(car)) put(x);

  // damage: front wing, rear wing and sidepods (left, right), suspensions and tyres (FL, FR, RL, RR) and level
  const d = car.damage ?? NO_DAMAGE;
  for (const part of [d.frontWing, d.rearWing, d.sidepod, d.suspension, d.tyre]) for (const x of part) put(x);
  put(DAMAGE_LEVEL[car.damageLevel] ?? 0);

  // the 7th and 8th rival
  for (let k = OPPONENTS; k < ALL_OPPONENTS; k++) rival(near[k]);

  // how the 8 are driving: pedals, steering, their car relative to its own, damage and which side of the track
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

  // start lights: lights on, seconds since the last one and whether the start already happened
  const lights = car.lights ?? LIGHTS_OUT;
  put(lights.lit / 5);
  put(lights.since / 3);
  put(lights.out ? 1 : 0);

  // tyres and weight: temperature and wear of each tyre, fuel and brake bias (+: more to the front)
  for (const t of car.tyreTemp ?? [TEMP_MID, TEMP_MID, TEMP_MID, TEMP_MID]) put((t - TEMP_MID) / TEMP_SCALE);
  for (const w of car.tyreWear ?? [0, 0, 0, 0]) put(w);
  put((car.fuel ?? 0) / FUEL_SCALE);
  put((car.tune?.brake ?? 0) / BRAKE_TUNE_MAX);

  // risk with each of the 8: zone alongside and collision in the next seconds (who hits)
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

  // the far track: how much each segment turns, continuing from the last near point
  for (const d of FAR_AHEAD) {
    const h = trackHeading(track, u + d / meters);
    put(wrapAngle(h - heading) / Math.PI);
    heading = h;
  }
  return out;
}

// Where a car will be in the next RISK_HORIZON s if it keeps the same velocity (forward and sideways, in its frame)
// and the same yaw rate: every RISK_STEP s, x, y (m), heading and world velocity (m/s), from now (t = 0)
const ownPath = new Float64Array((RISK_POINTS + 1) * 5),
  otherPath = new Float64Array((RISK_POINTS + 1) * 5);
function predict(car, meters, out) {
  let x = car.x * meters,
    y = car.y * meters,
    a = car.angle;
  const { speed, slip, omega } = car;
  for (let k = 0; k <= RISK_POINTS; k++) {
    const c = Math.cos(a),
      s = Math.sin(a),
      i = k * 5;
    out[i] = x;
    out[i + 1] = y;
    out[i + 2] = a;
    out[i + 3] = c * speed - s * slip;
    out[i + 4] = s * speed + c * slip;
    // with the heading at the middle of the interval, so error doesn't accumulate in corners
    const am = a + (omega * RISK_STEP) / 2,
      cm = Math.cos(am),
      sm = Math.sin(am);
    x += (cm * speed - sm * slip) * RISK_STEP;
    y += (sm * speed + cm * slip) * RISK_STEP;
    a += omega * RISK_STEP;
  }
  return out;
}

// Whether two cars (rectangles of 2·HALF_L × 2·HALF_W) with center and heading overlap (separating axes)
function overlap(ax, ay, aa, bx, by, ba) {
  const dx = bx - ax,
    dy = by - ay;
  if (dx * dx + dy * dy > 4 * (HALF_L * HALF_L + HALF_W * HALF_W)) return false;
  const ca = Math.cos(aa),
    sa = Math.sin(aa),
    cb = Math.cos(ba),
    sb = Math.sin(ba);
  for (const [ux, uy] of [
    [ca, sa],
    [-sa, ca],
    [cb, sb],
    [-sb, cb],
  ]) {
    // half of each car projected onto the axis
    const ra = HALF_L * Math.abs(ca * ux + sa * uy) + HALF_W * Math.abs(-sa * ux + ca * uy);
    const rb = HALF_L * Math.abs(cb * ux + sb * uy) + HALF_W * Math.abs(-sb * ux + cb * uy);
    if (Math.abs(dx * ux + dy * uy) > ra + rb) return false;
  }
  return true;
}

// The first collision between two predictions: [1 - t / RISK_HORIZON (0 if they don't collide), whether the first
// one hits]. The one hitting is the one moving more toward the other at the moment of the collision: the one catching
// the car ahead or the one moving into the other from the side
function crash(a, b) {
  for (let k = 0; k <= RISK_POINTS; k++) {
    const i = k * 5;
    if (!overlap(a[i], a[i + 1], a[i + 2], b[i], b[i + 1], b[i + 2])) continue;
    const dx = b[i] - a[i],
      dy = b[i + 1] - a[i + 1],
      d = Math.hypot(dx, dy) || 1;
    const towardB = (a[i + 3] * dx + a[i + 4] * dy) / d; // how fast the first moves toward the other (m/s)
    const towardA = -(b[i + 3] * dx + b[i + 4] * dy) / d;
    return [1 - (k * RISK_STEP) / RISK_HORIZON, towardB >= towardA];
  }
  return [0, false];
}

// For networks from before the segments (v21 and earlier), which read each LOOK_AHEAD point relative to the car: the
// turn of each segment summed up to that point, as they saw it (returns a copy)
export function aheadFromCar(obs, out = new Float32Array(obs.length)) {
  out.set(obs);
  let turn = 0;
  for (let k = 0; k < LOOK_AHEAD.length; k++) {
    turn += obs[AHEAD_START + k] * Math.PI;
    out[AHEAD_START + k] = wrapAngle(turn) / Math.PI;
  }
  return out;
}

// The car's limits relative to the reference car, roughly between -1 and 1 (computed once per limits object)
const refs = new WeakMap(),
  summaries = new WeakMap();
function limitValues(car) {
  const lim = car.limits;
  if (summaries.has(lim)) return summaries.get(lim);
  if (!refs.has(car.profile)) refs.set(car.profile, carLimits(car.profile, DEFAULT_TUNE, SEA_AIR));
  const ref = refs.get(car.profile);
  const balance = (l, v) => {
    const [f, r] = l.axles(v);
    return f / r - 1;
  };
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
