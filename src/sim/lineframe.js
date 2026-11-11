// The track's centerline, cell by cell: each point and its normal. Used by the AI (to follow the racing line, which
// is stored as a sideways offset from this line), the grid, the rescues, the renderer and the replay cameras.

// For each centerline cell: the centerline point and the normal pointing right.
// (The racing line is stored as a sideways offset from that line.)
const frames = new WeakMap();
export function lineFrame(track) {
  if (frames.has(track)) return frames.get(track);
  const { n, x, y, st } = track.path;
  const L = Math.ceil(st[n]) + 1;
  const cx = new Float32Array(L),
    cy = new Float32Array(L),
    nx = new Float32Array(L),
    ny = new Float32Array(L);
  const wrap = (b) => ((b % n) + n) % n;
  let b = 0;
  for (let u = 0; u < L; u++) {
    while (b < n - 1 && st[b + 1] <= u) b++;
    const t = Math.min(1, Math.max(0, (u - st[b]) / (st[b + 1] - st[b] || 1)));
    const c = wrap(b + 1);
    cx[u] = x[b] + (x[c] - x[b]) * t;
    cy[u] = y[b] + (y[c] - y[b]) * t;
    const dx = x[wrap(b + 2)] - x[wrap(b - 2)],
      dy = y[wrap(b + 2)] - y[wrap(b - 2)];
    const len = Math.hypot(dx, dy) || 1;
    nx[u] = -dy / len;
    ny[u] = dx / len;
  }
  const f = { L, length: st[n], cx, cy, nx, ny };
  frames.set(track, f);
  return f;
}

// Track point at a position along the centerline (cells) and a sideways offset (cells)
export function pointAt(f, u, side) {
  const i = ((Math.round(u) % f.L) + f.L) % f.L;
  return { x: f.cx[i] + f.nx[i] * side, y: f.cy[i] + f.ny[i] * side, angle: Math.atan2(-f.nx[i], f.ny[i]) };
}
