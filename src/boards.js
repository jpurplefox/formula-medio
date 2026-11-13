// Carteles de distancia a la curva (track.boards: 200, 150, 100 y 50 m antes de cada curva fuerte) en 3D: un tablero
// sobre dos postes, de frente a los autos que vienen. Adelante, panel blanco con el número en negro y marco azul
// oscuro (como las barreras), y abajo una franja con un sponsor (sponsors.js), el mismo para los cuatro carteles de
// cada curva; atrás y los postes, gris. La malla y la imagen las usa glrenderer.js.

import { lineFrame } from './ai.js';
import { BOARD_DISTANCES, stationAt } from './track.js';
import { SPONSORS } from './sponsors.js';

const W_M = 2.6, // ancho del tablero (m)
  NUMBER_M = 1.15, // alto de la parte del número
  STRIP_M = 0.42, // alto de la franja del sponsor
  BOTTOM_M = 0.55, // altura del borde de abajo del tablero
  DEPTH_M = 0.08, // espesor
  POST_M = 0.09, // medio ancho de cada poste
  POST_AT = 0.85; // a cuánto del centro va cada poste
const FRAME = '#1c2b4d';
const BACK = [0.36, 0.37, 0.39],
  POST = [0.28, 0.29, 0.31];

const IMG_W = 512,
  NUM_H = Math.round((IMG_W * NUMBER_M) / W_M),
  STRIP_H = Math.round((IMG_W * STRIP_M) / W_M);
export const BOARD_IMG = { w: IMG_W, h: NUM_H * BOARD_DISTANCES.length + STRIP_H * SPONSORS.length };

// la imagen: primero una fila por número (con el marco arriba y a los costados), después una por sponsor (con el
// marco abajo y a los costados)
export function boardImage() {
  const c = document.createElement('canvas');
  c.width = BOARD_IMG.w;
  c.height = BOARD_IMG.h;
  const g = c.getContext('2d');
  const F = 14; // ancho del marco (px)
  BOARD_DISTANCES.forEach((d, i) => {
    const y = i * NUM_H;
    g.fillStyle = FRAME;
    g.fillRect(0, y, IMG_W, NUM_H);
    g.fillStyle = '#f5f5f2';
    g.fillRect(F, y + F, IMG_W - 2 * F, NUM_H - F);
    g.fillStyle = '#111111';
    g.font = `bold ${Math.round(NUM_H * 0.78)}px Arial, Helvetica, sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(String(d), IMG_W / 2, y + F + (NUM_H - F) / 2 + NUM_H * 0.04, IMG_W - 4 * F);
  });
  SPONSORS.forEach((s, i) => {
    const y = BOARD_DISTANCES.length * NUM_H + i * STRIP_H;
    g.fillStyle = FRAME;
    g.fillRect(0, y, IMG_W, STRIP_H);
    g.fillStyle = s.bg;
    g.fillRect(F, y + 4, IMG_W - 2 * F, STRIP_H - 4 - F);
    g.fillStyle = s.fg;
    g.font = `bold ${Math.round(STRIP_H * 0.45)}px Arial, Helvetica, sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(s.name, IMG_W / 2, y + 4 + (STRIP_H - 4 - F) / 2 + 1, IMG_W - 6 * F);
  });
  return c;
}

