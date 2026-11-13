// Rejas sobre las barreras, como en la F1: no en todo el trazado sino donde un auto (o lo que vuela de un choque)
// puede salir para afuera: por fuera de las curvas, unos metros antes y después, y en la recta principal de los dos
// lados; además algunos tramos rectos al azar, para que no quede todo igual. Van arriba del muro (a la distancia del
// muro de la línea central: el medio ancho más la escapatoria), sólo donde ese muro existe de verdad (en los tramos
// que pasan cerca de otra parte de la pista, el muro es el de la otra). La malla la dibuja glrenderer.js.

import { lineFrame } from './ai.js';
import { sampleField } from './track.js';

export const FENCE_H_M = 3.2; // alto de la reja sobre el muro (m)
const CURVE_R_M = 200; // curvas más cerradas que este radio (m) llevan reja por fuera
const AROUND = 30; // celdas antes y después de cada curva
const MAIN = 180; // celdas de la recta principal, para cada lado de la largada, con reja de los dos lados
const RANDOM_SEG = 60,
  RANDOM_SHARE = 0.15; // tramos (celdas) que se suman al azar, y qué parte de ellos

// dónde hay reja: para cada lado (-1 izquierda, 1 derecha), un arreglo por celda de recorrido
export function fenceSpans(track) {
  const f = lineFrame(track),
    L = f.L,
    M = track.meters;
  const hw = (u) => track.halfWidths[Math.min(track.halfWidths.length - 1, u)];
  const at = (u, side) => {
    const i = ((u % L) + L) % L,
      w = side * (hw(i) + track.runoff);
    return [f.cx[i] + f.nx[i] * w, f.cy[i] + f.ny[i] * w];
  };
  const spans = {};
  for (const side of [-1, 1]) {
    // por fuera de una curva el muro de ese lado es más largo que la línea central: cuánto más dice el radio
    const outside = new Uint8Array(L);
    for (let u = 0; u < L; u++) {
      const w = hw(u) + track.runoff;
      let along = 0,
        center = 0;
      for (let k = -6; k < 6; k++) {
        const a = at(u + k, side),
          b = at(u + k + 1, side);
        along += Math.hypot(b[0] - a[0], b[1] - a[1]);
        const i = (((u + k) % L) + L) % L,
          j = (i + 1) % L;
        center += Math.hypot(f.cx[j] - f.cx[i], f.cy[j] - f.cy[i]);
      }
      const radius = center > 0 && along > center ? (w * center) / (along - center) : Infinity; // celdas
      if (radius * M < CURVE_R_M) outside[u] = 1;
    }
    const on = new Uint8Array(L);
    for (let u = 0; u < L; u++) {
      if (!outside[u]) continue;
      for (let k = -AROUND; k <= AROUND; k++) on[(((u + k) % L) + L) % L] = 1;
    }
    for (let u = 0; u < L; u++) {
      const d = Math.min(u, L - u);
      if (d < MAIN) on[u] = 1;
      const seg = Math.floor(u / RANDOM_SEG),
        h = Math.sin(seg * 12.9898 + side * 78.233) * 43758.5453;
      if (h - Math.floor(h) < RANDOM_SHARE) on[u] = 1;
    }
    // sólo donde ese muro es el de verdad: ahí la distancia a la pista (sdf) es la de la escapatoria
    for (let u = 0; u < L; u++) {
      if (!on[u]) continue;
      const [x, y] = at(u, side);
      const s = sampleField(track.sdf, track.W, x, y);
      if (Math.abs(s + track.runoff) > 0.35) on[u] = 0;
    }
    spans[side] = on;
  }
  spans.at = at;
  spans.L = L;
  return spans;
}

// la malla: un rectángulo por celda con reja, del tope del muro (el piso del borde de la pista más wallH) hasta
// FENCE_H_M más arriba. Por vértice: x, y, z (celdas), u (m a lo largo, para la textura), v (0 arriba, 1 abajo)
export function fenceMesh(track, wallH) {
  const spans = fenceSpans(track),
    { at, L } = spans,
    M = track.meters,
    H = FENCE_H_M / M;
  const v = [];
  for (const side of [-1, 1]) {
    const on = spans[side];
    let meters = 0;
    for (let u = 0; u < L; u++) {
      const a = at(u, side),
        b = at(u + 1, side);
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]) * M;
      if (on[u] && on[(u + 1) % L]) {
        // el tope del muro: el piso justo del lado de la pista
        const za = sampleField(track.height, track.W, ...at(u, side * 0.999)) + wallH;
        const zb = sampleField(track.height, track.W, ...at(u + 1, side * 0.999)) + wallH;
        const ua = meters,
          ub = meters + len;
        v.push(a[0], a[1], za + H, ua, 0, b[0], b[1], zb + H, ub, 0, b[0], b[1], zb, ub, 1);
        v.push(a[0], a[1], za + H, ua, 0, b[0], b[1], zb, ub, 1, a[0], a[1], za, ua, 1);
      }
      meters += len;
    }
  }
  return new Float32Array(v);
}
