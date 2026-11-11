// Phases 2 to 4: races with several cars. Some cars learn (the "agents", all with the same network: it competes
// against itself) and the others are opponents that don't learn: the classic AI (ai.js) at different paces or
// already trained networks (earlier versions).
//
// Each race is a scenario (rl/CURRICULUM.md), picked at random according to the phase's mix:
//   solo     agents spread around the track, without opponents (a review of phase 1)
//   pack     groups of 2 or 3 cars arriving together at a corner: brake without taking anyone out
//   start    start with many cars, shortly before a corner: get through it without crashing
//   chase    a slower opponent ahead (and sometimes another agent behind), on a straight or before a corner: pass it
//   race     full race: standing start or in single file, with all kinds of opponents (consolidate)
// The short scenarios last a few seconds: many more attempts per hour in the situations that matter.
//
// Reward of each agent (the same in every scenario, so what is learned in one applies to the others):
//   + meters advanced (they don't count on the grass); - grass, wall, standing still, needing to be rescued
//   - contact with another car, according to its strength; much more if it caused it (hit the car ahead or squeezed
//     the car alongside)
//   - danger: if at the rate it is closing it would catch the car ahead (or alongside) in less than TTC seconds
//     (it penalizes danger, not closeness: following close at the same speed, in the slipstream, is fine)
//   + clean pass: passes a nearby car and stays ahead PASS_HOLD seconds, without touching anyone or going on the
//     grass in that time, and with no more than 2 cars around (in a pack the priority is not crashing)
//   - being passed cleanly (much less: defending yes, but never at the cost of a contact)
//   - weaving while defending: on a straight with someone right behind, changing direction more than once
//   - driving slowly with a clear track (pace floor, if the phase uses it)
//   - slow start: losing more than allowed on the first lap from a standstill (launch, if the phase uses it)
//
// Each phase can scale parts of the reward (rewards: progress, pass, paceFloor, paceAlways, paceCrowd, crowd) and
// the penalty for a caused contact is multiplied by contactScale, which training adjusts on its own according to a
// contact budget (rl/train.py). progress (from 0 to 1, how far along the phase is) shrinks the opponent's handicap
// in the chase. boost makes the opponents faster (see the constructor).
//
// Each car is a little different (engine, top speed, grip, brakes, wear: ± spread) and the tyres may be worn; the
// network receives this as inputs. With different cars, passing and defending appear on their own.
//
// If an agent gets stuck on the grass, stands still or goes backwards, it is put back on the track right there with
// a penalty; the race goes on. When the scenario's time runs out the race ends for everyone.
//
// Damage (damage): 'off', 'reduced', 'real' or 'mix' (each scenario with one of the three at random), for every car
// in the race. With damagedStarts, that share of the agents starts with something broken (damage.js: randomDamage),
// so it learns to drive a broken car. If an agent retires, its episode ends with a penalty (and it earns nothing
// more: it lost the rest of the race) and it goes back on the track with the car repaired; opponents that retire
// leave the track once they have stopped.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Driver } from '../src/drivers/ai.js';
import { Car, DEFAULT_PROFILE, limitsOn, RIVAL_AIDS, SAME_SETUP } from '../src/sim/car.js';
import { stepCars } from '../src/sim/traffic.js';
import { NeuralDriver, Policy } from '../src/drivers/policy.js';
import { racingLine } from '../src/sim/racingline.js';
import { ACTIONS, OBS_SIZE, observe, stationAt, trackHeading } from '../src/drivers/sensors.js';
import { halfWidthAt, sampleField } from '../src/sim/track.js';
import { pointOnCenter, randomSetup, randomTune, randomTyres, rng, TUNE_SPREAD } from './env.js';
import { NO_DAMAGE, randomDamage } from '../src/sim/damage.js';
import { loadTrack } from './tracks.js';

const DT = 1 / 60;
const SUBSTEPS = 3;
const PROGRESS_REWARD = 0.02;
const GRASS_PENALTY = 0.1;
const WALL_PENALTY = 1;
const CAR_PENALTY = 6; // for a full-strength contact with another car, if it hit the car ahead
const CAR_PENALTY_HIT = 0.25; // fraction if it was hit (always some fault: don't go where there is no room)
const TTC = 1; // s: time to catch the car ahead below which there is danger
const TTC_SIDE = 1; // s: the same with the car alongside (with less, it swerves sideways and squeezes it)
// per decision, with the crash imminent (proportional to how close it is). At most 0.6 per second: less than what
// advancing at cornering pace gives, so lifting with someone nearby never pays more than racing on
const DANGER_PENALTY = 0.03;
const ALONGSIDE = 5.5; // m ahead or behind: up to here a car is "alongside"
const CAR_WIDTH = 2; // m between centers below which two cars side by side touch
const SQUEEZE_SPEED = 0.5; // m/s sideways toward the other car: from here on, a side contact is its fault
const PASS_REWARD = 1; // per clean pass
const PASSED_PENALTY = 0.3; // for being passed cleanly
const PASS_GAP = 30; // m: only order changes between nearby cars count
const PASS_HOLD = 2.5; // s it has to stay ahead for the pass to count
const PASS_CLEAN = 2; // s before the pass without contacts or grass
const CROWD_RANGE = 50,
  CROWD_MAX = 2; // with more than 2 cars within 50 m, passing earns nothing
