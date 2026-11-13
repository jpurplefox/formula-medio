// Herd races (curriculum v8, rl/CURRICULUM.md): every car in the race is an agent with the same network, which is
// learning. This trains the group behavior seen in the game (21 identical networks), for example the single file at
// the start, which did not appear with classic AI opponents.
//
// Scenarios (their length comes from the racing line lap of the track):
//   solo     agents spread around the track, at speed, two laps (a review of phase 1)
//   grid     standing start with start lights (src/sim/lights.js), two laps: the track's grid or a random one
//            before a corner. With the lights on the network raises and lowers the revs with its two rpm outputs
//            (car.revBy); when they go out, if it is already accelerating it releases the clutch at whatever revs
//            it has (car.launch: bogged down or with wheelspin if they are outside the window) or, if not, when it
//            accelerates
//   start    launch: like grid (start lights, the track's grid or a random one), but it ends when the first car
//            reaches START_MARGIN m from the start of the braking zone of the first corner: up to there the right
//            thing is to go flat out, so it does not reward arriving too fast (what follows is estimated by the
//            critic, as in a time cutoff). Short: many more starts per step than in grid (in grid, about 280 every
//            3.5 M steps)
//   flying   flying start: two staggered rows FLYING_GAP m apart, all at the same fraction of the racing line speed
//            (±3 %), before a corner, one lap. To learn to run side by side and in a tight group
//   rolling  in single file, at speed, at different gaps, two laps
//   chase    in pairs: the car ahead with less engine, one lap. Only the car behind is measured; the car ahead drives
//            with the usual reward (its time): if easing off to let the other pass costs it, it doesn't learn to
//            ease off
//
// A single measure, in every scenario: the time with penalty (the same rules for rewarding and for measuring; see
// Budgets in rl/train.py), against the racing line's time for its car starting the same way (1.05: 5 % slower):
//   solo, rolling  each lap
//   grid           both laps, against the racing line from a standstill plus a flying lap
//   start          how far each one got when the first one crossed the line, against the racing line from a
//                  standstill
//   flying         the lap, against the racing line starting at its speed
//   chase          the lap of the car behind
// The penalty, in seconds added to the time:
//   - ZONE_TIME for each second with another car in the zone alongside (the car plus ZONE_MARGIN m on each side,
//     the same length: side by side within that margin, or overlapping). It is no longer than the car: following
//     behind costs nothing (with a penalty for the danger of catching another car, in the pack at the start it paid
//     to lift and get hit from behind, v10 and v11). Fault is not assigned: between equals, both pay
//   - HIT_TIME for each contact: a contact that starts after CONTACT_GAP without touching (a long rub counts once)
//   - GRASS_TIME for each second and each wheel on the grass
// Whatever breaks already costs on its own: driving a broken car is slower.
//
// Reward of each agent, × the scale of its scenario (scales; set by training: the scenario the phase rewards with a
// fixed weight and the others adjusted on their own so they don't get worse, budgets):
//   + meters advanced (also on the grass: its per-wheel penalty charges for it; if cutting corners ever pays off,
//     raise GRASS_TIME)
//   - the penalty, as the distance it would cover in those seconds at the racing line's average speed
// And without scale: - wall, standing still, rescue, retirement, driving slowly with a clear track (pace floor)

import { gridSlots } from '../src/race/grid.js';
import { stepCars } from '../src/sim/traffic.js';
import { ACTIONS, inZone, stationAt } from '../src/drivers/sensors.js';
import { halfWidthAt, sampleField } from '../src/sim/track.js';
import { NO_DAMAGE } from '../src/sim/damage.js';
import { randomSetup, randomTune, randomTyres, TUNE_SPREAD } from './env.js';
import { getTrack, mod, RaceSim, recordPace, wrap } from './race.js';
import { LIGHT_FIRST, lightsAt, lightsDuration, randomHold } from '../src/sim/lights.js';
import { RubberMap } from '../src/sim/rubber.js';

const DT = 1 / 60,
  SUBSTEPS = 3,
  DECISIONS = 20; // decisions per second
// rubber already laid on the racing line at the start of each episode: between none (race just started) and this
// (rubber.js: 25 is a clear mark; 75, almost black), so the network races with the track at any point of the race
const RUBBER_LAID = 75;
const PROGRESS_REWARD = 0.02,
  WALL_PENALTY = 1;
const GRASS_LIMIT = 6,
  STUCK_LIMIT = 6,
  BACKWARDS_LIMIT = 30,
  RESCUE_PENALTY = 4,
  STALL_PENALTY = 1,
  RETIRE_PENALTY = 10;
