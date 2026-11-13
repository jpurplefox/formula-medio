// What the tests share: the real car (cars/f1-2025.json), a track built in Node as in the game, and a car placed on
// the grid to drive it.
import { readFileSync } from 'node:fs';
import { gridSlots } from '../src/race/grid.js';
import { Car } from '../src/sim/car.js';
import { loadTrack } from '../rl/tracks.js';

export const PROFILE = JSON.parse(readFileSync(new URL('../cars/f1-2025.json', import.meta.url), 'utf8'));
export const DT = 1 / 60;
export const kmh = (v) => v * 3.6;

// tracks take a while to build: each one only once
const tracks = new Map();
export function track(id = 'monza') {
  if (!tracks.has(id)) tracks.set(id, loadTrack(id));
  return tracks.get(id);
}

// A car in the first grid slot (at Monza, on the main straight), at speed m/s in that gear
export function carOnGrid(t = track(), { speed = 0, gear = 1 } = {}) {
  const s = gridSlots(t, 1)[0];
  const car = new Car(s.x, s.y, s.angle, PROFILE).placeOn(t);
  car.speed = speed;
  car.gear = gear;
  return car;
}

// Drives the car with those pedals and steering for seconds s (or until until(car, t) returns true); returns the
// time and the straight-line meters from where it started
export function drive(car, t, input, seconds, until = () => false) {
  const x0 = car.x,
    y0 = car.y;
  let time = 0;
  while (time < seconds && !until(car, time)) {
    car.update(DT, { throttle: 0, brake: 0, steer: 0, ...input }, t);
    time += DT;
  }
  return { time, meters: Math.hypot(car.x - x0, car.y - y0) * t.meters };
}
