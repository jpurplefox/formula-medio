// Mide redes en los escenarios del currículum (rl/race.js), siempre con las mismas carreras: misma semilla,
// mismos circuitos, mismos autos y rivales de la IA de siempre. Así la diferencia entre redes es de manejo y no
// de suerte con el auto que les tocó.
//
//   node rl/scenario_eval.js models/a.json [models/b.json ...]
//
// Por escenario: toques, toques provocados (le pegó al de adelante o apretó al de al lado) y segundos en peligro cada 1000 m, pasadas limpias, veces que lo pasaron, zigzags y metros
// recorridos por episodio (el ritmo: una red miedosa choca poco pero avanza menos) y rescates (trabado, en el pasto o
// para atrás demasiado tiempo). Variables: RACES (carreras por escenario, 40), SPREAD (variación de los autos, 0.02),
// ESCENARIOS (sólo esos, separados por comas).

import { readFileSync } from 'node:fs';
import { Policy } from '../src/policy.js';
import { ACTIONS } from '../src/sensors.js';
import { RaceSim, SCENARIOS } from './race.js';
import { TRACK_IDS } from './tracks.js';

const RACES = Number(process.env.RACES ?? 40), SPREAD = Number(process.env.SPREAD ?? 0.02);
const files = process.argv.slice(2);

function measure(policy, scenario) {
  const sim = new RaceSim({ trackIds: TRACK_IDS, agents: 4, seed: 12345, mix: { [scenario]: 1 }, spread: SPREAD, progress: 1 });
  const eps = [];
  for (let race = 0; race < RACES; race++) {
    let obs = sim.reset();
    for (let done = false; !done; ) {
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
    toques: sum((e) => e.hits) / km, provocados: sum((e) => e.faults) / km, peligro: sum((e) => e.danger) / km, pasadas: sum((e) => e.passes) / eps.length,
    pasado: sum((e) => e.passed) / eps.length, zigzag: sum((e) => e.weaves) / eps.length, metros: (km * 1000) / eps.length,
    rescates: sum((e) => e.rescues) / eps.length,
    // largadas: segundos perdidos contra la trazada cada 10 s de trazada recorridos
    largada: sum((e) => e.lag ?? 0) / Math.max(1e-9, sum((e) => e.lagRef ?? 0)) * 10,
  };
}

const policies = files.map((f) => new Policy(JSON.parse(readFileSync(f, 'utf8'))));
const only = process.env.ESCENARIOS?.split(',');
for (const scenario of Object.keys(SCENARIOS).filter((s) => !only || only.includes(s))) {
  console.log(`\n${scenario}`);
  policies.forEach((p, i) => {
    const m = measure(p, scenario);
    console.log(`  ${files[i].padEnd(36)} toques/km ${m.toques.toFixed(2)} · provocados/km ${m.provocados.toFixed(2)} · peligro s/km ${m.peligro.toFixed(2)} · pasadas ${m.pasadas.toFixed(2)} · ` +
      `pasado ${m.pasado.toFixed(2)} · zigzag ${m.zigzag.toFixed(2)} · metros ${m.metros.toFixed(0)} · rescates ${m.rescates.toFixed(2)} · largada ${m.largada.toFixed(2)} s/10 s`);
  });
}
