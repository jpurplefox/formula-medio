// Proceso de Node que simula varios entornos y habla con Python (rl/racing_env.py) por stdin/stdout.
//
//   node rl/worker.js <cantidad de entornos> <circuitos separados por coma> <semilla>
//
// Al arrancar escribe una línea JSON ({ obs_size, envs }) y espera órdenes. Cada orden empieza con un byte:
//   0 = paso: le siguen las acciones (float32, 2 por entorno). Responde con un bloque binario
//       (observaciones, recompensas, terminado, cortado; float32) y una línea JSON con lo que pasó en cada
//       entorno que terminó una vuelta o un episodio (y la última observación de ese episodio).
//       Los que terminan arrancan otro episodio solos: la observación que se devuelve ya es la del nuevo.
//   1 = reset: reinicia todos y responde con el bloque binario de las observaciones.

import { OBS_SIZE } from '../src/sensors.js';
import { RaceEnv } from './env.js';

const [n, ids, seed] = process.argv.slice(2);
const N = Number(n);
const envs = Array.from({ length: N }, (_, k) => new RaceEnv({ trackIds: ids.split(','), seed: Number(seed) * 1000 + k }));
const obs = new Float32Array(N * OBS_SIZE);
const out = new Float32Array(N * (OBS_SIZE + 3));

function resetAll() {
  envs.forEach((e, k) => obs.set(e.reset(), k * OBS_SIZE));
  process.stdout.write(Buffer.from(obs.buffer));
}

function stepAll(actions) {
  const infos = [];
  envs.forEach((e, k) => {
    let r = e.step(actions[2 * k], actions[2 * k + 1]);
    const ended = r.done || r.truncated;
    const info = {};
    if (r.info.lap) info.lap = [r.info.track, r.info.lap];
    if (ended) {
      info.episode = r.info.episode;
      info.terminal = Array.from(r.obs);
      r = { ...r, obs: e.reset() };
    }
    if (Object.keys(info).length) infos.push([k, info]);
    out.set(r.obs, k * OBS_SIZE);
    out[N * OBS_SIZE + k] = r.reward;
    out[N * (OBS_SIZE + 1) + k] = ended ? 1 : 0;
    out[N * (OBS_SIZE + 2) + k] = r.truncated ? 1 : 0;
  });
  process.stdout.write(Buffer.from(out.buffer));
  process.stdout.write(JSON.stringify(infos) + '\n');
}

// lectura de órdenes: se van juntando los bytes que llegan hasta tener una orden completa
let pending = Buffer.alloc(0);
const STEP_BYTES = 1 + N * 2 * 4;
process.stdin.on('data', (chunk) => {
  pending = Buffer.concat([pending, chunk]);
  while (pending.length) {
    const op = pending[0];
    if (op === 1) {
      pending = pending.subarray(1);
      resetAll();
    } else if (op === 0) {
      if (pending.length < STEP_BYTES) return;
      const bytes = pending.subarray(1, STEP_BYTES);
      const actions = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length));
      pending = pending.subarray(STEP_BYTES);
      stepAll(actions);
    } else {
      throw new Error(`Orden desconocida: ${op}`);
    }
  }
});
process.stdin.on('end', () => process.exit(0));

process.stdout.write(JSON.stringify({ obs_size: OBS_SIZE, envs: N }) + '\n');
