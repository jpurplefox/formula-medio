// lapsim.js and racingline.js: the highest speed at each point of a line, and the racing line on a real track.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { limitsOn } from '../src/sim/car.js';
import { carLimits } from '../src/sim/dynamics.js';
import { cornerSpeed, lapSim, pathFromPoints } from '../src/sim/lapsim.js';
import { racingLine } from '../src/sim/racingline.js';
import { halfWidthAt } from '../src/sim/track.js';
import { kmh, PROFILE, track } from './helpers.js';

const lim = carLimits(PROFILE);

// a circle of radius r (m), with a point every degree
const circle = (r) =>
  pathFromPoints(
    Array.from({ length: 360 }, (_, i) => [
      r * Math.cos((i * Math.PI) / 180),
      r * Math.sin((i * Math.PI) / 180),
      i / 360,
    ]),
  );

// an oval: two straights of `straight` m joined by half circles of radius r
function oval(straight, r) {
  const pts = [];
  const half = (cx, from) => {
    for (let i = 0; i <= 90; i++) {
      const a = from + (i * Math.PI) / 90;
      pts.push([cx + r * Math.cos(a), r * Math.sin(a)]);
    }
  };
  for (let x = 0; x < straight; x += 5) pts.push([x, -r]);
  half(straight, -Math.PI / 2);
  for (let x = straight; x > 0; x -= 5) pts.push([x, r]);
  half(0, Math.PI / 2);
  return pathFromPoints(pts.map(([x, y], i) => [x, y, i / pts.length]));
}

describe('pathFromPoints', () => {
  test('a circle of radius r has curvature 1/r and the right length', () => {
    const p = circle(100);
    // except near where the loop closes, where one segment is shorter than the rest
    for (let i = 8; i < p.n - 8; i++) assert.ok(Math.abs(p.k[i] - 0.01) < 1e-4, `point ${i}: ${p.k[i]}`);
    assert.ok(Math.abs(p.n * p.ds - 2 * Math.PI * 100) < 2 * p.ds);
  });
  test('the lap fraction goes from 0 to 1', () => {
    const p = circle(100);
    assert.ok(p.f[0] < 0.01 && p.f[p.n - 1] > 0.99);
  });
});

describe('cornerSpeed', () => {
  test('at corner speed, what turning demands (v²/r) is what the grip can hold', () => {
    for (const r of [30, 60, 100]) {
      const v = cornerSpeed(lim, 1 / r);
      assert.ok(Math.abs((v * v) / r - lim.lateral(v)) / lim.lateral(v) < 0.01, `radius ${r}`);
    }
  });
  test('a flat-out corner gives top speed', () => {
    const r = 1000;
    assert.equal(cornerSpeed(lim, 1 / r), lim.topSpeed);
    assert.ok(lim.topSpeed ** 2 / r <= lim.lateral(lim.topSpeed));
  });
  test('tighter means slower; on a straight, top speed; and using less grip, slower', () => {
    assert.ok(cornerSpeed(lim, 1 / 30) < cornerSpeed(lim, 1 / 100));
    assert.equal(cornerSpeed(lim, 0), lim.topSpeed);
    assert.ok(cornerSpeed(lim, 1 / 100, 0.9) < cornerSpeed(lim, 1 / 100));
  });
});

describe('lapSim', () => {
  test('on a circle it always goes at corner speed', () => {
    const p = circle(100),
      v = cornerSpeed(lim, 0.01);
    const { time } = lapSim(p, lim);
    assert.ok(Math.abs(time - (p.n * p.ds) / v) / time < 0.01);
  });
  test('on an oval it accelerates on the straights, brakes before the corners and never exceeds top speed', () => {
    const p = oval(1000, 60);
    const { v, time } = lapSim(p, lim);
    const slowest = Math.min(...v),
      fastest = Math.max(...v);
    assert.ok(Math.abs(slowest - cornerSpeed(lim, 1 / 60)) / slowest < 0.05);
    assert.ok(fastest > 1.5 * slowest && fastest <= lim.topSpeed + 1e-9);
    // slower than always flat out and faster than always at corner speed
    assert.ok(time > (p.n * p.ds) / fastest && time < (p.n * p.ds) / slowest);
  });
});

describe('racingLine', () => {
  const t = track('monza');
  const line = racingLine(t, limitsOn(PROFILE, t));
  test('gives one speed per centerline point, all reasonable', () => {
    assert.ok(Math.abs(line.speed.length - t.length) <= 2);
    for (const v of line.speed) assert.ok(v > 15 && v < 110);
  });
  test('at Monza: top speed over 320 km/h and the chicanes below 120 km/h', () => {
    assert.ok(kmh(Math.max(...line.speed)) > 320);
    assert.ok(kmh(Math.min(...line.speed)) < 120);
  });
  test('the line stays on the track', () => {
    // offset: cells from the centerline, at each centerline position (one cell apart)
    for (let u = 0; u < t.length; u++) assert.ok(Math.abs(line.offset[u]) <= halfWidthAt(t, u), `position ${u}`);
  });
});
