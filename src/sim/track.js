// Turns the image of a layout into a map of cells, Wolfenstein 3D style:
// each cell is grass, track or wall, and also has a height and (where applicable) a kerb.

import { airDensity, DEFAULT_TUNE } from './dynamics.js';

export const T = { GRASS: 0, ROAD: 1, WALL: 3 };
const KERB_W = 0.9; // default kerb width (in cells)
export const DEFAULT_KERB = [
  [235, 235, 235],
  [200, 30, 30],
]; // white and red
export const MAX_KERB_COLORS = 4;
// What lies beside the track where there is a kerb, from the inside out:
//   kerb       a hump with colored stripes and a sawtooth (steps along it), of width width
//   green      a flat strip painted abrasive green behind the kerb, of width green (0 = none)
//   sausage    a tall yellow hump, only on the inside of the tightest corners (if sausage)
// Each track can change the style (kerbStyle in tracks/index.js); the rest stays as here.
export const KERB_STYLE = {
  width: KERB_W, // kerb width (cells)
  stripe: 1.6, // length of each colored stripe (cells)
  line: true, // white line between the track and the kerb
  green: 0.8, // width of the green strip (cells; 0 = no strip)
  sausage: true, // sausage kerbs in the tightest corners
};
export const KERB_H = 0.07; // height of the kerb's hump (in cells)
export const RIDGE = 0.8; // length of each sawtooth step (cells)
export const RIDGE_DEPTH = 0.35; // how much the hump drops at the start of each step (fraction of the height)
export const SAUSAGE_W = 0.45; // sausage kerb width (cells)
export const SAUSAGE_H = 0.09; // sausage kerb height (cells)

const N8 = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];
const N4 = N8.slice(0, 4);

// The track from its image mask (imageMask, in trackimage.js, which is the only part that needs the browser): that
// way it can also be built in Node (to train the AI, see rl/)
export function buildTrackFromMask({ W, H, road: dark }, def, elevation = null) {
  // From the image we take only the route: the centerline and the track width
  const raw = cleanRoad(dark, def, W, H);
  const path = traceCenterline(raw, startLine(raw, def, W, H), W, H, def.smooth ?? 3);
  // the start line, on the final track
  const start = (road) => startLine(road, def, W, H);
  return buildTrackFromPath(path, W, H, def, elevation, start);
}

// From the layout taken from telemetry (tools/layout.py): the centerline in meters from the start line and the
// heights. Each cell is CELL_M meters; around it there is room for the grass, the walls and the trees.
// def.rotate (degrees): rotates the layout, so the map is oriented like the usual drawing
const CELL_M = 2,
  LAYOUT_MARGIN = 45; // cells
export function buildTrackFromLayout(layout, def) {
  const a = ((def.rotate ?? 0) * Math.PI) / 180,
    c = Math.cos(a),
    s = Math.sin(a);
  const turned = layout.points.map(([x, y]) => [x * c - y * s, x * s + y * c]);
  const x0 = Math.min(...turned.map((p) => p[0])),
    y0 = Math.min(...turned.map((p) => p[1]));
  const pts = turned.map(([x, y]) => [(x - x0) / CELL_M + LAYOUT_MARGIN, (y - y0) / CELL_M + LAYOUT_MARGIN]);
  const W = Math.ceil(Math.max(...pts.map((p) => p[0])) + LAYOUT_MARGIN);
  const H = Math.ceil(Math.max(...pts.map((p) => p[1])) + LAYOUT_MARGIN);
  const n = pts.length;
  const path = {
    n,
    x: Float64Array.from(pts, (p) => p[0]),
    y: Float64Array.from(pts, (p) => p[1]),
    wrap: (b) => ((b % n) + n) % n,
    // telemetry doesn't include the edges (see tools/layout.py): the width is the track's
    halfWidth: (def.widthMeters ?? 14) / 2 / CELL_M,
  };
  // start: the first point, facing the next one
  const dx = path.x[1] - path.x[0],
    dy = path.y[1] - path.y[0],
    l = Math.hypot(dx, dy);
  const start = (road) => ({
    x: path.x[0],
    y: path.y[0],
    dx: dx / l,
    dy: dy / l,
    half: lineHalf(road, W, H, path.x[0], path.y[0], dx / l, dy / l, def),
  });
  const elevation = { lapLengthMeters: layout.lapLengthMeters, heightsMeters: layout.heightsMeters };
  return buildTrackFromPath(path, W, H, def, elevation, start);
}

