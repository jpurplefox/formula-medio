// car.js: el auto andando sobre un circuito real (Monza, desde la grilla, sobre la recta), y las ayudas del teclado.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { keyboardBrake, keyboardSteer, LAUNCH_WINDOW, slipstream } from '../src/sim/car.js';
import { carOnGrid, DT, drive, kmh, PROFILE, track } from './helpers.js';

const t = track('monza');

describe('Car: andando', () => {
  test('parado y sin pedales, no se mueve', () => {
    const car = carOnGrid(t);
    const { meters } = drive(car, t, {}, 3);
    assert.ok(meters < 0.01 && Math.abs(car.speed) < 0.01);
  });

  test('a fondo: de 0 a 100 km/h en 2,5 a 5 s, sube de marcha y no pasa el corte', () => {
    const car = carOnGrid(t);
    let maxRpm = 0;
    const { time } = drive(car, t, { throttle: 1 }, 10, (c) => {
      maxRpm = Math.max(maxRpm, c.rpm);
      return kmh(c.speed) >= 100;
    });
    assert.ok(time > 2.5 && time < 5, `0-100 en ${time.toFixed(2)} s`);
    drive(car, t, { throttle: 1 }, 3);
    assert.ok(car.gear >= 3);
    assert.ok(maxRpm <= PROFILE.maxRpm);
  });

  test('frenando a fondo desde 288 km/h para en menos de 160 m (con y sin ABS)', () => {
    for (const abs of [false, true]) {
      const car = carOnGrid(t, { speed: 80, gear: 7 });
      car.abs = abs;
      let locked = false;
      const { time, meters } = drive(car, t, { brake: 1 }, 10, (c) => {
        locked ||= c.locked[0] || c.locked[1];
        return c.speed < 0.5;
      });
      assert.ok(meters > 60 && meters < 160 && time < 5, `ABS ${abs}: ${meters.toFixed(1)} m en ${time.toFixed(2)} s`);
      // el ABS suelta el freno antes de que una rueda se bloquee
      if (abs) assert.equal(locked, false);
    }
  });

  test('sin pedales pierde velocidad (aire, rodadura y freno motor) pero no va para atrás', () => {
    const car = carOnGrid(t, { speed: 60, gear: 6 });
    drive(car, t, {}, 2);
    assert.ok(car.speed < 55 && car.speed > 30);
  });

  test('el volante dobla para su lado, igual para los dos lados', () => {
    const turn = (steer) => {
      const car = carOnGrid(t, { speed: 30, gear: 4 }),
        a = car.angle;
      drive(car, t, { throttle: 0.3, steer }, 0.5);
      return car.angle - a;
    };
    const right = turn(1),
      left = turn(-1);
    assert.ok(right > 0.1 && left < -0.1);
    assert.ok(Math.abs(right + left) < 1e-3);
  });

  test('gasta nafta acelerando, no sin acelerar', () => {
    const car = carOnGrid(t);
    car.fuel = 50;
    drive(car, t, { throttle: 1 }, 5);
    assert.ok(car.fuel < 50 && car.fuel > 49);
    const coasting = carOnGrid(t, { speed: 60, gear: 6 });
    coasting.fuel = 50;
    drive(coasting, t, {}, 2);
    assert.equal(coasting.fuel, 50);
  });

  test('las gomas se calientan acelerando y se gastan si el desgaste está prendido', () => {
    const car = carOnGrid(t);
    car.wearRate = 1 / (t.length * t.meters);
    const cold = [...car.tyreTemp];
    drive(car, t, { throttle: 1 }, 6);
    assert.ok(car.tyreTemp[2] > cold[2] && car.tyreTemp[3] > cold[3]); // las de atrás, que empujan
    assert.ok(car.wear > 0 && car.wear < 0.2);
  });

  test('un auto que abandona frena, queda parado y lo sacan de la pista', () => {
    const car = carOnGrid(t, { speed: 40, gear: 5 });
    car.damage = { ...car.damage, retired: 'Suspensión rota' };
    const { time } = drive(car, t, { throttle: 1 }, 30, (c) => c.gone);
    assert.ok(car.gone, `a los ${time.toFixed(1)} s sigue en pista a ${kmh(car.speed).toFixed(1)} km/h`);
    assert.ok(car.speed >= -0.5);
  });
});

