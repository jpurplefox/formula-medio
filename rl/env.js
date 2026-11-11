// Training environment: one car on a track, with the same physics as the game and without drawing anything.
//
// Action: [steering, pedal], both from -1 to 1 (positive pedal accelerates, negative brakes).
// The AI decides 20 times per second; between decisions the physics advances 3 steps of 1/60 s, as in the game.
//
// Reward for each decision:
//   + meters advanced along the centerline (going backwards subtracts): optimizing it means lowering the lap time.
//     They don't count on the grass, so cutting corners never pays off
//   - for each step on the grass
//   - for each hit against the wall, according to its strength
// The episode ends if the car spends too long on the grass, stands still or goes backwards,
// and is truncated (through no fault of the car) at EPISODE_STEPS.
//
// Each episode the car is a little different (engine, top speed, grip, brakes, wear rate: ± spread) and starts
// with half-worn tyres; the network receives that data (sensors.js), so it learns to drive any car.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Car, DEFAULT_PROFILE, FUEL_PER_KM, limitsOn, RIVAL_AIDS, SETUP_KEYS } from '../src/sim/car.js';
import { airDensity, BRAKE_TUNE_MAX, WING_MAX, WING_MIN } from '../src/sim/dynamics.js';
import { racingLine } from '../src/sim/racingline.js';
import { halfWidthAt } from '../src/sim/track.js';
import { OBS_SIZE, observe, stationAt, trackHeading } from '../src/drivers/sensors.js';
import { loadTrack } from './tracks.js';

const PHYSICS_DT = 1 / 60;
export const SUBSTEPS = 3;
const EPISODE_STEPS = 2400; // 2 minutes
const PROGRESS_REWARD = 0.02; // per meter
const GRASS_PENALTY = 0.1; // per decision on the grass
const WALL_PENALTY = 1; // for a full-strength hit
const GRASS_LIMIT = 6; // s in a row on the grass: the episode ends (before that, it should learn to come back)
const STUCK_LIMIT = 6; // s almost standing still
const STANDING_START = 0.2; // share of episodes that start with the car standing still, as on the grid
const ROUGH_START = 0.2; // and share that start sideways or with two wheels off, to learn to recover
const BACKWARDS_LIMIT = 30; // m of accumulated reversing
const END_PENALTY = 2;
const RETIRE_PENALTY = 10; // for breaking the car against the wall until it retires (with damage)
const DAMAGE_LEVELS = ['off', 'reduced', 'real'];

let profile = DEFAULT_PROFILE;
try {
  profile = JSON.parse(readFileSync(fileURLToPath(new URL('../cars/f1-2025.json', import.meta.url)), 'utf8'));
} catch {
  // without the measured profile, the default one
}

const tracks = new Map(); // id → { track, line } (built once per process)
function getTrack(id) {
  if (!tracks.has(id)) {
    const track = loadTrack(id);
    tracks.set(id, { track, line: racingLine(track, limitsOn(profile, track)) });
  }
  return tracks.get(id);
}

// seeded random number generator (mulberry32), so a training run can be repeated
export function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// A random car: each multiplier between 1 - spread and 1 + spread, or between 1 - spread[0] and 1 + spread[1]
// (wear always varies ±30 %)
export function randomSetup(rand, spread) {
  const [down, up] = Array.isArray(spread) ? spread : [spread, spread];
  return Object.fromEntries(
    SETUP_KEYS.map((k) => [k, k === 'wear' ? 1 + (2 * rand() - 1) * 0.3 : 1 - down + (down + up) * rand()]),
  );
}

// Random setup for the learning network: wings up to TUNE_SPREAD points more or less than the track's, balance from
// -TUNE_SPREAD to TUNE_SPREAD, brake bias up to TUNE_SPREAD points further forward or back and, one in AIR_CHANCE
// times, the air of another altitude (up to Mexico's). That way it learns to drive cars with more or less downforce,
// more or less top speed, understeering or oversteering, and braking more with one axle or the other.
// With spread 0, the track's setup and its air.
export const TUNE_SPREAD = 3;
const AIR_CHANCE = 1 / 3,
  MAX_ALTITUDE = 2300;
