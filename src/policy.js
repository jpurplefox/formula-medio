// La red entrenada (rl/): recibe lo que ve el auto (sensors.js) y devuelve volante y pedal.
// Los pesos vienen de rl/export.py: capas lineales con tanh entre ellas.

import { OBS_SIZE, observe } from './sensors.js';
import { stationAt } from './track.js';

export class Policy {
  // opponents: si aprendió a mirar a los demás autos (etapa 2); si no, se le pasan en cero, como al entrenar
  constructor({ obs_size, layers, opponents = false }) {
    if (obs_size !== OBS_SIZE) throw new Error(`La red espera ${obs_size} valores y los sensores dan ${OBS_SIZE}`);
    this.opponents = opponents;
    this.layers = layers.map((l) => {
      const w = floats(l.w);
      return { w: Array.from({ length: l.out }, (_, i) => w.subarray(i * l.in, (i + 1) * l.in)), b: floats(l.b) };
    });
  }

  static async load(url) {
    return new Policy(await fetch(url).then((r) => r.json()));
  }

  // obs → [volante, pedal], los dos entre -1 y 1
  act(obs) {
    let x = obs;
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

// float32 en base64 (como los escribe rl/export.py)
function floats(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Float32Array(bytes.buffer);
}

// Piloto con la red: decide 20 veces por segundo (como al entrenar) y entre medio mantiene los controles
export const DECISION_DT = 1 / 20;

export class NeuralDriver {
  // opponents: si le pasa los demás autos a la red (por defecto, si la red aprendió a mirarlos)
  constructor(policy, { opponents = policy.opponents } = {}) {
    this.policy = policy;
    this.opponents = opponents;
    this.obs = new Float32Array(OBS_SIZE);
    this.wait = 0;
    this.u = 0;
    this.input = { throttle: 0, brake: 0, steer: 0 };
  }

  // Misma forma que Driver.drive de ai.js: me y others son { car, ... }
  drive(dt, track, line, { car }, others = []) {
    const u = stationAt(track, car.x, car.y);
    if (u >= 0) this.u = u;
    this.wait -= dt;
    if (this.wait <= 0) {
      this.wait += DECISION_DT;
      const cars = this.opponents ? others.map((o) => o.car) : [];
      const [steer, pedal] = this.policy.act(observe(track, car, this.u, cars, this.obs));
      this.input = { steer, throttle: Math.max(0, pedal), brake: Math.max(0, -pedal) };
    }
    return this.input;
  }
}
