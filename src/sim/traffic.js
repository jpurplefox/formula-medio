// Un paso de física de varios autos en la pista: la estela de cada uno, cada auto con lo que pide su piloto y los
// choques entre ellos, siempre en ese orden. Lo usan la carrera del juego (race/race.js) y el entrenamiento (rl/),
// así se manejan igual en los dos lados.
import { isSolid, slipstream } from './car.js';
import { collideCars } from './collision.js';

// un golpe que se nota (cuánto sube car.bump): menos es un roce que no cuenta
export const HIT_MIN = 0.05;

// cars: los autos en pista (los que ya sacaron no van), en el orden en que se mueven y chocan. inputFor(i): lo que
// pide el piloto del auto i, en el momento de moverlo (puede mirar a los que ya se movieron en este paso), o null si
// este paso no se mueve (en la grilla, esperando para largar). Devuelve cuánto golpe se llevó cada uno contra el muro
// (al moverse) y contra otro auto (0: nada).
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
