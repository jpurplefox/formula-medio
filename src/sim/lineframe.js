// La línea central de la pista, celda por celda: cada punto y su normal. La usan la IA (para seguir la trazada, que
// está guardada como desplazamiento de costado respecto de esta línea), la grilla, los rescates, el renderer y las
// cámaras de la repetición.

// Por cada celda de la línea central: el punto de la línea central y la normal hacia la derecha.
// (La trazada ideal está guardada como desplazamiento de costado respecto de esa línea.)
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

// Punto de la pista a una posición sobre la línea central (celdas) y a un desplazamiento de costado (celdas)
export function pointAt(f, u, side) {
  const i = ((Math.round(u) % f.L) + f.L) % f.L;
  return { x: f.cx[i] + f.nx[i] * side, y: f.cy[i] + f.ny[i] * side, angle: Math.atan2(-f.nx[i], f.ny[i]) };
}