const FLYING_GAP = 6,
  FLYING_SPEED = [0.6, 0.8]; // flying start: m between cars and fraction of the racing line
const PASS_HOLD = 2.5; // s the car behind has to stay ahead, without touching, for the pass to count
const CONTACT_GAP = 0.5; // s without touching for the next contact to count as a new one
// penalty, in seconds: for each second with another car in the zone alongside, for each contact and for each second
// and wheel on the grass
const ZONE_TIME = 0.4,
  HIT_TIME = 2.5,
  GRASS_TIME = 0.8;
// engine handicap of the car ahead in chases, at the start and at the end of the phase
const CHASE_HANDICAP = [0.2, 0.08];
// laps of each scenario and time margin (the racing line lap × SLACK, plus a few seconds)
// (start: how long it usually lasts, in laps, to share out the mix steps and to cut it off if nobody gets there)
export const HERD_SCENARIOS = { solo: 2, grid: 2, rolling: 2, chase: 1, flying: 1, start: 0.25 };
const START_MARGIN = 10; // m before the start of the braking zone where the launch ends
const SLACK = 1.25,
  EXTRA = 25; // with a grid of 22 (as in the game) the last cars take a while to complete the two laps
const DAMAGE_LEVELS = ['off', 'reduced', 'real'];

// Start of the braking zone of each corner (cells): from the apex (corners, rl/race.js), backwards while the racing
// line is faster
const brakeCache = new WeakMap();
function brakePoints(track, line, corners) {
  if (brakeCache.has(track)) return brakeCache.get(track);
  const v = line.speed,
    n = v.length,
    at = (i) => v[((i % n) + n) % n];
  const out = corners.map((c) => {
    let i = c;
    while (i > c - n / 2 && at(i - 1) > at(i)) i--;
    return ((i % n) + n) % n;
  });
  brakeCache.set(track, out);
  return out;
}

export class HerdSim extends RaceSim {
  constructor({
    trackIds,
    agents = 16,
    seed = 1,
    mix = { grid: 1 },
    spread = 0.02,
    rewards = {},
    progress = 0,
    damage = 'off',
    tuneSpread = TUNE_SPREAD,
  }) {
    super({ trackIds, agents, seed, mix: {}, spread, rewards, progress, damage, tuneSpread });
    this.rewards = { paceFloor: 1, ...rewards };
    this.scales = Object.fromEntries(Object.keys(HERD_SCENARIOS).map((k) => [k, 1]));
    // the weight is the share of steps: each scenario is picked by its weight divided by its laps
    this.mix = Object.entries(mix)
      .filter(([, w]) => w > 0)
      .map(([k, w]) => [k, w / HERD_SCENARIOS[k]]);
    this.mixTotal = this.mix.reduce((a, [, w]) => a + w, 0);
  }

