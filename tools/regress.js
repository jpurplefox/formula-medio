// Regression check: runs races with a fixed seed and compares them with the saved ones. It makes refactoring safe:
// if a "cleanup" change touches the physics, sensors, collisions, damage or AI, it shows up.
//
//   node tools/regress.js        compares with tools/regress.base.txt (exits with an error if something changed)
//   node tools/regress.js save   saves the current results as the baseline (when the change is intended)
//
// Three parts, all with the game network:
// - the scenarios of the earlier curriculum (rl/race.js, 4 cars) and those of herd training (rl/herd.js, 22 cars,
//   which is how the network is trained today): at each step the full state of every car (all its numbers, with
//   every decimal) and the rewards are taken and summarized in one hash per scenario;
// - the game race (rl/race_eval.js with GAME=1 and real damage) on two tracks: its report, as is.

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { GAME_NET, Policy } from '../src/drivers/policy.js';
import { ACTIONS } from '../src/drivers/sensors.js';
import { setDamageRandom } from '../src/sim/damage.js';
import { HERD_SCENARIOS, HerdSim } from '../rl/herd.js';
import { RaceSim, SCENARIOS } from '../rl/race.js';
import { rng } from '../rl/env.js';
import { TRACK_IDS } from '../rl/tracks.js';

const NET = GAME_NET;
const RACES = 2; // races per rl/race.js scenario
const HERD_STEPS = 600; // for the herd, one race and only the first 30 s (22 cars: a whole race takes minutes)
const GAME_TRACKS = 'monza,interlagos';
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const BASE = new URL('regress.base.txt', import.meta.url);

// all the numbers in an object (and in the objects and arrays inside it), in order, with every decimal
function numbers(value, out, seen = new Set()) {
  if (typeof value === 'number') out.push(value);
  else if (typeof value === 'boolean') out.push(value ? 1 : 0);
  else if (value && typeof value === 'object' && !seen.has(value)) {
    seen.add(value);
    if (ArrayBuffer.isView(value)) for (const v of value) out.push(v);
    else for (const k of Object.keys(value).sort()) numbers(value[k], out, seen);
  }
  return out;
}

// Runs `races` races of a training simulation (each until it ends or for maxSteps steps) and summarizes everything
// that happened in a hash
function simHash(label, policy, sim, races, maxSteps = Infinity) {
  Math.random = rng(777);
  setDamageRandom(rng(778));
  const hash = createHash('sha256');
  let steps = 0;
  for (let race = 0; race < races; race++) {
    let obs = sim.reset();
    for (let done = false, n = 0; !done && n < maxSteps; steps++, n++) {
      const actions = new Float32Array(ACTIONS * obs.length);
      obs.forEach((o, k) => actions.set(policy.act(o), ACTIONS * k));
      const results = sim.step(actions);
      obs = results.map((r) => r.next ?? r.obs);
      // the whole car: position, speed, tyres, temperature, damage... (cars reference each other, so each one is
      // walked separately without following references to other cars; the track rubber is shared by all and is
      // large: it goes once at the end of each race)
      const state = [];
      for (const e of sim.cars) {
        const skip = new Set(sim.cars.map((o) => o.car).filter((c) => c !== e.car));
        if (e.car.rubber) skip.add(e.car.rubber);
        numbers(e.car, state, skip);
      }
      for (const r of results) state.push(r.reward);
      hash.update(new Uint8Array(new Float64Array(state).buffer));
      done = results.some((r) => r.truncated);
    }
    if (sim.rubber) hash.update(new Uint8Array(new Float64Array(numbers(sim.rubber, [])).buffer));
  }
  return `${label.padEnd(13)} ${steps} steps ${hash.digest('hex').slice(0, 16)}`;
}

const raceSim = (scenario) =>
  new RaceSim({ trackIds: TRACK_IDS, agents: 4, seed: 12345, mix: { [scenario]: 1 }, damage: 'real', progress: 1 });
const herdSim = (scenario) =>
  new HerdSim({
    trackIds: ['spa'],
    agents: 22,
    seed: 4321,
    mix: { [scenario]: 1 },
    spread: [0.15, 0.2],
    damage: 'real',
  });

function report() {
  const policy = new Policy(JSON.parse(readFileSync(new URL(`../${NET}`, import.meta.url), 'utf8')));
  const lines = [
    ...Object.keys(SCENARIOS).map((s) => simHash(s, policy, raceSim(s), RACES)),
    ...Object.keys(HERD_SCENARIOS).map((s) => simHash(`herd ${s}`, policy, herdSim(s), 1, HERD_STEPS)),
  ];
  const game = execFileSync('node', ['rl/race_eval.js', NET, GAME_TRACKS, '2'], {
    cwd: ROOT,
    env: { ...process.env, GAME: '1', DAMAGE: 'real' },
    encoding: 'utf8',
  });
  return [...lines, ...game.trim().split('\n')].join('\n') + '\n';
}

const now = report();
if (process.argv[2] === 'save') {
  writeFileSync(BASE, now);
  console.log(`saved to tools/regress.base.txt\n${now}`);
} else {
  const base = readFileSync(BASE, 'utf8');
  if (base === now) console.log('same as the baseline ✓');
  else {
    const a = base.split('\n'),
      b = now.split('\n');
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if (a[i] !== b[i]) console.log(`- ${a[i] ?? ''}\n+ ${b[i] ?? ''}`);
    }
    console.log('CHANGED: if the change is intended, node tools/regress.js save');
    process.exit(1);
  }
}