export function randomTune(car, rand, track, spread = TUNE_SPREAD) {
  if (spread) {
    const t = track.tune,
      wing = (x) => Math.max(WING_MIN, Math.min(WING_MAX, x + Math.round((2 * rand() - 1) * spread)));
    const brake = Math.max(
      -BRAKE_TUNE_MAX,
      Math.min(BRAKE_TUNE_MAX, (t.brake ?? 0) + Math.round((2 * rand() - 1) * spread)),
    );
    car.ownTune = { front: wing(t.front), rear: wing(t.rear), balance: Math.round((2 * rand() - 1) * spread), brake };
    car.ownAir = rand() < AIR_CHANCE ? airDensity(rand() * MAX_ALTITUDE) : null;
  }
  car.placeOn(track);
}

// Random tyres: races of 3 to 20 laps (wear per meter) and at any point of the race; cold as if just out of the
// pits, at their best or somewhat overheated (all four similar); and with fuel for 0 to 20 laps
export function randomTyres(car, rand, track) {
  car.wearRate = 1 / ((3 + 17 * rand()) * track.length * track.meters);
  car.wear = 0.9 * rand();
  const temp = 60 + 55 * rand();
  car.tyreTemp = car.tyreTemp.map(() => temp + 10 * (rand() - 0.5));
  car.fuel = (FUEL_PER_KM * 20 * rand() * (track.length * track.meters)) / 1000;
}

export class RaceEnv {
  // rewards: scale of the grass and wall penalties (phase 1 of the third attempt makes them more expensive); damage:
  // the damage level (src/sim/damage.js: 'off', 'reduced', 'real' or 'mix', one of the three at random each
  // episode). With damage, a hard hit against the wall breaks the car, and if it retires the episode ends
  constructor({ trackIds, seed = 1, spread = 0.02, rewards = {}, tuneSpread = TUNE_SPREAD, damage = 'off' }) {
    this.tuneSpread = tuneSpread;
    this.damage = damage;
    this.rewards = { grass: 1, wall: 1, ...rewards };
    this.trackIds = trackIds;
    this.spread = spread;
    this.rand = rng(seed);
    this.obs = new Float32Array(OBS_SIZE);
  }

  reset() {
    const id = this.trackIds[Math.floor(this.rand() * this.trackIds.length)];
    const { track, line } = getTrack(id);
    this.id = id;
    this.track = track;
    // start at any point of the lap, on the racing line and at a fraction of its speed
    const L = track.length;
    const u = this.rand() * L;
    const rough = this.rand() < ROUGH_START;
    const side = (this.rand() - 0.5) * halfWidthAt(track, u) * (rough ? 2.6 : 1);
    const h = trackHeading(track, u);
    const { x, y } = pointOnCenter(track, u);
    const car = new Car(
      x - Math.sin(h) * side,
      y + Math.cos(h) * side,
      h + (this.rand() - 0.5) * (rough ? 1.6 : 0.2),
      profile,
    );
    Object.assign(car, RIVAL_AIDS); // with the game's driving aids
    const standing = this.rand() < STANDING_START;
    car.speed = standing ? 0 : this.rand() * (rough ? 0.4 : 0.8) * line.speed[Math.floor(u) % line.speed.length];
    if (standing) car.launch();
    while (car.gear < car.gears && car.rpmAt(car.speed, car.gear) > profile.upshiftRpm) car.gear++;
    car.rpm = Math.max(4000, car.rpmAt(car.speed, car.gear));
    car.throttle = 0.5;
    car.setup = randomSetup(this.rand, this.spread);
    randomTune(car, this.rand, track, this.tuneSpread);
    randomTyres(car, this.rand, track);
    car.damageLevel = this.damage === 'mix' ? DAMAGE_LEVELS[Math.floor(this.rand() * 3)] : this.damage;
    this.car = car;
    this.u = stationAt(track, car.x, car.y);
    this.steps = 0;
    this.grass = 0;
    this.stuck = 0;
    this.back = 0;
    this.lapStart = null; // time when it crossed the start line (to measure complete laps)
    this.time = 0;
    this.ret = 0;
    this.dist = 0;
    return observe(track, car, this.u, [], this.obs);
  }

