// Decoración del auto, dibujada por código en un canvas: una sola imagen (atlas) con tres zonas.
// - Costado derecho y costado izquierdo: el auto visto de costado (x a lo largo, z para arriba).
//   Son el mismo dibujo; en uno de los dos los textos van espejados, así se leen bien de los dos lados.
// - Arriba: el auto visto desde arriba (x a lo largo, y a lo ancho).
// Todo se dibuja en metros, con la misma escala en las dos direcciones (LIVERY_S texeles por metro).
// Además: el flanco de las gomas, con la franja de color del compuesto y letras que giran con la rueda,
// la banda de rodadura, de caucho gastado, y la cara de la llanta, con sus rayos.

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
  const sc = g.getTransform().a; // el atlas puede dibujarse más grande (sharp en liveryTexture)
  g.setTransform(m[0] * k * sc, m[1] * k * sc, m[2] * k * sc, m[3] * k * sc, X * sc, Y * sc);
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
  g.fillRect(X(-2.55), Y(1.0), 0.6 * S, 0.24 * S);
  label(g, 'RAYCAST', X(-2.235), Y(0.88), 0.11, right, color);
}

// Visto desde arriba: franja blanca por el centro, número en la trompa (se lee mirando el auto de frente, como en
// los de verdad),
// sponsor sobre la cubierta del motor y en el flap del alerón trasero, puntas blancas en el alerón delantero.
function drawTop(g, color, accent, number) {
  const S = LIVERY_S;
  const X = (x) => (x + HALF_L) * S, Y = (y) => TOP + (y + HALF_W) * S;
  const up = [0, 1, -1, 0]; // texto girado: se lee desde atrás, mirando hacia adelante
  const down = [0, -1, 1, 0]; // y al revés: se lee desde adelante
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
  label(g, number, X(1.75), Y(0), 0.13, down, '#111111');
  // sponsor sobre la cubierta del motor
  label(g, 'RAYCAST', X(-1.45), Y(0), 0.1, up, accent, '#111111');
  // flap del alerón trasero
  label(g, 'RAYCAST', X(-2.35), Y(0), 0.13, up, accent);
  // puntas del alerón delantero
  g.fillStyle = accent;
  for (const s of [-1, 1]) g.fillRect(X(2.2), Y(s > 0 ? 0.72 : -0.96), 0.35 * S, 0.24 * S);
}

// Atlas de la decoración de un auto
// color: carrocería; accent: franja, sponsors y detalles; sharp: el atlas en sharp veces más resolución (para el
// auto propio, que desde la cabina se ve de muy cerca); las coordenadas de textura se multiplican igual
export function liveryTexture(color, accent, number, sharp = 1) {
  const c = document.createElement('canvas');
  c.width = c.height = SIZE * sharp;
  const g = c.getContext('2d');
  g.scale(sharp, sharp);
  g.fillStyle = color;
  g.fillRect(0, 0, SIZE, SIZE);
  drawSide(g, SIDE_R, color, accent, number, false);
  drawSide(g, SIDE_L, color, accent, number, true);
  drawTop(g, color, accent, number);
  return canvasTexture(c);
}

export const SIDEWALL_SIZE = 256;
export const SIDEWALL_S = 128 / 0.37; // texeles por metro: la rueda (radio 0,36 m) ocupa casi todo el cuadrado
export const TREAD_SIZE = 256;
export const RIM_SIZE = 256;
export const RIM_S = 128 / 0.235; // texeles por metro: la cara de la llanta (radio 0,229 m) ocupa casi todo el cuadrado

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
  g.arc(m, m, 0.245 * S, 0, Math.PI * 2);
  g.stroke();
  // letras siguiendo el círculo, de los dos lados
  g.fillStyle = '#d8d8dc';
  g.font = `bold ${Math.round(0.045 * S)}px ${FONT}`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  const word = 'FIRELLO'; // el proveedor de neumáticos
  for (const base of [-Math.PI / 2, Math.PI / 2]) {
    for (let i = 0; i < word.length; i++) {
      const a = base + (i - (word.length - 1) / 2) * 0.17;
      g.save();
      g.translate(m + Math.cos(a) * 0.282 * S, m + Math.sin(a) * 0.282 * S);
      g.rotate(a + Math.PI / 2);
      g.fillText(word[i], 0, 0);
      g.restore();
    }
  }
  return canvasTexture(c);
}

