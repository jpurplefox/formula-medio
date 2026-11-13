// Measures networks in herd races (rl/herd.js), always with the same races (same seed, tracks and cars): every car
// with the network. Each race is on a different track, in order: with random tracks, the same network measured with
// 3 or 6 races gave very different results (each track has its own level of lap time and contacts). Reports:
//   time       the training measure: the time with penalty against the racing line's starting the same way (in solo
//              and rolling each lap; in grid both laps; in flying the lap; in chase the lap of the car behind; in
//              start how far each one got when the first one reached the braking point of the first corner)
// and, to see where it comes from: the flying lap without penalty (lap), lap 1 of a start (lap1) and, on the grid,
// lap 2 (lap2), without penalty; the penalty per lap (s, per car) and its parts: contacts per km, seconds side by
// side with another car per lap (zone), seconds on the grass per episode with two or more wheels (grass, as in the
// older tables) and the grass penalty per lap (grass.pen); clean passes per pair in the chase and rescues per
// episode.
//
//   node rl/herd_eval.js models/a.json [models/b.json ...]
//
// Variables: SCENARIOS (for example grid,chase; default, all), RACES (races per scenario, 8: one per track), DAMAGE
// (off, reduced or real; default, off), AGENTS (cars per race, 22, as in the game). With JSON=1, for a single
// network, writes the time of each scenario as the training budgets use it (Budgets, rl/train.py).

import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { Policy } from '../src/drivers/policy.js';
import { ACTIONS } from '../src/drivers/sensors.js';
import { setDamageRandom } from '../src/sim/damage.js';
import { rng } from './env.js';
import { HerdSim } from './herd.js';
import { TRACK_IDS } from './tracks.js';

const RACES = Number(process.env.RACES ?? 8),
  AGENTS = Number(process.env.AGENTS ?? 22);
const PEN = ['penalty', 'contacts', 'zone', 'grass', 'grass.pen'];
const SCENARIOS = {
  solo: ['time', 'lap', ...PEN],
  grid: ['time', 'lap1', 'lap2', ...PEN],
  flying: ['time', 'lap1', ...PEN],
  rolling: ['time', 'lap', ...PEN],
  chase: ['time', 'passes', ...PEN],
  start: ['time', ...PEN],
};

function measure(policy, scenario) {
  const sim = new HerdSim({
    trackIds: TRACK_IDS,
    agents: AGENTS,
    seed: 4321,
    mix: { [scenario]: 1 },
    spread: [0.15, 0.2],
    damage: process.env.DAMAGE ?? 'off',
  });
  const eps = [];
  for (let race = 0; race < RACES; race++) {
    sim.trackIds = [TRACK_IDS[race % TRACK_IDS.length]];
    // what is random inside the physics (the spin of a car thrown off in a crash) is also seeded: otherwise the same
    // network measured twice gave up to 15 % different contacts
    Math.random = rng(9000 + race);
    setDamageRandom(rng(9500 + race)); // punctures, with their own randomness

    let obs = sim.reset();
    for (let done = false; !done;) {
      const actions = new Float32Array(ACTIONS * obs.length);
      obs.forEach((o, k) => actions.set(policy.act(o), ACTIONS * k));
      const results = sim.step(actions);
      obs = results.map((r) => r.next ?? r.obs);
      for (const r of results) if (r.info.episode) eps.push(r.info.episode);
      done = results.some((r) => r.truncated);
    }
  }
  const mean = (f) => {
    const xs = eps.map(f).filter((x) => x !== null && x !== undefined);
    return xs.length ? xs.reduce((a, x) => a + x, 0) / xs.length : NaN;
  };
  const sum = (f) => eps.reduce((a, e) => a + f(e), 0);
  const km = eps.reduce((a, e) => a + Math.max(0, e.dist), 0) / 1000;
  const laps = sum((e) => e.laps);
  return {
    time: mean((e) => e.time),
    lap: mean((e) => e.pace),
    lap1: mean((e) => e.launch),
    lap2: mean((e) => e.lap2),
    penalty: sum((e) => e.penalty) / laps,
    contacts: sum((e) => e.hits) / km,
    zone: sum((e) => e.zone) / laps,
    // grass: seconds on the grass per episode (two or more wheels), as in the older tables; grass.pen, its penalty
    // per lap
    grass: mean((e) => e.grass),
    'grass.pen': sum((e) => e.grassPen) / laps,
    // each pass is counted by the car behind: per pair, the mean of the cars behind
    passes: mean((e) => (e.front ? null : (e.passes ?? 0))),
    rescues: mean((e) => e.rescues),
  };
}

const files = process.argv.slice(2);
const policies = files.map((f) => new Policy(JSON.parse(readFileSync(f, 'utf8'))));
if (process.env.SCENARIO) {
  // one scenario, for the parallel measurement below
  console.log(JSON.stringify(measure(policies[0], process.env.SCENARIO)));
  process.exit(0);
}
if (process.env.JSON === '1') {
  // each scenario in its own process: with large networks, one after another took longer than training the phase.
  // The result is the same (each scenario has its own seed)
  const one = (scenario) =>
    new Promise((resolve, reject) =>
      execFile(
        'node',
        [process.argv[1], files[0]],
        { env: { ...process.env, SCENARIO: scenario }, maxBuffer: 1 << 20 },
        (err, out) => (err ? reject(err) : resolve(JSON.parse(out))),
      ),
    );
  const names = ['solo', 'grid', 'rolling', 'flying', 'chase', 'start'];
  const all = await Promise.all(names.map(one));
  console.log(JSON.stringify({ time: Object.fromEntries(names.map((sc, i) => [sc, all[i].time])) }));
  process.exit(0);
}
const fmt = {
  time: 3,
  penalty: 2,
  zone: 1,
  grass: 1,
  'grass.pen': 2,
  lap: 3,
  lap1: 3,
  lap2: 3,
  contacts: 2,
  passes: 2,
};
const only = process.env.SCENARIOS?.split(',');
for (const [scenario, keys] of Object.entries(SCENARIOS)) {
  if (only && !only.includes(scenario)) continue;
  console.log(`\n${scenario}`);
  policies.forEach((p, i) => {
    const m = measure(p, scenario);
    const parts = keys.map(
      (k) =>
        `${k} ${m[k].toFixed(fmt[k])}${k === 'contacts' ? '/km' : k === 'grass' ? ' s' : ['penalty', 'zone', 'grass.pen'].includes(k) ? ' s/lap' : ''}`,
    );
    console.log(`  ${files[i].padEnd(28)} ${parts.join(' · ')} · rescues ${m.rescues.toFixed(2)}`);
  });
}
