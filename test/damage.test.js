// damage.js: what breaks on each hit and what that does to the car.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  applyHit,
  damaged,
  deflate,
  NO_DAMAGE,
  powerLoss,
  randomDamage,
  setDamageRandom,
  steerPull,
  STRENGTH,
  wheelDrag,
  wheelGrip,
  zoneAt,
} from '../src/sim/damage.js';
import { rng } from '../rl/env.js';

// points on the car (m from the center; x forward, y to the right)
const FRONT_WING_LEFT = [2.5, -0.6],
  NOSE = [1.5, 0],
  SIDEPOD_RIGHT = [0, 0.6],
  REAR_WING = [-2.5, 0],
  FRONT_LEFT_WHEEL = [1.6, -0.8];

describe('zoneAt', () => {
  test('each point falls on its part', () => {
    assert.equal(zoneAt(...FRONT_WING_LEFT).part, 'frontWing');
    assert.equal(zoneAt(...NOSE).part, 'frontWing');
    assert.equal(zoneAt(...SIDEPOD_RIGHT).part, 'sidepod');
    assert.equal(zoneAt(...REAR_WING).part, 'rearWing');
    assert.deepEqual([zoneAt(...FRONT_LEFT_WHEEL).part, zoneAt(...FRONT_LEFT_WHEEL).wheel], ['wheel', 0]);
  });
  test('a point outside all of them gets the nearest one', () => {
    assert.equal(zoneAt(10, 0).part, 'frontWing');
    assert.equal(zoneAt(-10, 0).part, 'rearWing');
  });
});

describe('applyHit', () => {
  test('with damage off, or a brush below the threshold, returns the same object', () => {
    assert.equal(applyHit(NO_DAMAGE, ...FRONT_WING_LEFT, 50, null, 'off'), NO_DAMAGE);
    assert.equal(applyHit(NO_DAMAGE, ...FRONT_WING_LEFT, STRENGTH.frontWing.from - 1, null, 'real'), NO_DAMAGE);
  });

  test('does not modify the previous damage: builds a new one', () => {
    const before = structuredClone(NO_DAMAGE);
    const after = applyHit(NO_DAMAGE, ...FRONT_WING_LEFT, 30, null, 'real');
    assert.notEqual(after, NO_DAMAGE);
    assert.deepEqual({ ...NO_DAMAGE }, before);
  });

  test('a hit on the front-left wing breaks only that side; on the nose, both', () => {
    const side = applyHit(NO_DAMAGE, ...FRONT_WING_LEFT, 15, null, 'real');
    assert.ok(side.frontWing[0] > 0 && side.frontWing[1] === 0);
    const nose = applyHit(NO_DAMAGE, ...NOSE, 15, null, 'real');
    assert.ok(nose.frontWing[0] > 0 && nose.frontWing[0] === nose.frontWing[1]);
  });

  test('harder means more damage; hits add up and nothing goes past broken (1)', () => {
    const soft = applyHit(NO_DAMAGE, ...SIDEPOD_RIGHT, 12, null, 'real'),
      hard = applyHit(NO_DAMAGE, ...SIDEPOD_RIGHT, 20, null, 'real');
    assert.ok(hard.sidepod[1] > soft.sidepod[1]);
    const twice = applyHit(soft, ...SIDEPOD_RIGHT, 12, null, 'real');
    assert.ok(Math.abs(twice.sidepod[1] - 2 * soft.sidepod[1]) < 1e-12);
    let d = NO_DAMAGE;
    for (let i = 0; i < 5; i++) d = applyHit(d, ...SIDEPOD_RIGHT, 100, null, 'real');
    assert.equal(d.sidepod[1], 1);
  });

  test('with reduced damage it breaks half as much and never fully (no retirement)', () => {
    const real = applyHit(NO_DAMAGE, ...SIDEPOD_RIGHT, 15, null, 'real'),
      reduced = applyHit(NO_DAMAGE, ...SIDEPOD_RIGHT, 15, null, 'reduced');
    assert.ok(Math.abs(reduced.sidepod[1] - real.sidepod[1] / 2) < 1e-12);
    let d = NO_DAMAGE;
    for (let i = 0; i < 10; i++) d = applyHit(d, ...FRONT_LEFT_WHEEL, 100, null, 'reduced');
    assert.ok(d.suspension[0] <= 0.6 && d.retired === null);
  });

  test('with real damage, a very hard hit on a wheel breaks it and retires the car', () => {
    const front = applyHit(NO_DAMAGE, ...FRONT_LEFT_WHEEL, 40, null, 'real');
    assert.equal(front.suspension[0], 1);
    assert.equal(front.retired, 'Dirección rota');
    const rear = applyHit(NO_DAMAGE, -1.7, 0.8, 40, null, 'real');
    assert.equal(rear.retired, 'Suspensión rota');
    // and once retired, nothing else changes
    assert.equal(applyHit(front, ...SIDEPOD_RIGHT, 40, null, 'real'), front);
  });

  test("another car's wing against a tyre can puncture it (random, seeded)", () => {
    setDamageRandom(() => 0); // always "yes"
    const cut = applyHit(NO_DAMAGE, ...FRONT_LEFT_WHEEL, 6, { part: 'frontWing' }, 'real');
    assert.ok(cut.tyre[0] > 0);
    setDamageRandom(() => 0.99); // always "no"
    assert.equal(applyHit(NO_DAMAGE, ...FRONT_LEFT_WHEEL, 6, { part: 'frontWing' }, 'real').tyre[0], 0);
    // with reduced damage there are no punctures
    setDamageRandom(() => 0);
    assert.equal(applyHit(NO_DAMAGE, ...FRONT_LEFT_WHEEL, 6, { part: 'frontWing' }, 'reduced').tyre[0], 0);
    setDamageRandom(Math.random);
  });
});