  reset() {
    const r = this.rand;
    const id = this.trackIds[Math.floor(r() * this.trackIds.length)];
    const { track, line, clock, corners } = getTrack(id);
    const scenario = this.pickScenario();
    const damage = this.damage === 'mix' ? DAMAGE_LEVELS[Math.floor(r() * 3)] : this.damage;
    const lap = clock[clock.length - 1];
    const length = Math.ceil((HERD_SCENARIOS[scenario] * lap * SLACK + EXTRA) * DECISIONS);
    // on the grid, the start lights: time counts from when they go out (before that, negative). It begins at some
    // point in the first second, before the first light
    const lights = scenario === 'grid' || scenario === 'start';
    const lightsTotal = lights ? lightsDuration(randomHold(r)) : 0;
    const time = lights ? r() * LIGHT_FIRST - lightsTotal : 0;
    Object.assign(this, {
      id,
      track,
      line,
      clock,
      corners,
      scenario,
      damage,
      steps: 0,
      time,
      lightsTotal,
      length: length + Math.ceil(-time * DECISIONS),
    });
    const L = track.length,
      M = track.meters,
      half = track.halfWidth * M,
      A = this.agents;
    const corner = () => (corners.length ? corners[Math.floor(r() * corners.length)] : r() * L);
    const spots = []; // { u, side (m), v (m/s), partner?, handicap? }

    if (scenario === 'solo') {
      const front = r() * L;
      for (let k = 0; k < A; k++) {
        const u = front + (k * L) / A;
        spots.push({ u, side: (r() - 0.5) * half, v: (0.6 + 0.3 * r()) * this.lineSpeed(u) });
      }
    } else if (scenario === 'grid') {
      // half the time the track's grid (as in the game); otherwise, 250-500 m before a corner
      const first = gridSlots(track, 1)[0];
      const line0 = r() < 0.5 ? stationAt(track, first.x, first.y) : corner() - (250 + 250 * r()) / M;
      for (let k = 0; k < A; k++)
        spots.push({ u: line0 - (k * 8) / M, side: (k % 2 ? -1 : 1) * Math.min(3, half * 0.5), v: 0 });
    } else if (scenario === 'start') {
      // half the time the track's grid and its first braking zone; otherwise, 300-700 m before a braking zone
      const brakes = brakePoints(track, line, corners);
      const first = gridSlots(track, 1)[0];
      let line0, brake;
      if (r() < 0.5 || !brakes.length) {
        line0 = stationAt(track, first.x, first.y);
        brake = brakes.reduce(
          (a, b) => (mod(b - line0, L) * M > 100 && mod(b - line0, L) < mod(a - line0, L) ? b : a),
          line0 + L / 2,
        );
      } else {
        brake = brakes[Math.floor(r() * brakes.length)];
        line0 = brake - (300 + 400 * r()) / M;
      }
      this.finish = brake - START_MARGIN / M;
      for (let k = 0; k < A; k++)
        spots.push({ u: line0 - (k * 8) / M, side: (k % 2 ? -1 : 1) * Math.min(3, half * 0.5), v: 0 });
    } else if (scenario === 'flying') {
      // 150-400 m before a corner, in two rows like the grid but closer together, all at the same fraction of the
      // racing line speed where the first car is (±3 % each)
      const line0 = corner() - (150 + 250 * r()) / M;
      const v = (FLYING_SPEED[0] + (FLYING_SPEED[1] - FLYING_SPEED[0]) * r()) * this.lineSpeed(line0);
      for (let k = 0; k < A; k++) {
        spots.push({
          u: line0 - (k * FLYING_GAP) / M,
          side: (k % 2 ? -1 : 1) * Math.min(3, half * 0.5),
          v: v * (0.97 + 0.06 * r()),
        });
      }
    } else if (scenario === 'rolling') {
      let u = r() * L;
      for (let k = 0; k < A; k++) {
        spots.push({ u, side: (r() - 0.5) * half, v: (0.6 + 0.3 * r()) * this.lineSpeed(u) });
        u -= (8 + r() * 35) / M;
      }
    } else {
      // in pairs spread around the track: on a straight coming out of a corner or before a corner
      const [h0, h1] = CHASE_HANDICAP;
      const pairs = Math.floor(A / 2);
      const front = r() * L;
      for (let p = 0; p < pairs; p++) {
        const straight = r() < 0.5;
        const base = front + (p * L) / pairs;
        // the corner closest to its place on the track
        const c = corners.reduce(
          (a, x) => (Math.abs(wrap(x - base, L)) < Math.abs(wrap(a - base, L)) ? x : a),
          corners[0] ?? base,
        );
        const u0 = straight ? c + (20 + 40 * r()) / M : c - (150 + 150 * r()) / M;
        const v = (straight ? 0.9 : 0.8 + 0.15 * r()) * this.lineSpeed(u0);
        const handicap = (h0 + (h1 - h0) * Math.min(1, this.progress)) * (0.75 + 0.5 * r());
        const gap = (straight ? 10 + 20 * r() : 12 + 25 * r()) / M;
        spots.push({
          u: u0,
          side: (r() - 0.5) * half * 0.5,
          v: v * (1 - handicap / 2),
          partner: spots.length + 1,
          handicap,
        });
        spots.push({ u: u0 - gap, side: (r() - 0.5) * half * 0.6, v: v * (1 + 0.05 * r()), partner: spots.length - 1 });
      }
      while (spots.length < A)
        spots.push({ u: front + L / 2 + (spots.length * 50) / M, side: 0, v: 0.8 * this.lineSpeed(front) });
    }

    this.cars = spots.map((s) => {
      const car = this.place(s.u, s.side, s.v);
      car.setup = randomSetup(r, this.spread);
      if (s.handicap) car.setup = { ...car.setup, power: car.setup.power * (1 - s.handicap) };
      randomTune(car, r, track, this.tuneSpread);
      randomTyres(car, r, track);
      car.damageLevel = damage;
      // offset: where it started relative to the first car (m), to know who is ahead
      const e = {
        kind: 'agent',
        car,
        u: stationAt(track, car.x, car.y),
        dist: 0,
        offset: wrap(s.u - spots[0].u, L) * M,
        lastHit: -1e9,
        lastTouch: -1e9,
        lastGrass: -1e9,
      };
      this.newEpisode(e);
      e.front = !!s.handicap; // the car ahead in a chase
      e.standing = !s.v;
      // the first lap is a start lap (not a flying lap): it is measured against the racing line starting the same way
      e.startLap = scenario === 'grid' || scenario === 'flying' || scenario === 'start';
      if (e.startLap) {
        e.startClock = this.launchClock(car, e.u, car.speed);
        e.startIdeal = e.startClock[e.startClock.length - 1];
      }
      // launch: how far it has to go to the line (before the braking zone)
      if (scenario === 'start') e.finishDist = mod(this.finish - e.u, L) * M;
      if (lights) {
        // standing on the grid at idle, clutch not released (place releases it): released when the lights go out
        Object.assign(car, { launchTime: 0, throttle: 0 });
        e.marks = [0];
      }
      return e;
    });
    this.cars.forEach((e, k) => (e.partner = spots[k].partner === undefined ? null : this.cars[spots[k].partner]));
    // the track rubber (one map per track, reused): grip depends on how much there is and the cars lay it down
    this.rubberMaps ??= new Map();
    if (!this.rubberMaps.has(id)) this.rubberMaps.set(id, new RubberMap(track, line.offset));
    this.rubber = this.rubberMaps.get(id);
    this.rubber.reset(RUBBER_LAID * r());
    for (const e of this.cars) e.car.rubber = this.rubber;
    this.agentsList = this.cars;
    this.setLights();
    return this.cars.map((e) => this.observe(e));
  }