  // Returns { obs, reward, done, truncated, info }
  step(steer, pedal) {
    const { track, car } = this;
    const input = { steer: clamp(steer), throttle: Math.max(0, clamp(pedal)), brake: Math.max(0, -clamp(pedal)) };
    let reward = 0,
      lap = null;
    const L = track.length;
    for (let k = 0; k < SUBSTEPS; k++) {
      const bump = car.bump;
      car.update(PHYSICS_DT, input, track);
      if (car.bump > bump + 0.05) reward -= WALL_PENALTY * this.rewards.wall * (car.bump - bump);
      this.time += PHYSICS_DT;
      // progress along the centerline (in meters); when crossing the start line the station goes back to 0
      const u = stationAt(track, car.x, car.y);
      if (u >= 0) {
        let du = u - this.u;
        if (du < -L / 2) {
          du += L;
          if (this.lapStart !== null) lap = this.time - this.lapStart;
          this.lapStart = this.time;
        } else if (du > L / 2) {
          du -= L;
          this.lapStart = null; // crossed the line backwards: that lap doesn't count
        }
        this.u = u;
        const m = du * track.meters;
        if (!car.onGrass || m < 0) reward += PROGRESS_REWARD * m;
        this.dist += m;
        this.back = m < 0 ? this.back - m : Math.max(0, this.back - m);
      }
    }
    const dt = PHYSICS_DT * SUBSTEPS;
    if (car.onGrass) {
      reward -= GRASS_PENALTY * this.rewards.grass;
      this.grass += dt;
    } else this.grass = 0;
    this.stuck = Math.abs(car.speed) < 1 ? this.stuck + dt : 0;
    this.steps++;

    const retired = !!car.damage.retired;
    const done = retired || this.grass > GRASS_LIMIT || this.stuck > STUCK_LIMIT || this.back > BACKWARDS_LIMIT;
    if (done) reward -= retired ? RETIRE_PENALTY : END_PENALTY;
    const truncated = !done && this.steps >= EPISODE_STEPS;
    this.ret += reward;
    const info = { lap, track: this.id };
    if (done || truncated) {
      info.episode = {
        r: this.ret,
        l: this.steps,
        dist: this.dist,
        track: this.id,
        end: retired
          ? 'retired'
          : this.grass > GRASS_LIMIT
            ? 'grass'
            : this.stuck > STUCK_LIMIT
              ? 'stuck'
              : this.back > BACKWARDS_LIMIT
                ? 'back'
                : 'time',
      };
    }
    return { obs: observe(track, car, this.u, [], this.obs), reward, done, truncated, info };
  }
}

const clamp = (v) => Math.max(-1, Math.min(1, Number.isFinite(v) ? v : 0));

// point on the centerline at position u of the lap (cells)
export function pointOnCenter(track, u) {
  const { n, x, y, st } = track.path;
  const L = st[n];
  u = ((u % L) + L) % L;
  let lo = 0,
    hi = n;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (st[mid] <= u) lo = mid;
    else hi = mid;
  }
  const b = (lo + 1) % n,
    t = (u - st[lo]) / Math.max(1e-9, st[lo + 1] - st[lo]);
  return { x: x[lo] + (x[b] - x[lo]) * t, y: y[lo] + (y[b] - y[lo]) * t };
}
