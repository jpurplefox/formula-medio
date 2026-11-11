// Compares the real pole lap (2025 qualifying, OpenF1) with the game car, track by track: the speed along the lap,
// the time, the top speed and the speed in each corner. It is used to calibrate the physics.
//
// The real lap comes from tools/openf1.js: the speed is the distance covered on the track drawing per second
// (careful: the position timestamps jitter, so the top speed comes out a few km/h too high; the true one is the trap).
// The game gives two curves:
//   limit    the racing line with all the grip and braking (racingline.js): the most the physics allows
//   network  the game network driving a flying lap alone: what the car really does
//
//   node tools/lapcompare.js [comma-separated tracks] [output.html]

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

const [ids = TRACK_IDS.join(','), out = 'tools/.out/laps.html'] = process.argv.slice(2);
const profile = JSON.parse(readFileSync(root('cars/f1-2025.json'), 'utf8'));
const policy = new Policy(JSON.parse(readFileSync(root(GAME_NET), 'utf8')));

// A flying lap by the network alone on the track: [{ s (lap fraction), v }] and time
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
      if (lap === 3) return { pts, lapTime: t - t0 }; // the whole second lap: a flying lap
      t0 = t;
      pts = [];
    }
    if (lap === 2) pts.push({ s: u / track.length, v: car.speed });
    prev = u;
  }
  return null;
}

// The racing line at the limit: speed per cell and approximate time (using the centerline length, a bit longer than
// the racing line)
function limitLap(track) {
  const line = racingLine(track, limitsOn(profile, track), { gripUse: 1, brakeUse: 1 });
  const L = line.speed.length - 1;
  let t = 0;
  for (let u = 0; u < L; u++) t += track.meters / line.speed[u];
  return { pts: Array.from(line.speed.subarray(0, L), (v, u) => ({ s: u / L, v })), lapTime: t };
}

// What is compared for each lap: top speed and the minimum of each corner (the speed valleys: the slowest point within
// ±100 m and at least 40 km/h below the fastest within ±300 m). s as a lap fraction.
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
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="speed at ${id}">${g}${series.join('')}</svg>`;
}

const rows = [],
  charts = [];
for (const id of ids.split(',')) {
  const def = TRACKS.find((t) => t.id === id);
  const real = realLap(def);
  if (!real) {
    console.log(`${id}: no qualifying session in the cache`);
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
  // each real corner paired with the nearest game corner (along the lap)
  const near = (s, list) => list?.reduce((a, b) => (Math.abs(b.s - s) < Math.abs(a.s - s) ? b : a), list[0]);
  const corners = rs.valleys.map((c) => [c.v, near(c.s, ls.valleys)?.v, near(c.s, ns?.valleys)?.v]);
  const ratio = (k) => corners.reduce((a, c) => a + (c[k] ?? c[0]) / c[0], 0) / corners.length;
  rows.push({ id, real, limit, net, rs, ls, ns, corners, curveLimit: ratio(1), curveNet: ratio(2) });
  console.log(
    `${id.padEnd(12)} real ${real.lapTime.toFixed(2)} s (${real.driver}), top ${kmh(rs.top)} · ` +
      `limit ${limit.lapTime.toFixed(2)} s, top ${kmh(ls.top)}, corners ×${ratio(1).toFixed(2)} · ` +
      (net
        ? `network ${net.lapTime.toFixed(2)} s, top ${kmh(ns.top)}, corners ×${ratio(2).toFixed(2)}`
        : 'network: did not finish'),
  );
  charts.push(`<section><h2>${def.name} <small>pole ${real.driver} ${real.lapTime.toFixed(3)} s</small></h2>${chart(
    id,
    real,
    [{ pts: limit.pts, cls: 'limit' }, ...(net ? [{ pts: net.pts, cls: 'net' }] : [])],
  )}
    <p class="corners">corners (km/h, real / limit / network): ${corners.map((c) => c.map((v) => (v ? kmh(v) : '–')).join('/')).join(' · ')}</p></section>`);
}

const td = (x) => `<td>${x}</td>`;
const table = `<table><tr><th>Track</th><th>Real</th><th>Limit</th><th>Network</th><th>Real top</th><th>Limit top</th><th>Network top</th><th>Corners limit/real</th><th>Corners network/real</th></tr>${rows
  .map(
    (r) =>
      `<tr>${td(r.id)}${td(r.real.lapTime.toFixed(2))}${td(r.limit.lapTime.toFixed(2))}${td(r.net ? r.net.lapTime.toFixed(2) : '–')}${td(kmh(r.rs.top))}${td(kmh(r.ls.top))}${td(r.ns ? kmh(r.ns.top) : '–')}${td('×' + r.curveLimit.toFixed(2))}${td('×' + r.curveNet.toFixed(2))}</tr>`,
  )
  .join('')}</table>`;
writeFileSync(
  out,
  `<!doctype html><meta charset="utf-8"><title>Real lap vs game</title>
<style>
body{font:14px system-ui;margin:16px;background:#fff;color:#222}h2{font-size:15px;margin:18px 0 4px}small{color:#777;font-weight:400}
svg{width:100%;height:auto;background:#fafafa}.grid{stroke:#e4e4e4}.ax{font-size:10px;fill:#888;text-anchor:end}
path{fill:none;stroke-width:1.4}.real{stroke:#222}.limit{stroke:#2a73d6}.net{stroke:#e8002d}
table{border-collapse:collapse}td,th{padding:3px 8px;border-bottom:1px solid #eee;text-align:right}.corners{color:#555;font-size:12px;margin:2px 0}
.key span{display:inline-block;width:18px;height:3px;margin:0 4px 3px 12px;vertical-align:middle}
</style>
<h1>Real lap vs game</h1><p class="key"><span style="background:#222"></span>real 2025 pole<span style="background:#2a73d6"></span>physics limit<span style="background:#e8002d"></span>game network</p>
${table}${charts.join('')}`,
);
console.log(`→ ${out}`);