  // how each car sees the start lights (only on the grid; without them, off)
  setLights() {
    if (!this.lightsTotal) return;
    const lights = lightsAt(this.time + this.lightsTotal, this.lightsTotal);
    for (const e of this.cars) e.car.lights = lights;
  }

  // With the start lights on: standing still; the two rpm outputs raise and lower the revs (not the pedal: with the
  // network saturated flat out it never tried anything but the rev limiter). When they go out, a car that is
  // accelerating releases the clutch at whatever revs it has; one that isn't, when it accelerates (waiting)
  countdown(actions) {
    const { cars } = this;
    cars.forEach((e, k) => {
      const a = ACTIONS * k,
        pedal = clamp(actions[a + 1]);
      e.input = { steer: 0, throttle: Math.max(0, pedal), brake: Math.max(0, -pedal) };
      e.car.throttle = e.input.throttle;
      for (let s = 0; s < SUBSTEPS; s++) e.car.revBy(DT, clamp(actions[a + 2]), clamp(actions[a + 3]));
    });
    this.time += DT * SUBSTEPS;
    if (this.time >= 0) {
      this.time = 0;
      for (const e of cars) {
        if (e.input.throttle > 0) e.car.launch();
        else e.waiting = true;
      }
    }
    this.setLights();
    this.steps++;
    return cars.map((e) => ({
      obs: this.observe(e),
      reward: 0,
      done: false,
      truncated: false,
      info: { lap: null, track: this.id },
    }));
  }

