// La clasificación real de un circuito, sacada de lo que bajó tools/layout.py a tools/.cache/ (OpenF1): las
// posiciones de los autos unas 4 veces por segundo, ya puestas sobre el dibujo del circuito, y los tiempos y las
// trampas de velocidad de cada vuelta.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = (p) => new URL('../' + p, import.meta.url);
const CACHE = fileURLToPath(root('tools/.cache/'));

const cached = (endpoint, query) => {
  const f = CACHE + `${endpoint}_${encodeURIComponent(query)}.json`; // con los % tal cual (no como URL)
  return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null;
};
const time = (d) => Date.parse(d) / 1000;

// La clasificación: la velocidad a lo largo de la vuelta [{ s (m desde la largada), v (m/s) }], la mediana de las
// TOP vueltas más rápidas, y el tiempo y el piloto de la pole. Cada posición se proyecta sobre la línea central del
// circuito (tracks/<id>.layout.json): sumar lo que hay entre posición y posición cuenta de más, porque cada una
// tiene un error de algún metro y la vuelta sale en zigzag. Igual los tiempos de las posiciones bailan un poco, así
// que la velocidad sale de una recta ajustada a lo que avanzó en ±WINDOW.
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
  // y un promedio en ±SMOOTH metros, para que lo que queda de ruido no parezca una curva
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
    driver: pole.name, // trampas de velocidad (radar): la más alta de la vuelta, en m/s
    trap: Math.max(pole.st_speed ?? 0, pole.i1_speed ?? 0, pole.i2_speed ?? 0) / 3.6,
  };
}

// La línea central del circuito, con la distancia desde la largada de cada punto
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

// Una vuelta: [{ s, v }]. tools/layout.py guarda los puntos como (x - x0, y1 - y) de las posiciones de OpenF1 (en
// m), con x0 la x más chica e y1 la y más grande: lo mismo se le hace a la vuelta antes de proyectarla.
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
    p.s = bs + turns * length; // sin volver a cero al pasar la línea
  }
  // la vuelta empieza donde estaba el auto en t0
  const i0 = loc.findIndex((p) => p.t >= t0),
    a = loc[i0 - 1] ?? loc[i0],
    b = loc[i0];
  const start = a.s + ((b.s - a.s) * (t0 - a.t)) / (b.t - a.t || 1);
  const lapStart = Math.round(start / length) * length; // la línea de largada más cercana
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