// path: centerline (in cells, from the start line), with the half width at each point (halfWidths) or a single one
// (halfWidth); start(road): the start line on the already built track
function buildTrackFromPath(path, W, H, def, elevation, start) {
  // Real scale: how many meters a cell measures, from the real lap length
  // (from telemetry if available; otherwise, what the track says or 4 km)
  const lapMeters = elevation?.lapLengthMeters ?? def.lengthMeters ?? 4000;
  const st = stations(path);
  const length = st[path.n]; // centerline length, in cells
  const meters = lapMeters / length;
  const halfWidths =
    path.halfWidths ?? new Float32Array(path.n).fill(def.widthMeters ? def.widthMeters / 2 / meters : path.halfWidth);
  const halfWidth = [...halfWidths].sort((a, b) => a - b)[path.n >> 1]; // the typical one

  // 2) Rebuild the track as a ribbon of constant width around the centerline:
  //    smooth edges, without the waves and bites of the pixelated image
  // Each cell also stores its position along the centerline (station) and which side it is on (lat)
  const { road, sdf, station, lat } = ribbon(path, st, halfWidths, W, H);

  // 3) With the final track, compute everything else
  const { dist, tiles, line, progress, maxProgress } = layout(road, sdf, def, W, H, start(road));
  const runoff = def.runoff ?? 3;

  // Start a few cells behind the line
  const spawn = { x: line.x - line.dx * 6, y: line.y - line.dy * 6, angle: Math.atan2(line.dy, line.dx) };

  const curv = curvature(path);
  const kerbStyle = { ...KERB_STYLE, ...def.kerbStyle };
  const { left: kerbLeft, right: kerbRight, sausageLeft, sausageRight } = kerbFlags(path, st, curv, kerbStyle.sausage);
  const corners = findCorners(path, st, curv, meters);
  const { left: runoffLeft, right: runoffRight } = runoffSurfaces(corners, st[path.n], meters, def.surfaces);
  const height = computeHeight(
    elevation,
    (def.elevationScale ?? 1) / meters,
    station,
    length,
    sdf,
    -(runoff + 1),
    W,
    H,
  );

  const trees = placeTrees(dist, tiles, W, H, runoff);
  for (const t of trees) t.z = sampleField(height, W, t.x, t.y);
  const boards = brakeBoards(path, st, corners, meters, sdf, W, H);
  for (const b of boards) b.z = sampleField(height, W, b.x, b.y);

  return {
    W,
    H,
    meters,
    runoff,
    halfWidth,
    halfWidths,
    tiles,
    road,
    sdf,
    station,
    lat,
    length,
    kerbLeft,
    kerbRight,
    runoffLeft,
    runoffRight,
    height,
    sausageLeft,
    sausageRight,
    kerbStyle,
    path: { n: path.n, x: path.x, y: path.y, st }, // centerline: points and their cumulative position
    progress,
    maxProgress,
    line,
    spawn,
    trees,
    boards,
    scale: def.scale ?? 3,
    name: def.name,
    kerbColors: def.kerb ?? DEFAULT_KERB, // colors of the kerb stripes, in order
    // the air (higher up, less dense) and the cars' default setup there (dynamics.js)
    air: airDensity(def.altitude ?? 0),
    tune: def.tune ?? DEFAULT_TUNE,
  };
}

function cleanRoad(dark, def, W, H) {
  let road = dark;
  // Thin lines touching the layout (pit lane, old chicanes, the flag pole): erased by shrinking everything by
  // `open` cells and growing it back; the track, which is thicker, survives
  if (def.open) road = openThin(road, W, H, def.open);
  // Corner numbers and other text remain as islands: keep
  // only the largest connected component, which is the layout.
  road = largestComponent(road, W, H);
  // And fill the small holes inside the track (e.g. the checkered flag)
  fillHoles(road, W, H, 400);
  road = closeGaps(road, W, H, def.close ?? 2);

  if (def.widen) {
    const d = distanceFrom(road, W, H, def.widen);
    for (let i = 0; i < W * H; i++) road[i] = d[i] >= 0 ? 1 : 0;
  }
  return road;
}

// From the track: type of each cell, start line and lap progress.
// The wall is the strip more than `runoff` cells from the edge (according to sdf, which is continuous).
function layout(road, sdf, def, W, H, line) {
  const runoff = def.runoff ?? 3;
  const dist = distanceFrom(road, W, H, 255);
  const tiles = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const s = sdf[i];
      const border = x === 0 || y === 0 || x === W - 1 || y === H - 1;
      if (border) tiles[i] = T.WALL;
      else if (road[i]) tiles[i] = T.ROAD;
      else if (s < -runoff && s >= -(runoff + 2)) tiles[i] = T.WALL;
      else tiles[i] = T.GRASS;
    }
  }
  const drivable = (i) => sdf[i] >= -runoff && tiles[i] !== T.WALL;

  const progress = computeProgress(drivable, W, H, line);
  let maxProgress = 0;
  for (let i = 0; i < W * H; i++) if (progress[i] > maxProgress) maxProgress = progress[i];
  return { dist, tiles, line, progress, maxProgress };
}

// Start line: point (on the track), race direction and half width
function startLine(road, def, W, H) {
  const scale = def.scale ?? 3;
  let sx = def.start.x / scale;
  let sy = def.start.y / scale;
  let dx = def.towards.x - def.start.x;
  let dy = def.towards.y - def.start.y;
  const len = Math.hypot(dx, dy) || 1;
  dx /= len;
  dy /= len;
  [sx, sy] = snapToRoad(road, W, H, sx, sy);
  return { x: sx, y: sy, dx, dy, half: lineHalf(road, W, H, sx, sy, dx, dy, def) };
}

// Half width of the start line: how far the track reaches to each side, plus the grass
function lineHalf(road, W, H, sx, sy, dx, dy, def) {
  let half = 1;
  for (const s of [1, -1]) {
    let k = 0;
    while (k < 60 && road[idx(W, H, sx - dy * s * k, sy + dx * s * k)]) k++;
    half = Math.max(half, k + (def.runoff ?? 3) + 1);
  }
  return half;
}

