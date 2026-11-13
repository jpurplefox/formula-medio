// Racing line: the line that uses the full width of the track to open up the corners,
// and the speed the car can carry at each point of that line with its limits (car.limits).
// Everything is stored by position along the centerline (one entry per cell), like the kerbs.

import { cornerSpeed } from './lapsim.js';
import { curvature, halfWidthAt } from './track.js';

const MARGIN = 1.3; // minimum distance from the racing line to the track edge (m): half a car and a bit more
const GRIP_USE = 0.94; // fraction of the lateral grip the racing line uses (a little margin)
const BRAKE_USE = 0.85; // fraction of the maximum braking, so the braking points are reachable
const BRAKE_TURNING = 0.3; // cornering at the limit the car can still brake this fraction (trail braking on entry)
const BEND_RADIUS = 400; // radius (m) below which the track counts as turning
// minimum radius (m) for a corner to be taken out-in-out (gentler ones, flat out and straight through)
const CORNER_RADIUS = 250;
const ENTRY = 25; // how far before the corner starts the car is fully out wide (m)
const EXIT = 60; // how far after the corner ends the car finishes running out wide (m)
const SMOOTH = [[4, 12]]; // final smoothing: [distance to the neighbors (cells), passes]

// limits: what fraction of the grip and braking it uses (by default, with margin, for the racing line you see;
// the rivals use one closer to the limit)
export function racingLine(track, limits, { gripUse = GRIP_USE, brakeUse = BRAKE_USE } = {}) {
  const { path, meters, halfWidths } = track;
  const { n, x, y, st } = path;
  const wrap = (b) => ((b % n) + n) % n;

  // normal to the right of the direction of travel at each point (same sign as track.lat)
  const nx = new Float64Array(n),
    ny = new Float64Array(n);
  for (let b = 0; b < n; b++) {
    const dx = x[wrap(b + 2)] - x[wrap(b - 2)],
      dy = y[wrap(b + 2)] - y[wrap(b - 2)];
    const len = Math.hypot(dx, dy) || 1;
    nx[b] = -dy / len;
    ny[b] = dx / len;
  }

  // 1) The line, corner by corner, the way drivers take it: arrive from the outside,
  //    touch the apex (the tightest point) on the inside and exit running out wide again.
  //    Between one corner and the next the line crosses the track gradually; in the esses it goes apex to apex.
  // how far out it can go at each point (and at any position on the lap): the track width is not uniform
  const lim = Float64Array.from(halfWidths, (h) => h - MARGIN / meters);
  const limAt = (s) => halfWidthAt(track, s) - MARGIN / meters;
  const len = st[n];
  const corners = findCorners(curvature({ n, x, y, wrap }), st, n, wrap, meters);
  const ctrl = controlPoints(corners, len, limAt, meters);
  const off = new Float64Array(n);
  if (ctrl.length) {
    // between two control points, a smooth transition (no kinks, flat at each control point)
    let j = -1; // last control point before b (-1: the segment comes from the last one of the lap)
    for (let b = 0; b < n; b++) {
      while (j + 1 < ctrl.length && ctrl[j + 1].s <= st[b]) j++;
      const a = ctrl[j < 0 ? ctrl.length - 1 : j],
        c = ctrl[(j + 1) % ctrl.length];
      const span = (c.s - a.s + len) % len || len;
      const t = ((st[b] - a.s + len) % len) / span;
      off[b] = a.o + (c.o - a.o) * t * t * (3 - 2 * t);
    }
  }
  // then it is smoothed: each point moves sideways toward the average of its neighbors, without leaving the track.
  // That straightens the zigzags between consecutive small bends without losing the out-in-out of each corner.
  for (const [k, iters] of SMOOTH) {
    for (let it = 0; it < iters; it++) {
      for (let b = 0; b < n; b++) {
        const a = wrap(b - k),
          c = wrap(b + k);
        const mx = (x[a] + nx[a] * off[a] + x[c] + nx[c] * off[c]) / 2;
        const my = (y[a] + ny[a] * off[a] + y[c] + ny[c] * off[c]) / 2;
        const target = (mx - x[b]) * nx[b] + (my - y[b]) * ny[b];
        off[b] = Math.max(-lim[b], Math.min(lim[b], off[b] + (target - off[b]) * 0.5));
      }
    }
  }
  const px = new Float64Array(n),
    py = new Float64Array(n);
  for (let b = 0; b < n; b++) {
    px[b] = x[b] + nx[b] * off[b];
    py[b] = y[b] + ny[b] * off[b];
  }

  // 2) Curvature of the racing line (from the circle through three points) and length of each segment, in meters
  const K = 6;
  let curv = new Float64Array(n);
  const ds = new Float64Array(n);
  for (let b = 0; b < n; b++) {
    const a = wrap(b - K),
      c = wrap(b + K);
    const ax = px[a] - px[b],
      ay = py[a] - py[b],
      cx = px[c] - px[b],
      cy = py[c] - py[b];
    const cross = ax * cy - ay * cx;
    const la = Math.hypot(ax, ay),
      lc = Math.hypot(cx, cy),
      lac = Math.hypot(px[c] - px[a], py[c] - py[a]);
    curv[b] = Math.abs((2 * cross) / (la * lc * lac || 1)) / meters;
    ds[b] = Math.hypot(px[wrap(b + 1)] - px[b], py[wrap(b + 1)] - py[b]) * meters;
  }
  const c2 = new Float64Array(n);
  for (let b = 0; b < n; b++) {
    for (let k = -5; k <= 5; k++) c2[b] += curv[wrap(b + k)];
    c2[b] /= 11;
  }
  curv = c2;

  // 3) Speed: at each point, the maximum the grip can take (v²·curvature = grip, which grows with v²);
  //    then, going backward, the car has to arrive braking, and going forward, it can only accelerate as much as the
  //    engine allows. Two passes are made so the end of the lap joins up with the start.
  const v = Float64Array.from(curv, (k) => cornerSpeed(limits, k, gripUse));
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 2 * n - 1; i >= 0; i--) {
      const b = wrap(i),
        next = v[wrap(b + 1)];
      // while turning, the tyres have less left for braking (friction circle): braking has to start before the corner
      const turning = Math.min(1, (next * next * curv[b]) / (limits.lateral(next) * gripUse));
      const decel =
        (limits.brake(next) * Math.max(BRAKE_TURNING, Math.sqrt(1 - turning * turning)) + limits.drag(next)) * brakeUse;
      v[b] = Math.min(v[b], Math.sqrt(next * next + 2 * decel * ds[b]));
    }
    for (let i = 0; i < 2 * n; i++) {
      const b = wrap(i),
        prev = v[wrap(b - 1)];
      v[b] = Math.min(v[b], Math.sqrt(prev * prev + 2 * Math.max(0, limits.accel(prev)) * ds[wrap(b - 1)]));
    }
  }

  // 4) Convert everything to one entry per centerline cell
  const L = Math.ceil(st[n]) + 1;
  const offset = new Float32Array(L),
    speed = new Float32Array(L);
  let b = 0;
  for (let u = 0; u < L; u++) {
    while (b < n - 1 && st[b + 1] <= u) b++;
    const t = Math.min(1, Math.max(0, (u - st[b]) / (st[b + 1] - st[b] || 1)));
    const c = wrap(b + 1);
    offset[u] = off[b] + (off[c] - off[b]) * t;
    speed[u] = v[b] + (v[c] - v[b]) * t;
  }
  return { offset, speed, color: new Uint32Array(L) };
}

