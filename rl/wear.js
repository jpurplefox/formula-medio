// Calibrates tyre wear (WEAR_USE in src/sim/car.js): the classic AI drives a lap on each track with
// wearRate = 1 / lap length; if the calibration is right, it ends each lap with wear ≈ 1.
//
//   node rl/wear.js

import { readFileSync } from 'node:fs';
import { Driver } from '../src/drivers/ai.js';
import { gridSlots } from '../src/race/grid.js';
import { Car, limitsOn } from '../src/sim/car.js';
import { racingLine } from '../src/sim/racingline.js';
import { sampleField, stationAt } from '../src/sim/track.js';
import { loadTrack, TRACK_IDS } from './tracks.js';

const profile = JSON.parse(readFileSync(new URL('../cars/f1-2025.json', import.meta.url), 'utf8'));
const DT = 1 / 60;
const all = [];
for (const id of TRACK_IDS) {
  const track = loadTrack(id);
  const line = racingLine(track, limitsOn(profile, track), { brakeUse: 0.93 });
  const slot = gridSlots(track, 1)[0];
  const car = new Car(slot.x, slot.y, slot.angle, profile);
  car.launch();
  car.wearRate = 1 / (track.length * track.meters);
  const driver = new Driver(1, 1);
  let st = stationAt(track, car.x, car.y),
    prev = st,
    crossed = 0,
    start = 0;
  for (let t = 0; t < 400 && crossed < 2; t += DT) {
    const s = stationAt(track, car.x, car.y);
    if (s >= 0) st = s;
    car.update(
      DT,
      driver.drive(DT, track, line, { car, st, lat: sampleField(track.lat, track.W, car.x, car.y) }, []),
      track,
    );
    if (st - prev < -track.length / 2) {
      // the first lap starts when crossing the line; the next one, a flying lap, is measured
      if (++crossed === 1) start = car.wear;
    }
    prev = st;
  }
  const lap = car.wear - start;
  all.push(lap);
  console.log(`${id.padEnd(12)} wear over a flying lap: ${lap.toFixed(3)}`);
}
console.log(`mean ${(all.reduce((a, b) => a + b, 0) / all.length).toFixed(3)}`);
