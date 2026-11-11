// A physics step for several cars on the track: each one's wake, each car with what its driver asks for, and the
// collisions between them, always in that order. Used by the game race (race/race.js) and training (rl/), so the
// cars drive the same on both sides.
import { isSolid, slipstream } from './car.js';
import { collideCars } from './collision.js';

// a noticeable hit (how much car.bump rises): less is a light contact that doesn't count
export const HIT_MIN = 0.05;

// cars: the cars on track (those already removed are left out), in the order in which they move and collide.
// inputFor(i): what the driver of car i asks for, at the moment it is moved (it can look at the ones that already
// moved in this step), or null if it doesn't move in this step (on the grid, waiting for the start). Returns how hard
// each one was hit against the wall (while moving) and against another car (0: none).
/**
 * @param {ReturnType<typeof import('./track.js').buildTrackFromLayout>} track
 * @param {import('./car.js').Car[]} cars
 * @param {number} dt
 * @param {(i: number) => { throttle: number, brake: number, steer: number } | null} inputFor
 * @returns {{ wall: Float64Array, hit: Float64Array }}
 */
export function stepCars(track, cars, dt, inputFor) {
  const n = cars.length,
    wall = new Float64Array(n),
    hit = new Float64Array(n);
  for (const c of cars) c.draft = slipstream(c, cars, track.meters);
  for (let i = 0; i < n; i++) {
    const input = inputFor(i);
    if (!input) continue;
    const car = cars[i],
      bump = car.bump;
    car.update(dt, input, track);
    if (car.bump > bump + HIT_MIN) wall[i] = car.bump - bump;
  }
  const before = cars.map((c) => c.bump);
  collideCars(cars, track, isSolid);
  for (let i = 0; i < n; i++) if (cars[i].bump > before[i] + HIT_MIN) hit[i] = cars[i].bump - before[i];
  return { wall, hit };
}