const WEAVE_PENALTY = 0.5; // for each extra change of direction while defending on a straight
const WEAVE_MOVE = 1.5; // m sideways: from here on it counts as a move
// Stuck, on the grass or going backwards for too long: it is put back on the track (like the game's rescue) with a
// penalty, but the episode goes on. If it ended, standing still would be a cheap way out of a pile-up: the network
// would avoid the contacts and danger that were coming, and learn to brake instead of getting out of there
const GRASS_LIMIT = 6,
  STUCK_LIMIT = 6,
  BACKWARDS_LIMIT = 30,
  RESCUE_PENALTY = 4;
const STALL_PENALTY = 1; // per second almost standing still
const RETIRE_PENALTY = 10; // for retiring
const DAMAGE_LEVELS = ['off', 'reduced', 'real'];
// Pace floor: with a clear track ahead, going below PACE_FLOOR of the racing line speed is penalized (up to
// PACE_PENALTY per second, proportional to the shortfall). That way braking is never "safe" without a reason; with
// someone ahead it does not apply, because following a slower car is fine
const PACE_FLOOR = 0.75,
  PACE_PENALTY = 1,
  FREE_ROAD = 40;
// With paceAlways the floor also counts with someone ahead (staying behind a slow car costs: it has to be passed),
// except in a pile-up: more than CROWD_CLOSE cars within CROWD_NEAR m (starts, packs). There, with crowd, a caused
// contact costs crowd times more and danger is checked TTC_CROWD times further ahead
const CROWD_NEAR = 30,
  CROWD_CLOSE = 3,
  TTC_CROWD = 1.5;
// With paceCrowd (a fraction, like PACE_FLOOR) the floor also counts in a pile-up, but lower: at a start, getting
// into single file by lifting costs time, so if there is room it pays to keep running side by side
// Start (launch): from a standstill, what the first lap loses against its flying lap pace. LAUNCH_START s are
// allowed for getting off the line plus LAUNCH_LAP s spread over the lap: what phase 2 of v6 lost (the first lap
// 7.5 to 10 s slower than the best), before it learned to avoid crashing by forming a line. Beyond that, each extra
// second costs LAUNCH_PENALTY, and more the more it has lost (×2 at LAUNCH_SCALE s over): losing a little is
// acceptable, a lot is not. To avoid penalizing what going slower already costs, the flying lap pace is that of the
// agents' recent laps on that track (LAUNCH_PACE: the fastest quartile of the latest ones)
const LAUNCH_START = 5,
  LAUNCH_LAP = 10,
  LAUNCH_PENALTY = 2,
  LAUNCH_SCALE = 3;
const LAUNCH_PACE = { laps: 60, min: 8, quantile: 0.25, initial: 1.08 };
// Chase: handicap of the opponent ahead (less grip and engine) at the start and at the end of the phase
const CHASE_HANDICAP = [0.2, 0.08];

// scenarios: length (decisions, at 20 per second)
export const SCENARIOS = { solo: 2400, pack: 300, start: 500, chase: 600, race: 2400 };

// recent flying laps of the agents per track, as a fraction of the racing line lap for their car
const paces = new Map();
export function recordPace(id, ratio) {
  if (!paces.has(id)) paces.set(id, []);
  const xs = paces.get(id);
  xs.push(ratio);
  if (xs.length > LAUNCH_PACE.laps) xs.shift();
}
function paceOf(id) {
  const xs = paces.get(id);
  if (!xs || xs.length < LAUNCH_PACE.min) return LAUNCH_PACE.initial;
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.floor(LAUNCH_PACE.quantile * (sorted.length - 1))];
}

let profile = DEFAULT_PROFILE;
try {
  profile = JSON.parse(readFileSync(fileURLToPath(new URL('../cars/f1-2025.json', import.meta.url)), 'utf8'));
} catch {
  // without the measured profile, the default one
}

// track, racing line and where the corners are (the slowest point of each one, in cells)
const tracks = new Map();
export function getTrack(id) {
  if (!tracks.has(id)) {
    const track = loadTrack(id);
    const line = racingLine(track, limitsOn(profile, track), { brakeUse: 0.93 });
    // seconds to each cell going at the racing line speed (to measure what is lost at the start)
    const clock = new Float64Array(line.speed.length + 1);
    line.speed.forEach((v, i) => (clock[i + 1] = clock[i] + track.meters / Math.max(1, v)));
    tracks.set(id, { track, line, clock, corners: corners(track, line) });
  }
  return tracks.get(id);
}