// Walks the track from the start line like a "walker": takes a step, measures how far the track reaches to each
// side and recenters. That way it follows hairpins without cutting across.
// smooth: smoothing passes over the centerline (more on small images, where the lines come out stepped)
function traceCenterline(road, line, W, H, smooth) {
  const onRoad = (x, y) => road[idx(W, H, x, y)] === 1;
  const reach = (x, y, nx, ny) => {
    let t = 0;
    while (t < 40 && onRoad(x + nx * t, y + ny * t)) t += 0.25;
    return t;
  };
  let px = line.x,
    py = line.y,
    dx = line.dx,
    dy = line.dy;
  const xs = [],
    ys = [],
    widths = [];
  for (let iter = 0; iter < 20000; iter++) {
    // center on the cross-section
    for (let k = 0; k < 2; k++) {
      const a = reach(px, py, -dy, dx),
        b = reach(px, py, dy, -dx);
      px += (-dy * (a - b)) / 2;
      py += (dx * (a - b)) / 2;
      if (k === 1) widths.push(a + b);
    }
    xs.push(px);
    ys.push(py);
    const n = xs.length;
    // closed lap: back at the start line, within half a track width (the checkered flag can shift the center a
    // little, and if it isn't recognized here the walk continues and does another lap)
    if (n > 50 && Math.hypot(px - xs[0], py - ys[0]) < Math.max(1.5, widths[widths.length - 1] / 2)) break;
    // heading: the direction we have been moving, smoothed
    if (n > 4) {
      let ndx = px - xs[n - 5],
        ndy = py - ys[n - 5];
      const l = Math.hypot(ndx, ndy) || 1;
      dx = dx * 0.5 + (ndx / l) * 0.5;
      dy = dy * 0.5 + (ndy / l) * 0.5;
      const l2 = Math.hypot(dx, dy) || 1;
      dx /= l2;
      dy /= l2;
    }
    px += dx;
    py += dy;
  }
  let x = Float64Array.from(xs),
    y = Float64Array.from(ys);
  const n = x.length;
  const wrap = (b) => ((b % n) + n) % n;
  for (let pass = 0; pass < smooth; pass++) {
    const nx = new Float64Array(n),
      ny = new Float64Array(n);
    for (let b = 0; b < n; b++) {
      for (let k = -3; k <= 3; k++) {
        nx[b] += x[wrap(b + k)];
        ny[b] += y[wrap(b + k)];
      }
      nx[b] /= 7;
      ny[b] /= 7;
    }
    x = nx;
    y = ny;
  }
  // typical width: the median of the measurements (corners and the flag give outliers)
  widths.sort((a, b) => a - b);
  const halfWidth = widths[widths.length >> 1] / 2;
  return { n, x, y, wrap, halfWidth };
}

// Cumulative centerline length at each point, in cells (st[n] = total length)
function stations({ n, x, y, wrap }) {
  const st = new Float64Array(n + 1);
  for (let b = 0; b < n; b++) st[b + 1] = st[b] + Math.hypot(x[wrap(b + 1)] - x[b], y[wrap(b + 1)] - y[b]);
  return st;
}

// Track as a ribbon of fixed width. For each cell it finds the nearest centerline point and stores:
//   sdf     = half width − distance (positive on the track)
//   station = position of that point along the centerline, in cells from the start line (-1 if far away)
//   lat     = signed sideways distance (positive to the right of the race direction)
function ribbon({ n, x, y, wrap }, st, halfWidths, W, H) {
  const R = Math.max(...halfWidths) + 12;
  const d = new Float32Array(W * H).fill(R);
  const half = new Float32Array(W * H); // the half width at the nearest centerline point
  const station = new Float32Array(W * H).fill(-1);
  const lat = new Float32Array(W * H);
  for (let b = 0; b < n; b++) {
    const ax = x[b],
      ay = y[b],
      bx = x[wrap(b + 1)],
      by = y[wrap(b + 1)];
    const ex = bx - ax,
      ey = by - ay;
    const len2 = ex * ex + ey * ey || 1e-9;
    const len = Math.sqrt(len2);
    const x0 = Math.max(0, Math.floor(Math.min(ax, bx) - R)),
      x1 = Math.min(W - 1, Math.ceil(Math.max(ax, bx) + R));
    const y0 = Math.max(0, Math.floor(Math.min(ay, by) - R)),
      y1 = Math.min(H - 1, Math.ceil(Math.max(ay, by) + R));
    for (let cy = y0; cy <= y1; cy++) {
      for (let cx = x0; cx <= x1; cx++) {
        const px = cx + 0.5 - ax,
          py = cy + 0.5 - ay;
        const t = Math.max(0, Math.min(1, (px * ex + py * ey) / len2));
        const dd = Math.hypot(px - ex * t, py - ey * t);
        const i = cy * W + cx;
        if (dd < d[i]) {
          d[i] = dd;
          half[i] = halfWidths[b] * (1 - t) + halfWidths[wrap(b + 1)] * t;
          station[i] = st[b] + t * len;
          lat[i] = (py * ex - px * ey) / len;
        }
      }
    }
  }
  const sdf = new Float32Array(W * H);
  const road = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) {
    sdf[i] = half[i] - d[i];
    road[i] = sdf[i] > 0 ? 1 : 0;
  }
  return { road, sdf, station, lat };
}

