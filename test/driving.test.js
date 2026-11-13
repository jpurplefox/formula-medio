// Lo que ve la red (sensors.js), la red del juego (policy.js) y los choques (collision.js).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { isSolid, limitsOn, RIVAL_AIDS } from '../src/sim/car.js';
import { collideCars } from '../src/sim/collision.js';
import { GAME_NET, NeuralDriver, Policy } from '../src/drivers/policy.js';
import { racingLine } from '../src/sim/racingline.js';
import { ACTIONS, OBS_SIZE, observe } from '../src/drivers/sensors.js';
import { stationAt } from '../src/sim/track.js';
import { carOnGrid, DT, PROFILE, track } from './helpers.js';

const t = track('monza');
const policy = new Policy(JSON.parse(readFileSync(new URL(`../${GAME_NET}`, import.meta.url), 'utf8')));

// un auto puesto a `ahead` m adelante y `side` m a la derecha de otro, mirando para el mismo lado
function beside(car, ahead, side = 0, speed = car.speed) {
  const o = carOnGrid(t, { speed, gear: car.gear });
  const fx = Math.cos(car.angle),
    fy = Math.sin(car.angle);
  o.x = car.x + (ahead * fx - side * fy) / t.meters;
  o.y = car.y + (ahead * fy + side * fx) / t.meters;
  o.angle = car.angle;
  return o;
}

describe('observe', () => {
  test('da siempre OBS_SIZE números, todos finitos, con o sin rivales', () => {
    const car = carOnGrid(t, { speed: 50, gear: 6 });
    const u = stationAt(t, car.x, car.y);
    for (const others of [[], [beside(car, 10), beside(car, -15, 3), beside(car, 60, -2)]]) {
      const obs = observe(t, car, u, others);
      assert.equal(obs.length, OBS_SIZE);
      assert.ok(obs.every(Number.isFinite));
    }
  });
  test('un rival cerca cambia lo que ve; el mismo estado da lo mismo', () => {
    const car = carOnGrid(t, { speed: 50, gear: 6 });
    const u = stationAt(t, car.x, car.y);
    const alone = observe(t, car, u, []),
      again = observe(t, car, u, []),
      withRival = observe(t, car, u, [beside(car, 10)]);
    assert.deepEqual(alone, again);
    assert.notDeepEqual(alone, withRival);
  });
});

describe('la red del juego', () => {
  test(`${GAME_NET} lee las entradas de ahora y da volante y pedal entre -1 y 1`, () => {
    const car = carOnGrid(t, { speed: 50, gear: 6 });
    const out = policy.act(observe(t, car, stationAt(t, car.x, car.y), []));
    assert.ok(out.length >= ACTIONS);
    assert.ok([...out].every((x) => x >= -1 && x <= 1));
  });

  test('da una vuelta lanzada a Monza sola: en 76–88 s, sin rescates y casi sin pasto', () => {
    // con las ayudas con las que corre en el juego y con las que se entrenó (sin ellas se pasa en la primera chicana)
    const car = Object.assign(carOnGrid(t), RIVAL_AIDS);
    car.launch();
    const driver = new NeuralDriver(policy),
      line = racingLine(t, limitsOn(PROFILE, t), { brakeUse: 0.93 });
    let prev = stationAt(t, car.x, car.y),
      laps = 0,
      start = 0,
      lapTime = null,
      grass = 0,
      rescues = 0;
    for (let time = 0; time < 400 && lapTime === null; time += DT) {
      const before = { x: car.x, y: car.y };
      car.update(DT, driver.drive(DT, t, line, { car }), t);
      if (Math.hypot(car.x - before.x, car.y - before.y) * t.meters > 5) rescues++; // la movieron de golpe
      if (laps === 2 && car.onGrass) grass += DT;
      const u = stationAt(t, car.x, car.y);
      if (u < 0) continue;
      if (u - prev < -t.length / 2) {
        laps++;
        if (laps === 3) lapTime = time - start; // la segunda vuelta entera: la primera larga desde parado
        start = time;
      }
      prev = u;
    }
    assert.ok(lapTime > 76 && lapTime < 88, `vuelta en ${lapTime?.toFixed(2)} s`);
    assert.equal(rescues, 0);
    assert.ok(grass < 2, `${grass.toFixed(1)} s en el pasto`);
  });
});

describe('collideCars', () => {
  test('dos autos que no se tocan quedan igual', () => {
    const a = carOnGrid(t, { speed: 50, gear: 6 }),
      b = beside(a, 20);
    const before = [a.x, a.y, a.speed, b.x, b.y, b.speed];
    collideCars([a, b], t, isSolid);
    assert.deepEqual([a.x, a.y, a.speed, b.x, b.y, b.speed], before);
  });

  test('uno que le pega de atrás a otro: se separan, el de atrás frena, el de adelante acelera', () => {
    const a = carOnGrid(t, { speed: 60, gear: 6 }),
      b = beside(a, 5, 0, 40); // a 5 m de centro a centro: los autos miden 5,6 m de punta a punta
    const gap = () => Math.hypot(b.x - a.x, b.y - a.y) * t.meters;
    const before = gap();
    collideCars([a, b], t, isSolid);
    assert.ok(gap() > before);
    assert.ok(a.speed < 60 && b.speed > 40);
    // las fuerzas son iguales y opuestas: lo que pierde uno lo gana el otro (autos iguales)
    assert.ok(Math.abs(a.speed + b.speed - 100) < 1);
    assert.ok(a.bump > 0 && b.bump > 0);
  });

  test('con daños reales, un golpe fuerte rompe el alerón delantero del que pega', () => {
    const a = carOnGrid(t, { speed: 70, gear: 7 }),
      b = beside(a, 5, 0, 30);
    a.damageLevel = b.damageLevel = 'real';
    collideCars([a, b], t, isSolid);
    assert.ok(a.damage.frontWing.some((x) => x > 0));
    assert.ok(b.damage.rearWing.some((x) => x > 0));
  });
});
