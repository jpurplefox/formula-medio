// Fits the car's numbers (cars/f1-2025.json: grip, power, downforce and drag, braking, traction) so that, with each
// track's setup and altitude (tracks/index.js), the laps resemble the real 2025 poles (tools/openf1.js): the speed
// along the lap and the top speed at the traps.
//
// Each lap is computed as in a lap simulator (src/sim/lapsim.js) over a fixed line: the one the game network drives
// (recorded once in tools/.cache/paths/; delete it to record it again with the current physics).
//
//   node tools/calibrate.js            measures the car as it is
//   node tools/calibrate.js --fit      searches for the best-fitting numbers and writes them to cars/f1-2025.json

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Car, limitsOn } from '../src/sim/car.js';
import { racingLine } from '../src/sim/racingline.js';
import { GAME_NET, Policy, NeuralDriver } from '../src/drivers/policy.js';
import { stationAt } from '../src/sim/track.js';
import { gridSlots } from '../src/race/grid.js';
import { carLimits, airDensity } from '../src/sim/dynamics.js';
import { pathFromPoints, lapSim } from '../src/sim/lapsim.js';
import { loadTrack, TRACK_IDS } from '../rl/tracks.js';
import { TRACKS } from '../tracks/index.js';
import { realLap } from './openf1.js';

const root = (p) => fileURLToPath(new URL('../' + p, import.meta.url));
const CAR = 'cars/f1-2025.json';
const PATHS = root('tools/.cache/paths/');
const DT = 1 / 60;

// The network's line on a flying lap: points in meters and the lap fraction of each one
function recordPath(id) {
  const file = PATHS + id + '.json';
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'));
  const track = loadTrack(id),
    M = track.meters;
  const profile = JSON.parse(readFileSync(root('cars/f1-2025.json'), 'utf8'));
  const driver = new NeuralDriver(new Policy(JSON.parse(readFileSync(root(GAME_NET), 'utf8'))));
  const slot = gridSlots(track, 1)[0];
  const car = new Car(slot.x, slot.y, slot.angle, profile);
  const line = racingLine(track, limitsOn(profile, track), { brakeUse: 0.93 });
  car.launch();
  let prev = stationAt(track, car.x, car.y),
    lap = 0,
    pts = [];
  for (let t = 0; t < 500 && lap < 3; t += DT) {
    car.update(DT, driver.drive(DT, track, line, { car }), track);
    const u = stationAt(track, car.x, car.y);
    if (u < 0) continue;
    if (u - prev < -track.length / 2) lap++;
    prev = u;
    if (lap === 2) pts.push([+(car.x * M).toFixed(2), +(car.y * M).toFixed(2), +(u / track.length).toFixed(5)]);
  }
  mkdirSync(PATHS, { recursive: true });
  writeFileSync(file, JSON.stringify(pts));
  return pts;
}

// What is measured on a track: the speed error (km/h, root mean square) against the real one, the lap time
// difference and the top speed difference against the trap
export function measure(car, c) {
  const lim = carLimits(car, c.def.tune, airDensity(c.def.altitude));
  const sim = lapSim(c.path, lim);
  const seen = blur(sim.v, c.path.ds);
  // robust error: up to HUBER km/h it counts squared and beyond that, linearly. The game's chicanes ended up more
  // open than the real ones (the layout is smoothed), and there the difference comes from the track, not the car
  let se = 0;
  for (let i = 0; i < c.path.n; i++) {
    const e = Math.abs(seen[i] - c.realAt(c.path.f[i])) * 3.6;
    se += e < HUBER ? e * e : HUBER * (2 * e - HUBER);
  }
  return {
    sim,
    seen,
    lim,
    rms: Math.sqrt(se / c.path.n),
    dt: sim.time - c.real.lapTime,
    dTop: (lim.topSpeed - c.real.trap) * 3.6,
  };
}

const HUBER = 15; // km/h

// The simulated speed as the real telemetry would see it (tools/openf1.js smooths it: a line over ±0.8 s and an
// average over ±30 m): an average over ±(0.3 s of travel + 15 m), which gives roughly the same. Otherwise the real
// braking zones look longer than they are.
export function blur(v, ds) {
  const n = v.length,
    out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const k = Math.round((0.3 * v[i] + 15) / ds);
    let sum = 0;
    for (let j = -k; j <= k; j++) sum += v[(i + j + n) % n];
    out[i] = sum / (2 * k + 1);
  }
  return out;
}

