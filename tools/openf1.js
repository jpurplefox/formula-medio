// A track's real qualifying session, taken from what tools/layout.py downloaded to tools/.cache/ (OpenF1): the car
// positions about 4 times per second, already placed on the track drawing, and the times and speed traps of each
// lap.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = (p) => new URL('../' + p, import.meta.url);
const CACHE = fileURLToPath(root('tools/.cache/'));

const cached = (endpoint, query) => {
  const f = CACHE + `${endpoint}_${encodeURIComponent(query)}.json`; // with the % as is (not as a URL)
  return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null;
};
const time = (d) => Date.parse(d) / 1000;

// Qualifying: the speed along the lap [{ s (m from the start line), v (m/s) }], the median of the TOP fastest laps,
// and the pole time and driver. Each position is projected onto the track centerline (tracks/<id>.layout.json):
// adding up the distance between positions overcounts, because each one has an error of a meter or so and the lap
// comes out zigzagging. The position timestamps still jitter a little, so the speed comes from a line fitted to the
// distance covered within ±WINDOW.
const TOP = 5,
  BIN = 10,
  SMOOTH = 30; // m
const WINDOW = 0.8; // s
export function realLap(def) {
  const sessions = cached('sessions', `circuit_short_name=${def.circuit}&year=2025`);
  const q = sessions?.find((s) => s.session_name === 'Qualifying');
  if (!q) return null;
  const drivers = cached('drivers', `session_key=${q.session_key}`) ?? [];
  const laps = [];
  for (const d of drivers) {
    for (const l of cached('laps', `session_key=${q.session_key}&driver_number=${d.driver_number}`) ?? []) {
      if (l.lap_duration && l.date_start) laps.push({ ...l, name: d.name_acronym });
    }
  }
  laps.sort((a, b) => a.lap_duration - b.lap_duration);
  const center = centerLine(def);
  const traces = laps.slice(0, TOP).map((l) => lapTrace(q.session_key, l, center));
  const bins = Array.from({ length: Math.floor(center.length / BIN) }, () => []);
  for (const t of traces) for (const p of t) bins[Math.floor(p.s / BIN)]?.push(p.v);
  const median = (a) => a.sort((x, y) => x - y)[a.length >> 1];
  const raw = bins.map((b) => (b.length ? median(b) : NaN));
  // and an average over ±SMOOTH meters, so the remaining noise does not look like a corner
  const pts = [];
  raw.forEach((_, i) => {
    const near = raw.slice(Math.max(0, i - SMOOTH / BIN), i + SMOOTH / BIN + 1).filter((v) => v === v);
    if (near.length) pts.push({ s: (i + 0.5) * BIN, v: near.reduce((a, v) => a + v, 0) / near.length });
  });
  const pole = laps[0];
  return {
    pts,
    length: center.length,
    lapTime: pole.lap_duration,
    driver: pole.name, // speed traps (radar): the highest of the lap, in m/s
    trap: Math.max(pole.st_speed ?? 0, pole.i1_speed ?? 0, pole.i2_speed ?? 0) / 3.6,
  };
}

// The track centerline, with each point's distance from the start line
function centerLine(def) {
  const { points } = JSON.parse(readFileSync(root(def.layout), 'utf8'));
  const s = [0];
  for (let i = 1; i <= points.length; i++) {
    const a = points[i - 1],
      b = points[i % points.length];
    s.push(s[i - 1] + Math.hypot(b[0] - a[0], b[1] - a[1]));
  }
  return { points, s, length: s[points.length] };
}

// One lap: [{ s, v }]. tools/layout.py saves the points as (x - x0, y1 - y) of the OpenF1 positions (in m), with x0
// the smallest x and y1 the largest y: the same is done to the lap before projecting it.
function lapTrace(session, lap, { points, s: cs, length }) {
  const t0 = time(lap.date_start),
    t1 = t0 + lap.lap_duration;
  const loc = cached('location', `session_key=${session}&driver_number=${lap.driver_number}`)
    .map((p) => ({ t: time(p.date), x: p.x / 10, y: p.y / 10 }))
    .filter((p) => p.t >= t0 - 3 && p.t <= t1 + 3);
  const inLap = loc.filter((p) => p.t >= t0 && p.t <= t1);
  const x0 = Math.min(...inLap.map((p) => p.x)) - Math.min(...points.map((p) => p[0]));
  const y1 = Math.max(...inLap.map((p) => p.y)) + Math.min(...points.map((p) => p[1]));
  const n = points.length;
  let last = -1,
    turns = 0,
    prevS = null;
  for (const p of loc) {
    const x = p.x - x0,
      y = y1 - p.y;
    let best = Infinity,
      bs = 0,
      bi = 0;
    const range = last < 0 ? [0, n] : [last - 40, last + 40];
    for (let k = range[0]; k < range[1]; k++) {
      const i = ((k % n) + n) % n,
        a = points[i],
        b = points[(i + 1) % n];
      const ex = b[0] - a[0],
        ey = b[1] - a[1],
        l2 = ex * ex + ey * ey || 1e-9;
      const f = Math.max(0, Math.min(1, ((x - a[0]) * ex + (y - a[1]) * ey) / l2));
      const d = (x - a[0] - ex * f) ** 2 + (y - a[1] - ey * f) ** 2;
      if (d < best) [best, bs, bi] = [d, cs[i] + f * (cs[i + 1] - cs[i]), i];
    }
    last = bi;
    if (prevS !== null && bs - prevS < -length / 2) turns++;
    prevS = bs;
    p.s = bs + turns * length; // without going back to zero when crossing the line
  }
  // the lap starts where the car was at t0
  const i0 = loc.findIndex((p) => p.t >= t0),
    a = loc[i0 - 1] ?? loc[i0],
    b = loc[i0];
  const start = a.s + ((b.s - a.s) * (t0 - a.t)) / (b.t - a.t || 1);
  const lapStart = Math.round(start / length) * length; // the nearest start line
  const out = [];
  for (const p of loc) {
    if (p.t < t0 || p.t > t1) continue;
    const near = loc.filter((q) => Math.abs(q.t - p.t) <= WINDOW);
    const mt = near.reduce((a, q) => a + q.t, 0) / near.length,
      ms = near.reduce((a, q) => a + q.s, 0) / near.length;
    const v = near.reduce((a, q) => a + (q.t - mt) * (q.s - ms), 0) / near.reduce((a, q) => a + (q.t - mt) ** 2, 0);
    const s = p.s - lapStart;
    if (s >= 0 && s < length) out.push({ s, v });
  }
  return out;
}
