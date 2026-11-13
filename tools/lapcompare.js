// Compara la vuelta de la pole real (clasificación 2025, OpenF1) con el auto del juego, circuito por circuito: la
// velocidad a lo largo de la vuelta, el tiempo, la velocidad punta y la de cada curva. Sirve para calibrar la física.
//
// La vuelta real sale de tools/openf1.js: la velocidad es lo que avanzan sobre el dibujo del circuito por segundo
// (ojo: los tiempos de las posiciones bailan, así que la punta sale unos km/h de más; la de verdad es la trampa).
// Del juego salen dos curvas:
//   límite  la trazada ideal con todo el agarre y la frenada (racingline.js): lo máximo que da la física
//   red     la red del juego dando una vuelta lanzada sola: lo que de verdad hace el auto
//
//   node tools/lapcompare.js [circuitos separados por coma] [salida.html]

import { readFileSync, writeFileSync } from 'node:fs';
import { Car, limitsOn } from '../src/sim/car.js';
import { GAME_NET, Policy, NeuralDriver } from '../src/drivers/policy.js';
import { racingLine } from '../src/sim/racingline.js';
import { stationAt } from '../src/sim/track.js';
import { gridSlots } from '../src/race/grid.js';
import { loadTrack, TRACK_IDS } from '../rl/tracks.js';
import { TRACKS } from '../tracks/index.js';
import { realLap } from './openf1.js';

const root = (p) => new URL('../' + p, import.meta.url);
const DT = 1 / 60;

const [ids = TRACK_IDS.join(','), out = 'tools/.out/vueltas.html'] = process.argv.slice(2);
const profile = JSON.parse(readFileSync(root('cars/f1-2025.json'), 'utf8'));
const policy = new Policy(JSON.parse(readFileSync(root(GAME_NET), 'utf8')));

// Una vuelta lanzada de la red sola en la pista: [{ s (fracción de la vuelta), v }] y tiempo
function netLap(track, setup) {
  const slot = gridSlots(track, 1)[0];
  const car = new Car(slot.x, slot.y, slot.angle, profile);
  if (setup) car.setup = setup;
  car.launch();
  car.throttle = 1;
  const driver = new NeuralDriver(policy),
    line = racingLine(track, limitsOn(profile, track), { brakeUse: 0.93 });
  let prev = stationAt(track, car.x, car.y),
    lap = 0,
    t0 = 0,
    pts = [];
  for (let t = 0; t < 500 && lap < 4; t += DT) {
    car.update(DT, driver.drive(DT, track, line, { car }), track);
    const u = stationAt(track, car.x, car.y);
    if (u < 0) continue;
    if (u - prev < -track.length / 2) {
      lap++;
      if (lap === 3) return { pts, lapTime: t - t0 }; // la segunda vuelta entera: lanzada
      t0 = t;
      pts = [];
    }
    if (lap === 2) pts.push({ s: u / track.length, v: car.speed });
    prev = u;
  }
  return null;
}

// La trazada ideal al límite: velocidad por celda y tiempo aproximado (con el largo de la línea central, un poco más
// larga que la trazada)
function limitLap(track) {
  const line = racingLine(track, limitsOn(profile, track), { gripUse: 1, brakeUse: 1 });
  const L = line.speed.length - 1;
  let t = 0;
  for (let u = 0; u < L; u++) t += track.meters / line.speed[u];
  return { pts: Array.from(line.speed.subarray(0, L), (v, u) => ({ s: u / L, v })), lapTime: t };
}

// Lo que se compara de cada vuelta: punta y mínimo de cada curva (los valles de la velocidad: lo más lento en
// ±100 m y al menos 40 km/h menos que lo más rápido en ±300 m). s en fracción de la vuelta.
function summary(pts, length) {
  const top = Math.max(...pts.map((p) => p.v));
  const valleys = [];
  const around = (i, m) => pts.filter((p) => Math.abs(p.s - pts[i].s) * length < m).map((p) => p.v);
  for (let i = 0; i < pts.length; i++) {
    const v = pts[i].v;
    if (v === Math.min(...around(i, 100)) && Math.max(...around(i, 300)) - v > 11) valleys.push({ s: pts[i].s, v });
  }
  return { top, valleys };
}

const kmh = (v) => (v * 3.6).toFixed(0);

