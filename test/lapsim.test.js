// lapsim.js y racingline.js: la velocidad más alta en cada punto de una trazada, y la trazada sobre un circuito real.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { limitsOn } from '../src/sim/car.js';
import { carLimits } from '../src/sim/dynamics.js';
import { cornerSpeed, lapSim, pathFromPoints } from '../src/sim/lapsim.js';
import { racingLine } from '../src/sim/racingline.js';
import { halfWidthAt } from '../src/sim/track.js';
import { kmh, PROFILE, track } from './helpers.js';

const lim = carLimits(PROFILE);

// un círculo de radio r (m), con puntos cada grado
const circle = (r) =>
  pathFromPoints(
    Array.from({ length: 360 }, (_, i) => [
      r * Math.cos((i * Math.PI) / 180),
      r * Math.sin((i * Math.PI) / 180),
      i / 360,
    ]),
  );

// un óvalo: dos rectas de `straight` m unidas por medias vueltas de radio r
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
  test('un círculo de radio r tiene curvatura 1/r y su largo', () => {
    const p = circle(100);
    // salvo cerca de donde cierra la vuelta, que queda un tramo más corto que los demás
    for (let i = 8; i < p.n - 8; i++) assert.ok(Math.abs(p.k[i] - 0.01) < 1e-4, `punto ${i}: ${p.k[i]}`);
    assert.ok(Math.abs(p.n * p.ds - 2 * Math.PI * 100) < 2 * p.ds);
  });
  test('la fracción de vuelta va de 0 a 1', () => {
    const p = circle(100);
    assert.ok(p.f[0] < 0.01 && p.f[p.n - 1] > 0.99);
  });
});

describe('cornerSpeed', () => {
  test('en la velocidad de la curva, lo que pide doblar (v²/r) es lo que aguanta el agarre', () => {
    for (const r of [30, 60, 100]) {
      const v = cornerSpeed(lim, 1 / r);
      assert.ok(Math.abs((v * v) / r - lim.lateral(v)) / lim.lateral(v) < 0.01, `radio ${r}`);
    }
  });
  test('una curva que se toma a fondo da la punta', () => {
    const r = 1000;
    assert.equal(cornerSpeed(lim, 1 / r), lim.topSpeed);
    assert.ok(lim.topSpeed ** 2 / r <= lim.lateral(lim.topSpeed));
  });
  test('más cerrada, más lenta; en recta, la punta; y usando menos agarre, más lenta', () => {
    assert.ok(cornerSpeed(lim, 1 / 30) < cornerSpeed(lim, 1 / 100));
    assert.equal(cornerSpeed(lim, 0), lim.topSpeed);
    assert.ok(cornerSpeed(lim, 1 / 100, 0.9) < cornerSpeed(lim, 1 / 100));
  });
});

describe('lapSim', () => {
  test('en un círculo va siempre a la velocidad de la curva', () => {
    const p = circle(100),
      v = cornerSpeed(lim, 0.01);
    const { time } = lapSim(p, lim);
    assert.ok(Math.abs(time - (p.n * p.ds) / v) / time < 0.01);
  });
  test('en un óvalo acelera en las rectas, frena antes de las curvas y nunca pasa la punta', () => {
    const p = oval(1000, 60);
    const { v, time } = lapSim(p, lim);
    const slowest = Math.min(...v),
      fastest = Math.max(...v);
    assert.ok(Math.abs(slowest - cornerSpeed(lim, 1 / 60)) / slowest < 0.05);
    assert.ok(fastest > 1.5 * slowest && fastest <= lim.topSpeed + 1e-9);
    // más lento que ir siempre a fondo y más rápido que ir siempre a la velocidad de la curva
    assert.ok(time > (p.n * p.ds) / fastest && time < (p.n * p.ds) / slowest);
  });
});

describe('racingLine', () => {
  const t = track('monza');
  const line = racingLine(t, limitsOn(PROFILE, t));
  test('da una velocidad por punto de la línea central, todas razonables', () => {
    assert.ok(Math.abs(line.speed.length - t.length) <= 2);
    for (const v of line.speed) assert.ok(v > 15 && v < 110);
  });
  test('en Monza: punta de más de 320 km/h y las chicanas por debajo de 120 km/h', () => {
    assert.ok(kmh(Math.max(...line.speed)) > 320);
    assert.ok(kmh(Math.min(...line.speed)) < 120);
  });
  test('la línea no se sale de la pista', () => {
    // offset: celdas desde la línea central, en cada posición de la línea central (de a una celda)
    for (let u = 0; u < t.length; u++) assert.ok(Math.abs(line.offset[u]) <= halfWidthAt(t, u), `posición ${u}`);
  });
});
