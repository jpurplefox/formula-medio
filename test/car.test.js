// car.js: the car driving on a real track (Monza, from the grid, on the straight), and the keyboard aids.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { keyboardBrake, keyboardSteer, LAUNCH_WINDOW, slipstream } from '../src/sim/car.js';
import { carOnGrid, DT, drive, kmh, PROFILE, track } from './helpers.js';

const t = track('monza');

describe('Car: driving', () => {
  test('stopped and with no pedals, it does not move', () => {
    const car = carOnGrid(t);
    const { meters } = drive(car, t, {}, 3);
    assert.ok(meters < 0.01 && Math.abs(car.speed) < 0.01);
  });

  test('full throttle: 0 to 100 km/h in 2.5 to 5 s, shifts up and does not pass the rev limiter', () => {
    const car = carOnGrid(t);
    let maxRpm = 0;
    const { time } = drive(car, t, { throttle: 1 }, 10, (c) => {
      maxRpm = Math.max(maxRpm, c.rpm);
      return kmh(c.speed) >= 100;
    });
    assert.ok(time > 2.5 && time < 5, `0-100 in ${time.toFixed(2)} s`);
    drive(car, t, { throttle: 1 }, 3);
    assert.ok(car.gear >= 3);
    assert.ok(maxRpm <= PROFILE.maxRpm);
  });

  test('full braking from 288 km/h stops in under 160 m (with and without ABS)', () => {
    for (const abs of [false, true]) {
      const car = carOnGrid(t, { speed: 80, gear: 7 });
      car.abs = abs;
      let locked = false;
      const { time, meters } = drive(car, t, { brake: 1 }, 10, (c) => {
        locked ||= c.locked[0] || c.locked[1];
        return c.speed < 0.5;
      });
      assert.ok(meters > 60 && meters < 160 && time < 5, `ABS ${abs}: ${meters.toFixed(1)} m in ${time.toFixed(2)} s`);
      // ABS releases the brake before a wheel locks
      if (abs) assert.equal(locked, false);
    }
  });

  test('with no pedals it loses speed (air, rolling and engine braking) but does not go backwards', () => {
    const car = carOnGrid(t, { speed: 60, gear: 6 });
    drive(car, t, {}, 2);
    assert.ok(car.speed < 55 && car.speed > 30);
  });

  test('the steering turns toward its side, the same for both sides', () => {
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

  test('it burns fuel on throttle, not off throttle', () => {
    const car = carOnGrid(t);
    car.fuel = 50;
    drive(car, t, { throttle: 1 }, 5);
    assert.ok(car.fuel < 50 && car.fuel > 49);
    const coasting = carOnGrid(t, { speed: 60, gear: 6 });
    coasting.fuel = 50;
    drive(coasting, t, {}, 2);
    assert.equal(coasting.fuel, 50);
  });

  test('tyres heat up under throttle and wear if wear is on', () => {
    const car = carOnGrid(t);
    car.wearRate = 1 / (t.length * t.meters);
    const cold = [...car.tyreTemp];
    drive(car, t, { throttle: 1 }, 6);
    assert.ok(car.tyreTemp[2] > cold[2] && car.tyreTemp[3] > cold[3]); // the rear ones, which push
    assert.ok(car.wear > 0 && car.wear < 0.2);
  });

  test('a car that retires brakes, stops and is removed from the track', () => {
    const car = carOnGrid(t, { speed: 40, gear: 5 });
    car.damage = { ...car.damage, retired: 'Suspensión rota' };
    const { time } = drive(car, t, { throttle: 1 }, 30, (c) => c.gone);
    assert.ok(car.gone, `after ${time.toFixed(1)} s still on track at ${kmh(car.speed).toFixed(1)} km/h`);
    assert.ok(car.speed >= -0.5);
  });
});

describe('Car: gearbox and start', () => {
  test('with a manual gearbox it does not allow a downshift that would over-rev the engine', () => {
    const car = carOnGrid(t, { speed: 80, gear: 7 });
    car.manual = true;
    assert.equal(car.shift(-1), false);
    assert.equal(car.gear, 7);
    assert.equal(car.shift(1), true);
    assert.equal(car.gear, Math.min(car.gears, 8));
  });

  test('the start is good inside the rpm window, bogs down below it and wheelspins above it', () => {
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

describe('keyboard aids', () => {
  test('steering jumps at once, builds more slowly the faster the car goes and returns to center on its own', () => {
    assert.ok(keyboardSteer(0, 1, 0, DT) >= 0.35);
    assert.ok(keyboardSteer(0, -1, 0, DT) <= -0.35);
    const slow = keyboardSteer(0.5, 1, 0, DT) - 0.5,
      fast = keyboardSteer(0.5, 1, 80, DT) - 0.5;
    assert.ok(slow > fast && fast > 0);
    assert.ok(keyboardSteer(0.5, 0, 50, DT) < 0.5);
    // never goes past full lock
    let s = 0;
    for (let i = 0; i < 120; i++) s = keyboardSteer(s, 1, 0, DT);
    assert.equal(s, 1);
  });

  test('the brake releases up to 45% at full lock, only at speed, and gradually', () => {
    assert.equal(keyboardBrake(0.5, false, 0, 50, DT), 0);
    assert.equal(keyboardBrake(0, true, 0, 80, DT), 1);
    assert.ok(Math.abs(keyboardBrake(0, true, 1, 80, DT) - 0.55) < 1e-12);
    assert.equal(keyboardBrake(0, true, 1, 2, DT), 1); // at low speed it does not release
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
  test('there is a wake behind another car, more the closer it is, and none beside, ahead or head-on', () => {
    const car = carOnGrid(t);
    const near = slipstream(car, [car, at(car, 10)], t.meters),
      far = slipstream(car, [car, at(car, 30)], t.meters);
    assert.ok(near > far && far > 0);
    assert.equal(slipstream(car, [car, at(car, 10, 5)], t.meters), 0);
    assert.equal(slipstream(car, [car, at(car, -10)], t.meters), 0);
    assert.equal(slipstream(car, [car, at(car, 10, 0, Math.PI)], t.meters), 0);
  });
});