// Track half width (cells) at a position st along the centerline
export function halfWidthAt(track, st) {
  const {
    halfWidths,
    path: { n, st: s },
  } = track;
  let lo = 0,
    hi = n;
  const u = ((st % s[n]) + s[n]) % s[n];
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (s[mid] <= u) lo = mid;
    else hi = mid;
  }
  const t = (u - s[lo]) / Math.max(1e-9, s[lo + 1] - s[lo]);
  return halfWidths[lo] * (1 - t) + halfWidths[(lo + 1) % n] * t;
}

// Position along the centerline at any point, interpolated.
// Where it jumps (at the start line, or between two nearby stretches of track) it uses the nearest cell.
export function stationAt(track, x, y) {
  const { W, station } = track;
  const gx = x - 0.5,
    gy = y - 0.5;
  const x0 = Math.floor(gx),
    y0 = Math.floor(gy);
  const u = gx - x0,
    v = gy - y0;
  const j = y0 * W + x0;
  const a = station[j],
    b = station[j + 1],
    c = station[j + W],
    d = station[j + W + 1];
  const lo = Math.min(a, b, c, d),
    hi = Math.max(a, b, c, d);
  if (lo < 0 || hi - lo > 4) return station[Math.floor(y) * W + Math.floor(x)];
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}

// How far what lies beside the track (kerb, green and sausage kerb) can reach, in cells from the edge
export const edgeReach = (style) => style.width + style.green + SAUSAGE_W;

// Edges of the side strips (distances to the track edge, negative: outward), with k = how much kerb there is and
// q = how much sausage kerb: the kerb goes from kerb to 0, the green from green to kerb and the sausage kerb from
// sausage to green
function edgeBounds(style, k, q) {
  const kerb = -style.width * k;
  const green = kerb - style.green * k;
  return { kerb, green, sausage: green - SAUSAGE_W * q };
}

// What lies at a distance s from the edge (see edgeBounds) and how much the ground rises there (cells), given the
// position st along the centerline (the kerb's sawtooth)
export function edgeAt(style, s, k, q, st) {
  if (s >= 0) return { surface: 'road', lift: 0 };
  const b = edgeBounds(style, k, q);
  if (k > 0.02 && s > b.kerb) return { surface: 'kerb', lift: kerbLift(s, b.kerb, k, st) };
  if (k > 0.02 && s > b.green) return { surface: 'green', lift: 0 };
  if (q > 0.02 && s > b.sausage)
    return { surface: 'sausage', lift: SAUSAGE_H * q * Math.sin((Math.PI * (s - b.sausage)) / (b.green - b.sausage)) };
  return { surface: 'runoff', lift: 0 }; // beyond: the runoff (see edgeInfo)
}

// The kerb's hump: rises from the outside, peaks and drops toward the track; along it, sawtooth steps
// (each rises slowly and drops sharply)
export function kerbLift(s, outer, k, st) {
  const t = (s - outer) / -outer;
  const r = st / RIDGE - Math.floor(st / RIDGE);
  const saw = r < 0.8 ? r / 0.8 : (1 - r) / 0.2;
  return KERB_H * k * Math.sin(Math.PI * t) * (1 - RIDGE_DEPTH * (1 - saw));
}

// What lies at a point: 'road' (the track), 'kerb' (outside the edge), 'green' (the green strip behind the kerb),
// 'sausage' (the sausage kerb) or whatever is in the runoff on that side on that stretch: 'grass', 'gravel' or
// 'asphalt' (paved runoff); and how much the ground rises there (lift, in cells). The properties of each surface
// (grip, drag) are in SURFACES in car.js.
export const RUNOFF = ['grass', 'gravel', 'asphalt'];
export function edgeInfo(track, x, y) {
  const s = sampleField(track.sdf, track.W, x, y);
  if (s >= 0) return { surface: 'road', lift: 0 };
  const st = stationAt(track, x, y);
  if (st < 0) return { surface: 'grass', lift: 0 };
  const right = sampleField(track.lat, track.W, x, y) > 0;
  const style = track.kerbStyle ?? KERB_STYLE;
  if (s > -edgeReach(style) - 0.1) {
    const k = kerbAmount(right ? track.kerbRight : track.kerbLeft, st);
    const sq = right ? track.sausageRight : track.sausageLeft;
    const e = edgeAt(style, s, k, sq ? kerbAmount(sq, st) : 0, st);
    if (e.surface !== 'runoff') return e;
  }
  return { surface: RUNOFF[runoffAt(right ? track.runoffRight : track.runoffLeft, st)], lift: 0 };
}

export function surfaceAt(track, x, y) {
  return edgeInfo(track, x, y).surface;
}

// Which runoff there is at that position along the centerline (an index into RUNOFF)
export function runoffAt(kinds, st) {
  if (!kinds) return 0;
  const n = kinds.length;
  return kinds[((Math.floor(st) % n) + n) % n];
}

export function kerbAmount(amounts, st) {
  const n = amounts.length;
  const i = Math.floor(st),
    t = st - i;
  return amounts[i % n] * (1 - t) + amounts[(i + 1) % n] * t;
}