function chart(id, real, lines) {
  const W = 1000,
    H = 260,
    pad = 34,
    max = 100;
  const X = (f) => pad + f * (W - pad - 8),
    Y = (v) => H - 20 - (v / max) * (H - 30);
  const path = (pts, f) => 'M' + pts.map((p) => `${X(f(p)).toFixed(1)},${Y(p.v).toFixed(1)}`).join('L');
  let g = '';
  for (let k = 50; k <= 350; k += 50)
    g += `<line x1="${pad}" x2="${W - 8}" y1="${Y(k / 3.6)}" y2="${Y(k / 3.6)}" class="grid"/><text x="${pad - 4}" y="${Y(k / 3.6) + 4}" class="ax">${k}</text>`;
  for (let m = 0; m < real.length; m += 1000)
    g += `<text x="${X(m / real.length)}" y="${H - 4}" class="ax">${m / 1000} km</text>`;
  const series = [`<path d="${path(real.pts, (p) => p.s / real.length)}" class="real"/>`].concat(
    lines.map((l) => `<path d="${path(l.pts, (p) => p.s)}" class="${l.cls}"/>`),
  );
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="velocidad en ${id}">${g}${series.join('')}</svg>`;
}

const rows = [],
  charts = [];
for (const id of ids.split(',')) {
  const def = TRACKS.find((t) => t.id === id);
  const real = realLap(def);
  if (!real) {
    console.log(`${id}: no hay clasificación en el caché`);
    continue;
  }
  const track = loadTrack(id);
  const limit = limitLap(track),
    net = netLap(track);
  const rs = summary(
    real.pts.map((p) => ({ s: p.s / real.length, v: p.v })),
    real.length,
  );
  const ls = summary(limit.pts, real.length);
  const ns = net && summary(net.pts, real.length);
  // cada curva real con la del juego más cerca (en la vuelta)
  const near = (s, list) => list?.reduce((a, b) => (Math.abs(b.s - s) < Math.abs(a.s - s) ? b : a), list[0]);
  const corners = rs.valleys.map((c) => [c.v, near(c.s, ls.valleys)?.v, near(c.s, ns?.valleys)?.v]);
  const ratio = (k) => corners.reduce((a, c) => a + (c[k] ?? c[0]) / c[0], 0) / corners.length;
  rows.push({ id, real, limit, net, rs, ls, ns, corners, curveLimit: ratio(1), curveNet: ratio(2) });
  console.log(
    `${id.padEnd(12)} real ${real.lapTime.toFixed(2)} s (${real.driver}), punta ${kmh(rs.top)} · ` +
      `límite ${limit.lapTime.toFixed(2)} s, punta ${kmh(ls.top)}, curvas ×${ratio(1).toFixed(2)} · ` +
      (net
        ? `red ${net.lapTime.toFixed(2)} s, punta ${kmh(ns.top)}, curvas ×${ratio(2).toFixed(2)}`
        : 'red: no completó'),
  );
  charts.push(`<section><h2>${def.name} <small>pole ${real.driver} ${real.lapTime.toFixed(3)} s</small></h2>${chart(
    id,
    real,
    [{ pts: limit.pts, cls: 'limit' }, ...(net ? [{ pts: net.pts, cls: 'net' }] : [])],
  )}
    <p class="corners">curvas (km/h, real / límite / red): ${corners.map((c) => c.map((v) => (v ? kmh(v) : '–')).join('/')).join(' · ')}</p></section>`);
}

const td = (x) => `<td>${x}</td>`;
const table = `<table><tr><th>Circuito</th><th>Real</th><th>Límite</th><th>Red</th><th>Punta real</th><th>Punta límite</th><th>Punta red</th><th>Curvas límite/real</th><th>Curvas red/real</th></tr>${rows
  .map(
    (r) =>
      `<tr>${td(r.id)}${td(r.real.lapTime.toFixed(2))}${td(r.limit.lapTime.toFixed(2))}${td(r.net ? r.net.lapTime.toFixed(2) : '–')}${td(kmh(r.rs.top))}${td(kmh(r.ls.top))}${td(r.ns ? kmh(r.ns.top) : '–')}${td('×' + r.curveLimit.toFixed(2))}${td('×' + r.curveNet.toFixed(2))}</tr>`,
  )
  .join('')}</table>`;
writeFileSync(
  out,
  `<!doctype html><meta charset="utf-8"><title>Vuelta real vs juego</title>
<style>
body{font:14px system-ui;margin:16px;background:#fff;color:#222}h2{font-size:15px;margin:18px 0 4px}small{color:#777;font-weight:400}
svg{width:100%;height:auto;background:#fafafa}.grid{stroke:#e4e4e4}.ax{font-size:10px;fill:#888;text-anchor:end}
path{fill:none;stroke-width:1.4}.real{stroke:#222}.limit{stroke:#2a73d6}.net{stroke:#e8002d}
table{border-collapse:collapse}td,th{padding:3px 8px;border-bottom:1px solid #eee;text-align:right}.corners{color:#555;font-size:12px;margin:2px 0}
.key span{display:inline-block;width:18px;height:3px;margin:0 4px 3px 12px;vertical-align:middle}
</style>
<h1>Vuelta real vs juego</h1><p class="key"><span style="background:#222"></span>pole real 2025<span style="background:#2a73d6"></span>límite de la física<span style="background:#e8002d"></span>red del juego</p>
${table}${charts.join('')}`,
);
console.log(`→ ${out}`);
