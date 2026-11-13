// Proceso de Node que simula varios entornos y habla con Python (rl/racing_env.py) por stdin/stdout.
//
//   node rl/worker.js solo  <entornos> <circuitos separados por coma> <semilla> [config]
//   node rl/worker.js race  <carreras> <circuitos> <semilla> [config]
//   node rl/worker.js herd  <carreras> <circuitos> <semilla> [config]
//
// "solo" es la fase 1 (un auto por entorno); "race" las carreras con rivales (rl/race.js: varios agentes por
// carrera); "herd" las carreras en manada, todos los autos agentes (rl/herd.js).
// config es un JSON con las opciones de RaceEnv o RaceSim (spread, agents, opponents, mix, raceSpread).
// Para Python cada agente es un entorno más: en total, entornos × agentes.
//
// Al arrancar escribe una línea JSON ({ obs_size, actions, envs }) y espera órdenes. Cada orden empieza con un byte:
//   0 = paso: le siguen las acciones (float32, 2 por agente). Responde con un bloque binario
//       (observaciones, recompensas, terminado, cortado; float32) y una línea JSON con lo que pasó en cada
//       agente que terminó una vuelta o un episodio (y la última observación de ese episodio).
//       Los que terminan arrancan otro episodio solos: la observación que se devuelve ya es la del nuevo.
//   1 = reset: reinicia todos y responde con el bloque binario de las observaciones.
//   2 = ajustes de las carreras: le siguen 4 bytes con el largo y un JSON, por ejemplo { contactScale, progress }
//       (rl/race.js). No responde.

import { ACTIONS, OBS_SIZE } from '../src/drivers/sensors.js';
import { RaceEnv } from './env.js';
import { RaceSim } from './race.js';
import { HerdSim } from './herd.js';

const [mode, n, ids, seed, config = '{}'] = process.argv.slice(2);
const trackIds = ids.split(',');
const options = JSON.parse(config);

// Etapa 1 con la misma forma que una carrera: un solo agente
class Solo {
  constructor(seed) {
    this.env = new RaceEnv({ ...options, trackIds, seed });
    this.agents = 1;
  }

  reset() {
    return [Float32Array.from(this.env.reset())];
  }

  step(actions) {
    const r = this.env.step(actions[0], actions[1]);
    const obs = Float32Array.from(r.obs);
    return [{ ...r, obs, next: r.done ? Float32Array.from(this.env.reset()) : undefined }];
  }
}

const Sim = { race: RaceSim, herd: HerdSim }[mode];
const sims = Array.from({ length: Number(n) }, (_, k) =>
  Sim ? new Sim({ ...options, trackIds, seed: Number(seed) * 1000 + k }) : new Solo(Number(seed) * 1000 + k),
);
const N = sims.reduce((a, s) => a + s.agents, 0);
const obs = new Float32Array(N * OBS_SIZE);
const out = new Float32Array(N * (OBS_SIZE + 3));

function resetAll() {
  let k = 0;
  for (const sim of sims) for (const o of sim.reset()) obs.set(o, OBS_SIZE * k++);
  process.stdout.write(Buffer.from(obs.buffer));
}

function stepAll(actions) {
  const infos = [];
  let k = 0;
  for (const sim of sims) {
    const results = sim.step(actions.subarray(ACTIONS * k, ACTIONS * (k + sim.agents)));
    // si la carrera terminó (se cortó por tiempo), arranca otra y esas son las observaciones nuevas
    const fresh = results.some((r) => r.truncated) ? sim.reset() : null;
    results.forEach((r, j) => {
      const ended = r.done || r.truncated;
      const info = {};
      if (r.info.lap) info.lap = [r.info.track, r.info.lap];
      if (ended) {
        info.episode = r.info.episode;
        info.terminal = Array.from(r.obs);
      }
      if (Object.keys(info).length) infos.push([k, info]);
      out.set(fresh ? fresh[j] : (r.next ?? r.obs), k * OBS_SIZE);
      out[N * OBS_SIZE + k] = r.reward;
      out[N * (OBS_SIZE + 1) + k] = ended ? 1 : 0;
      out[N * (OBS_SIZE + 2) + k] = r.truncated ? 1 : 0;
      k++;
    });
  }
  process.stdout.write(Buffer.from(out.buffer));
  process.stdout.write(JSON.stringify(infos) + '\n');
}

// lectura de órdenes: se van juntando los bytes que llegan hasta tener una orden completa
let pending = Buffer.alloc(0);
const STEP_BYTES = 1 + N * ACTIONS * 4;
process.stdin.on('data', (chunk) => {
  pending = Buffer.concat([pending, chunk]);
  while (pending.length) {
    const op = pending[0];
    if (op === 1) {
      pending = pending.subarray(1);
      resetAll();
    } else if (op === 2) {
      if (pending.length < 5 || pending.length < 5 + pending.readUInt32LE(1)) return;
      const size = pending.readUInt32LE(1);
      const settings = JSON.parse(pending.subarray(5, 5 + size).toString());
      pending = pending.subarray(5 + size);
      for (const sim of sims) Object.assign(sim, settings);
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

process.stdout.write(JSON.stringify({ obs_size: OBS_SIZE, actions: ACTIONS, envs: N }) + '\n');
