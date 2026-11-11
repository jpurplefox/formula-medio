// What the network sees (sensors.js), the game network (policy.js) and collisions (collision.js).
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

// a car placed `ahead` m in front of and `side` m to the right of another, facing the same way
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
  test('always gives OBS_SIZE numbers, all finite, with or without rivals', () => {
    const car = carOnGrid(t, { speed: 50, gear: 6 });
    const u = stationAt(t, car.x, car.y);
    for (const others of [[], [beside(car, 10), beside(car, -15, 3), beside(car, 60, -2)]]) {
      const obs = observe(t, car, u, others);
      assert.equal(obs.length, OBS_SIZE);
      assert.ok(obs.every(Number.isFinite));
    }
  });
  test('a nearby rival changes what it sees; the same state gives the same result', () => {
    const car = carOnGrid(t, { speed: 50, gear: 6 });
    const u = stationAt(t, car.x, car.y);
    const alone = observe(t, car, u, []),
      again = observe(t, car, u, []),
      withRival = observe(t, car, u, [beside(car, 10)]);
    assert.deepEqual(alone, again);
    assert.notDeepEqual(alone, withRival);
  });
});

describe('the game network', () => {
  test(`${GAME_NET} reads the current inputs and gives steering and pedal between -1 and 1`, () => {
    const car = carOnGrid(t, { speed: 50, gear: 6 });
    const out = policy.act(observe(t, car, stationAt(t, car.x, car.y), []));
    assert.ok(out.length >= ACTIONS);
    assert.ok([...out].every((x) => x >= -1 && x <= 1));
  });

  test('drives a flying lap of Monza alone: in 76–88 s, with no rescues and almost no grass', () => {
    // with the aids it races with in the game and was trained with (without them it overshoots the first chicane)
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
      if (Math.hypot(car.x - before.x, car.y - before.y) * t.meters > 5) rescues++; // it was moved suddenly
      if (laps === 2 && car.onGrass) grass += DT;
      const u = stationAt(t, car.x, car.y);
      if (u < 0) continue;
      if (u - prev < -t.length / 2) {
        laps++;
        if (laps === 3) lapTime = time - start; // the whole second lap: the first one starts from a standstill
        start = time;
      }
      prev = u;
    }
    assert.ok(lapTime > 76 && lapTime < 88, `lap in ${lapTime?.toFixed(2)} s`);
    assert.equal(rescues, 0);
    assert.ok(grass < 2, `${grass.toFixed(1)} s on the grass`);
  });
});

describe('collideCars', () => {
  test('two cars that do not touch stay the same', () => {
    const a = carOnGrid(t, { speed: 50, gear: 6 }),
      b = beside(a, 20);
    const before = [a.x, a.y, a.speed, b.x, b.y, b.speed];
    collideCars([a, b], t, isSolid);
    assert.deepEqual([a.x, a.y, a.speed, b.x, b.y, b.speed], before);
  });

  test('one car hitting another from behind: they separate, the rear one slows, the front one speeds up', () => {
    const a = carOnGrid(t, { speed: 60, gear: 6 }),
      b = beside(a, 5, 0, 40); // 5 m center to center: the cars are 5.6 m long nose to tail
    const gap = () => Math.hypot(b.x - a.x, b.y - a.y) * t.meters;
    const before = gap();
    collideCars([a, b], t, isSolid);
    assert.ok(gap() > before);
    assert.ok(a.speed < 60 && b.speed > 40);
    // the forces are equal and opposite: what one loses the other gains (identical cars)
    assert.ok(Math.abs(a.speed + b.speed - 100) < 1);
    assert.ok(a.bump > 0 && b.bump > 0);
  });

  test("with real damage, a hard hit breaks the hitting car's front wing", () => {
    const a = carOnGrid(t, { speed: 70, gear: 7 }),
      b = beside(a, 5, 0, 30);
    a.damageLevel = b.damageLevel = 'real';
    collideCars([a, b], t, isSolid);
    assert.ok(a.damage.frontWing.some((x) => x > 0));
    assert.ok(b.damage.rearWing.some((x) => x > 0));
  });
});