// Kerbs as on a real track: on the inside where the corner is tight,
// and on the outside at the exit of the sharpest corners. On the straights, none.
// Decided from the centerline curvature and stored per cell of distance along the track.
const KERB_INSIDE = 1 / 28; // minimum curvature for an inside kerb (radius < 28 cells)
const KERB_EXIT = 1 / 16; // minimum curvature for an outside kerb at the exit
const KERB_MIN = 5; // minimum length of a kerb and of a gap between kerbs (cells)
const KERB_RAMP = 3; // length of each kerb's tip, where it grows from 0 to full width (cells)
const SAUSAGE_CURV = 1 / 15; // minimum curvature for a sausage kerb on the inside (radius < 15 cells)

// Centerline curvature at each point (radians per cell; positive = right-hand corner), smoothed
export function curvature({ n, x, y, wrap }) {
  const K = 6;
  const heading = new Float64Array(n);
  for (let b = 0; b < n; b++) heading[b] = Math.atan2(y[wrap(b + K)] - y[wrap(b - K)], x[wrap(b + K)] - x[wrap(b - K)]);
  let curv = new Float64Array(n);
  for (let b = 0; b < n; b++) {
    let d = heading[wrap(b + K)] - heading[wrap(b - K)];
    d = Math.atan2(Math.sin(d), Math.cos(d));
    curv[b] = d / (2 * K); // centerline points are ~1 cell apart
  }
  for (let pass = 0; pass < 2; pass++) {
    const c2 = new Float64Array(n);
    for (let b = 0; b < n; b++) {
      for (let k = -4; k <= 4; k++) c2[b] += curv[wrap(b + k)];
      c2[b] /= 9;
    }
    curv = c2;
  }
  return curv;
}

function kerbFlags({ n, wrap }, st, curv, sausages = true) {
  const L = Math.ceil(st[n]) + 1;
  const left = new Uint8Array(L),
    right = new Uint8Array(L);
  const sLeft = new Uint8Array(L),
    sRight = new Uint8Array(L);
  let b = 0;
  for (let u = 0; u < L; u++) {
    while (b < n - 1 && st[b + 1] <= u) b++;
    const k = curv[b];
    if (k > KERB_INSIDE) right[u] = 1;
    if (k < -KERB_INSIDE) left[u] = 1;
    // sausage kerb: on the inside of the tightest corners, so cutting them doesn't pay off
    if (sausages && k > SAUSAGE_CURV) sRight[u] = 1;
    if (sausages && k < -SAUSAGE_CURV) sLeft[u] = 1;
    for (let back = 3; back <= 18; back++) {
      const kb = curv[wrap(b - back)];
      if (kb > KERB_EXIT) left[u] = 1;
      if (kb < -KERB_EXIT) right[u] = 1;
    }
  }
  const kl = taper(cleanRuns(left)),
    kr = taper(cleanRuns(right));
  // the sausage kerb goes behind a kerb: where there is no kerb, there is none either
  const sl = taper(cleanRuns(sLeft)).map((q, u) => Math.min(q, kl[u]));
  const sr = taper(cleanRuns(sRight)).map((q, u) => Math.min(q, kr[u]));
  return { left: kl, right: kr, sausageLeft: sl, sausageRight: sr };
}

// Distance boards before the heavy braking corners (200, 150, 100 and 50 m to the point where the corner starts),
// on the outside, which is where the car comes from before turning in.
// A corner is "heavy" if its minimum radius is small and it has a long straight before it where cars arrive fast.
const BOARD_DISTANCES = [200, 150, 100, 50]; // meters
const BOARD_RADIUS = 110; // maximum corner radius (m) to get boards
const BOARD_STRAIGHT = 250; // minimum straight before the corner (m)
const BOARD_TURN_IN = 260; // radius (m) from which we consider the corner to have started
const BOARD_OFFSET = 2; // distance from the board to the track edge (cells)

// Corners: consecutive stretches of the centerline with curvature (on the same side) tighter than BOARD_TURN_IN.
// For each: where it starts and ends (from, to, in cells along the track), which way it turns (sign, + = right),
// its minimum radius (radius, m) and how much straight there is before it (straight, m, from the end of the previous
// corner)
function findCorners(path, st, curv, meters) {
  const { n, wrap } = path;
  const length = st[n];
  const turnIn = 1 / (BOARD_TURN_IN / meters);
  const bent = (b) => Math.abs(curv[b]) > turnIn;
  const corners = [];
  let start = 0;
  while (bent(start) && start < n) start++; // start on a straight so as not to split a corner in half
  for (let k = 0; k < n; k++) {
    const b = wrap(start + k);
    if (!bent(b)) continue;
    const sign = Math.sign(curv[b]);
    let peak = 0,
      end = k;
    while (end < n && bent(wrap(start + end)) && Math.sign(curv[wrap(start + end)]) === sign) {
      peak = Math.max(peak, Math.abs(curv[wrap(start + end)]));
      end++;
    }
    corners.push({ b, sign, peak, radius: meters / peak, from: st[b], to: st[wrap(start + end - 1)] });
    k = end - 1;
  }
  corners.forEach((c, i) => {
    const prev = corners[(i - 1 + corners.length) % corners.length];
    c.straight = ((c.from - prev.to + length) % length) * meters;
  });
  return corners;
}