function corners(track, line) {
  const v = line.speed,
    n = v.length,
    M = track.meters;
  const near = Math.round(100 / M),
    far = Math.round(300 / M);
  const at = (i) => v[((i % n) + n) % n];
  const out = [];
  for (let i = 0; i < n; i++) {
    let min = true,
      top = 0;
    for (let d = -far; d <= far && min; d++) {
      if (Math.abs(d) <= near && at(i + d) < v[i]) min = false;
      top = Math.max(top, at(i + d));
    }
    if (min && v[i] < 0.85 * top && !out.some((u) => Math.abs(u - i) < near)) out.push(i);
  }
  return out;
}

const policies = new Map();
function getPolicy(file) {
  if (!policies.has(file)) {
    policies.set(
      file,
      new Policy(JSON.parse(readFileSync(fileURLToPath(new URL('../' + file, import.meta.url)), 'utf8'))),
    );
  }
  return policies.get(file);
}

export const wrap = (d, L) => (((d % L) + 1.5 * L) % L) - L / 2; // position difference in the lap, between -L/2 and L/2
export const mod = (u, L) => ((u % L) + L) % L;

export class RaceSim {
  // agents: how many cars learn; opponents: networks that drive some opponents; mix: weight of each scenario
  // (in training steps, not in races); spread: car variation (raceSpread in a full race)
  constructor({
    trackIds,
    agents = 4,
    seed = 1,
    opponents = [],
    mix = { race: 1 },
    spread = 0.02,
    raceSpread = spread,
    rewards = {},
    contactScale = 1,
    progress = 0,
    boost = 0,
    damage = 'off',
    damagedStarts = 0,
    tuneSpread = TUNE_SPREAD,
  }) {
    this.tuneSpread = tuneSpread;
    this.damage = damage;
    this.damagedStarts = damagedStarts;
    // boost: opponents with that fraction more grip and power, and the classic AI at a higher pace (from 1 to 1.1):
    // to keep improving the pace behind cars faster than itself
    this.boost = boost;
    this.rewards = { progress: 1, pass: 1, paceFloor: 0, paceAlways: 0, paceCrowd: 0, crowd: 1, launch: 0, ...rewards };
    this.contactScale = contactScale;
    this.progress = progress;
    this.trackIds = trackIds;
    this.agents = agents;
    this.rand = rng(seed);
    this.opponents = opponents.map(getPolicy);
    this.spread = spread;
    this.raceSpread = raceSpread;
    // each scenario is picked by its weight divided by its length: that way the weight is the share of steps
    this.mix = Object.entries(mix)
      .filter(([, w]) => w > 0)
      .map(([k, w]) => [k, w / SCENARIOS[k]]);
    this.mixTotal = this.mix.reduce((a, [, w]) => a + w, 0);
  }

  pickScenario() {
    let x = this.rand() * this.mixTotal;
    for (const [k, w] of this.mix) if ((x -= w) <= 0) return k;
    return this.mix[this.mix.length - 1][0];
  }

  // Places a car at position u of the lap (cells), shifted side meters to the right of the centerline
  place(u, side, speed) {
    const { track } = this;
    u = mod(u, track.length);
    const h = trackHeading(track, u);
    const { x, y } = pointOnCenter(track, u);
    const s = side / track.meters;
    // with the game's driving aids
    const car = Object.assign(new Car(x - Math.sin(h) * s, y + Math.cos(h) * s, h, profile), RIVAL_AIDS);
    car.speed = speed;
    while (car.gear < car.gears && car.rpmAt(speed, car.gear) > profile.upshiftRpm) car.gear++;
    car.rpm = Math.max(4000, car.rpmAt(speed, car.gear));
    car.throttle = speed ? 0.5 : 1;
    if (!speed) car.launch();
    return car;
  }

  lineSpeed(u) {
    const v = this.line.speed;
    return v[Math.floor(mod(u, this.track.length)) % v.length];
  }

  // classic AI opponent (pace: fraction of the racing line) or, sometimes, an already trained network
  bot(k, pace = this.boost ? 1 + 0.1 * this.rand() : 0.9 + 0.18 * this.rand(), neural = 0) {
    if (this.opponents.length && this.rand() < neural)
      return new NeuralDriver(this.opponents[Math.floor(this.rand() * this.opponents.length)]);
    return new Driver(pace, k + 1);
  }

