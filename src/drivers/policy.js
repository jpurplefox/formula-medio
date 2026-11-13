// The trained network (rl/): takes what the car sees (sensors.js) and returns steering and pedal.
// The weights come from rl/export.py: linear layers with tanh between them.

import { rescue } from './ai.js';
import {
  aheadFromCar,
  DAMAGE_VALUES,
  LIMIT_VALUES,
  OBS_SIZE,
  observe,
  OPPONENT_INPUT_SIZE,
  SETUP_START,
  SETUP_VALUES,
  FAR_AHEAD,
  RISK_INPUT_SIZE,
  START_INPUT_START,
  START_VALUES,
  TYRE_VALUES,
  WHEEL_VALUES,
} from './sensors.js';
import { stationAt } from '../sim/track.js';

// The network the rivals drive with in the game (rl/CURRICULUM.md). It is the only reference: the regression check,
// the calibration and rl/curriculum.sh use it too, so changing the network only takes changing it here.
export const GAME_NET = 'models/v22/fase18.json';

export class Policy {
  // opponents: whether it learned to look at the other cars (stage 2); if not, they are passed as zeros, as in training
  constructor({ obs_size, layers, opponents = false }) {
    // networks from before the track segments, the risk per rival, the tyres and fuel, the start lights, the rivals'
    // pedals, the damage, the limits (setup and air) and the per-wheel grip read only the leading part (those inputs
    // go at the end); networks from before wear and car variation, in addition, don't receive those values: they are
    // removed
    this.size = obs_size;
    const reads = [OBS_SIZE];
    for (const n of [
      FAR_AHEAD.length,
      RISK_INPUT_SIZE,
      TYRE_VALUES,
      START_VALUES,
      OPPONENT_INPUT_SIZE,
      DAMAGE_VALUES,
      LIMIT_VALUES,
      WHEEL_VALUES,
    ])
      reads.push(reads.at(-1) - n);
    this.legacy = obs_size === reads.at(-1) - SETUP_VALUES;
    if (!reads.includes(obs_size) && !this.legacy) {
      throw new Error(`The network expects ${obs_size} values and the sensors give ${OBS_SIZE}`);
    }
    this.opponents = opponents;
    // networks from before the track segments (all that don't read the whole vector) saw each point relative to the car
    this.fromCar = obs_size < OBS_SIZE;
    this.scratch = new Float32Array(OBS_SIZE);
    // whether it sees the start lights and raises and lowers the rpm itself (two more outputs): if not, it starts with
    // the revs and the reaction of the classic AI
    this.lights = obs_size >= START_INPUT_START + START_VALUES && layers.at(-1).out >= 4;
    this.layers = layers.map((l) => {
      const w = floats(l.w);
      return { w: Array.from({ length: l.out }, (_, i) => w.subarray(i * l.in, (i + 1) * l.in)), b: floats(l.b) };
    });
  }

  static async load(url) {
    return new Policy(await fetch(url).then((r) => r.json()));
  }

  // obs → [steering, pedal] and, in networks that see the start lights, [rpm up, rpm down]: all between -1 and 1
  act(obs) {
    if (this.fromCar) obs = aheadFromCar(obs, this.scratch);
    let x = obs.subarray(0, this.legacy ? this.size + SETUP_VALUES : this.size);
    if (this.legacy) {
      const y = new Float32Array(this.size);
      y.set(x.subarray(0, SETUP_START));
      y.set(x.subarray(SETUP_START + SETUP_VALUES), SETUP_START);
      x = y;
    }
    this.layers.forEach(({ w, b }, k) => {
      const y = new Float32Array(b.length);
      for (let i = 0; i < b.length; i++) {
        const row = w[i];
        let s = b[i];
        for (let j = 0; j < row.length; j++) s += row[j] * x[j];
        y[i] = k < this.layers.length - 1 ? Math.tanh(s) : Math.max(-1, Math.min(1, s));
      }
      x = y;
    });
    return x;
  }
}

// float32 in base64 (as rl/export.py writes them)
function floats(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Float32Array(bytes.buffer);
}

// Network driver: decides 20 times per second (as in training) and holds the controls in between
const DECISION_DT = 1 / 20;
const STUCK_TIME = 3; // s almost still until it is rescued
const GRASS_TIME = 6; // s in a row on the grass until it is rescued (as in training)

export class NeuralDriver {
  // opponents: whether it passes the other cars to the network (by default, if the network learned to look at them)
  constructor(policy, { opponents = policy.opponents } = {}) {
    this.policy = policy;
    this.opponents = opponents;
    this.obs = new Float32Array(OBS_SIZE);
    this.wait = 0;
    this.stuck = 0;
    this.grass = 0;
    this.u = 0;
    this.input = { throttle: 0, brake: 0, steer: 0 };
  }

  // whether the network sees the start lights (sensors.js): then it handles its own start (race/race.js)
  get seesLights() {
    return !!this.policy.lights;
  }

  // Same shape as Driver.drive in ai.js: me and others are { car, ... }
  drive(dt, track, line, { car }, others = []) {
    const u = stationAt(track, car.x, car.y);
    if (u >= 0) this.u = u;
    // stuck (against a wall or in a pile-up): goes back to the track, like the classic AI. In training it is also
    // rescued, but after 6 s: here it gets half that so it doesn't hold up the race
    this.stuck = Math.abs(car.speed) < 1 ? this.stuck + dt : 0;
    // lost on the grass: in training it is rescued after 6 s, so it never learned to come back from far away (and on
    // the grass it doesn't stay still: it goes at ~90 km/h)
    this.grass = car.onGrass ? this.grass + dt : 0;
    if (this.stuck > STUCK_TIME || this.grass > GRASS_TIME) {
      rescue(track, line, car, this.u);
      this.stuck = 0;
      this.grass = 0;
    }
    this.wait -= dt;
    if (this.wait <= 0) {
      this.wait += DECISION_DT;
      const cars = this.opponents ? others.map((o) => o.car) : [];
      const [steer, pedal] = this.policy.act(observe(track, car, this.u, cars, this.obs));
      this.input = { steer, throttle: Math.max(0, pedal), brake: Math.max(0, -pedal) };
    }
    return this.input;
  }

  // Still on the grid (with the start lights on, or off without having started yet): it only decides, no rescues.
  // revUp and revDown raise and lower the revs (car.revBy); the caller releases the clutch when it accelerates with
  // the lights out (car.lights: the state of the start lights)
  grid(dt, track, { car }, others = []) {
    const u = stationAt(track, car.x, car.y);
    if (u >= 0) this.u = u;
    this.wait -= dt;
    if (this.wait <= 0) {
      this.wait += DECISION_DT;
      const cars = this.opponents ? others.map((o) => o.car) : [];
      const [steer, pedal, up = 0, down = 0] = this.policy.act(observe(track, car, this.u, cars, this.obs));
      this.input = { steer, throttle: Math.max(0, pedal), brake: Math.max(0, -pedal), revUp: up, revDown: down };
    }
    return this.input;
  }
}
