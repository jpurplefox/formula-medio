// Mide una red exportada (rl/export.py): larga desde la grilla de cada circuito y da 3 vueltas, como en una
// contrarreloj. Para comparar, también corre la IA clásica (ai.js) con el ritmo de Difícil más rápido.
//
//   node rl/eval.js models/v22/fase18.json [circuitos separados por coma]

import { readFileSync } from 'node:fs';
import { Driver } from '../src/drivers/ai.js';
import { gridSlots } from '../src/race/grid.js';
import { Car, DEFAULT_PROFILE, limitsOn, RIVAL_AIDS } from '../src/sim/car.js';
import { Policy, NeuralDriver } from '../src/drivers/policy.js';
import { racingLine } from '../src/sim/racingline.js';
import { sampleField, stationAt } from '../src/sim/track.js';
import { loadTrack, TRACK_IDS } from './tracks.js';

const [file, ids] = process.argv.slice(2);
const policy = new Policy(JSON.parse(readFileSync(file, 'utf8')));
const profile = JSON.parse(readFileSync(new URL('../cars/f1-2025.json', import.meta.url), 'utf8')) ?? DEFAULT_PROFILE;
const DT = 1 / 60,
  LAPS = 3,
  MAX_TIME = 400;

function run(track, drive) {
  const slot = gridSlots(track, 1)[0];
  const car = Object.assign(new Car(slot.x, slot.y, slot.angle, profile), RIVAL_AIDS); // con las ayudas del juego
  car.launch();
  car.throttle = 1;
  let prev = stationAt(track, car.x, car.y),
    laps = [],
    last = null,
    grass = 0,
    hits = 0;
  for (let t = 0; t < MAX_TIME && laps.length < LAPS; t += DT) {
    const bump = car.bump;
    car.update(DT, drive(car), track);
    if (car.bump > bump + 0.05) hits++;
    if (car.onGrass) grass += DT;
    const u = stationAt(track, car.x, car.y);
    if (u < 0) continue;
    if (u - prev < -track.length / 2) {
      if (last !== null) laps.push(t - last);
      last = t;
    }
    prev = u;
  }
  return { laps, grass, hits };
}

const fmt = ({ laps, grass, hits }) =>
  `${laps.length ? laps.map((l) => l.toFixed(1)).join(' ') : 'no completó vuelta'} (pasto ${grass.toFixed(1)} s, golpes ${hits})`;

// puntaje: promedio de (mejor vuelta de la red / mejor vuelta de la IA); menos es mejor, 2 si no completó
const scores = [];
for (const id of ids ? ids.split(',') : TRACK_IDS) {
  const track = loadTrack(id);
  const line = racingLine(track, limitsOn(profile, track), { brakeUse: 0.93 });
  const neural = new NeuralDriver(policy);
  const nn = run(track, (car) => neural.drive(DT, track, line, { car }));
  const old = new Driver(1.06, 1);
  let st = 0;
  const ref = run(track, (car) => {
    const s = stationAt(track, car.x, car.y);
    if (s >= 0) st = s;
    return old.drive(DT, track, line, { car, st, lat: sampleField(track.lat, track.W, car.x, car.y) }, []);
  });
  console.log(`${id.padEnd(12)} red: ${fmt(nn)}\n${''.padEnd(12)} IA:  ${fmt(ref)}`);
  scores.push(nn.laps.length < LAPS ? 2 : Math.min(...nn.laps) / Math.min(...ref.laps));
}
console.log(`puntaje ${(scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(3)}`);
