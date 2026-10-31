// Calibra el desgaste de las gomas (WEAR_USE en src/car.js): la IA de siempre da una vuelta en cada circuito
// con wearRate = 1 / largo de la vuelta; si la calibración está bien, termina cada vuelta con desgaste ≈ 1.
//
//   node rl/wear.js

import { readFileSync } from 'node:fs';
import { Driver, gridSlots } from '../src/ai.js';
import { Car } from '../src/car.js';
import { racingLine } from '../src/racingline.js';
import { sampleField, stationAt } from '../src/track.js';
import { loadTrack, TRACK_IDS } from './tracks.js';

const profile = JSON.parse(readFileSync(new URL('../cars/f1-2023.json', import.meta.url), 'utf8'));
const DT = 1 / 60;
const all = [];
for (const id of TRACK_IDS) {
  const track = loadTrack(id);
  const line = racingLine(track, profile, { brakeUse: 0.93 });
  const slot = gridSlots(track, 1)[0];
  const car = new Car(slot.x, slot.y, slot.angle, profile);
  car.launch();
  car.wearRate = 1 / (track.length * track.meters);
  const driver = new Driver(1, 1);
  let st = stationAt(track, car.x, car.y), prev = st, crossed = 0, start = 0;
  for (let t = 0; t < 400 && crossed < 2; t += DT) {
    const s = stationAt(track, car.x, car.y);
    if (s >= 0) st = s;
    car.update(DT, driver.drive(DT, track, line, { car, st, lat: sampleField(track.lat, track.W, car.x, car.y) }, []), track);
    if (st - prev < -track.length / 2) {
      // la primera vuelta arranca al cruzar la línea; se mide la siguiente, lanzada
      if (++crossed === 1) start = car.wear;
    }
    prev = st;
  }
  const lap = car.wear - start;
  all.push(lap);
  console.log(`${id.padEnd(12)} desgaste en una vuelta lanzada: ${lap.toFixed(3)}`);
}
console.log(`promedio ${(all.reduce((a, b) => a + b, 0) / all.length).toFixed(3)}`);
