// Measures networks in the curriculum scenarios (rl/race.js), always with the same races: same seed, same tracks,
// same cars and classic AI opponents. That way the difference between networks comes from driving and not from
// luck with the car they got.
//
//   node rl/scenario_eval.js models/a.json [models/b.json ...]
//
// Per scenario: contacts, caused contacts (hit the car ahead or squeezed the car alongside) and seconds in danger
// per 1000 m, clean passes, times it was passed, weaves and meters driven per episode (the pace: a timid network
// crashes little but covers less ground) and rescues (stuck, on the grass or going backwards for too long).
// Variables: RACES (races per scenario, 40), SPREAD (car variation, 0.02), SCENARIOS (only those, comma-separated).

import { readFileSync } from 'node:fs';
import { Policy } from '../src/drivers/policy.js';
import { ACTIONS } from '../src/drivers/sensors.js';
import { RaceSim, SCENARIOS } from './race.js';
import { TRACK_IDS } from './tracks.js';

const RACES = Number(process.env.RACES ?? 40),
  SPREAD = Number(process.env.SPREAD ?? 0.02);
const files = process.argv.slice(2);

function measure(policy, scenario) {
  const sim = new RaceSim({
    trackIds: TRACK_IDS,
    agents: 4,
    seed: 12345,
    mix: { [scenario]: 1 },
    spread: SPREAD,
    progress: 1,
  });
  const eps = [];
  for (let race = 0; race < RACES; race++) {
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
  const sum = (f) => eps.reduce((a, e) => a + f(e), 0);
  const km = sum((e) => Math.max(0, e.dist)) / 1000;
  return {
    contacts: sum((e) => e.hits) / km,
    faults: sum((e) => e.faults) / km,
    danger: sum((e) => e.danger) / km,
    passes: sum((e) => e.passes) / eps.length,
    passed: sum((e) => e.passed) / eps.length,
    weaves: sum((e) => e.weaves) / eps.length,
    meters: (km * 1000) / eps.length,
    rescues: sum((e) => e.rescues) / eps.length,
    // starts: seconds lost against the racing line per 10 s of racing line covered
    start:
      (sum((e) => e.lag ?? 0) /
        Math.max(
          1e-9,
          sum((e) => e.lagRef ?? 0),
        )) *
      10,
  };
}

const policies = files.map((f) => new Policy(JSON.parse(readFileSync(f, 'utf8'))));
const only = process.env.SCENARIOS?.split(',');
for (const scenario of Object.keys(SCENARIOS).filter((s) => !only || only.includes(s))) {
  console.log(`\n${scenario}`);
  policies.forEach((p, i) => {
    const m = measure(p, scenario);
    console.log(
      `  ${files[i].padEnd(36)} contacts/km ${m.contacts.toFixed(2)} · caused/km ${m.faults.toFixed(2)} · danger s/km ${m.danger.toFixed(2)} · passes ${m.passes.toFixed(2)} · ` +
        `passed ${m.passed.toFixed(2)} · weaves ${m.weaves.toFixed(2)} · meters ${m.meters.toFixed(0)} · rescues ${m.rescues.toFixed(2)} · start ${m.start.toFixed(2)} s/10 s`,
    );
  });
}
