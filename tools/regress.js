// Chequeo de regresión: corre carreras con semilla fija y compara con las guardadas. Sirve para refactorizar
// tranquilo: si un cambio "de prolijidad" toca la física, los sensores, los choques, los daños o la IA, salta.
//
//   node tools/regress.js           compara con tools/regress.base.txt (sale con error si algo cambió)
//   node tools/regress.js guardar   guarda los resultados actuales como base (cuando el cambio es a propósito)
//
// Dos partes:
// - los escenarios del currículum (rl/race.js) con la red del juego: en cada paso se toma el estado completo de
//   cada auto (todos sus números, con todos los decimales) y las recompensas, y se resume en un hash por escenario;
// - la carrera del juego (rl/race_eval.js con JUEGO=1 y daños reales) en dos circuitos: su informe, tal cual.

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { GAME_NET, Policy } from '../src/policy.js';
import { ACTIONS } from '../src/sensors.js';
import { setDamageRandom } from '../src/damage.js';
import { RaceSim, SCENARIOS } from '../rl/race.js';
import { rng } from '../rl/env.js';
import { TRACK_IDS } from '../rl/tracks.js';

const NET = GAME_NET;
const RACES = 2; // carreras por escenario
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

function scenarioHash(policy, scenario) {
  Math.random = rng(777);
  setDamageRandom(rng(778));
  const sim = new RaceSim({
    trackIds: TRACK_IDS,
    agents: 4,
    seed: 12345,
    mix: { [scenario]: 1 },
    damage: 'real',
    progress: 1,
  });
  const hash = createHash('sha256');
  let steps = 0;
  for (let race = 0; race < RACES; race++) {
    let obs = sim.reset();
    for (let done = false; !done; steps++) {
      const actions = new Float32Array(ACTIONS * obs.length);
      obs.forEach((o, k) => actions.set(policy.act(o), ACTIONS * k));
      const results = sim.step(actions);
      obs = results.map((r) => r.next ?? r.obs);
      // el auto entero: posición, velocidad, gomas, temperatura, daños... (los autos se cruzan entre sí, por eso
      // cada uno se recorre aparte y sin seguir referencias a otros autos)
      const state = [];
      for (const e of sim.cars) numbers(e.car, state, new Set(sim.cars.map((o) => o.car).filter((c) => c !== e.car)));
      for (const r of results) state.push(r.reward);
      hash.update(new Uint8Array(new Float64Array(state).buffer));
      done = results.some((r) => r.truncated);
    }
  }
  return `${scenario.padEnd(6)} ${steps} pasos ${hash.digest('hex').slice(0, 16)}`;
}

function report() {
  const policy = new Policy(JSON.parse(readFileSync(new URL(`../${NET}`, import.meta.url), 'utf8')));
  const lines = Object.keys(SCENARIOS).map((s) => scenarioHash(policy, s));
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
