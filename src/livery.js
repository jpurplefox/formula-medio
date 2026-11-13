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

// Letras de los sponsors: cada uno con su tipografía, así no se parecen todos
const FONTS = {
  black: `italic 900 100px ${FONT}`,
  wide: `900 100px "Arial Black", ${FONT}`,
  serif: `italic 700 100px Georgia, "Times New Roman", serif`,
  mono: `700 100px "Courier New", monospace`,
  narrow: `700 100px "Arial Narrow", "Avenir Next Condensed", ${FONT}`,
  round: `800 100px "Trebuchet MS", Verdana, ${FONT}`,
  thin: `300 100px "Helvetica Neue", ${FONT}`,
  impact: `100px Impact, "Haettenschweiler", "Arial Narrow", ${FONT}`,
};

// Texto en metros: centrado en (a, b) del plano de la zona, de alto h (m).
// m = [a, b, c, d] dice hacia dónde van la derecha y la "arriba" del texto en el canvas.
// s: el sponsor ({ t: texto, c: color, font, bg: pastilla de color detrás, line: borde de las letras, shield: en vez
// de la pastilla, un escudo de arriba recto y abajo redondeado, con un borde de ese color y un filete verde adentro });
// w: el ancho máximo (m): si no entra, las letras se angostan
function label(g, s, X, Y, h, m, w = Infinity) {
  if (typeof s === 'string') s = { t: s };
  g.save();
  const k = (h * LIVERY_S) / 100; // la letra se dibuja de 100 px de alto y se escala
  const sc = g.getTransform().a; // el atlas puede dibujarse más grande (sharp en liveryTexture)
  g.font = FONTS[s.font ?? 'black'];
  const tw = g.measureText(s.t).width + (s.shield ? 110 : s.bg ? 50 : 0);
  const sx = Math.min(1, (w * LIVERY_S) / (tw * k));
  g.setTransform(m[0] * k * sx * sc, m[1] * k * sx * sc, m[2] * k * sc, m[3] * k * sc, X * sc, Y * sc);
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  if (s.shield) {
    const shield = (k) => {
      g.beginPath();
      g.moveTo((-tw / 2) * k, -72 * k);
      g.lineTo((tw / 2) * k, -72 * k);
      g.lineTo((tw / 2) * k, -10);
      g.ellipse(0, -10, (tw / 2) * k, 88 * k, 0, 0, Math.PI);
      g.closePath();
    };
    shield(1);
    g.fillStyle = s.bg;
    g.fill();
    g.lineWidth = 12;
    g.strokeStyle = s.shield;
    g.stroke();
    shield(0.9);
    g.lineWidth = 5;
    g.strokeStyle = '#2f9a3c';
    g.stroke();
  } else if (s.bg) {
    g.fillStyle = s.bg;
    g.beginPath();
    g.roundRect(-tw / 2, -66, tw, 132, 22);
    g.fill();
  }
  if (s.line) {
    g.lineWidth = 14;
    g.lineJoin = 'round';
    g.strokeStyle = s.line;
    g.strokeText(s.t, 0, 0);
  }
  g.fillStyle = s.c ?? '#ffffff';
  g.fillText(s.t, 0, 0);
  g.restore();
}

// Dónde va cada sponsor, en partes de la carrocería bastante planas, así no se cortan. De costado: [x, z, alto, ancho
// máximo] (m): el pontón (el principal, grande, antes de que baje), la cubierta del motor, la trompa, la cabina, el
// pontón abajo y las placas del alerón trasero. Desde arriba: [x, y, alto, ancho máximo], los textos a lo largo del
// auto: la cubierta del motor, el flap del alerón trasero, la trompa, el alerón delantero y delante de la cabina.
export const SIDE_SLOTS = {
  pod: [-0.25, 0.4, 0.11, 0.62],
  cover: [-1.3, 0.66, 0.1, 0.62],
  nose: [2.12, 0.27, 0.065, 0.5],
  cockpit: [0.86, 0.47, 0.055, 0.34],
  podLow: [-0.75, 0.27, 0.05, 0.6],
  plate: [-2.24, 0.885, 0.11, 0.42],
  plateLow: [-2.38, 0.58, 0.06, 0.34],
};
export const TOP_SLOTS = {
  cover: [-1.45, 0, 0.1, 0.9],
  flap: [-2.35, 0, 0.12, 0.85],
  nose: [2.32, 0, 0.06, 0.4],
  wing: [2.32, 0.48, 0.05, 0.2],
  front: [0.92, 0, 0.055, 0.3],
};