function circuits(ids = TRACK_IDS) {
  return ids.map((id) => {
    const def = TRACKS.find((t) => t.id === id);
    const real = realLap(def);
    const path = pathFromPoints(recordPath(id));
    // real speed at a lap fraction (interpolated)
    const realAt = (f) => {
      const s = f * real.length,
        p = real.pts;
      let i = p.findIndex((q) => q.s >= s);
      if (i <= 0) return p[i < 0 ? p.length - 1 : 0].v;
      return p[i - 1].v + ((p[i].v - p[i - 1].v) * (s - p[i - 1].s)) / (p[i].s - p[i - 1].s);
    };
    return { id, def, real, path, realAt };
  });
}

// Teams pick the fastest setup for each track: with more or less wing (both, or just one) the lap should not come out
// faster. Returns what the best change would gain (s, 0 if none gains).
const NEIGHBORS = [
  [1, 1],
  [-1, -1],
  [2, 2],
  [-2, -2],
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];
function tuneGain(car, c, base) {
  const air = airDensity(c.def.altitude),
    t = c.def.tune;
  let gain = 0;
  for (const [df, dr] of NEIGHBORS) {
    const tune = { ...t, front: t.front + df, rear: t.rear + dr };
    if (tune.front < 1 || tune.front > 10 || tune.rear < 1 || tune.rear > 10) continue;
    gain = Math.max(gain, base - lapSim(c.path, carLimits(car, tune, air)).time);
  }
  return gain;
}

// Total score: speed along the lap, time, top speed, and that each track's setup is the best one there (all in
// similar units)
const score = (car, cs) =>
  cs.reduce((a, c) => {
    const m = measure(car, c);
    return a + m.rms ** 2 + m.dt ** 2 + (0.5 * m.dTop) ** 2 + (20 * tuneGain(car, c, m.sim.time)) ** 2;
  }, 0) / cs.length;

// What gets fitted: [path inside the car, minimum, maximum]. Braking (brakeMu) and how much grip is lost per kilo
// of load (loadExp) stay fixed at reasonable values: the position telemetry is so smoothed that it cannot tell one
// braking zone from another well, and the fit pushed them anywhere to make up for other things. Grip (mu) stays
// within what a slick tyre gives: otherwise the fit trades downforce for mechanical grip to gain in the chicanes,
// which ended up more open in the game than the real ones.
const KNOBS = [
  ['mu', 1.6, 1.9],
  ['power', 450000, 800000],
  ['tractionMu', 0.9, 1.15],
  ['aero.clMin', 1, 8],
  ['aero.cdBody', 0.4, 1.6],
  ['aero.ldRear', 1, 8],
];
// How much more downforce full wing gives than minimum wing: what is known from F1 (from the Monza setup to the
// Monaco one, ~45% more). Without this the fit made the wings change almost nothing, so any setup was the best.
const WING_SPAN = 1.45;
const get = (o, k) => k.split('.').reduce((x, p) => x[p], o);
const set = (o, k, v) => {
  const ps = k.split('.'),
    last = ps.pop();
  ps.reduce((x, p) => x[p], o)[last] = v;
};

// Nelder–Mead over the parameters normalized to 0..1
function fit(car, cs) {
  const toCar = (x) => {
    const c = structuredClone(car);
    KNOBS.forEach(([k, lo, hi], i) => set(c, k, lo + (hi - lo) * Math.min(1, Math.max(0, x[i]))));
    c.aero.clMax = c.aero.clMin * WING_SPAN;
    return c;
  };
  const f = (x) => score(toCar(x), cs);
  const x0 = KNOBS.map(([k, lo, hi]) => (get(car, k) - lo) / (hi - lo));
  let simplex = [x0, ...x0.map((_, i) => x0.map((v, j) => (i === j ? v + 0.08 : v)))].map((x) => ({ x, f: f(x) }));
  for (let it = 0; it < 600; it++) {
    simplex.sort((a, b) => a.f - b.f);
    if (it % 50 === 0) console.log(`  ${it}: ${simplex[0].f.toFixed(2)}`);
    const n = x0.length,
      best = simplex[0],
      worst = simplex[n];
    const c = x0.map((_, j) => simplex.slice(0, n).reduce((a, p) => a + p.x[j], 0) / n);
    const at = (k) => c.map((v, j) => v + k * (worst.x[j] - v));
    const r = { x: at(-1) };
    r.f = f(r.x);
    if (r.f < best.f) {
      const e = { x: at(-2) };
      e.f = f(e.x);
      simplex[n] = e.f < r.f ? e : r;
    } else if (r.f < simplex[n - 1].f) simplex[n] = r;
    else {
      const k = { x: at(0.5) };
      k.f = f(k.x);
      if (k.f < worst.f) simplex[n] = k;
      else
        simplex = simplex
          .map((p, i) => (i ? { x: p.x.map((v, j) => best.x[j] + 0.5 * (v - best.x[j])) } : p))
          .map((p) => ({ ...p, f: p.f ?? f(p.x) }));
    }
  }
  simplex.sort((a, b) => a.f - b.f);
  const out = toCar(simplex[0].x);
  KNOBS.forEach(([k]) => set(out, k, +get(out, k).toPrecision(4)));
  out.aero.clMax = +(out.aero.clMin * WING_SPAN).toPrecision(4);
  return out;
}

