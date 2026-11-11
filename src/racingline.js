// Trazada ideal: la línea que usa todo el ancho de la pista para abrir las curvas,
// y la velocidad a la que se puede ir en cada punto de esa línea con los límites del auto (car.limits).
// Todo se guarda por posición sobre la línea central (una entrada por celda), como los pianos.

import { cornerSpeed } from './lapsim.js';
import { curvature, halfWidthAt } from './track.js';

const MARGIN = 1.3; // distancia mínima de la trazada al borde de la pista (m): medio auto y un poco más
const GRIP_USE = 0.94; // fracción del agarre lateral que usa la trazada (un poco de margen)
const BRAKE_USE = 0.85; // fracción de la frenada máxima, para que los puntos de frenada sean alcanzables
const BRAKE_TURNING = 0.3; // doblando al límite todavía se puede frenar esta parte (soltando el freno al entrar)
const BEND_RADIUS = 400; // radio (m) por debajo del cual la pista está doblando
const CORNER_RADIUS = 250; // radio mínimo (m) para que una curva se tome abriendo y cerrando (las más suaves, a fondo y sin vueltas)
const ENTRY = 25; // cuánto antes de que empiece la curva se llega bien abierto (m)
const EXIT = 60; // cuánto después de que termina la curva se termina de abrir (m)
const SMOOTH = [[4, 12]]; // suavizado final: [distancia a los vecinos (celdas), pasadas]

