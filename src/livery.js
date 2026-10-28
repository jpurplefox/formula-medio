// Decoración del auto, dibujada por código en un canvas: una sola imagen (atlas) con tres zonas.
// - Costado derecho y costado izquierdo: el auto visto de costado (x a lo largo, z para arriba).
//   Son el mismo dibujo; en uno de los dos los textos van espejados, así se leen bien de los dos lados.
// - Arriba: el auto visto desde arriba (x a lo largo, y a lo ancho).
// Todo se dibuja en metros, con la misma escala en las dos direcciones (LIVERY_S texeles por metro).
// Además: el flanco de las gomas, con la franja de color del compuesto y letras que giran con la rueda.

import { canvasTexture } from './textures.js';

const SIZE = 1024;
export const LIVERY_S = 176; // texeles por metro
export const HALF_L = 2.9; // el atlas cubre x de -HALF_L a HALF_L (m)
export const HALF_W = 1.1; // la zona de arriba cubre y de -HALF_W a HALF_W (m)
export const TALL = 1.1; // las zonas de costado cubren z de 0 a TALL (m)
export const SIDE_R = 4; // fila donde empieza el costado derecho
export const SIDE_L = 206; // fila donde empieza el costado izquierdo
export const TOP = 410; // fila donde empieza la zona de arriba

const FONT = 'ui-sans-serif, "Helvetica Neue", Arial, sans-serif';

// color '#rrggbb' multiplicado por k (para versiones más oscuras)
function tint(hex, k) {
  const n = parseInt(hex.slice(1), 16);
  const c = (v) => Math.min(255, Math.round(v * k));
  return `rgb(${c(n >> 16)},${c((n >> 8) & 255)},${c(n & 255)})`;
}

// Texto en metros: centrado en (a, b) del plano de la zona, de alto h (m).
// m = [a, b, c, d] dice hacia dónde van la derecha y la "arriba" del texto en el canvas.
function label(g, str, X, Y, h, m, fill, stroke = null) {
  g.save();
  const k = (h * LIVERY_S) / 100; // la letra se dibuja de 100 px de alto y se escala
  g.setTransform(m[0] * k, m[1] * k, m[2] * k, m[3] * k, X, Y);
  g.font = `italic 900 100px ${FONT}`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  if (stroke) {
    g.lineWidth = 14;
    g.lineJoin = 'round';
    g.strokeStyle = stroke;
    g.strokeText(str, 0, 0);
  }
  g.fillStyle = fill;
  g.fillText(str, 0, 0);
  g.restore();
}

// Un costado: fondo del color del auto, parte baja oscura, una franja blanca que corre de la trompa
// a la cola, el número sobre el pontón y los "sponsors" en la cubierta del motor, la trompa y el alerón.
function drawSide(g, row, color, accent, number, mirror) {
  const S = LIVERY_S;
  const X = (x) => (x + HALF_L) * S, Y = (z) => row + (TALL - z) * S;
  const path = (pts) => {
    g.beginPath();
    pts.forEach(([x, z], i) => (i ? g.lineTo(X(x), Y(z)) : g.moveTo(X(x), Y(z))));
    g.closePath();
  };
  const right = mirror ? [-1, 0, 0, 1] : [1, 0, 0, 1];
  g.fillStyle = color;
  g.fillRect(0, row, SIZE, TALL * S);
  // parte baja en negro, como el piso
  g.fillStyle = '#18181c';
  g.fillRect(0, Y(0.19), SIZE, 0.19 * S);
  // franja blanca con un filo oscuro abajo
  path([[2.7, 0.19], [1.2, 0.27], [0.2, 0.31], [-1.0, 0.33], [-2.4, 0.3], [-2.4, 0.35], [-1.0, 0.39], [0.2, 0.37], [1.2, 0.33], [2.7, 0.25]]);
  g.fillStyle = accent;
  g.fill();
  path([[2.7, 0.17], [1.2, 0.25], [0.2, 0.29], [-1.0, 0.31], [-2.4, 0.28], [-2.4, 0.3], [-1.0, 0.33], [0.2, 0.31], [1.2, 0.27], [2.7, 0.19]]);
  g.fillStyle = tint(color, 0.45);
  g.fill();
  // número sobre el pontón
  label(g, number, X(0.15), Y(0.47), 0.2, right, '#ffffff', '#111111');
  // sponsor en la cubierta del motor
  g.fillStyle = accent;
  g.beginPath();
  g.roundRect(X(-1.8), Y(0.56), 0.85 * S, 0.15 * S, 0.03 * S);
  g.fill();
  label(g, 'RAYCAST', X(-1.375), Y(0.485), 0.11, right, color);
  // en la trompa
  label(g, 'VOXEL', X(1.9), Y(0.3), 0.08, right, accent);
  // placas del alerón trasero: arriba blancas con el sponsor
  g.fillStyle = accent;
  g.fillRect(X(-2.9), Y(1.0), 0.6 * S, 0.24 * S);
  label(g, 'RAYCAST', X(-2.585), Y(0.88), 0.11, right, color);
}

