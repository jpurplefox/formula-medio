// Node process that simulates several environments and talks to Python (rl/racing_env.py) over stdin/stdout.
//
//   node rl/worker.js solo  <environments> <comma-separated tracks> <seed> [config]
//   node rl/worker.js race  <races> <tracks> <seed> [config]
//   node rl/worker.js herd  <races> <tracks> <seed> [config]
//
// "solo" is phase 1 (one car per environment); "race" is races with opponents (rl/race.js: several agents per
// race); "herd" is herd races, with every car an agent (rl/herd.js).
// config is a JSON with the options of RaceEnv or RaceSim (spread, agents, opponents, mix, raceSpread).
// For Python each agent is one more environment: in total, environments × agents.
//
// On startup it writes a JSON line ({ obs_size, actions, envs }) and waits for commands. Each command starts with a
// byte:
//   0 = step: followed by the actions (float32, 2 per agent). Replies with a binary block
//       (observations, rewards, done, truncated; float32) and a JSON line with what happened to each
//       agent that finished a lap or an episode (and the last observation of that episode).
//       Agents that finish start another episode on their own: the returned observation is already the new one.
//   1 = reset: resets all of them and replies with the binary block of observations.
//   2 = race settings: followed by 4 bytes with the length and a JSON, for example { contactScale, progress }
//       (rl/race.js). No reply.

import { ACTIONS, OBS_SIZE } from '../src/drivers/sensors.js';
import { RaceEnv } from './env.js';
import { RaceSim } from './race.js';
import { HerdSim } from './herd.js';

const [mode, n, ids, seed, config = '{}'] = process.argv.slice(2);
const trackIds = ids.split(',');
const options = JSON.parse(config);

// Stage 1 with the same shape as a race: a single agent
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
    // if the race ended (cut off by time), another one starts and those are the new observations
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

// reading commands: incoming bytes are accumulated until there is a complete command
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
      throw new Error(`Unknown command: ${op}`);
    }
  }
});
process.stdin.on('end', () => process.exit(0));

process.stdout.write(JSON.stringify({ obs_size: OBS_SIZE, actions: ACTIONS, envs: N }) + '\n');
