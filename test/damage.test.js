// damage.js: qué se rompe en cada golpe y qué le hace eso al auto.
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

// puntos del auto (m desde el centro; x adelante, y a la derecha)
const FRONT_WING_LEFT = [2.5, -0.6],
  NOSE = [1.5, 0],
  SIDEPOD_RIGHT = [0, 0.6],
  REAR_WING = [-2.5, 0],
  FRONT_LEFT_WHEEL = [1.6, -0.8];

describe('zoneAt', () => {
  test('cada punto cae en su pieza', () => {
    assert.equal(zoneAt(...FRONT_WING_LEFT).part, 'frontWing');
    assert.equal(zoneAt(...NOSE).part, 'frontWing');
    assert.equal(zoneAt(...SIDEPOD_RIGHT).part, 'sidepod');
    assert.equal(zoneAt(...REAR_WING).part, 'rearWing');
    assert.deepEqual([zoneAt(...FRONT_LEFT_WHEEL).part, zoneAt(...FRONT_LEFT_WHEEL).wheel], ['wheel', 0]);
  });
  test('un punto fuera de todas, la más cercana', () => {
    assert.equal(zoneAt(10, 0).part, 'frontWing');
    assert.equal(zoneAt(-10, 0).part, 'rearWing');
  });
});

describe('applyHit', () => {
  test('sin daños, o con un roce por debajo del umbral, devuelve el mismo objeto', () => {
    assert.equal(applyHit(NO_DAMAGE, ...FRONT_WING_LEFT, 50, null, 'off'), NO_DAMAGE);
    assert.equal(applyHit(NO_DAMAGE, ...FRONT_WING_LEFT, STRENGTH.frontWing.from - 1, null, 'real'), NO_DAMAGE);
  });

  test('no modifica el daño anterior: arma uno nuevo', () => {
    const before = structuredClone(NO_DAMAGE);
    const after = applyHit(NO_DAMAGE, ...FRONT_WING_LEFT, 30, null, 'real');
    assert.notEqual(after, NO_DAMAGE);
    assert.deepEqual({ ...NO_DAMAGE }, before);
  });

  test('un golpe en el alerón delantero izquierdo rompe sólo ese lado; en la trompa, los dos', () => {
    const side = applyHit(NO_DAMAGE, ...FRONT_WING_LEFT, 15, null, 'real');
    assert.ok(side.frontWing[0] > 0 && side.frontWing[1] === 0);
    const nose = applyHit(NO_DAMAGE, ...NOSE, 15, null, 'real');
    assert.ok(nose.frontWing[0] > 0 && nose.frontWing[0] === nose.frontWing[1]);
  });

  test('más fuerte, más daño; los golpes se suman y nada pasa de roto (1)', () => {
    const soft = applyHit(NO_DAMAGE, ...SIDEPOD_RIGHT, 12, null, 'real'),
      hard = applyHit(NO_DAMAGE, ...SIDEPOD_RIGHT, 20, null, 'real');
    assert.ok(hard.sidepod[1] > soft.sidepod[1]);
    const twice = applyHit(soft, ...SIDEPOD_RIGHT, 12, null, 'real');
    assert.ok(Math.abs(twice.sidepod[1] - 2 * soft.sidepod[1]) < 1e-12);
    let d = NO_DAMAGE;
    for (let i = 0; i < 5; i++) d = applyHit(d, ...SIDEPOD_RIGHT, 100, null, 'real');
    assert.equal(d.sidepod[1], 1);
  });

  test('con daños reducidos rompe la mitad y nunca del todo (ni abandono)', () => {
    const real = applyHit(NO_DAMAGE, ...SIDEPOD_RIGHT, 15, null, 'real'),
      reduced = applyHit(NO_DAMAGE, ...SIDEPOD_RIGHT, 15, null, 'reduced');
    assert.ok(Math.abs(reduced.sidepod[1] - real.sidepod[1] / 2) < 1e-12);
    let d = NO_DAMAGE;
    for (let i = 0; i < 10; i++) d = applyHit(d, ...FRONT_LEFT_WHEEL, 100, null, 'reduced');
    assert.ok(d.suspension[0] <= 0.6 && d.retired === null);
  });

  test('con daños reales, un golpe muy fuerte en una rueda la rompe y deja afuera', () => {
    const front = applyHit(NO_DAMAGE, ...FRONT_LEFT_WHEEL, 40, null, 'real');
    assert.equal(front.suspension[0], 1);
    assert.equal(front.retired, 'Dirección rota');
    const rear = applyHit(NO_DAMAGE, -1.7, 0.8, 40, null, 'real');
    assert.equal(rear.retired, 'Suspensión rota');
    // y ya afuera, nada más cambia
    assert.equal(applyHit(front, ...SIDEPOD_RIGHT, 40, null, 'real'), front);
  });

  test('un alerón ajeno contra una goma la puede pinchar (al azar, con semilla)', () => {
    setDamageRandom(() => 0); // siempre "sí"
    const cut = applyHit(NO_DAMAGE, ...FRONT_LEFT_WHEEL, 6, { part: 'frontWing' }, 'real');
    assert.ok(cut.tyre[0] > 0);
    setDamageRandom(() => 0.99); // siempre "no"
    assert.equal(applyHit(NO_DAMAGE, ...FRONT_LEFT_WHEEL, 6, { part: 'frontWing' }, 'real').tyre[0], 0);
    // con daños reducidos no hay pinchazos
    setDamageRandom(() => 0);
    assert.equal(applyHit(NO_DAMAGE, ...FRONT_LEFT_WHEEL, 6, { part: 'frontWing' }, 'reduced').tyre[0], 0);
    setDamageRandom(Math.random);
  });
});

describe('efectos', () => {
  test('damaged: sólo con algo roto', () => {
    assert.equal(damaged(NO_DAMAGE), false);
    assert.equal(damaged(applyHit(NO_DAMAGE, ...REAR_WING, 20, null, 'real')), true);
  });

  test('un pontón roto le quita potencia al motor', () => {
    assert.equal(powerLoss(NO_DAMAGE), 1);
    const d = { ...NO_DAMAGE, sidepod: [1, 1] };
    assert.ok(powerLoss(d) < 1 && powerLoss(d) > 0.8);
  });

  test('una goma pinchada se desinfla en unos segundos: agarra menos y frena', () => {
    let d = { ...NO_DAMAGE, tyre: [1e-3, 0, 0, 0] };
    for (let i = 0; i < 2 * 60; i++) d = deflate(d, 1 / 60);
    assert.ok(d.tyre[0] > 0.3 && d.tyre[0] < 1);
    for (let i = 0; i < 10 * 60; i++) d = deflate(d, 1 / 60);
    assert.equal(d.tyre[0], 1);
    assert.equal(d.tyre[1], 0);
    assert.ok(wheelGrip(d, 0) < 0.5 && wheelGrip(d, 1) === 1);
    assert.ok(wheelDrag(d, 0) > 0 && wheelDrag(d, 1) === 0);
  });

  test('la suspensión torcida tira la dirección para el lado de esa rueda', () => {
    assert.equal(steerPull(NO_DAMAGE), 0);
    assert.ok(steerPull({ ...NO_DAMAGE, suspension: [0, 0.5, 0, 0] }) > 0);
    assert.ok(steerPull({ ...NO_DAMAGE, suspension: [0.5, 0, 0, 0] }) < 0);
  });

  test('randomDamage: una o dos piezas, nunca un abandono; con daños reducidos, poco y sin pinchazos', () => {
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
