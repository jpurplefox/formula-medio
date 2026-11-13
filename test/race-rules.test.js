// Las reglas de la carrera: el semáforo de largada (lights.js) y los equipos, rivales y grilla (teams.js).
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { LIGHT_FIRST, lightsAt, lightsDuration, randomHold } from '../src/sim/lights.js';
import {
  car,
  DEFAULT_RIVALS,
  DIFFICULTIES,
  gridOrder,
  rivalCars,
  rivalPaces,
  rivalSetups,
  RIVAL_OPTIONS,
  TEAMS,
} from '../src/race/teams.js';
import { rng } from '../rl/env.js';

describe('semáforo', () => {
  const hold = 1.5,
    total = lightsDuration(hold);

  test('dura la primera luz, cuatro más de a una por segundo y la espera', () => {
    assert.equal(total, LIGHT_FIRST + 4 + hold);
  });

  test('se prenden de a una por segundo hasta 5, y después de la espera se apagan', () => {
    assert.deepEqual(lightsAt(0, total), { lit: 0, since: 0, out: false });
    const lit = [1.2, 2.2, 3.2, 4.2, 5.2].map((s) => lightsAt(s, total).lit);
    assert.deepEqual(lit, [1, 2, 3, 4, 5]);
    assert.ok(Math.abs(lightsAt(2.2, total).since - 0.2) < 1e-9);
    assert.equal(lightsAt(total - 0.01, total).lit, 5);
    assert.deepEqual(lightsAt(total, total), { lit: 0, since: 0, out: true });
  });

  test('la espera al azar queda entre 0,4 y 2,6 s', () => {
    assert.equal(
      randomHold(() => 0),
      0.4,
    );
    assert.ok(Math.abs(randomHold(() => 1) - 2.6) < 1e-12);
    const rand = rng(1);
    for (let i = 0; i < 100; i++) {
      const h = randomHold(rand);
      assert.ok(h >= 0.4 && h <= 2.6);
    }
  });
});

describe('equipos', () => {
  test('11 equipos de 2 pilotos, con siglas y números sin repetir', () => {
    assert.equal(TEAMS.length, 11);
    const drivers = TEAMS.flatMap((t) => t.drivers);
    assert.equal(drivers.length, 22);
    assert.equal(new Set(drivers.map(([, code]) => code)).size, 22);
    assert.equal(new Set(drivers.map(([, , number]) => number)).size, 22);
  });

  test('las dificultades van de más lenta a más rápida', () => {
    for (let i = 1; i < DIFFICULTIES.length; i++) {
      assert.ok(DIFFICULTIES[i].paces[0] > DIFFICULTIES[i - 1].paces[0]);
      assert.ok(DIFFICULTIES[i].setups[0] > DIFFICULTIES[i - 1].setups[0]);
    }
  });

  test('ritmos y autos de los rivales: del más rápido al más lento, de punta a punta de la dificultad', () => {
    const d = DIFFICULTIES[1];
    const paces = rivalPaces(d, 10);
    assert.equal(paces.length, 10);
    assert.equal(paces[0], d.paces[0]);
    assert.ok(Math.abs(paces[9] - d.paces[1]) < 1e-12);
    for (let i = 1; i < 10; i++) assert.ok(paces[i] < paces[i - 1]);
    const setups = rivalSetups(d, 5);
    assert.equal(setups[0].grip, d.setups[0]);
    assert.equal(setups[0].power, setups[0].grip);
    assert.deepEqual(rivalPaces(d, 1), [d.paces[0]]);
  });
});

describe('rivalCars', () => {
  const mine = TEAMS[3];

  test('por defecto, el primer piloto de cada uno de los otros equipos', () => {
    const rivals = rivalCars(mine, DEFAULT_RIVALS);
    assert.equal(rivals.length, TEAMS.length - 1);
    assert.ok(rivals.every((r) => r.team !== mine && r.slot === 0));
    assert.equal(new Set(rivals.map((r) => r.team)).size, rivals.length);
  });

  test('con la grilla completa, los 21 otros autos, tu compañero incluido', () => {
    for (const slot of [0, 1]) {
      const rivals = rivalCars(mine, 21, slot);
      assert.equal(rivals.length, 21);
      const mate = rivals.filter((r) => r.team === mine);
      assert.equal(mate.length, 1);
      assert.equal(mate[0].slot, 1 - slot);
    }
  });

  test('cada cantidad del menú da esa cantidad de autos distintos; con uno, el del mejor equipo', () => {
    for (const n of RIVAL_OPTIONS) {
      const rivals = rivalCars(mine, n);
      assert.equal(rivals.length, n);
      assert.equal(new Set(rivals.map((r) => r.code)).size, n);
    }
    const [best] = rivalCars(
      TEAMS.find((t) => t.id !== 'merchoedes'),
      1,
    );
    assert.equal(best.team.id, 'merchoedes');
  });

  test('car arma el piloto de ese lugar del equipo', () => {
    const c = car(mine, 1);
    assert.deepEqual([c.name, c.code, c.number], mine.drivers[1]);
  });
});

describe('gridOrder', () => {
  test('es un orden de largada: cada lugar una vez', () => {
    const rand = rng(7);
    for (let k = 0; k < 50; k++) {
      const slots = gridOrder(21, rand);
      assert.deepEqual(
        [...slots].sort((a, b) => a - b),
        Array.from({ length: 21 }, (_, i) => i),
      );
    }
  });
  test('sin azar respeta el campeonato, y con azar nadie se mueve más de 6 lugares', () => {
    assert.deepEqual(
      gridOrder(10, () => 0),
      Array.from({ length: 10 }, (_, i) => i),
    );
    const rand = rng(3);
    for (let k = 0; k < 50; k++) gridOrder(21, rand).forEach((slot, i) => assert.ok(Math.abs(slot - i) <= 6));
  });
});