function brakeBoards(path, st, corners, meters, sdf, W, H) {
  const { n, x, y, wrap } = path;
  const length = st[n];
  const strong = 1 / (BOARD_RADIUS / meters);
  const boards = [];
  corners.forEach((c) => {
    if (c.peak < strong) return;
    if (c.straight < BOARD_STRAIGHT) return;
    for (const d of BOARD_DISTANCES) {
      const target = (c.from - d / meters + length) % length;
      // centerline point at that position
      let b = 0;
      while (b < n - 1 && st[b + 1] <= target) b++;
      const dx = x[wrap(b + 3)] - x[wrap(b - 3)],
        dy = y[wrap(b + 3)] - y[wrap(b - 3)];
      const len = Math.hypot(dx, dy) || 1;
      // normal to the right of the direction of travel (y grows downward); the board goes opposite the corner
      const nx = -dy / len,
        ny = dx / len;
      const side = -c.sign;
      // find the track edge and move a little further away
      let off = 0;
      while (off < 30 && sampleField(sdf, W, x[b] + nx * side * off, y[b] + ny * side * off) > 0) off += 0.25;
      off += BOARD_OFFSET;
      const bx = x[b] + nx * side * off,
        by = y[b] + ny * side * off;
      // if it lands on another part of the track (or off the map), skip it
      if (bx < 2 || by < 2 || bx >= W - 2 || by >= H - 2 || sampleField(sdf, W, bx, by) > -1) continue;
      boards.push({ x: bx, y: by, meters: d });
    }
  });
  return boards;
}

// Runoffs: what lies beside the track (an index into RUNOFF) per cell along the track and on each side.
// As on modern tracks, outside the corners, which is where a car that can't make the turn goes off:
//   - slow corners (hairpins, chicanes): asphalt, from the braking zone to the exit, to rejoin without losing
//     too much and without breaking the car
//   - fast corners after a straight: gravel, which stops whoever overshoots before reaching the wall
//   - everywhere else, grass
// surfaces (from the track, optional) overrides the automatic choice: [[from, to, side, material], ...] with from
// and to in meters from the start line, side 'left', 'right' or 'both' and material 'grass', 'gravel' or 'asphalt'
const RUNOFF_SLOW = 60; // m: radius below which the corner is slow (paved runoff)
const RUNOFF_FAST = 250; // m: radius up to which a fast corner gets gravel
const GRAVEL_STRAIGHT = 100; // m of straight before it, for cars to arrive fast and need gravel
const ASPHALT_BEFORE = 80,
  ASPHALT_AFTER = 60; // m of asphalt before the start of the slow corner and after its end
const GRAVEL_BEFORE = 20,
  GRAVEL_AFTER = 80; // m of gravel before and after the fast corner

function runoffSurfaces(corners, length, meters, surfaces = []) {
  const L = Math.ceil(length) + 1;
  const left = new Uint8Array(L),
    right = new Uint8Array(L);
  const paint = (side, from, to, kind) => {
    const k = RUNOFF.indexOf(kind);
    if (k < 0) return;
    const a = Math.floor(from / meters),
      b = Math.ceil(to / meters);
    for (let u = a; u <= b; u++) {
      const i = ((u % L) + L) % L;
      if (side !== 'right') left[i] = k;
      if (side !== 'left') right[i] = k;
    }
  };
  // a right-hander (sign > 0) is exited on the left; gravel first, so asphalt wins where they overlap
  const outside = (c) => (c.sign > 0 ? 'left' : 'right');
  for (const c of corners) {
    if (c.radius >= RUNOFF_SLOW && c.radius <= RUNOFF_FAST && c.straight >= GRAVEL_STRAIGHT) {
      paint(
        outside(c),
        c.from * meters - GRAVEL_BEFORE,
        (c.to + (c.to < c.from ? length : 0)) * meters + GRAVEL_AFTER,
        'gravel',
      );
    }
  }
  for (const c of corners) {
    if (c.radius < RUNOFF_SLOW)
      paint(
        outside(c),
        c.from * meters - ASPHALT_BEFORE,
        (c.to + (c.to < c.from ? length : 0)) * meters + ASPHALT_AFTER,
        'asphalt',
      );
  }
  for (const [from, to, side, kind] of surfaces) paint(side, from, to + (to < from ? length * meters : 0), kind);
  return { left, right };
}

// From 0/1 flags to kerb amount, with ramped tips at the start and end
function taper(flags) {
  const L = flags.length;
  const out = new Float32Array(L);
  let start = -1;
  for (let u = 0; u <= L; u++) {
    const on = u < L && flags[u] === 1;
    if (on && start < 0) start = u;
    if (!on && start >= 0) {
      for (let k = start; k < u; k++) out[k] = Math.min(1, (Math.min(k - start, u - 1 - k) + 0.5) / KERB_RAMP);
      start = -1;
    }
  }
  return out;
}

// Removes very short kerbs and fills very short gaps between kerbs
function cleanRuns(flags) {
  const L = flags.length;
  for (const value of [0, 1]) {
    let start = -1;
    for (let u = 0; u <= L; u++) {
      const isVal = u < L && flags[u] === value;
      if (isVal && start < 0) start = u;
      if (!isVal && start >= 0) {
        if (u - start < KERB_MIN && start > 0 && u < L) flags.fill(1 - value, start, u);
        start = -1;
      }
    }
  }
  return flags;
}