  reset() {
    const r = this.rand;
    const id = this.trackIds[Math.floor(r() * this.trackIds.length)];
    const { track, line, clock, corners } = getTrack(id);
    const scenario = this.pickScenario();
    const damage = this.damage === 'mix' ? DAMAGE_LEVELS[Math.floor(r() * 3)] : this.damage;
    Object.assign(this, {
      id,
      track,
      line,
      clock,
      corners,
      scenario,
      damage,
      steps: 0,
      time: 0,
      length: SCENARIOS[scenario],
    });
    const L = track.length,
      M = track.meters,
      half = track.halfWidth * M;
    const corner = () => (corners.length ? corners[Math.floor(r() * corners.length)] : r() * L);
    const spread = scenario === 'race' ? this.raceSpread : this.spread;
    const spots = []; // { kind, u, side (m), v (m/s), driver? }
    const agent = (u, side, v) => spots.push({ kind: 'agent', u, side, v });
    const bot = (u, side, v, driver) => spots.push({ kind: 'bot', u, side, v, driver });
    const A = this.agents;

    if (scenario === 'solo') {
      const front = r() * L;
      for (let k = 0; k < A; k++) {
        const u = front + (k * L) / A;
        agent(u, (r() - 0.5) * half, r() * 0.8 * this.lineSpeed(u));
      }
    } else if (scenario === 'pack') {
      // two agents (and sometimes an opponent) per corner, 150-350 m from the braking zone, side by side or one
      // behind the other
      const used = [];
      for (let k = 0; k < A; k += 2) {
        let c = corner();
        for (let t = 0; t < 5 && used.some((x) => Math.abs(wrap(x - c, L)) * M < 400); t++) c = corner();
        used.push(c);
        const u0 = c - (150 + 200 * r()) / M;
        const v = (0.85 + 0.15 * r()) * this.lineSpeed(u0);
        const group = Math.min(2, A - k) + (r() < 0.5 ? 1 : 0);
        const abreast = r() < 0.5; // the first two side by side; otherwise, one behind the other
        let back = 0;
        for (let j = 0; j < group; j++) {
          const side = abreast && j < 2 ? (j % 2 ? -1 : 1) * Math.min(2.2, half * 0.4) : (r() - 0.5) * half * 0.6;
          if (j > 0 && !(abreast && j === 1)) back += 6 + 9 * r();
          const u = u0 - back / M;
          const speed = v * (0.97 + 0.06 * r());
          if (j < Math.min(2, A - k)) agent(u, side, speed);
          else bot(u, side, speed, this.bot(spots.length));
        }
      }
    } else if (scenario === 'start') {
      // grid of 12 to 20 cars, 250-500 m before a corner; the agents in random places
      const total = A + 8 + Math.floor(r() * 9);
      const kinds = [...Array(A).fill('agent'), ...Array(total - A).fill('bot')];
      for (let i = kinds.length - 1; i > 0; i--) {
        const j = Math.floor(r() * (i + 1));
        [kinds[i], kinds[j]] = [kinds[j], kinds[i]];
      }
      const front = corner() - (250 + 250 * r()) / M;
      kinds.forEach((kind, k) => {
        const u = front - (k * 8) / M,
          side = (k % 2 ? -1 : 1) * Math.min(3, half * 0.5);
        if (kind === 'agent') agent(u, side, 0);
        else bot(u, side, 0, this.bot(k, undefined, 0.4));
      });
    } else if (scenario === 'chase') {
      // a slow opponent ahead; one or two agents behind. On a straight (coming out of a corner) or before a corner
      const used = [];
      for (let k = 0; k < A;) {
        const two = A - k >= 2 && r() < 0.5;
        const straight = r() < 0.5;
        let c = corner();
        for (let t = 0; t < 5 && used.some((x) => Math.abs(wrap(x - c, L)) * M < 400); t++) c = corner();
        used.push(c);
        const u0 = straight ? c + (20 + 40 * r()) / M : c - (150 + 150 * r()) / M;
        const v = (straight ? 0.9 : 0.8 + 0.15 * r()) * this.lineSpeed(u0);
        // slower: less grip, engine, brakes and top speed, a handicap that shrinks over the phase (first easy passes,
        // with plenty of room; at the end, tighter ones). It drives at its own pace with that car
        const [h0, h1] = CHASE_HANDICAP;
        const h = (h0 + (h1 - h0) * Math.min(1, this.progress)) * (0.75 + 0.5 * r());
        const setup = { ...SAME_SETUP, grip: 1 - h, power: 1 - h, brakes: 1 - h / 2, topSpeed: 1 - h / 3 };
        const slow = this.bot(spots.length, 0.93 + 0.04 * r());
        bot(u0, (r() - 0.5) * half * 0.5, v * (1 - h / 2), slow);
        spots[spots.length - 1].setup = setup;
        let gap = (straight ? 10 + 20 * r() : 12 + 25 * r()) / M;
        for (let j = 0; j < (two ? 2 : 1); j++) {
          agent(u0 - gap, (r() - 0.5) * half * 0.6, v * (1 + 0.05 * r()));
          gap += (10 + 15 * r()) / M;
        }
        k += two ? 2 : 1;
      }
    } else {
      // full race: grid or single file, with 0 to 14 opponents of all kinds
      const total = A + Math.floor(r() * 15);
      const kinds = [...Array(A).fill('agent'), ...Array(total - A).fill('bot')];
      for (let i = kinds.length - 1; i > 0; i--) {
        const j = Math.floor(r() * (i + 1));
        [kinds[i], kinds[j]] = [kinds[j], kinds[i]];
      }
      const grid = r() < 0.5;
      let u = r() * L;
      kinds.forEach((kind, k) => {
        const side = grid ? (k % 2 ? -1 : 1) * Math.min(3, half * 0.5) : (r() - 0.5) * half;
        const v = grid ? 0 : (0.5 + 0.4 * r()) * this.lineSpeed(u);
        if (kind === 'agent') agent(u, side, v);
        else bot(u, side, v, this.bot(k, undefined, 0.4));
        u -= (grid ? 8 : 8 + r() * 35) / M;
      });
    }

    const front = Math.max(...spots.map((s) => s.u));
    this.cars = spots.map((s) => {
      const car = this.place(s.u, s.side, s.v);
      car.setup = s.setup ?? randomSetup(r, spread);
      // faster opponents (except those that bring their own car, like the car ahead in chases)
      if (s.kind === 'bot' && !s.setup && this.boost) {
        car.setup = {
          ...car.setup,
          grip: car.setup.grip * (1 + this.boost),
          power: car.setup.power * (1 + this.boost),
        };
      }
      // setup and air vary only for the learners: the others drive for the track's setup
      if (s.kind === 'agent') randomTune(car, r, track, this.tuneSpread);
      else car.placeOn(track);
      randomTyres(car, r, track);
      car.damageLevel = damage;
      if (s.kind === 'agent' && damage !== 'off' && r() < this.damagedStarts) car.damage = randomDamage(r, damage);
      const e = {
        kind: s.kind,
        car,
        u: stationAt(track, car.x, car.y),
        start: wrap(s.u - front, L) * M,
        dist: 0,
        lastHit: -1e9,
        lastGrass: -1e9,
      };
      if (s.kind === 'bot') {
        e.driver = s.driver;
        // the classic AI doesn't know about its car: with less grip, less pace (cornering speed goes with its root)
        if (e.driver.pace) e.driver.pace *= Math.sqrt(Math.min(1, car.setup.grip));
      } else {
        this.newEpisode(e);
        // standing start: measure how much time it loses on the first lap against the racing line
        if (!s.v) e.launch = { from: e.dist, clock: this.launchClock(car, e.u), worst: 0 };
      }
      return e;
    });
    this.agentsList = this.cars.filter((e) => e.kind === 'agent');
    this.ahead = new Map(); // "i,j" → whether i was ahead of j
    this.pending = []; // passes to confirm: { passer, passed, t, clean }
    return this.agentsList.map((e) => this.observe(e));
  }