// La forma del auto de costado (x, z), para que los dibujos sigan sus líneas: lo alto de los pontones, de la
// cubierta del motor (por el medio y por los hombros) y de la trompa
export const LINES = {
  pod: [
    [0.58, 0.56],
    [0.3, 0.69],
    [-0.3, 0.7],
    [-0.75, 0.6],
    [-1.15, 0.47],
    [-1.5, 0.36],
    [-1.8, 0.3],
    [-2.3, 0.27],
  ],
  cover: [
    [-0.42, 0.8],
    [-0.6, 0.97],
    [-0.95, 0.95],
    [-1.25, 0.86],
    [-1.55, 0.74],
    [-1.95, 0.56],
    [-2.3, 0.41],
  ],
  shoulder: [
    [-0.42, 0.775],
    [-0.6, 0.75],
    [-0.95, 0.62],
    [-1.25, 0.47],
    [-1.55, 0.36],
    [-1.95, 0.3],
    [-2.3, 0.28],
  ],
  nose: [
    [2.9, 0.138],
    [2.74, 0.209],
    [2.62, 0.259],
    [2.4, 0.345],
    [2.1, 0.448],
    [1.7, 0.557],
    [1.15, 0.635],
  ],
};

// Herramientas para dibujar una zona en metros: de costado (a, b) = (x, z) y desde arriba (a, b) = (x, y).
// poly: un polígono relleno; band: lo que queda entre dos líneas que van de adelante hacia atrás (listas de [a, b]
// que se recorren de punta a punta); along: un degradé a lo largo del auto, de a0 a a1, entre los colores dados;
// text: un sponsor en un lugar de la lista (SIDE_SLOTS o TOP_SLOTS)
function zone(g, X, Y, m, slots, mirror = 1) {
  const path = (pts) => {
    g.beginPath();
    pts.forEach(([a, b], i) => (i ? g.lineTo(X(a), Y(b)) : g.moveTo(X(a), Y(b))));
    g.closePath();
  };
  const z = {
    g,
    X,
    Y,
    poly(pts, fill) {
      path(pts);
      g.fillStyle = fill;
      g.fill();
    },
    band(lo, hi, fill) {
      z.poly([...lo, ...[...hi].reverse()], fill);
    },
    rect(a0, b0, a1, b1, fill) {
      z.poly(
        [
          [a0, b0],
          [a1, b0],
          [a1, b1],
          [a0, b1],
        ],
        fill,
      );
    },
    along(a0, a1, stops) {
      const gr = g.createLinearGradient(X(a0), 0, X(a1), 0);
      stops.forEach((c, i) => gr.addColorStop(i / (stops.length - 1), c));
      return gr;
    },
    circle(a, b, r, fill) {
      g.beginPath();
      g.arc(X(a), Y(b), r * LIVERY_S, 0, Math.PI * 2);
      g.fillStyle = fill;
      g.fill();
    },
    // lo mismo del otro lado (desde arriba): b → -b
    both(fn) {
      fn(1);
      fn(-1);
    },
    text(slot, s, b = null) {
      const [a, bb, h, w] = slots[slot];
      label(g, s, X(a), Y(b ?? bb), h * (s.size ?? 1), m, w);
    },
    mirror,
  };
  return z;
}

// la parte de arriba de una línea, corrida dz
export const shift = (line, dz) => line.map(([a, b]) => [a, b + dz]);

// Un costado: la pintura del equipo (design.side), el piso negro, el número sobre el pontón y los sponsors
function drawSide(g, row, color, design, number, mirror) {
  const S = LIVERY_S;
  const right = mirror ? [-1, 0, 0, 1] : [1, 0, 0, 1];
  const z = zone(
    g,
    (x) => (x + HALF_L) * S,
    (h) => row + (TALL - h) * S,
    right,
    SIDE_SLOTS,
    mirror ? -1 : 1,
  );
  g.fillStyle = color;
  g.fillRect(0, row, SIZE, TALL * S);
  design.side(z);
  // parte baja en negro, como el piso
  g.fillStyle = '#18181c';
  g.fillRect(0, z.Y(0.19), SIZE, 0.19 * S);
  label(
    g,
    { t: number, c: design.number ?? '#ffffff', line: design.numberLine ?? '#111111' },
    z.X(0.27),
    z.Y(0.47),
    0.2,
    right,
  );
  for (const [slot, s] of Object.entries(design.sponsors.side)) z.text(slot, s);
}