// Height of each cell, in cells. On the track (and up to the wall) it comes from the telemetry profile according
// to the position along the centerline, so the track is level from side to side.
// Beyond that, the terrain extends and is smoothed into hills.
// cellsPerMeter: map scale (already includes the height exaggeration, if any)
function computeHeight(elevation, cellsPerMeter, station, length, sdf, limit, W, H) {
  const height = new Float32Array(W * H);
  if (!elevation) return height;
  const hs = elevation.heightsMeters;
  const m = hs.length;
  const profile = (f) => {
    const t = (((f % 1) + 1) % 1) * m;
    const i = Math.floor(t),
      u = t - i;
    return (hs[i % m] * (1 - u) + hs[(i + 1) % m] * u) * cellsPerMeter;
  };

  // fixed values on the track, propagated to the rest by proximity
  const known = new Uint8Array(W * H);
  const queue = new Int32Array(W * H);
  let head = 0,
    tail = 0;
  for (let i = 0; i < W * H; i++) {
    if (station[i] >= 0 && sdf[i] >= limit) {
      height[i] = profile(station[i] / length);
      known[i] = 1;
      queue[tail++] = i;
    }
  }
  const seen = known.slice();
  while (head < tail) {
    const j = queue[head++];
    const x = j % W,
      y = (j / W) | 0;
    for (const [dx, dy] of N4) {
      const nx = x + dx,
        ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const k = ny * W + nx;
      if (!seen[k]) {
        seen[k] = 1;
        height[k] = height[j];
        queue[tail++] = k;
      }
    }
  }
  // smoothing that respects the track: the terrain becomes gentle hills between stretches
  const fixed = height.slice();
  for (let pass = 0; pass < 6; pass++) {
    boxBlurInPlace(height, W, H, 6);
    for (let i = 0; i < W * H; i++) if (known[i]) height[i] = fixed[i];
  }
  return height;
}

function boxBlurInPlace(a, W, H, r) {
  const tmp = new Float32Array(Math.max(W, H));
  for (let y = 0; y < H; y++) {
    let sum = 0;
    const row = y * W;
    for (let x = -r; x <= r; x++) sum += a[row + Math.min(W - 1, Math.max(0, x))];
    for (let x = 0; x < W; x++) {
      tmp[x] = sum / (2 * r + 1);
      sum += a[row + Math.min(W - 1, x + r + 1)] - a[row + Math.max(0, x - r)];
    }
    for (let x = 0; x < W; x++) a[row + x] = tmp[x];
  }
  for (let x = 0; x < W; x++) {
    let sum = 0;
    for (let y = -r; y <= r; y++) sum += a[Math.min(H - 1, Math.max(0, y)) * W + x];
    for (let y = 0; y < H; y++) {
      tmp[y] = sum / (2 * r + 1);
      sum += a[Math.min(H - 1, y + r + 1) * W + x] - a[Math.max(0, y - r) * W + x];
    }
    for (let y = 0; y < H; y++) a[y * W + x] = tmp[y];
  }
}

// Interpolates a field defined at the cell centers (bilinear).
// This is what makes the edges look curved instead of stepped.
export function sampleField(field, W, x, y) {
  const gx = x - 0.5,
    gy = y - 0.5;
  const x0 = Math.floor(gx),
    y0 = Math.floor(gy);
  const u = gx - x0,
    v = gy - y0;
  const i = y0 * W + x0;
  const a = field[i],
    b = field[i + 1],
    c = field[i + W],
    d = field[i + W + 1];
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}

function idx(W, H, x, y) {
  const ix = Math.floor(x),
    iy = Math.floor(y);
  if (ix < 0 || iy < 0 || ix >= W || iy >= H) return -1;
  return iy * W + ix;
}

function largestComponent(mask, W, H) {
  const label = new Int32Array(W * H);
  const stack = new Int32Array(W * H);
  let best = 0,
    bestSize = 0,
    next = 0;
  for (let i = 0; i < W * H; i++) {
    if (!mask[i] || label[i]) continue;
    next++;
    let size = 0,
      sp = 0;
    stack[sp++] = i;
    label[i] = next;
    while (sp) {
      const j = stack[--sp];
      size++;
      const x = j % W,
        y = (j / W) | 0;
      for (const [dx, dy] of N8) {
        const nx = x + dx,
          ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const k = ny * W + nx;
        if (mask[k] && !label[k]) {
          label[k] = next;
          stack[sp++] = k;
        }
      }
    }
    if (size > bestSize) {
      bestSize = size;
      best = next;
    }
  }
  const out = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) out[i] = label[i] === best ? 1 : 0;
  return out;
}

function fillHoles(mask, W, H, maxSize) {
  const seen = new Uint8Array(W * H);
  const stack = new Int32Array(W * H);
  const comp = [];
  for (let i = 0; i < W * H; i++) {
    if (mask[i] || seen[i]) continue;
    comp.length = 0;
    let sp = 0;
    stack[sp++] = i;
    seen[i] = 1;
    while (sp) {
      const j = stack[--sp];
      comp.push(j);
      const x = j % W,
        y = (j / W) | 0;
      for (const [dx, dy] of N4) {
        const nx = x + dx,
          ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const k = ny * W + nx;
        if (!mask[k] && !seen[k]) {
          seen[k] = 1;
          stack[sp++] = k;
        }
      }
    }
    if (comp.length <= maxSize) for (const j of comp) mask[j] = 1;
  }
}

// Morphological closing: grows the track by r cells and then shrinks it by r cells.
// Fills narrow cracks even when they touch the outside (the flag sticks out of the track).
function closeGaps(mask, W, H, r) {
  if (!r) return mask;
  const grown = distanceFrom(mask, W, H, r);
  const outside = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) outside[i] = grown[i] < 0 ? 1 : 0;
  const back = distanceFrom(outside, W, H, r);
  const out = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) out[i] = mask[i] || back[i] < 0 ? 1 : 0;
  return out;
}