// Banda de rodadura: x alrededor de la rueda (se repite, así que todo lo que se dibuja se repite del otro lado),
// y a lo ancho, de un flanco al otro pasando por los hombros. Caucho con grano fino, la zona que pisa un poco más
// clara y opaca, hombros más oscuros y marcas de goma arrastrada a lo largo de la vuelta, que dejan ver que gira.
export function treadTexture() {
  const N = TREAD_SIZE;
  const c = document.createElement('canvas');
  c.width = c.height = N;
  const g = c.getContext('2d');
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  // a lo ancho: hombros oscuros, banda más clara
  const across = g.createLinearGradient(0, 0, 0, N);
  across.addColorStop(0, '#202024');
  across.addColorStop(0.2, '#2b2b30');
  across.addColorStop(0.3, '#34343a');
  across.addColorStop(0.7, '#34343a');
  across.addColorStop(0.8, '#2b2b30');
  across.addColorStop(1, '#202024');
  g.fillStyle = across;
  g.fillRect(0, 0, N, N);
  // marcas de goma a lo largo de la vuelta, más que nada sobre la zona que pisa
  for (let i = 0; i < 90; i++) {
    const x = rand() * N, y = N * (0.22 + rand() * 0.56), len = 8 + rand() * 50, h = 1 + rand() * 3;
    g.fillStyle = rand() < 0.6 ? `rgba(70,70,76,${0.25 + rand() * 0.3})` : `rgba(14,14,16,${0.3 + rand() * 0.3})`;
    for (const dx of [0, -N]) g.fillRect(x + dx, y, len, h);
  }
  // grano fino
  const img = g.getImageData(0, 0, N, N), d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const k = (rand() - 0.5) * 10;
    d[i] += k;
    d[i + 1] += k;
    d[i + 2] += k;
  }
  g.putImageData(img, 0, 0);
  return canvasTexture(c);
}

// Cara de la llanta, vista de costado y centrada: el borde del aro, diez rayos de metal en pares que salen del cubo
// y, entre los rayos, el hueco oscuro con el disco de freno ranurado detrás.
export function rimTexture() {
  const N = RIM_SIZE, m = N / 2, S = RIM_S;
  const c = document.createElement('canvas');
  c.width = c.height = N;
  const g = c.getContext('2d');
  const disc = (r, fill) => {
    g.beginPath();
    g.arc(m, m, r * S, 0, Math.PI * 2);
    g.fillStyle = fill;
    g.fill();
  };
  // fondo: el hueco entre los rayos
  g.fillStyle = '#0d0d0f';
  g.fillRect(0, 0, N, N);
  // disco de freno, con ranuras curvas
  disc(0.17, '#2c2c30');
  disc(0.09, '#0d0d0f');
  g.strokeStyle = '#19191c';
  g.lineWidth = 0.006 * S;
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * Math.PI * 2;
    g.beginPath();
    g.arc(m + Math.cos(a) * 0.13 * S, m + Math.sin(a) * 0.13 * S, 0.035 * S, a + 0.6, a + 2.2);
    g.stroke();
  }
  // rayos: de a pares, más anchos en el cubo y finos hacia el aro, con un filo claro de un lado
  const spoke = (a, w0, w1, fill) => {
    const p = (r, w) => [m + (Math.cos(a) * r - Math.sin(a) * w) * S, m + (Math.sin(a) * r + Math.cos(a) * w) * S];
    g.beginPath();
    g.moveTo(...p(0.05, -w0));
    g.lineTo(...p(0.215, -w1));
    g.lineTo(...p(0.215, w1));
    g.lineTo(...p(0.05, w0));
    g.closePath();
    g.fillStyle = fill;
    g.fill();
  };
  for (let i = 0; i < 5; i++) {
    for (const d of [-0.16, 0.16]) {
      const a = (i / 5) * Math.PI * 2 + d;
      spoke(a, 0.022, 0.012, '#4f535b');
      spoke(a + 0.025, 0.014, 0.007, '#8d929c');
    }
  }
  // aro (el borde interior de la llanta) y cubo
  g.strokeStyle = '#6f747d';
  g.lineWidth = 0.02 * S;
  g.beginPath();
  g.arc(m, m, 0.218 * S, 0, Math.PI * 2);
  g.stroke();
  disc(0.065, '#5a5e66');
  disc(0.05, '#3b3e44');
  return canvasTexture(c);
}