function report(car, cs) {
  for (const c of cs) {
    const m = measure(car, c);
    console.log(
      `${c.id.padEnd(12)} real ${c.real.lapTime.toFixed(2)} sim ${m.sim.time.toFixed(2)} (${m.dt >= 0 ? '+' : ''}${m.dt.toFixed(2)})` +
        ` · top ${(m.lim.topSpeed * 3.6).toFixed(0)} trap ${(c.real.trap * 3.6).toFixed(0)} · error ${m.rms.toFixed(1)} km/h` +
        ` · another setup gains ${tuneGain(car, c, m.sim.time).toFixed(2)} s`,
    );
  }
  console.log(`score ${score(car, cs).toFixed(2)}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const car = JSON.parse(readFileSync(root(CAR), 'utf8'));
  const cs = circuits();
  report(car, cs);
  if (process.argv.includes('--fit')) {
    const best = fit(car, cs);
    report(best, cs);
    writeFileSync(root(CAR), JSON.stringify(best, null, 1) + '\n');
    console.log(`→ ${CAR}`);
  }
  chartHtml(JSON.parse(readFileSync(root(CAR), 'utf8')), cs, root('tools/.out/calibration.html'));
}

// Chart of the simulated speed (as the telemetry would see it) against the real one, to see where it does not fit
function chartHtml(car, cs, file) {
  const W = 1000,
    H = 240,
    pad = 34,
    max = 100;
  const X = (f) => pad + f * (W - pad - 8),
    Y = (v) => H - 20 - (v / max) * (H - 30);
  const line = (pts, cls) =>
    `<path class="${cls}" d="M${pts.map(([f, v]) => `${X(f).toFixed(1)},${Y(v).toFixed(1)}`).join('L')}"/>`;
  const parts = cs.map((c) => {
    const m = measure(car, c);
    let g = '';
    for (let k = 50; k <= 350; k += 50)
      g += `<line x1="${pad}" x2="${W - 8}" y1="${Y(k / 3.6)}" y2="${Y(k / 3.6)}" class="grid"/><text x="${pad - 4}" y="${Y(k / 3.6) + 4}" class="ax">${k}</text>`;
    const real = c.real.pts.map((p) => [p.s / c.real.length, p.v]);
    const step = (i) => i % 3 === 0;
    const raw = Array.from(m.sim.v, (v, i) => [c.path.f[i], v]).filter((_, i) => step(i));
    const seen = Array.from(m.seen, (v, i) => [c.path.f[i], v]).filter((_, i) => step(i));
    return `<h2>${c.def.name} <small>real ${c.real.lapTime.toFixed(2)} · sim ${m.sim.time.toFixed(2)} · error ${m.rms.toFixed(1)} km/h</small></h2>
      <svg viewBox="0 0 ${W} ${H}">${g}${line(real, 'real')}${line(raw, 'raw')}${line(seen, 'sim')}</svg>`;
  });
  writeFileSync(
    file,
    `<!doctype html><meta charset="utf-8"><title>Calibration</title><style>body{font:14px system-ui;margin:16px;background:#fff}
  h2{font-size:15px;margin:14px 0 2px}small{color:#777;font-weight:400}svg{width:100%;height:auto;background:#fafafa}.grid{stroke:#e4e4e4}
  .ax{font-size:10px;fill:#888;text-anchor:end}path{fill:none;stroke-width:1.3}.real{stroke:#222}.sim{stroke:#e8002d}.raw{stroke:#e8002d;opacity:.3}</style>
  <p>black: real 2025 pole · red: simulation as the telemetry sees it (light: unsmoothed)</p>${parts.join('')}`,
  );
}