// Visto desde arriba: franja blanca por el centro, número en la trompa (para leerlo desde atrás),
// sponsor sobre la cubierta del motor y en el flap del alerón trasero, puntas blancas en el alerón delantero.
function drawTop(g, color, accent, number) {
  const S = LIVERY_S;
  const X = (x) => (x + HALF_L) * S, Y = (y) => TOP + (y + HALF_W) * S;
  const up = [0, 1, -1, 0]; // texto girado: se lee mirando hacia adelante
  g.fillStyle = color;
  g.fillRect(0, TOP, SIZE, 2 * HALF_W * S);
  g.fillStyle = accent;
  g.fillRect(X(-2.3), Y(-0.035), 4.95 * S, 0.07 * S);
  g.fillStyle = tint(color, 0.45);
  g.fillRect(X(-2.3), Y(0.035), 4.95 * S, 0.015 * S);
  g.fillRect(X(-2.3), Y(-0.05), 4.95 * S, 0.015 * S);
  // número en la trompa, sobre un círculo blanco
  g.fillStyle = '#f4f4f4';
  g.beginPath();
  g.arc(X(1.75), Y(0), 0.12 * S, 0, Math.PI * 2);
  g.fill();
  label(g, number, X(1.75), Y(0), 0.13, up, '#111111');
  // sponsor sobre la cubierta del motor
  label(g, 'RAYCAST', X(-1.45), Y(0), 0.1, up, accent, '#111111');
  // flap del alerón trasero
  label(g, 'RAYCAST', X(-2.7), Y(0), 0.13, up, accent);
  // puntas del alerón delantero
  g.fillStyle = accent;
  for (const s of [-1, 1]) g.fillRect(X(2.2), Y(s > 0 ? 0.72 : -0.96), 0.35 * S, 0.24 * S);
}

// Atlas de la decoración de un auto
// color: carrocería; accent: franja, sponsors y detalles
export function liveryTexture(color, accent, number) {
  const c = document.createElement('canvas');
  c.width = c.height = SIZE;
  const g = c.getContext('2d');
  g.fillStyle = color;
  g.fillRect(0, 0, SIZE, SIZE);
  drawSide(g, SIDE_R, color, accent, number, false);
  drawSide(g, SIDE_L, color, accent, number, true);
  drawTop(g, color, accent, number);
  return canvasTexture(c);
}

export const SIDEWALL_SIZE = 256;
export const SIDEWALL_S = 128 / 0.37; // texeles por metro: la rueda (radio 0,36 m) ocupa casi todo el cuadrado

// Flanco de la goma: caucho oscuro, franja del compuesto y letras alrededor
export function sidewallTexture(compound = '#e0262b') {
  const c = document.createElement('canvas');
  c.width = c.height = SIDEWALL_SIZE;
  const g = c.getContext('2d');
  const m = SIDEWALL_SIZE / 2, S = SIDEWALL_S;
  g.fillStyle = '#343438';
  g.fillRect(0, 0, SIDEWALL_SIZE, SIDEWALL_SIZE);
  g.strokeStyle = compound;
  g.lineWidth = 0.022 * S;
  g.beginPath();
  g.arc(m, m, 0.26 * S, 0, Math.PI * 2);
  g.stroke();
  // letras siguiendo el círculo, de los dos lados
  g.fillStyle = '#d8d8dc';
  g.font = `bold ${Math.round(0.045 * S)}px ${FONT}`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  const word = 'RAYCAST';
  for (const base of [-Math.PI / 2, Math.PI / 2]) {
    for (let i = 0; i < word.length; i++) {
      const a = base + (i - (word.length - 1) / 2) * 0.17;
      g.save();
      g.translate(m + Math.cos(a) * 0.31 * S, m + Math.sin(a) * 0.31 * S);
      g.rotate(a + Math.PI / 2);
      g.fillText(word[i], 0, 0);
      g.restore();
    }
  }
  return canvasTexture(c);
}