// Segments where the track keeps turning the same way, with their apex (the tightest point).
// sign: +1 turns right, -1 left. Positions in cells along the centerline.
function findCorners(curv, st, n, wrap, meters) {
  const bend = meters / BEND_RADIUS,
    sharp = meters / CORNER_RADIUS;
  const bent = (b) => Math.abs(curv[b]) > bend;
  let start = 0;
  while (start < n && bent(start)) start++; // start on a straight so as not to split a corner
  const corners = [];
  for (let k = 0; k < n; k++) {
    const b = wrap(start + k);
    if (!bent(b)) continue;
    const sign = Math.sign(curv[b]);
    let end = k,
      peak = 0,
      apex = b;
    while (end < k + n && bent(wrap(start + end)) && Math.sign(curv[wrap(start + end)]) === sign) {
      const c = wrap(start + end);
      if (Math.abs(curv[c]) > peak) {
        peak = Math.abs(curv[c]);
        apex = c;
      }
      end++;
    }
    if (peak > sharp) corners.push({ sign, from: st[b], apex: st[apex], to: st[wrap(start + end - 1)] });
    k = end - 1;
  }
  return corners;
}

// Control points of the racing line: outside before the corner, inside at the apex, outside after.
// If the exit of one corner overlaps the entry of the next: if they turn the same way, a single outside point is
// left in the middle; if they turn opposite ways (an S-bend), the line goes from apex to apex.
function controlPoints(corners, len, limAt, meters) {
  const m = corners.length;
  if (!m) return [];
  // "unwrapped" positions: always increasing along the lap
  let shift = 0;
  const cs = corners.map((c, i) => {
    if (i > 0 && c.from < corners[i - 1].from) shift = len;
    const u = (s) => (s < c.from ? s + len : s) + shift; // apex and to can go past the start line
    return { sign: c.sign, entry: c.from + shift - ENTRY / meters, apex: u(c.apex), exit: u(c.to) + EXIT / meters };
  });
  const pts = [];
  for (let i = 0; i < m; i++) {
    const c = cs[i];
    const next = i + 1 < m ? cs[i + 1] : { ...cs[0], entry: cs[0].entry + len, apex: cs[0].apex + len };
    const prev = i > 0 ? cs[i - 1] : { ...cs[m - 1], apex: cs[m - 1].apex - len, exit: cs[m - 1].exit - len };
    // entry: only if it doesn't overlap the exit of the previous one (the previous one handles that)
    if (c.entry > prev.exit && c.entry > prev.apex) pts.push({ s: c.entry, o: -c.sign * limAt(c.entry) });
    pts.push({ s: c.apex, o: c.sign * limAt(c.apex) });
    if (c.exit < next.entry) pts.push({ s: c.exit, o: -c.sign * limAt(c.exit) });
    else if (c.sign === next.sign) {
      // same direction: one outside point between the two, without passing either apex
      const mid = Math.min(Math.max((c.exit + next.entry) / 2, c.apex + 1), next.apex - 1);
      if (mid > c.apex) pts.push({ s: mid, o: -c.sign * limAt(mid) });
    }
  }
  // back to positions within the lap, sorted
  return pts.map((p) => ({ s: ((p.s % len) + len) % len, o: p.o })).sort((a, b) => a.s - b.s);
}
