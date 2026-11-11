// Lo que comparten los tests: el auto de verdad (cars/f1-2025.json), un circuito armado en Node como en el juego y
// un auto puesto en la grilla para manejarlo.
import { readFileSync } from 'node:fs';
import { gridSlots } from '../src/race/grid.js';
import { Car } from '../src/sim/car.js';
import { loadTrack } from '../rl/tracks.js';

export const PROFILE = JSON.parse(readFileSync(new URL('../cars/f1-2025.json', import.meta.url), 'utf8'));
export const DT = 1 / 60;
export const kmh = (v) => v * 3.6;

// los circuitos tardan en armarse: uno por test, una sola vez
const tracks = new Map();
export function track(id = 'monza') {
  if (!tracks.has(id)) tracks.set(id, loadTrack(id));
  return tracks.get(id);
}

// Un auto en el primer lugar de la grilla (en Monza, sobre la recta principal), a speed m/s en esa marcha
export function carOnGrid(t = track(), { speed = 0, gear = 1 } = {}) {
  const s = gridSlots(t, 1)[0];
  const car = new Car(s.x, s.y, s.angle, PROFILE).placeOn(t);
  car.speed = speed;
  car.gear = gear;
  return car;
}

// Maneja el auto con esos pedales y volante durante seconds s (o hasta que until(car, t) dé true); devuelve el
// tiempo y los metros recorridos en línea recta desde donde arrancó
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