// Visto desde arriba: la pintura del equipo (design.top), el número en la trompa (se lee mirando el auto de frente,
// como en los de verdad) y los sponsors (se leen desde atrás, mirando hacia adelante)
function drawTop(g, color, design, number) {
  const S = LIVERY_S;
  const up = [0, 1, -1, 0]; // texto girado: se lee desde atrás, mirando hacia adelante
  const down = [0, -1, 1, 0]; // y al revés: se lee desde adelante
  const z = zone(
    g,
    (x) => (x + HALF_L) * S,
    (y) => TOP + (y + HALF_W) * S,
    up,
    TOP_SLOTS,
  );
  g.fillStyle = color;
  g.fillRect(0, TOP, SIZE, 2 * HALF_W * S);
  design.top(z);
  // número en la trompa, sobre un círculo
  g.fillStyle = design.numberDisc ?? '#f4f4f4';
  g.beginPath();
  g.arc(z.X(1.75), z.Y(0), 0.12 * S, 0, Math.PI * 2);
  g.fill();
  label(g, { t: number, c: '#111111' }, z.X(1.75), z.Y(0), 0.13, down);
  for (const [slot, s] of Object.entries(design.sponsors.top)) {
    // los del alerón delantero van de a dos, uno de cada lado
    if (slot === 'wing') z.both((k) => z.text(slot, s, k * TOP_SLOTS[slot][1]));
    else z.text(slot, s);
  }
}

// La decoración de siempre, para lo que no es de un equipo (el fantasma de la contrarreloj): franja del color de
// detalle de la trompa a la cola y un par de sponsors
export const plainDesign = (color, accent) => ({
  side(z) {
    z.band(
      shift(LINES.nose, -0.2).concat([
        [0.2, 0.31],
        [-1.0, 0.33],
        [-2.4, 0.3],
      ]),
      [
        [2.7, 0.25],
        [1.2, 0.33],
        [0.2, 0.37],
        [-1.0, 0.39],
        [-2.4, 0.35],
      ],
      accent,
    );
    z.rect(-1.8, 0.56, -0.95, 0.41, accent);
    z.rect(-2.55, 1.0, -1.95, 0.76, accent);
  },
  top(z) {
    z.rect(-2.3, -0.035, 2.65, 0.035, accent);
    z.both((k) => z.rect(2.15, k * 0.45, 2.6, k * 0.97, accent));
  },
  sponsors: {
    side: { cover: { t: 'RAYCAST', c: color }, nose: { t: 'VOXEL', c: accent }, plate: { t: 'RAYCAST', c: color } },
    top: { cover: { t: 'RAYCAST', c: accent, line: '#111111' }, flap: { t: 'RAYCAST', c: accent } },
  },
});

// Atlas de la decoración de un auto
// color: carrocería (lo que mira hacia adelante o atrás queda de este color); design: la pintura y los sponsors del
// equipo (teamliveries.js); sharp: el atlas en sharp veces más resolución (para el auto propio, que desde la cabina
// se ve de muy cerca); las coordenadas de textura se multiplican igual. Lleva también el dibujo (art), para las
// vistas del auto en el menú
export function liveryTexture(color, design, number, sharp = 1) {
  const c = document.createElement('canvas');
  c.width = c.height = SIZE * sharp;
  const g = c.getContext('2d');
  g.scale(sharp, sharp);
  g.fillStyle = color;
  g.fillRect(0, 0, SIZE, SIZE);
  drawSide(g, SIDE_R, color, design, number, false);
  drawSide(g, SIDE_L, color, design, number, true);
  drawTop(g, color, design, number);
  return Object.assign(canvasTexture(c), { art: c });
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
  const m = SIDEWALL_SIZE / 2,
    S = SIDEWALL_S;
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
  const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
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
    const x = rand() * N,
      y = N * (0.22 + rand() * 0.56),
      len = 8 + rand() * 50,
      h = 1 + rand() * 3;
    g.fillStyle = rand() < 0.6 ? `rgba(70,70,76,${0.25 + rand() * 0.3})` : `rgba(14,14,16,${0.3 + rand() * 0.3})`;
    for (const dx of [0, -N]) g.fillRect(x + dx, y, len, h);
  }
  // grano fino
  const img = g.getImageData(0, 0, N, N),
    d = img.data;
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
  const N = RIM_SIZE,
    m = N / 2,
    S = RIM_S;
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
