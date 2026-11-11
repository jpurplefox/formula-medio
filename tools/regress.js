// Chequeo de regresión: corre carreras con semilla fija y compara con las guardadas. Sirve para refactorizar
// tranquilo: si un cambio "de prolijidad" toca la física, los sensores, los choques, los daños o la IA, salta.
//
//   node tools/regress.js           compara con tools/regress.base.txt (sale con error si algo cambió)
//   node tools/regress.js guardar   guarda los resultados actuales como base (cuando el cambio es a propósito)
//
// Tres partes, todas con la red del juego:
// - los escenarios del currículum anterior (rl/race.js, 4 autos) y los del entrenamiento en manada (rl/herd.js, 22
//   autos, con el que se entrena la red hoy): en cada paso se toma el estado completo de cada auto (todos sus
//   números, con todos los decimales) y las recompensas, y se resume en un hash por escenario;
// - la carrera del juego (rl/race_eval.js con JUEGO=1 y daños reales) en dos circuitos: su informe, tal cual.

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
const RACES = 2; // carreras por escenario de rl/race.js
const HERD_STEPS = 600; // de la manada, una carrera y sólo los primeros 30 s (son 22 autos: entera tarda minutos)
const GAME_TRACKS = 'monza,interlagos';
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const BASE = new URL('regress.base.txt', import.meta.url);

// todos los números de un objeto (y de sus objetos y listas adentro), en orden, con todos los decimales
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

// Corre `races` carreras de una simulación de entrenamiento (cada una hasta que termina o hasta maxSteps pasos) y
// resume todo lo que pasó en un hash
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
      // el auto entero: posición, velocidad, gomas, temperatura, daños... (los autos se cruzan entre sí, por eso
      // cada uno se recorre aparte y sin seguir referencias a otros autos; la goma de la pista es de todos y es
      // grande: va una vez al final de cada carrera)
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
  return `${label.padEnd(13)} ${steps} pasos ${hash.digest('hex').slice(0, 16)}`;
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
    ...Object.keys(HERD_SCENARIOS).map((s) => simHash(`manada ${s}`, policy, herdSim(s), 1, HERD_STEPS)),
  ];
  const game = execFileSync('node', ['rl/race_eval.js', NET, GAME_TRACKS, '2'], {
    cwd: ROOT,
    env: { ...process.env, JUEGO: '1', DANOS: 'real' },
    encoding: 'utf8',
  });
  return [...lines, ...game.trim().split('\n')].join('\n') + '\n';
}

const now = report();
if (process.argv[2] === 'guardar') {
  writeFileSync(BASE, now);
  console.log(`guardado en tools/regress.base.txt\n${now}`);
} else {
  const base = readFileSync(BASE, 'utf8');
  if (base === now) console.log('igual que la base ✓');
  else {
    const a = base.split('\n'),
      b = now.split('\n');
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if (a[i] !== b[i]) console.log(`- ${a[i] ?? ''}\n+ ${b[i] ?? ''}`);
    }
    console.log('CAMBIÓ: si el cambio es a propósito, node tools/regress.js guardar');
    process.exit(1);
  }
}