// la malla de todos los carteles del circuito. Por vértice: posición (celdas), normal, uv (en la imagen; u < 0: sin
// imagen) y color (para lo que no lleva imagen)
export function boardMesh(track) {
  const f = lineFrame(track),
    M = track.meters,
    v = [];
  const H = BOARD_IMG.h;
  for (const b of track.boards) {
    const st = Math.max(0, stationAt(track, b.x, b.y));
    const i = Math.min(f.L - 1, Math.round(st));
    // hacia dónde corren los autos ahí, y a la derecha de eso (lineFrame: la normal apunta a la derecha)
    const rx = f.nx[i],
      ry = f.ny[i],
      fx = -ry,
      fy = rx;
    // el sponsor de la curva: el mismo para sus cuatro carteles (los de una curva caen cerca de la misma posición
    // contando la distancia que falta)
    const corner = Math.round((st + b.meters / M) / 40);
    const h = Math.sin(corner * 12.9898) * 43758.5453,
      sponsor = Math.floor((h - Math.floor(h)) * SPONSORS.length);
    const row = BOARD_DISTANCES.indexOf(b.meters);
    const P = (a, z, depth = 0) => [b.x + (rx * a - fx * depth) / M, b.y + (ry * a - fy * depth) / M, b.z + z / M];
    const quad = (p0, p1, p2, p3, n, uv, color) => {
      const [u0, v0, u1, v1] = uv ?? [-1, 0, -1, 0];
      const c = color ?? [1, 1, 1];
      for (const [p, u, w] of [
        [p0, u0, v1],
        [p1, u1, v1],
        [p2, u1, v0],
        [p0, u0, v1],
        [p2, u1, v0],
        [p3, u0, v0],
      ])
        v.push(...p, ...n, u, w, ...c);
    };
    const back = [fx, fy, 0],
      front = [-fx, -fy, 0]; // el frente mira a los que vienen
    const zStrip = BOTTOM_M,
      zNum = BOTTOM_M + STRIP_M,
      zTop = zNum + NUMBER_M,
      hw = W_M / 2,
      d = DEPTH_M;
    // frente: franja del sponsor y número (u de izquierda a derecha mirando desde la pista)
    const numV = [row * NUM_H, (row + 1) * NUM_H].map((y) => y / H);
    const stripV = [
      BOARD_DISTANCES.length * NUM_H + sponsor * STRIP_H,
      BOARD_DISTANCES.length * NUM_H + (sponsor + 1) * STRIP_H,
    ].map((y) => y / H);
    quad(P(-hw, zNum), P(hw, zNum), P(hw, zTop), P(-hw, zTop), front, [0, numV[0], 1, numV[1]]);
    quad(P(-hw, zStrip), P(hw, zStrip), P(hw, zNum), P(-hw, zNum), front, [0, stripV[0], 1, stripV[1]]);
    // dorso y cantos
    quad(P(hw, zStrip, d), P(-hw, zStrip, d), P(-hw, zTop, d), P(hw, zTop, d), back, null, BACK);
    quad(P(-hw, zTop), P(hw, zTop), P(hw, zTop, d), P(-hw, zTop, d), [0, 0, 1], null, BACK);
    quad(P(hw, zStrip), P(-hw, zStrip), P(-hw, zStrip, d), P(hw, zStrip, d), [0, 0, -1], null, BACK);
    quad(P(-hw, zStrip, d), P(-hw, zStrip), P(-hw, zTop), P(-hw, zTop, d), [-rx, -ry, 0], null, BACK);
    quad(P(hw, zStrip), P(hw, zStrip, d), P(hw, zTop, d), P(hw, zTop), [rx, ry, 0], null, BACK);
    // postes: del piso (un poco enterrados) al tablero, detrás del panel
    for (const at of [-POST_AT, POST_AT]) {
      const a0 = at - POST_M,
        a1 = at + POST_M,
        d0 = d,
        d1 = d + 2 * POST_M;
      quad(P(a0, -0.3, d0), P(a1, -0.3, d0), P(a1, zStrip, d0), P(a0, zStrip, d0), front, null, POST);
      quad(P(a1, -0.3, d1), P(a0, -0.3, d1), P(a0, zStrip, d1), P(a1, zStrip, d1), back, null, POST);
      quad(P(a0, -0.3, d1), P(a0, -0.3, d0), P(a0, zStrip, d0), P(a0, zStrip, d1), [-rx, -ry, 0], null, POST);
      quad(P(a1, -0.3, d0), P(a1, -0.3, d1), P(a1, zStrip, d1), P(a1, zStrip, d0), [rx, ry, 0], null, POST);
    }
  }
  return new Float32Array(v);
}