  step(actions) {
    if (this.time < 0) return this.countdown(actions);
    const { track, cars } = this;
    const L = track.length,
      M = track.meters,
      lapM = L * M;
    const all = cars.map((e) => e.car);
    const n = cars.length;
    const rewards = new Float32Array(n),
      penalty = new Float32Array(n);
    const scale = this.scales[this.scenario] ?? 1;
    const laps = cars.map(() => null);
    cars.forEach((e, k) => {
      const steer = clamp(actions[ACTIONS * k]),
        pedal = clamp(actions[ACTIONS * k + 1]);
      e.input = { steer, throttle: Math.max(0, pedal), brake: Math.max(0, -pedal) };
    });
    for (let s = 0; s < SUBSTEPS; s++) {
      const { wall, hit } = stepCars(track, all, DT, (k) => {
        const e = cars[k];
        if (e.waiting) {
          // the lights went out and it wasn't accelerating: it starts when it accelerates
          if (e.input.throttle <= 0) {
            e.car.rev(DT, 0);
            return null;
          }
          e.car.launch();
          e.waiting = false;
        }
        return e.input;
      });
      this.time += DT;
      cars.forEach((e, k) => {
        const carHit = hit[k];
        rewards[k] -= WALL_PENALTY * wall[k];
        if (carHit) {
          const fresh = this.time - e.lastTouch > CONTACT_GAP;
          e.lastTouch = e.lastHit = this.time;
          if (fresh) {
            e.hits++;
            penalty[k] += HIT_TIME;
          }
        }
        if (e.car.onGrass) e.lastGrass = this.time;
        const u = stationAt(track, e.car.x, e.car.y);
        if (u < 0) return;
        let du = u - e.u;
        if (du < -L / 2) du += L;
        else if (du > L / 2) du -= L;
        e.u = u;
        const m = du * M;
        e.dist += m;
        rewards[k] += PROGRESS_REWARD * (m < 0 ? 1 : (this.rewards.progress ?? 1)) * m * scale;
        // grass: per wheel (car.grass: the fraction of the wheels on it)
        const grassPen = GRASS_TIME * 4 * (e.car.grass ?? (e.car.onGrass ? 1 : 0)) * DT;
        penalty[k] += grassPen;
        e.grassPen += grassPen;
        e.epDist += m;
        e.back = m < 0 ? e.back - m : Math.max(0, e.back - m);
        // laps counted from where the episode started (and the penalty it had at each one)
        while (e.dist - e.lapFrom >= e.marks.length * lapM) {
          e.marks.push(this.time);
          e.penMarks.push(e.penalty + penalty[k]);
          const t = e.marks.at(-1) - e.marks.at(-2);
          laps[k] = t;
          // the first lap of a start is not a flying lap
          if (!(e.startLap && e.marks.length === 2)) {
            const ratio = t / this.idealLap(e);
            e.paceLaps.push(ratio);
            recordPace(this.id, ratio);
          }
        }
      });
      this.rubber.update(
        DT,
        cars.map((e) => ({ car: e.car, st: e.u, lat: sampleField(track.lat, track.W, e.car.x, e.car.y) })),
      );
    }
    const dt = DT * SUBSTEPS;
    // the zone alongside (inZone, src/drivers/sensors.js: the same one the network sees)
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const [ahead, side] = this.rel(cars[i], cars[j]);
        if (inZone(ahead, side)) {
          for (const k of [i, j]) {
            cars[k].zone += dt;
            penalty[k] += ZONE_TIME * dt;
          }
        }
      }
    }
    cars.forEach((e, k) => {
      if (penalty[k]) {
        e.penalty += penalty[k];
        // the penalty as time: the distance it would cover in those seconds at the racing line's average speed
        rewards[k] -= PROGRESS_REWARD * ((track.length * M) / this.idealLap(e)) * penalty[k] * scale;
      }
      if (this.rewards.paceFloor) rewards[k] -= this.slow(e, dt) * this.rewards.paceFloor;
      if (e.partner) this.chasePass(e); // only counted, no reward
    });

    // launch: ends when the first car reaches the line, before the braking zone
    if (this.scenario === 'start' && cars.some((e) => e.dist >= e.finishDist)) this.length = this.steps + 1;
    this.steps++;
    const truncated = this.steps >= this.length;
    const results = cars.map((e, k) => {
      const car = e.car;
      if (car.onGrass) {
        e.grass += dt;
        e.grassTime += dt;
      } else e.grass = 0;
      if (Math.abs(car.speed) < 1) {
        rewards[k] -= STALL_PENALTY * dt;
        e.stuck += dt;
      } else e.stuck = 0;
      e.steps++;
      const retired = !!car.damage.retired;
      if (retired) rewards[k] -= RETIRE_PENALTY;
      const rescue = !retired && (e.grass > GRASS_LIMIT || e.stuck > STUCK_LIMIT || e.back > BACKWARDS_LIMIT);
      if (rescue) {
        rewards[k] -= RESCUE_PENALTY;
        e.rescues++;
      }
      e.ret += rewards[k];
      const info = { lap: laps[k], track: this.id };
      if (truncated || retired) info.episode = this.episodeInfo(e, retired);
      return {
        obs: null,
        reward: rewards[k],
        done: retired,
        truncated: truncated && !retired,
        info,
        e,
        rescue,
        retired,
      };
    });
    // rescued cars: back on the track where they were, to one side and slowly; retired ones, repaired and with a
    // new episode (their start is no longer measured)
    for (const r of results) {
      const e = r.e;
      if (r.retired) r.obs = this.observe(e);
      if (r.rescue || r.retired) {
        const old = e.car;
        const side = (this.rand() < 0.5 ? -1 : 1) * halfWidthAt(track, e.u) * M * 0.6;
        e.car = this.place(e.u, side, 10);
        Object.assign(e.car, {
          setup: old.setup,
          wear: old.wear,
          wearRate: old.wearRate,
          ownTune: old.ownTune,
          ownAir: old.ownAir,
          damageLevel: old.damageLevel,
          damage: r.retired ? NO_DAMAGE : old.damage,
        });
        e.car.placeOn(track);
        Object.assign(e, { grass: 0, stuck: 0, back: 0, waiting: false });
        if (r.retired) {
          this.newEpisode(e);
          e.standing = e.startLap = false;
        }
      }
      if (r.retired) r.next = this.observe(e);
      else r.obs = this.observe(e);
      delete r.rescue;
      delete r.retired;
    }
    return results;
  }

  newEpisode(e) {
    super.newEpisode(e);
    // marks: when it completed each lap, counting from lapFrom (where the episode started)
    Object.assign(e, {
      penalty: 0,
      penMarks: [0],
      zone: 0,
      grassPen: 0,
      paceLaps: [],
      grassTime: 0,
      marks: [this.time],
      lapFrom: e.dist,
      passDone: false,
      passFrom: null,
      passBonus: 0,
    });
  }

  // Pass in the chase: the car behind passes the car ahead and stays ahead PASS_HOLD s without them touching. It is
  // only counted (once per pair), for reference: what is measured is the time of the car behind
  chasePass(e) {
    const p = e.partner;
    if (e.front || e.passDone) return;
    const ahead = e.offset + e.dist > p.offset + p.dist; // e: the car behind, which started without a handicap
    if (!ahead) {
      e.passFrom = null;
      return;
    }
    e.passFrom ??= this.time;
    if (Math.max(e.lastTouch, p.lastTouch) >= e.passFrom) {
      e.passFrom = this.time; // they touched: count from now
      return;
    }
    if (this.time - e.passFrom < PASS_HOLD) return;
    e.passDone = p.passDone = true;
    e.passes++;
    p.passed++;
  }

  // What is reported at the end of the episode: the measure (time: the time with penalty against the racing line's,
  // null if there was nothing to measure it with) and, for reference, the time without penalty and the penalty by
  // parts
  episodeInfo(e, retired) {
    const lapTimes = e.marks.slice(1).map((t, i) => t - e.marks[i]);
    const withPen = lapTimes.map((t, i) => t + e.penMarks[i + 1] - e.penMarks[i]);
    const mean = (xs) => (xs.length ? xs.reduce((a, x) => a + x, 0) / xs.length : null);
    const ideal = this.idealLap(e);
    let time = null;
    if (this.scenario === 'grid') {
      if (withPen.length >= 2) time = (withPen[0] + withPen[1]) / (e.startIdeal + ideal);
    } else if (this.scenario === 'start') {
      // how far it got, against the racing line from a standstill up to there (if it barely moved, there is nothing
      // to measure with)
      const at = Math.min(e.startClock.length - 1, Math.floor(e.dist / this.track.meters));
      if (e.dist > 50 && !e.rescues) time = (this.time + e.penalty) / e.startClock[at];
    } else if (this.scenario === 'flying') {
      if (withPen.length >= 1) time = withPen[0] / e.startIdeal;
    } else if (this.scenario === 'chase') {
      if (!e.front && withPen.length >= 1) time = withPen[0] / ideal;
    } else if (withPen.length) time = mean(withPen) / ideal;
    // for reference: lap 1 of a start against the racing line starting the same way and, on the grid, lap 2 (without
    // penalty)
    const launch = e.startLap && lapTimes.length >= 1 ? lapTimes[0] / e.startIdeal : null;
    const lap2 = e.standing && lapTimes.length >= 2 ? lapTimes[1] / ideal : null;
    return {
      r: e.ret,
      l: e.steps,
      dist: e.epDist,
      track: this.id,
      scenario: this.scenario,
      damage: this.damage,
      retired,
      hits: e.hits,
      penalty: e.penalty,
      zone: e.zone,
      grassPen: e.grassPen,
      laps: e.epDist / (this.track.length * this.track.meters),
      passes: e.passes,
      front: e.front,
      rescues: e.rescues,
      danger: e.danger,
      grass: e.grassTime,
      pace: mean(e.paceLaps),
      paceLaps: e.paceLaps.length,
      time,
      launch,
      lap2,
    };
  }
}

const clamp = (v) => Math.max(-1, Math.min(1, Number.isFinite(v) ? v : 0));
