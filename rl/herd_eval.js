// Mide redes en las carreras en manada (rl/herd.js), siempre con las mismas carreras (misma semilla, circuitos y
// autos): todos los autos con la red. Cada carrera es en otro circuito, en orden: con circuitos al azar, la misma
// red medida con 3 o 6 carreras daba muy distinto (cada circuito tiene su nivel de vuelta y de toques). Informa:
//   tiempo     la medida del entrenamiento: el tiempo con castigo contra el de la trazada arrancando igual (en solo y
//              rolling cada vuelta; en grid las dos; en flying la vuelta; en chase la vuelta del de atrás; en start
//              hasta donde llegó cada uno cuando el primero llegó a la frenada de la primera curva)
// y para ver de dónde sale: la vuelta lanzada sin castigo (vuelta), la vuelta 1 de una largada (vuelta1) y en la
// grilla la 2 (vuelta2), sin castigo; el castigo por vuelta (s, por auto) y sus partes: toques por km, segundos
// encimados al lado de otro por vuelta (zona), segundos en el pasto por episodio con dos ruedas o más (pasto, como en
// las tablas de antes) y el castigo por el pasto por vuelta (c.pasto); pasadas limpias por par en persecución y
// rescates por episodio.
//
//   node rl/herd_eval.js models/a.json [models/b.json ...]
//
// Variables: ESCENARIOS (por ejemplo grid,chase; por defecto, todos), RACES (carreras por escenario, 8: una por circuito), DANOS (off, reduced o real; por defecto, off), AGENTS (autos por carrera, 22, como en el juego). Con JSON=1, para una sola red,
// escribe el tiempo de cada escenario como lo usan los presupuestos del entrenamiento (Budgets, rl/train.py).

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
const PEN = ['castigo', 'toques', 'zona', 'pasto', 'c.pasto'];
const SCENARIOS = {
  solo: ['tiempo', 'vuelta', ...PEN],
  grid: ['tiempo', 'vuelta1', 'vuelta2', ...PEN],
  flying: ['tiempo', 'vuelta1', ...PEN],
  rolling: ['tiempo', 'vuelta', ...PEN],
  chase: ['tiempo', 'pasadas', ...PEN],
  start: ['tiempo', ...PEN],
};

function measure(policy, scenario) {
  const sim = new HerdSim({
    trackIds: TRACK_IDS,
    agents: AGENTS,
    seed: 4321,
    mix: { [scenario]: 1 },
    spread: [0.15, 0.2],
    damage: process.env.DANOS ?? 'off',
  });
  const eps = [];
  for (let race = 0; race < RACES; race++) {
    sim.trackIds = [TRACK_IDS[race % TRACK_IDS.length]];
    // lo que es al azar dentro de la física (el giro de un auto que sale despedido en un choque) también con semilla:
    // si no, la misma red medida dos veces daba hasta 15 % distinto en toques
    Math.random = rng(9000 + race);
    setDamageRandom(rng(9500 + race)); // los pinchazos, con su propio azar

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
    tiempo: mean((e) => e.time),
    vuelta: mean((e) => e.pace),
    vuelta1: mean((e) => e.launch),
    vuelta2: mean((e) => e.lap2),
    castigo: sum((e) => e.penalty) / laps,
    toques: sum((e) => e.hits) / km,
    zona: sum((e) => e.zone) / laps,
    // pasto: segundos en el pasto por episodio (dos ruedas o más), como en las tablas de antes; c.pasto, su castigo por vuelta
    pasto: mean((e) => e.grass),
    'c.pasto': sum((e) => e.grassPen) / laps,
    // cada pasada la cuenta el de atrás: por par, el promedio de los de atrás
    pasadas: mean((e) => (e.front ? null : (e.passes ?? 0))),
    rescates: mean((e) => e.rescues),
  };
}

const files = process.argv.slice(2);
const policies = files.map((f) => new Policy(JSON.parse(readFileSync(f, 'utf8'))));
if (process.env.ESCENARIO) {
  // un escenario, para la medición en paralelo de abajo
  console.log(JSON.stringify(measure(policies[0], process.env.ESCENARIO)));
  process.exit(0);
}
if (process.env.JSON === '1') {
  // cada escenario en su proceso: con redes grandes, uno tras otro tardaba más que entrenar la fase. Da lo mismo
  // (cada escenario tiene su propia semilla)
  const one = (scenario) =>
    new Promise((resolve, reject) =>
      execFile(
        'node',
        [process.argv[1], files[0]],
        { env: { ...process.env, ESCENARIO: scenario }, maxBuffer: 1 << 20 },
        (err, out) => (err ? reject(err) : resolve(JSON.parse(out))),
      ),
    );
  const names = ['solo', 'grid', 'rolling', 'flying', 'chase', 'start'];
  const all = await Promise.all(names.map(one));
  console.log(JSON.stringify({ time: Object.fromEntries(names.map((sc, i) => [sc, all[i].tiempo])) }));
  process.exit(0);
}
const fmt = {
  tiempo: 3,
  castigo: 2,
  zona: 1,
  pasto: 1,
  'c.pasto': 2,
  vuelta: 3,
  vuelta1: 3,
  vuelta2: 3,
  toques: 2,
  pasadas: 2,
};
const only = process.env.ESCENARIOS?.split(',');
for (const [scenario, keys] of Object.entries(SCENARIOS)) {
  if (only && !only.includes(scenario)) continue;
  console.log(`\n${scenario}`);
  policies.forEach((p, i) => {
    const m = measure(p, scenario);
    const parts = keys.map(
      (k) =>
        `${k} ${m[k].toFixed(fmt[k])}${k === 'toques' ? '/km' : k === 'pasto' ? ' s' : ['castigo', 'zona', 'c.pasto'].includes(k) ? ' s/v' : ''}`,
    );
    console.log(`  ${files[i].padEnd(28)} ${parts.join(' · ')} · rescates ${m.rescates.toFixed(2)}`);
  });
}
