// dynamics.js: los límites del auto. Se prueban propiedades físicas (con márgenes), no los números exactos: así
// siguen valiendo después de recalibrar el auto.
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
  test('a nivel del mar es la del aire estándar', () => assert.equal(airDensity(0), SEA_AIR));
  test('baja con la altura (México, a 2240 m: ~23 % menos)', () => {
    assert.ok(airDensity(1000) < SEA_AIR);
    assert.ok(Math.abs(airDensity(2240) / SEA_AIR - 0.77) < 0.02);
  });
});

describe('tyreCurve', () => {
  test('sin deriva no hay fuerza y es simétrica', () => {
    assert.equal(tyreCurve(0), 0);
    for (const x of [0.3, 1, 2.5]) assert.equal(tyreCurve(-x), -tyreCurve(x));
  });
  test('crece hasta el pico (1 en x = 1) y después cae hacia lo que agarra deslizando', () => {
    for (let i = 0; i < 10; i++) assert.ok(tyreCurve(i / 10) < tyreCurve((i + 1) / 10));
    assert.equal(tyreCurve(1), 1);
    for (let x = 1; x < 10; x += 0.5) assert.ok(tyreCurve(x + 0.5) <= tyreCurve(x));
    assert.ok(Math.abs(tyreCurve(1000, 0.75) - 0.75) < 0.01);
    assert.ok(tyreCurve(5) > 0.75);
  });
});

describe('weightShift y brakeBias', () => {
  test('frenando el peso pasa adelante, acelerando atrás, y nunca más del límite', () => {
    assert.ok(weightShift(-20, 9.8) > 0);
    assert.ok(weightShift(10, 9.8) < 0);
    assert.ok(weightShift(0, 9.8) === 0);
    assert.ok(weightShift(-1000, 9.8) <= 0.3);
    assert.ok(weightShift(1000, 9.8) >= -0.3);
  });
  test('el reparto sigue a la carga, corrido adelante, entre 15 % y 85 %', () => {
    assert.ok(Math.abs(brakeBias(1, 1, 0) - 0.5) < 1e-12);
    assert.ok(brakeBias(1, 1) > 0.5);
    assert.equal(brakeBias(100, 1), 0.85);
    assert.equal(brakeBias(1, 100, 0), 0.15);
  });
});

describe('carLimits', () => {
  test('la punta y el agarre son los de un F1 (300–360 km/h; más de 4 g en curva rápida)', () => {
    assert.ok(kmh(base.topSpeed) > 300 && kmh(base.topSpeed) < 360, `punta ${kmh(base.topSpeed)} km/h`);
    assert.ok(base.lateral(80) / 9.8 > 4);
    assert.ok(base.brakePeak(80) / 9.8 > 4);
  });

  test('despacio la aceleración la limita la tracción y rápido el motor, que rinde menos cuanto más rápido va', () => {
    assert.equal(base.thrust(20), base.traction(20));
    assert.equal(base.thrust(70), base.engine(70));
    for (let v = 50; v < base.topSpeed - 10; v += 10) assert.ok(base.accel(v + 10) < base.accel(v));
    // y en la punta el motor apenas le gana al aire
    assert.ok(Math.abs(base.accel(base.topSpeed)) < 0.05);
  });

  test('la carga aerodinámica y el agarre crecen con la velocidad', () => {
    assert.ok(Math.abs(base.load(0) - 1) < 1e-12);
    for (let v = 10; v < 90; v += 10) {
      assert.ok(base.load(v + 10) > base.load(v));
      assert.ok(base.lateral(v + 10) > base.lateral(v));
    }
  });

  test('más alerón: más agarre en las rápidas y menos punta', () => {
    const low = withTune({ front: 1, rear: 1 }),
      high = withTune({ front: 10, rear: 10 });
    assert.ok(high.lateral(80) > base.lateral(80) && base.lateral(80) > low.lateral(80));
    assert.ok(high.topSpeed < base.topSpeed && base.topSpeed < low.topSpeed);
  });

  test('el balance mecánico pasa agarre de un eje al otro en las lentas', () => {
    const ratio = (balance) => {
      const [f, r] = withTune({ balance }).axles(20);
      return f / r;
    };
    assert.ok(ratio(-5) < ratio(0) && ratio(0) < ratio(5));
  });

  test('el reparto de frenada adelante corre la frenada hacia la trompa', () => {
    assert.ok(withTune({ brake: 5 }).brakeFwd > base.brakeFwd);
    assert.ok(withTune({ brake: -5 }).brakeFwd < base.brakeFwd);
  });

  test('con aire más fino (altura) hay menos carga y más punta', () => {
    const thin = carLimits(PROFILE, DEFAULT_TUNE, airDensity(2240));
    assert.ok(thin.lateral(80) < base.lateral(80));
    assert.ok(thin.topSpeed > base.topSpeed);
  });

  test('con nafta encima acelera menos', () => {
    const full = carLimits(PROFILE, DEFAULT_TUNE, SEA_AIR, {}, NO_DAMAGE, 100);
    assert.equal(full.mass, base.mass + 100);
    assert.ok(full.accel(30) < base.accel(30));
  });

  test('la variación del auto (setup) cambia agarre y potencia', () => {
    const better = carLimits(PROFILE, DEFAULT_TUNE, SEA_AIR, { grip: 1.1, power: 1.1 });
    assert.ok(better.lateral(40) > base.lateral(40));
    assert.ok(better.engine(50) > base.engine(50));
  });

  test('un alerón delantero roto quita agarre adelante en las rápidas, no atrás', () => {
    const broken = applyHit(NO_DAMAGE, 2.5, -0.5, 30, null, 'real');
    assert.equal(broken.frontWing[0], 1);
    const hurt = carLimits(PROFILE, DEFAULT_TUNE, SEA_AIR, {}, broken);
    const [f, r] = base.axles(80);
    for (const turn of [1, -1]) {
      const [hf, hr] = hurt.axles(80, turn);
      assert.ok(hf < 0.9 * f, `doblando ${turn}: adelante ${hf} contra ${f}`);
      assert.ok(Math.abs(hr - r) / r < 0.02);
    }
  });
});
