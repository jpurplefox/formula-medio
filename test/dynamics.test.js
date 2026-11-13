// dynamics.js: the car's limits. The tests check physical properties (with margins), not exact numbers, so they
// still hold after the car is recalibrated.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { applyHit, NO_DAMAGE } from '../src/sim/damage.js';
import {
  airDensity,
  brakeBias,
  carLimits,
  DEFAULT_TUNE,
  SEA_AIR,
  tyreCurve,
  weightShift,
} from '../src/sim/dynamics.js';
import { kmh, PROFILE } from './helpers.js';

const base = carLimits(PROFILE);
const withTune = (tune) => carLimits(PROFILE, { ...DEFAULT_TUNE, ...tune });

describe('airDensity', () => {
  test('at sea level it is standard air', () => assert.equal(airDensity(0), SEA_AIR));
  test('drops with altitude (Mexico, at 2240 m: ~23% less)', () => {
    assert.ok(airDensity(1000) < SEA_AIR);
    assert.ok(Math.abs(airDensity(2240) / SEA_AIR - 0.77) < 0.02);
  });
});

describe('tyreCurve', () => {
  test('no slip means no force, and it is symmetric', () => {
    assert.equal(tyreCurve(0), 0);
    for (const x of [0.3, 1, 2.5]) assert.equal(tyreCurve(-x), -tyreCurve(x));
  });
  test('rises to the peak (1 at x = 1) and then falls toward the sliding grip', () => {
    for (let i = 0; i < 10; i++) assert.ok(tyreCurve(i / 10) < tyreCurve((i + 1) / 10));
    assert.equal(tyreCurve(1), 1);
    for (let x = 1; x < 10; x += 0.5) assert.ok(tyreCurve(x + 0.5) <= tyreCurve(x));
    assert.ok(Math.abs(tyreCurve(1000, 0.75) - 0.75) < 0.01);
    assert.ok(tyreCurve(5) > 0.75);
  });
});

describe('weightShift and brakeBias', () => {
  test('braking shifts weight forward, accelerating shifts it back, never beyond the limit', () => {
    assert.ok(weightShift(-20, 9.8) > 0);
    assert.ok(weightShift(10, 9.8) < 0);
    assert.ok(weightShift(0, 9.8) === 0);
    assert.ok(weightShift(-1000, 9.8) <= 0.3);
    assert.ok(weightShift(1000, 9.8) >= -0.3);
  });
  test('the bias follows the load, shifted forward, between 15% and 85%', () => {
    assert.ok(Math.abs(brakeBias(1, 1, 0) - 0.5) < 1e-12);
    assert.ok(brakeBias(1, 1) > 0.5);
    assert.equal(brakeBias(100, 1), 0.85);
    assert.equal(brakeBias(1, 100, 0), 0.15);
  });
});

describe('carLimits', () => {
  test('top speed and grip are those of an F1 car (300–360 km/h; over 4 g in fast corners)', () => {
    assert.ok(kmh(base.topSpeed) > 300 && kmh(base.topSpeed) < 360, `top speed ${kmh(base.topSpeed)} km/h`);
    assert.ok(base.lateral(80) / 9.8 > 4);
    assert.ok(base.brakePeak(80) / 9.8 > 4);
  });

  test('acceleration is traction-limited at low speed and engine-limited at high speed, falling as speed rises', () => {
    assert.equal(base.thrust(20), base.traction(20));
    assert.equal(base.thrust(70), base.engine(70));
    for (let v = 50; v < base.topSpeed - 10; v += 10) assert.ok(base.accel(v + 10) < base.accel(v));
    // and at top speed the engine barely beats the air
    assert.ok(Math.abs(base.accel(base.topSpeed)) < 0.05);
  });

  test('downforce and grip grow with speed', () => {
    assert.ok(Math.abs(base.load(0) - 1) < 1e-12);
    for (let v = 10; v < 90; v += 10) {
      assert.ok(base.load(v + 10) > base.load(v));
      assert.ok(base.lateral(v + 10) > base.lateral(v));
    }
  });

  test('more wing: more grip in fast corners and less top speed', () => {
    const low = withTune({ front: 1, rear: 1 }),
      high = withTune({ front: 10, rear: 10 });
    assert.ok(high.lateral(80) > base.lateral(80) && base.lateral(80) > low.lateral(80));
    assert.ok(high.topSpeed < base.topSpeed && base.topSpeed < low.topSpeed);
  });

  test('mechanical balance moves grip from one axle to the other in slow corners', () => {
    const ratio = (balance) => {
      const [f, r] = withTune({ balance }).axles(20);
      return f / r;
    };
    assert.ok(ratio(-5) < ratio(0) && ratio(0) < ratio(5));
  });

  test('forward brake bias moves braking toward the nose', () => {
    assert.ok(withTune({ brake: 5 }).brakeFwd > base.brakeFwd);
    assert.ok(withTune({ brake: -5 }).brakeFwd < base.brakeFwd);
  });

  test('with thinner air (altitude) there is less downforce and more top speed', () => {
    const thin = carLimits(PROFILE, DEFAULT_TUNE, airDensity(2240));
    assert.ok(thin.lateral(80) < base.lateral(80));
    assert.ok(thin.topSpeed > base.topSpeed);
  });

  test('with fuel on board it accelerates less', () => {
    const full = carLimits(PROFILE, DEFAULT_TUNE, SEA_AIR, {}, NO_DAMAGE, 100);
    assert.equal(full.mass, base.mass + 100);
    assert.ok(full.accel(30) < base.accel(30));
  });

  test('the car variation (setup) changes grip and power', () => {
    const better = carLimits(PROFILE, DEFAULT_TUNE, SEA_AIR, { grip: 1.1, power: 1.1 });
    assert.ok(better.lateral(40) > base.lateral(40));
    assert.ok(better.engine(50) > base.engine(50));
  });

  test('a broken front wing takes front grip in fast corners, not rear grip', () => {
    const broken = applyHit(NO_DAMAGE, 2.5, -0.5, 30, null, 'real');
    assert.equal(broken.frontWing[0], 1);
    const hurt = carLimits(PROFILE, DEFAULT_TUNE, SEA_AIR, {}, broken);
    const [f, r] = base.axles(80);
    for (const turn of [1, -1]) {
      const [hf, hr] = hurt.axles(80, turn);
      assert.ok(hf < 0.9 * f, `turning ${turn}: front ${hf} vs ${f}`);
      assert.ok(Math.abs(hr - r) / r < 0.02);
    }
  });
});