describe('Car: caja y largada', () => {
  test('con caja manual no deja bajar si el motor se pasa de vueltas', () => {
    const car = carOnGrid(t, { speed: 80, gear: 7 });
    car.manual = true;
    assert.equal(car.shift(-1), false);
    assert.equal(car.gear, 7);
    assert.equal(car.shift(1), true);
    assert.equal(car.gear, Math.min(car.gears, 8));
  });

  test('la largada sale bien dentro de la ventana de vueltas, se ahoga abajo y patina arriba', () => {
    const launch = (rpm) => {
      const car = carOnGrid(t);
      car.rpm = rpm;
      return [car.launch(), car.launchFactor];
    };
    const [lo, hi] = LAUNCH_WINDOW;
    assert.deepEqual(launch((lo + hi) / 2), ['perfect', 1]);
    const [bog, bogFactor] = launch(lo - 2000),
      [spin, spinFactor] = launch(PROFILE.maxRpm);
    assert.equal(bog, 'bog');
    assert.equal(spin, 'spin');
    assert.ok(bogFactor < 1 && spinFactor < 1);
  });
});

describe('ayudas del teclado', () => {
  test('el volante salta enseguida, sube más despacio cuanto más rápido va y vuelve solo al centro', () => {
    assert.ok(keyboardSteer(0, 1, 0, DT) >= 0.35);
    assert.ok(keyboardSteer(0, -1, 0, DT) <= -0.35);
    const slow = keyboardSteer(0.5, 1, 0, DT) - 0.5,
      fast = keyboardSteer(0.5, 1, 80, DT) - 0.5;
    assert.ok(slow > fast && fast > 0);
    assert.ok(keyboardSteer(0.5, 0, 50, DT) < 0.5);
    // nunca pasa del fondo
    let s = 0;
    for (let i = 0; i < 120; i++) s = keyboardSteer(s, 1, 0, DT);
    assert.equal(s, 1);
  });

  test('el freno suelta hasta 45 % con el volante a fondo, sólo rápido, y de a poco', () => {
    assert.equal(keyboardBrake(0.5, false, 0, 50, DT), 0);
    assert.equal(keyboardBrake(0, true, 0, 80, DT), 1);
    assert.ok(Math.abs(keyboardBrake(0, true, 1, 80, DT) - 0.55) < 1e-12);
    assert.equal(keyboardBrake(0, true, 1, 2, DT), 1); // despacio no suelta
    const next = keyboardBrake(1, true, 1, 80, DT);
    assert.ok(next < 1 && next > 0.9);
  });
});

describe('slipstream', () => {
  const at = (car, ahead, side = 0, turned = 0) => {
    const o = carOnGrid(t);
    const fx = Math.cos(car.angle),
      fy = Math.sin(car.angle);
    o.x = car.x + (ahead * fx - side * fy) / t.meters;
    o.y = car.y + (ahead * fy + side * fx) / t.meters;
    o.angle = car.angle + turned;
    return o;
  };
  test('hay estela detrás de otro auto, más cuanto más cerca, y nada al costado, adelante ni de frente', () => {
    const car = carOnGrid(t);
    const near = slipstream(car, [car, at(car, 10)], t.meters),
      far = slipstream(car, [car, at(car, 30)], t.meters);
    assert.ok(near > far && far > 0);
    assert.equal(slipstream(car, [car, at(car, 10, 5)], t.meters), 0);
    assert.equal(slipstream(car, [car, at(car, -10)], t.meters), 0);
    assert.equal(slipstream(car, [car, at(car, 10, 0, Math.PI)], t.meters), 0);
  });
});