describe('effects', () => {
  test('damaged: only with something broken', () => {
    assert.equal(damaged(NO_DAMAGE), false);
    assert.equal(damaged(applyHit(NO_DAMAGE, ...REAR_WING, 20, null, 'real')), true);
  });

  test('a broken sidepod takes power from the engine', () => {
    assert.equal(powerLoss(NO_DAMAGE), 1);
    const d = { ...NO_DAMAGE, sidepod: [1, 1] };
    assert.ok(powerLoss(d) < 1 && powerLoss(d) > 0.8);
  });

  test('a punctured tyre deflates in a few seconds: less grip and more drag', () => {
    let d = { ...NO_DAMAGE, tyre: [1e-3, 0, 0, 0] };
    for (let i = 0; i < 2 * 60; i++) d = deflate(d, 1 / 60);
    assert.ok(d.tyre[0] > 0.3 && d.tyre[0] < 1);
    for (let i = 0; i < 10 * 60; i++) d = deflate(d, 1 / 60);
    assert.equal(d.tyre[0], 1);
    assert.equal(d.tyre[1], 0);
    assert.ok(wheelGrip(d, 0) < 0.5 && wheelGrip(d, 1) === 1);
    assert.ok(wheelDrag(d, 0) > 0 && wheelDrag(d, 1) === 0);
  });

  test("bent suspension pulls the steering toward that wheel's side", () => {
    assert.equal(steerPull(NO_DAMAGE), 0);
    assert.ok(steerPull({ ...NO_DAMAGE, suspension: [0, 0.5, 0, 0] }) > 0);
    assert.ok(steerPull({ ...NO_DAMAGE, suspension: [0.5, 0, 0, 0] }) < 0);
  });

  test('randomDamage: one or two parts, never a retirement; with reduced damage, little and no punctures', () => {
    const rand = rng(42);
    for (let i = 0; i < 200; i++) {
      for (const level of ['real', 'reduced']) {
        const d = randomDamage(rand, level);
        assert.equal(d.retired, null);
        assert.ok(damaged(d));
        if (level === 'reduced') {
          assert.ok(d.tyre.every((x) => x === 0));
          for (const part of ['frontWing', 'rearWing', 'sidepod', 'suspension'])
            assert.ok(d[part].every((x) => x <= 0.6));
        }
      }
    }
  });
});