// limits: qué fracción del agarre y de la frenada usa (por defecto, con margen, para la trazada que ves;
// los rivales usan una más al límite)
export function racingLine(track, limits, { gripUse = GRIP_USE, brakeUse = BRAKE_USE } = {}) {
  const { path, meters, halfWidths } = track;
  const { n, x, y, st } = path;
  const wrap = (b) => ((b % n) + n) % n;

  // normal hacia la derecha de la marcha en cada punto (mismo signo que track.lat)
  const nx = new Float64Array(n),
    ny = new Float64Array(n);
  for (let b = 0; b < n; b++) {
    const dx = x[wrap(b + 2)] - x[wrap(b - 2)],
      dy = y[wrap(b + 2)] - y[wrap(b - 2)];
    const len = Math.hypot(dx, dy) || 1;
    nx[b] = -dy / len;
    ny[b] = dx / len;
  }

  // 1) La línea, curva por curva, como la hacen los pilotos: se llega por el lado de afuera,
  //    se toca el vértice (el punto más cerrado) del lado de adentro y se sale abriendo de nuevo hacia afuera.
  //    Entre una curva y otra la línea cruza la pista de a poco; en las eses va de vértice a vértice.
  // hasta dónde se puede abrir en cada punto (y en una posición cualquiera de la vuelta): la pista no es pareja
  const lim = Float64Array.from(halfWidths, (h) => h - MARGIN / meters);
  const limAt = (s) => halfWidthAt(track, s) - MARGIN / meters;
  const len = st[n];
  const corners = findCorners(curvature({ n, x, y, wrap }), st, n, wrap, meters);
  const ctrl = controlPoints(corners, len, limAt, meters);
  const off = new Float64Array(n);
  if (ctrl.length) {
    // entre dos puntos de control, transición suave (sin quiebres, plana en cada punto de control)
    let j = -1; // último punto de control antes de b (-1: el tramo viene del último de la vuelta)
    for (let b = 0; b < n; b++) {
      while (j + 1 < ctrl.length && ctrl[j + 1].s <= st[b]) j++;
      const a = ctrl[j < 0 ? ctrl.length - 1 : j],
        c = ctrl[(j + 1) % ctrl.length];
      const span = (c.s - a.s + len) % len || len;
      const t = ((st[b] - a.s + len) % len) / span;
      off[b] = a.o + (c.o - a.o) * t * t * (3 - 2 * t);
    }
  }
  // después se suaviza: cada punto se corre de costado hacia el promedio de sus vecinos, sin salirse de la pista.
  // Eso endereza los zigzags entre curvitas seguidas sin perder el abrir-cerrar-abrir de cada curva.
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

  // 2) Curvatura de la trazada (por el círculo que pasa por tres puntos) y largo de cada tramo, en metros
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

  // 3) Velocidad: en cada punto, la máxima que aguanta el agarre (v²·curvatura = agarre, que crece con v²);
  //    después, hacia atrás, hay que llegar frenando, y hacia adelante, sólo se puede acelerar lo que da el motor.
  //    Se dan dos vueltas para que el final de la vuelta empalme con el principio.
  const v = Float64Array.from(curv, (k) => cornerSpeed(limits, k, gripUse));
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 2 * n - 1; i >= 0; i--) {
      const b = wrap(i),
        next = v[wrap(b + 1)];
      // doblando, a las gomas les queda menos para frenar (círculo de fricción): hay que frenar antes de la curva
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

  // 4) Pasamos todo a una entrada por celda de la línea central
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

// Tramos donde la pista dobla siempre para el mismo lado, con su vértice (el punto más cerrado).
// sign: +1 dobla a la derecha, -1 a la izquierda. Posiciones en celdas sobre la línea central.
function findCorners(curv, st, n, wrap, meters) {
  const bend = meters / BEND_RADIUS,
    sharp = meters / CORNER_RADIUS;
  const bent = (b) => Math.abs(curv[b]) > bend;
  let start = 0;
  while (start < n && bent(start)) start++; // arrancamos en una recta para no partir una curva
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

// Puntos de control de la trazada: afuera antes de la curva, adentro en el vértice, afuera después.
// Si la salida de una curva se pisa con la entrada de la siguiente: si doblan para el mismo lado,
// queda un solo punto afuera en el medio; si doblan para lados contrarios (una ese), se va de vértice a vértice.
function controlPoints(corners, len, limAt, meters) {
  const m = corners.length;
  if (!m) return [];
  // posiciones "desenrolladas": siempre crecientes a lo largo de la vuelta
  let shift = 0;
  const cs = corners.map((c, i) => {
    if (i > 0 && c.from < corners[i - 1].from) shift = len;
    const u = (s) => (s < c.from ? s + len : s) + shift; // apex y to pueden pasar la largada
    return { sign: c.sign, entry: c.from + shift - ENTRY / meters, apex: u(c.apex), exit: u(c.to) + EXIT / meters };
  });
  const pts = [];
  for (let i = 0; i < m; i++) {
    const c = cs[i];
    const next = i + 1 < m ? cs[i + 1] : { ...cs[0], entry: cs[0].entry + len, apex: cs[0].apex + len };
    const prev = i > 0 ? cs[i - 1] : { ...cs[m - 1], apex: cs[m - 1].apex - len, exit: cs[m - 1].exit - len };
    // entrada: sólo si no se pisa con la salida de la anterior (de eso se ocupa la anterior)
    if (c.entry > prev.exit && c.entry > prev.apex) pts.push({ s: c.entry, o: -c.sign * limAt(c.entry) });
    pts.push({ s: c.apex, o: c.sign * limAt(c.apex) });
    if (c.exit < next.entry) pts.push({ s: c.exit, o: -c.sign * limAt(c.exit) });
    else if (c.sign === next.sign) {
      // misma mano: un punto afuera entre las dos, sin pasar ninguno de los vértices
      const mid = Math.min(Math.max((c.exit + next.entry) / 2, c.apex + 1), next.apex - 1);
      if (mid > c.apex) pts.push({ s: mid, o: -c.sign * limAt(mid) });
    }
  }
  // a posiciones dentro de la vuelta, ordenadas
  return pts.map((p) => ({ s: ((p.s % len) + len) % len, o: p.o })).sort((a, b) => a.s - b.s);
}