// Opening: erases whatever is narrower than 2r+1 cells and leaves the rest unchanged
function openThin(mask, W, H, r) {
  const outside = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) outside[i] = mask[i] ? 0 : 1;
  const near = distanceFrom(outside, W, H, r);
  const core = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) core[i] = mask[i] && near[i] < 0 ? 1 : 0;
  const grown = distanceFrom(core, W, H, r);
  const out = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) out[i] = mask[i] && grown[i] >= 0 ? 1 : 0;
  return out;
}

// Distance (Chebyshev, in cells) to the mask; -1 if it exceeds maxDist
function distanceFrom(mask, W, H, maxDist) {
  const dist = new Int16Array(W * H).fill(-1);
  const queue = new Int32Array(W * H);
  let head = 0,
    tail = 0;
  for (let i = 0; i < W * H; i++)
    if (mask[i]) {
      dist[i] = 0;
      queue[tail++] = i;
    }
  while (head < tail) {
    const j = queue[head++];
    const d = dist[j];
    if (d >= maxDist) continue;
    const x = j % W,
      y = (j / W) | 0;
    for (const [dx, dy] of N8) {
      const nx = x + dx,
        ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const k = ny * W + nx;
      if (dist[k] < 0) {
        dist[k] = d + 1;
        queue[tail++] = k;
      }
    }
  }
  return dist;
}

function snapToRoad(road, W, H, x, y) {
  const i = idx(W, H, x, y);
  if (i >= 0 && road[i]) return [x, y];
  for (let r = 1; r < 40; r++) {
    for (let a = 0; a < 32; a++) {
      const nx = x + Math.cos((a / 32) * Math.PI * 2) * r;
      const ny = y + Math.sin((a / 32) * Math.PI * 2) * r;
      const k = idx(W, H, nx, ny);
      if (k >= 0 && road[k]) return [nx, ny];
    }
  }
  return [x, y];
}

// Progress along the lap: BFS from the start line forward,
// without allowing it to be crossed backward. Used to validate laps and detect driving the wrong way.
// It is a Dijkstra with diagonal steps of √2, so the distance is "real" and not stepped.
function computeProgress(drivable, W, H, line) {
  const progress = new Float32Array(W * H).fill(-1);
  const heap = new MinHeap();
  const along = (x, y) => (x + 0.5 - line.x) * line.dx + (y + 0.5 - line.y) * line.dy;
  const side = (x, y) => -(x + 0.5 - line.x) * line.dy + (y + 0.5 - line.y) * line.dx;
  const nearLine = (x, y) => Math.abs(side(x, y)) < line.half && Math.abs(along(x, y)) < 3;

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const a = along(x, y);
      if (drivable(i) && a >= 0 && a < 1 && Math.abs(side(x, y)) < line.half) {
        progress[i] = a;
        heap.push(i, a);
      }
    }
  }
  const done = new Uint8Array(W * H);
  while (heap.size) {
    const j = heap.pop();
    if (done[j]) continue;
    done[j] = 1;
    const x = j % W,
      y = (j / W) | 0;
    for (const [dx, dy] of N8) {
      const nx = x + dx,
        ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const k = ny * W + nx;
      if (done[k] || !drivable(k)) continue;
      // diagonals can't slip between two blocked cells
      if (dx && dy && (!drivable(y * W + nx) || !drivable(ny * W + x))) continue;
      if (nearLine(nx, ny) && along(x, y) >= 0 && along(nx, ny) < 0) continue;
      const nd = progress[j] + (dx && dy ? Math.SQRT2 : 1);
      if (progress[k] < 0 || nd < progress[k]) {
        progress[k] = nd;
        heap.push(k, nd);
      }
    }
  }
  return progress;
}

class MinHeap {
  constructor() {
    this.ids = [];
    this.keys = [];
  }
  get size() {
    return this.ids.length;
  }
  push(id, key) {
    const { ids, keys } = this;
    let i = ids.length;
    ids.push(id);
    keys.push(key);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (keys[p] <= key) break;
      ids[i] = ids[p];
      keys[i] = keys[p];
      i = p;
    }
    ids[i] = id;
    keys[i] = key;
  }
  pop() {
    const { ids, keys } = this;
    const top = ids[0];
    const id = ids.pop(),
      key = keys.pop();
    const n = ids.length;
    if (n) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && keys[c + 1] < keys[c]) c++;
        if (keys[c] >= key) break;
        ids[i] = ids[c];
        keys[i] = keys[c];
        i = c;
      }
      ids[i] = id;
      keys[i] = key;
    }
    return top;
  }
}

function placeTrees(dist, tiles, W, H, runoff) {
  let seed = 1234567;
  const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const trees = [];
  for (let y = 2; y < H - 2; y++) {
    for (let x = 2; x < W - 2; x++) {
      const i = y * W + x;
      const d = dist[i];
      if (tiles[i] !== T.GRASS || (d >= 0 && d < runoff + 5)) continue;
      if (rand() < 0.006) trees.push({ x: x + rand(), y: y + rand(), scale: 0.8 + rand() * 0.7 });
    }
  }
  return trees;
}