  newEpisode(e) {
    Object.assign(e, {
      grass: 0,
      stuck: 0,
      back: 0,
      ret: 0,
      steps: 0,
      lapStart: null,
      epDist: 0,
      lag: 0,
      lagRef: 0,
      launchCost: 0,
      passes: 0,
      passed: 0,
      hits: 0,
      faults: 0,
      slow: 0,
      danger: 0,
      weaves: 0,
      rescues: 0,
      defDir: 0,
      moves: 0,
      behind: 0,
      ext: undefined,
    });
  }

  observe(e) {
    return observe(
      this.track,
      e.car,
      e.u,
      this.cars.map((o) => o.car),
      new Float32Array(OBS_SIZE),
    );
  }

  raceDist(e) {
    return e.start + e.dist;
  }

  // o in e's frame: [ahead, to the right] (m)
  rel(e, o) {
    const M = this.track.meters,
      { car } = e;
    const ca = Math.cos(car.angle),
      sa = Math.sin(car.angle);
    const dx = (o.car.x - car.x) * M,
      dy = (o.car.y - car.y) * M;
    return [dx * ca + dy * sa, -dx * sa + dy * ca];
  }

  // actions: [steering, pedal] of each agent, in order. Returns one result per agent, like RaceEnv.step
  step(actions) {
    const { track, line, cars } = this;
    const L = track.length,
      M = track.meters;
    const all = cars.map((e) => e.car);
    const rewards = new Float32Array(this.agentsList.length);
    const laps = this.agentsList.map(() => null);
    this.agentsList.forEach((e, k) => {
      const steer = clamp(actions[ACTIONS * k]),
        pedal = clamp(actions[ACTIONS * k + 1]);
      e.input = { steer, throttle: Math.max(0, pedal), brake: Math.max(0, -pedal) };
    });
    const states = cars.map((e) => ({ car: e.car, st: e.u, lat: sampleField(track.lat, track.W, e.car.x, e.car.y) }));
    for (let s = 0; s < SUBSTEPS; s++) {
      const { wall, hit } = stepCars(track, all, DT, (i) =>
        cars[i].kind === 'agent'
          ? cars[i].input
          : cars[i].driver.drive(
              DT,
              track,
              line,
              states[i],
              states.filter((_, j) => j !== i),
            ),
      );
      this.time += DT;
      cars.forEach((e, i) => {
        const k = this.agentsList.indexOf(e);
        const carHit = hit[i];
        if (carHit) e.lastHit = this.time;
        if (e.car.onGrass) e.lastGrass = this.time;
        if (k >= 0) {
          rewards[k] -= WALL_PENALTY * wall[i];
          if (carHit) {
            const fault = this.hitAhead(e) || this.squeezed(e);
            const crowd = this.crowded(e) ? this.rewards.crowd : 1;
            rewards[k] -= CAR_PENALTY * carHit * (fault ? this.contactScale * crowd : CAR_PENALTY_HIT);
            e.hits++;
            if (fault) e.faults++;
          }
        }
        // progress along the centerline
        const u = stationAt(track, e.car.x, e.car.y);
        if (u < 0) return;
        let du = u - e.u;
        if (du < -L / 2) {
          du += L;
          if (k >= 0) {
            if (e.lapStart !== null) {
              laps[k] = this.time - e.lapStart;
              recordPace(this.id, laps[k] / this.idealLap(e));
            }
            e.lapStart = this.time;
          }
        } else if (du > L / 2) {
          du -= L;
          e.lapStart = null;
        }
        e.u = u;
        const m = du * M;
        e.dist += m;
        states[i].st = u;
        states[i].lat = sampleField(track.lat, track.W, e.car.x, e.car.y);
        if (k >= 0) {
          if (!e.car.onGrass || m < 0) rewards[k] += PROGRESS_REWARD * (m < 0 ? 1 : this.rewards.progress) * m;
          e.epDist += m;
          e.back = m < 0 ? e.back - m : Math.max(0, e.back - m);
        }
      });
    }
    const dt = DT * SUBSTEPS;
    this.passes(rewards);
    this.agentsList.forEach((e, k) => {
      rewards[k] -= this.lag(e);
      rewards[k] -= this.danger(e, dt);
      rewards[k] -= this.weave(e, dt);
      if (this.rewards.paceFloor) rewards[k] -= this.slow(e, dt);
    });

    this.steps++;
    const truncated = this.steps >= this.length;
    const results = this.agentsList.map((e, k) => {
      const car = e.car;
      if (car.onGrass) {
        rewards[k] -= GRASS_PENALTY;
        e.grass += dt;
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
      if (truncated || retired) {
        info.episode = {
          r: e.ret,
          l: e.steps,
          dist: e.epDist,
          track: this.id,
          scenario: this.scenario,
          damage: this.damage,
          retired,
          passes: e.passes,
          passed: e.passed,
          hits: e.hits,
          faults: e.faults,
          slow: e.slow,
          lag: e.lag,
          lagRef: e.lagRef,
          launchCost: e.launchCost,
          danger: e.danger,
          weaves: e.weaves,
          rescues: e.rescues,
        };
      }
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
    // rescued cars go back on the track where they were, to one side and slowly, without ending the episode (with
    // their car as it was); retired ones, the same but repaired and with a new episode
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
        Object.assign(e, { grass: 0, stuck: 0, back: 0, launch: null });
        if (r.retired) this.newEpisode(e);
      }
      if (r.retired) r.next = this.observe(e);
      else r.obs = this.observe(e);
      delete r.rescue;
      delete r.retired;
    }
    // opponents that retired and have stopped leave the race (and the passes to confirm)
    if (this.cars.some((e) => e.car.gone)) {
      this.cars = this.cars.filter((e) => !e.car.gone);
      this.ahead = new Map();
      this.pending = this.pending.filter((p) => !p.passer.car.gone && !p.passed.car.gone);
    }
    return results;
  }

  // Passes between nearby cars (at least one an agent). An order change stays pending for PASS_HOLD seconds;
  // if it holds, it counts: reward for the passer and penalty for the passed car, only if it was clean
  passes(rewards) {
    const { cars, time } = this;
    const reward = (e, x) => {
      const k = this.agentsList.indexOf(e);
      if (k >= 0) rewards[k] += x;
    };
    for (let i = 0; i < cars.length; i++) {
      for (let j = i + 1; j < cars.length; j++) {
        const a = cars[i],
          b = cars[j];
        if (a.kind !== 'agent' && b.kind !== 'agent') continue;
        const gap = this.raceDist(a) - this.raceDist(b);
        const key = `${i},${j}`,
          was = this.ahead.get(key),
          now = gap > 0;
        this.ahead.set(key, now);
        if (was === undefined || was === now || Math.abs(gap) > PASS_GAP) continue;
        const [passer, passed] = now ? [a, b] : [b, a];
        // if it was a pending pass the other way, it is undone
        const back = this.pending.findIndex((p) => p.passer === passed && p.passed === passer);
        if (back >= 0) {
          this.pending.splice(back, 1);
          continue;
        }
        const crowd = cars.filter((o) => o !== passer && Math.hypot(...this.rel(passer, o)) < CROWD_RANGE).length;
        this.pending.push({
          passer,
          passed,
          t: time,
          clean: crowd <= CROWD_MAX && time - passer.lastHit > PASS_CLEAN && time - passer.lastGrass > PASS_CLEAN,
        });
      }
    }
    this.pending = this.pending.filter((p) => {
      if (time - p.t < PASS_HOLD) return true;
      // in the time that followed it also must not have touched anyone or gone onto the grass
      if (p.clean && p.passer.lastHit < p.t && p.passer.lastGrass < p.t) {
        reward(p.passer, PASS_REWARD * this.rewards.pass);
        reward(p.passed, -PASSED_PENALTY * this.rewards.pass);
        if (p.passer.kind === 'agent') p.passer.passes++;
        if (p.passed.kind === 'agent') p.passed.passed++;
      }
      return false;
    });
  }

  // Danger: the car ahead in its lane, if at the rate it is closing it catches it in less than TTC
  danger(e, dt) {
    let worst = 0;
    const look = this.rewards.crowd > 1 && this.crowded(e) ? TTC_CROWD : 1;
    const TTC_AHEAD = TTC * look,
      TTC_LAT = TTC_SIDE * look;
    const { car } = e;
    const ca = Math.cos(car.angle),
      sa = Math.sin(car.angle);
    const vx = ca * car.speed - sa * car.slip,
      vy = sa * car.speed + ca * car.slip;
    for (const o of this.cars) {
      if (o === e) continue;
      const [fwd, side] = this.rel(e, o);
      if (fwd <= 0 || fwd > 40 || Math.abs(side) > 2.2) continue;
      const oc = Math.cos(o.car.angle),
        os = Math.sin(o.car.angle);
      const ovx = oc * o.car.speed - os * o.car.slip,
        ovy = os * o.car.speed + oc * o.car.slip;
      const closing = (vx - ovx) * ca + (vy - ovy) * sa;
      if (closing <= 0) continue;
      const ttc = Math.max(0, fwd - 5) / closing; // 5 m: the length of a car
      if (ttc < TTC_AHEAD) worst = Math.max(worst, 1 - ttc / TTC_AHEAD);
    }
    // sideways: the car alongside, if it moves into it and at that rate touches it in less than TTC_SIDE
    for (const o of this.cars) {
      if (o === e) continue;
      const [fwd, side] = this.rel(e, o);
      if (Math.abs(fwd) > ALONGSIDE || Math.abs(side) > 4) continue;
      const toward = this.lateralToward(e, o);
      if (toward <= 0) continue;
      const ttc = Math.max(0, Math.abs(side) - CAR_WIDTH) / toward;
      if (ttc < TTC_LAT) worst = Math.max(worst, 1 - ttc / TTC_LAT);
    }
    if (worst > 0) e.danger += dt;
    return DANGER_PENALTY * worst;
  }

  // Seconds to each cell of the lap starting from u at a standstill (or at v0 m/s): the racing line for that car
  // (slower with less grip, as in the pace floor), but accelerating from v0 with what its engine gives
  launchClock(car, u, v0 = 0) {
    const { track } = this,
      L = track.length,
      M = track.meters,
      n = this.line.speed.length;
    const g = Math.sqrt(Math.min(1, car.setup.grip)),
      lim = car.limits;
    const clock = new Float32Array(L + 1);
    let v = v0;
    for (let i = 0; i < L; i++) {
      const cap = this.line.speed[(Math.floor(mod(u, L)) + i + 1) % n] * g;
      const next = Math.min(cap, Math.sqrt(v * v + 2 * Math.max(0, lim.accel(v)) * M));
      clock[i + 1] = clock[i] + (2 * M) / Math.max(1, v + next);
      v = next;
    }
    return clock;
  }

  // racing line lap for e's car (s; with less grip, slower, as in the pace floor)
  idealLap(e) {
    return this.clock[this.clock.length - 1] / Math.sqrt(Math.min(1, e.car.setup.grip));
  }

  // Start: what it loses on the first lap from a standstill (lag, s) against its flying lap pace on that track
  // (lagRef: the seconds of racing line it has covered, for its car). It stops being measured when the lap is
  // completed or if it is rescued. Returns the penalty (with launch) for what it loses beyond the allowance (see
  // LAUNCH_START)
  lag(e) {
    const { launch } = e;
    if (!launch) return 0;
    const L = this.track.length,
      M = this.track.meters;
    const d = e.dist - launch.from;
    if (d >= L * M) {
      e.launch = null;
      return 0;
    }
    const lap = this.idealLap(e);
    e.lagRef = launch.clock[Math.max(0, Math.floor(d / M))];
    e.lag = this.time - e.lagRef * paceOf(this.id);
    if (!this.rewards.launch) return 0;
    const excess = e.lag - LAUNCH_START - (LAUNCH_LAP * e.lagRef) / lap;
    if (excess <= launch.worst) return 0;
    const more = excess - Math.max(0, launch.worst);
    launch.worst = excess;
    if (excess <= 0) return 0;
    const cost = this.rewards.launch * LAUNCH_PENALTY * more * (1 + excess / LAUNCH_SCALE);
    e.launchCost += cost;
    return cost;
  }

  // Pace floor: with nobody ahead in its lane within FREE_ROAD meters (or always, with paceAlways, except in a
  // pile-up), below PACE_FLOOR of the racing line speed for its car it pays in proportion to the shortfall
  slow(e, dt) {
    const crowded = this.rewards.paceAlways && this.crowded(e);
    const free = this.rewards.paceAlways
      ? !crowded || this.rewards.paceCrowd > 0
      : !this.cars.some((o) => {
          if (o === e) return false;
          const [fwd, side] = this.rel(e, o);
          return fwd > 0 && fwd < FREE_ROAD && Math.abs(side) < 4;
        });
    const level = crowded ? this.rewards.paceCrowd : PACE_FLOOR;
    const floor = level * this.lineSpeed(e.u) * Math.sqrt(Math.min(1, e.car.setup.grip));
    if (!free || e.car.speed >= floor) return 0;
    e.slow += dt;
    return PACE_PENALTY * dt * (1 - Math.max(0, e.car.speed) / floor);
  }

  // Weaving while defending: on a straight, with a car right behind, the first move is allowed and so is moving
  // back; changing direction again is penalized. With nobody behind the count resets; in a pack it does not apply
  weave(e, dt) {
    const { track } = this,
      M = track.meters;
    const behind = this.cars.some((o) => {
      if (o === e) return false;
      const [fwd, side] = this.rel(e, o);
      return fwd < -2 && fwd > -25 && Math.abs(side) < 4;
    });
    e.behind = behind ? 0 : e.behind + dt;
    if (e.behind > 2) {
      e.defDir = 0;
      e.moves = 0;
    }
    // lateral position on the track (m); ext: how far it went in the last move
    const lat = sampleField(track.lat, track.W, e.car.x, e.car.y) * M;
    // straight: the track heading barely changes 50 m before and 100 m after
    const h = (d) => trackHeading(track, e.u + d / M);
    const turn = (a, b) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
    // in a pack (more than 2 cars nearby) swerving is the right thing: the rule is for duels
    const crowd = this.cars.filter((o) => o !== e && Math.hypot(...this.rel(e, o)) < CROWD_RANGE).length;
    if (!behind || crowd > CROWD_MAX || turn(h(-50), h(0)) > 0.15 || turn(h(0), h(100)) > 0.15) {
      e.ext = lat;
      return 0;
    }
    e.ext ??= lat;
    const d = lat - e.ext;
    if (e.defDir === 0) {
      // first move: allowed
      if (Math.abs(d) > WEAVE_MOVE) [e.defDir, e.ext] = [Math.sign(d), lat];
      return 0;
    }
    if (d * e.defDir > 0) {
      e.ext = lat; // keeps going the same way
      return 0;
    }
    if (-d * e.defDir < WEAVE_MOVE) return 0;
    // changed direction: going back to the racing line is allowed once; the next one is already weaving
    [e.defDir, e.ext] = [-e.defDir, lat];
    if (++e.moves < 2) return 0;
    e.weaves++;
    return WEAVE_PENALTY;
  }

  // e's sideways speed (relative to the track) toward o (m/s): positive if it is moving into it
  lateralToward(e, o) {
    const { track } = this,
      M = track.meters;
    const h = trackHeading(track, e.u);
    const nx = -Math.sin(h),
      ny = Math.cos(h);
    const lat = (c) => {
      const ca = Math.cos(c.angle),
        sa = Math.sin(c.angle);
      return (ca * c.speed - sa * c.slip) * nx + (sa * c.speed + ca * c.slip) * ny;
    };
    const dir = Math.sign((o.car.x - e.car.x) * M * nx + (o.car.y - e.car.y) * M * ny);
    return lat(e.car) * dir;
  }

  // pile-up? more than CROWD_CLOSE cars within CROWD_NEAR meters
  crowded(e) {
    let n = 0;
    for (const o of this.cars)
      if (o !== e && Math.hypot(...this.rel(e, o)) < CROWD_NEAR && ++n > CROWD_CLOSE) return true;
    return false;
  }

  // did it squeeze a car alongside? It is its fault if it moved into it faster than the other car closed in
  squeezed(e) {
    return this.cars.some((o) => {
      if (o === e) return false;
      const [fwd, side] = this.rel(e, o);
      if (Math.abs(fwd) > ALONGSIDE || Math.abs(side) > 4) return false;
      const mine = this.lateralToward(e, o);
      return mine > SQUEEZE_SPEED && mine >= this.lateralToward(o, e);
    });
  }

  // was there a car right ahead of it (did it hit it)?
  hitAhead(e) {
    return this.cars.some((o) => {
      if (o === e) return false;
      const [fwd, side] = this.rel(e, o);
      return fwd > 0 && fwd < 7 && Math.abs(side) < 2.5;
    });
  }
}

const clamp = (v) => Math.max(-1, Math.min(1, Number.isFinite(v) ? v : 0));
