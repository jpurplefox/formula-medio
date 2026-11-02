// Modelo 3D del auto de fórmula, armado en código con piezas redondeadas (secciones unidas entre sí, tubos y ruedas).
// Coordenadas en metros, con el origen en el piso debajo del centro del auto:
// x hacia adelante, y hacia la derecha, z hacia arriba.
// Cada pieza es una serie de secciones (anillos de puntos) unidas por caras; la normal de cada cara se calcula
// al armar el modelo y apunta hacia afuera, así el renderer sabe qué caras se ven y cómo las ilumina el sol.

import { rgb } from './renderer.js';
import { carbonTexture } from './textures.js';
import { HALF_L, HALF_W, LIVERY_S, SIDE_L, SIDE_R, SIDEWALL_S, SIDEWALL_SIZE, TALL, TOP, TREAD_SIZE, RIM_S, RIM_SIZE, liveryTexture, rimTexture, sidewallTexture, treadTexture } from './livery.js';

const CARBON = rgb(34, 34, 38);
const COCKPIT = rgb(16, 16, 18);
const TYRE = rgb(26, 26, 28);
const SIDEWALL = rgb(52, 52, 56);
const RIM = rgb(118, 120, 128);
const RIM_FACE = rgb(90, 94, 102); // cara de la llanta (lleva la textura con los rayos)
const BARREL = rgb(44, 45, 50); // el interior de la llanta, del lado de adentro (en sombra)
const MIRROR = rgb(120, 140, 160);
const PADDING = rgb(32, 33, 38); // acolchado de la cabina
const RAIN_LIGHT = rgb(255, 60, 60);
const VISOR = rgb(20, 22, 28);
const CARBON_S = 400; // texeles de carbono por metro (cada celda del tejido, 2 cm)

export const WHEEL_R = 0.36; // radio de las ruedas (m)
const HUB_IN = -0.05; // la punta de los brazos de la suspensión, hacia adentro del costado de la goma (m):
// negativa, queda metida adentro de la llanta, donde va la mangueta
const WHEEL_SEGMENTS = 32; // lados del polígono de cada rueda
const SHOULDER_R = 0.05; // radio del hombro de la goma (m): el borde redondeado entre la banda y el flanco
const SHOULDER_STEPS = 4; // anillos con que se redondea cada hombro
const TREAD_TILES = 4; // veces que la textura de la banda da la vuelta a la rueda

// color '#rrggbb', multiplicado por k (k < 1 lo oscurece)
function hex(s, k = 1) {
  const n = parseInt(s.slice(1), 16);
  return rgb((n >> 16) * k, ((n >> 8) & 255) * k, (n & 255) * k);
}

// sección rectangular con las esquinas redondeadas (radio r, n tramos por esquina), perpendicular al eje x:
// centrada en yc, de medio ancho hw, entre z0 y z1
function sec(x, yc, hw, z0, z1, r = 0, n = 3) {
  r = Math.min(r, hw, (z1 - z0) / 2);
  const corners = [[yc + hw - r, z0 + r, -Math.PI / 2], [yc + hw - r, z1 - r, 0], [yc - hw + r, z1 - r, Math.PI / 2], [yc - hw + r, z0 + r, Math.PI]];
  const pts = [];
  for (const [cy, cz, a0] of corners) {
    for (let i = 0; i <= n; i++) {
      const a = a0 + (i / n) * (Math.PI / 2);
      pts.push([x, cy + r * Math.cos(a), cz + r * Math.sin(a)]);
    }
  }
  return pts;
}

// sección perpendicular al eje x con la forma de un polígono convexo (puntos [y, z]) de esquinas redondeadas:
// radii[i] es el radio de la esquina i (se achica si no entra en los lados vecinos), n tramos por esquina
function rounded(x, poly, radii, n = 4) {
  const pts = [], k = poly.length;
  for (let i = 0; i < k; i++) {
    const p = poly[i], a = poly[(i + k - 1) % k], b = poly[(i + 1) % k];
    const la = Math.hypot(a[0] - p[0], a[1] - p[1]), lb = Math.hypot(b[0] - p[0], b[1] - p[1]);
    const ua = [(a[0] - p[0]) / la, (a[1] - p[1]) / la], ub = [(b[0] - p[0]) / lb, (b[1] - p[1]) / lb];
    const half = Math.acos(Math.max(-1, Math.min(1, ua[0] * ub[0] + ua[1] * ub[1]))) / 2;
    // el arco toca los dos lados a una distancia t de la esquina
    const r = Math.min(radii[i], 0.45 * Math.min(la, lb) * Math.tan(half)), t = r / Math.tan(half);
    const bis = [ua[0] + ub[0], ua[1] + ub[1]], lbis = Math.hypot(...bis);
    const c = [p[0] + (bis[0] / lbis) * (r / Math.sin(half)), p[1] + (bis[1] / lbis) * (r / Math.sin(half))];
    const a0 = Math.atan2(p[1] + ua[1] * t - c[1], p[0] + ua[0] * t - c[0]);
    let a1 = Math.atan2(p[1] + ub[1] * t - c[1], p[0] + ub[0] * t - c[0]);
    if (a1 - a0 > Math.PI) a1 -= Math.PI * 2;
    if (a0 - a1 > Math.PI) a1 += Math.PI * 2;
    for (let j = 0; j <= n; j++) {
      const ang = a0 + (j / n) * (a1 - a0);
      pts.push([x, c[0] + r * Math.cos(ang), c[1] + r * Math.sin(ang)]);
    }
  }
  return pts;
}

// elipse perpendicular al eje x, de radios ry y rz, con n puntos
function ellipse(x, yc, ry, zc, rz, n = 12) {
  return [...Array(n).keys()].map((i) => {
    const a = (i / n) * Math.PI * 2;
    return [x, yc + ry * Math.cos(a), zc + rz * Math.sin(a)];
  });
}

const center = (ring) => ring.reduce((c, p) => [c[0] + p[0] / ring.length, c[1] + p[1] / ring.length, c[2] + p[2] / ring.length], [0, 0, 0]);

// normal de un polígono (método de Newell), orientada para alejarse del punto ref
function normal(pts, ref) {
  let nx = 0, ny = 0, nz = 0, cx = 0, cy = 0, cz = 0;
  for (let a = 0; a < pts.length; a++) {
    const p = pts[a], q = pts[(a + 1) % pts.length];
    nx += (p[1] - q[1]) * (p[2] + q[2]);
    ny += (p[2] - q[2]) * (p[0] + q[0]);
    nz += (p[0] - q[0]) * (p[1] + q[1]);
    cx += p[0]; cy += p[1]; cz += p[2];
  }
  const k = pts.length;
  if (nx * (cx / k - ref[0]) + ny * (cy / k - ref[1]) + nz * (cz / k - ref[2]) < 0) { nx = -nx; ny = -ny; nz = -nz; }
  const len = Math.hypot(nx, ny, nz) || 1;
  return [nx / len, ny / len, nz / len];
}

// Pieza que une dos o más secciones (con la misma cantidad de puntos), cerrada con tapas en las puntas.
// side(i): color del lado i (para las franjas de las gomas)
function loft(rings, color, capColor = color, side = null) {
  const k = rings[0].length, m = rings.length;
  const verts = rings.flat();
  const centers = rings.map(center);
  const faces = [];
  const face = (idx, c, ref) => faces.push({ idx, color: c, n: normal(idx.map((i) => verts[i]), ref) });
  const all = [...Array(k).keys()];
  // las tapas miran hacia afuera de la pieza: lejos de la sección vecina
  face(all, capColor, centers[1]);
  face(all.map((i) => (m - 1) * k + i), capColor, centers[m - 2]);
  for (let r = 0; r < m - 1; r++) {
    const a = centers[r], b = centers[r + 1];
    const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
    for (let i = 0; i < k; i++) {
      const j = (i + 1) % k;
      face([r * k + i, r * k + j, (r + 1) * k + j, (r + 1) * k + i], side ? side(i) : color, mid);
    }
  }
  return { verts, faces };
}

// tubo que pasa por los puntos de path: de sección cuadrada (medio lado t) o, con sides > 4, redondo (radio t; con
// un radio por punto, se afina o se ensancha a lo largo). flat < 1 lo aplasta en la dirección "hacia arriba" (sección ovalada, como un perfil)
function tube(path, t, color, sides = 4, flat = 1) {
  const rings = path.map((p, i) => {
    const a = path[Math.max(0, i - 1)], b = path[Math.min(path.length - 1, i + 1)];
    let dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
    const l = Math.hypot(dx, dy, dz) || 1;
    dx /= l; dy /= l; dz /= l;
    // dos direcciones perpendiculares al tubo: una horizontal y otra "hacia arriba"
    let ux = -dy, uy = dx, uz = 0;
    const lu = Math.hypot(ux, uy);
    if (lu < 1e-6) { ux = 1; uy = 0; } else { ux /= lu; uy /= lu; }
    const vx = dy * uz - dz * uy, vy = dz * ux - dx * uz, vz = dx * uy - dy * ux;
    const corners = sides > 4
      ? [...Array(sides).keys()].map((i) => [Math.cos((i / sides) * Math.PI * 2), Math.sin((i / sides) * Math.PI * 2)])
      : [[1, 1], [-1, 1], [-1, -1], [1, -1]];
    const r = Array.isArray(t) ? t[i] : t;
    return corners.map(([s, q]) => [p[0] + (ux * s + vx * q * flat) * r, p[1] + (uy * s + vy * q * flat) * r, p[2] + (uz * s + vz * q * flat) * r]);
  });
  return loft(rings, color);
}

// placa fina (el alerón del casco): de una sección en x0 a otra en x1, cada una con su altura de abajo y su espesor
const plate = (x0, z0, x1, z1, hw, t, color, yc = 0) => loft([sec(x0, yc, hw, z0, z0 + t), sec(x1, yc, hw, z1, z1 + t)], color);

// Perfil de ala (sección en el plano x-z, a la altura y): del borde de ataque `le` ([x, z], adelante) al de fuga
// `te`, con espesor máximo t (m) cerca del frente y combado hacia abajo, como las alas invertidas de un F1 que
// empujan el auto contra el piso. n puntos por cara, más juntos en los bordes.
function airfoil(y, le, te, t, camber = 0.05, n = 6) {
  const c = Math.hypot(te[0] - le[0], te[1] - le[1]);
  const ux = (te[0] - le[0]) / c, uz = (te[1] - le[1]) / c;
  const nx = uz * Math.sign(-ux), nz = -ux * Math.sign(-ux); // perpendicular a la cuerda, hacia arriba
  // medio espesor de un perfil NACA de 4 cifras (máximo 0,5 en un 30 % de la cuerda), con el borde de fuga cerrado
  const half = (u) => (t / 0.2) * (0.2969 * Math.sqrt(u) - 0.126 * u - 0.3516 * u * u + 0.2843 * u ** 3 - 0.1036 * u ** 4);
  const at = (u, side) => {
    const off = -camber * c * 4 * u * (1 - u) + side * half(u);
    return [le[0] + ux * c * u + nx * off, y, le[1] + uz * c * u + nz * off];
  };
  const us = [...Array(n + 1).keys()].map((i) => (1 - Math.cos((Math.PI * i) / n)) / 2);
  return [...us.map((u) => at(u, 1)), ...us.slice(1, -1).reverse().map((u) => at(u, -1))];
}

// Ala de punta a punta (y de -hw a hw): wing(y) da { le, te, t } en cada estación, para que cambie a lo ancho
function wing(hw, at, color, stations = 7) {
  return loft([...Array(stations).keys()].map((i) => {
    const y = -hw + (2 * hw * i) / (stations - 1), { le, te, t } = at(y);
    return airfoil(y, le, te, t);
  }), color);
}

// recorta un polígono [x, z] a la franja za <= z <= zb
function band(pts, za, zb) {
  const cut = (poly, inside, z) => poly.flatMap((p, i) => {
    const q = poly[(i + 1) % poly.length], a = inside(p[1]), b = inside(q[1]);
    const cross = a !== b ? [[p[0] + ((z - p[1]) / (q[1] - p[1])) * (q[0] - p[0]), z]] : [];
    return a ? [p, ...cross] : cross;
  });
  return cut(cut(pts, (z) => z >= za, za), (z) => z <= zb, zb);
}

// placa lateral de un alerón: de perfil, un polígono convexo de esquinas redondeadas (puntos [x, z]),
// de espesor t centrada en y. bend ([z, dy] de abajo hacia arriba) la dobla vista de atrás: corre la placa dy hacia
// afuera (o adentro, si es negativo) a cada altura; entre dos alturas es un tramo plano inclinado
function endplate(y, poly, radii, t, color, bend = null) {
  const outline = rounded(0, poly, radii, 3).map(([, x, z]) => [x, z]);
  const piece = (pts, za = 0, da = 0, zb = 1, db = 0) => {
    const off = (z) => Math.sign(y) * (da + ((z - za) / (zb - za)) * (db - da));
    const side = (yy) => pts.map(([x, z]) => [x, yy + off(z), z]);
    return loft([side(y - t / 2), side(y + t / 2)], color);
  };
  if (!bend) return piece(outline);
  const parts = [];
  for (let i = 0; i < bend.length - 1; i++) {
    const [za, da] = bend[i], [zb, db] = bend[i + 1];
    const pts = band(outline, i ? za : -Infinity, i < bend.length - 2 ? zb : Infinity);
    if (pts.length > 2) parts.push(piece(pts, za, da, zb, db));
  }
  return parts;
}
const box = (x0, x1, yc, hw, z0, z1, color, r = 0) => loft([sec(x0, yc, hw, z0, z1, r), sec(x1, yc, hw, z0, z1, r)], color);

// cilindro con el eje en y (ruedas y llantas)
function cylinder(x, z, r, y0, y1, n, color, capColor, side) {
  const ring = (y) => [...Array(n).keys()].map((i) => {
    const t = (i / n) * Math.PI * 2;
    return [x + r * Math.cos(t), y, z + r * Math.sin(t)];
  });
  return loft([ring(y0), ring(y1)], color, capColor, side);
}

// Goma: anillos alrededor del eje que siguen el perfil de un costado al otro. La banda es plana y los hombros
// se redondean en un cuarto de círculo hasta el flanco (las tapas, con el dibujo del flanco).
// Cada cara de la banda y los hombros lleva sus coordenadas en la textura de la banda: u alrededor de la rueda,
// v a lo ancho, siguiendo el perfil.
function tyre(x, y, width) {
  const hw = width / 2, rs = SHOULDER_R, n = WHEEL_SEGMENTS;
  // perfil: [corrimiento a lo ancho, radio], de un flanco al otro
  const profile = [];
  for (let i = SHOULDER_STEPS; i >= 0; i--) {
    const a = (i / SHOULDER_STEPS) * (Math.PI / 2);
    profile.push([-(hw - rs + rs * Math.sin(a)), WHEEL_R - rs + rs * Math.cos(a)]);
  }
  for (let i = 0; i <= SHOULDER_STEPS; i++) {
    const a = (i / SHOULDER_STEPS) * (Math.PI / 2);
    profile.push([hw - rs + rs * Math.sin(a), WHEEL_R - rs + rs * Math.cos(a)]);
  }
  const rings = profile.map(([dy, r]) => [...Array(n).keys()].map((i) => {
    const t = (i / n) * Math.PI * 2;
    return [x + r * Math.cos(t), y + dy, WHEEL_R + r * Math.sin(t)];
  }));
  const part = loft(rings, TYRE, SIDEWALL);
  // v: largo recorrido sobre el perfil, de 0 a 1
  const along = [0];
  for (let i = 1; i < profile.length; i++) along.push(along[i - 1] + Math.hypot(profile[i][0] - profile[i - 1][0], profile[i][1] - profile[i - 1][1]));
  const total = along[along.length - 1];
  // las dos primeras caras son las tapas; después van de a n por cada tramo del perfil
  part.faces.slice(2).forEach((f, k) => {
    const r = (k / n) | 0, i = k % n;
    const u0 = (i / n) * TREAD_TILES, u1 = ((i + 1) / n) * TREAD_TILES;
    const v0 = along[r] / total, v1 = along[r + 1] / total;
    Object.assign(f, { tread: true, uv: [[u0, v0], [u1, v0], [u1, v1], [u0, v1]] });
  });
  return part;
}

// Sólido de revolución alrededor del eje de la rueda: section es el corte (un polígono convexo de puntos
// [corrimiento hacia afuera, radio]) que se gira alrededor del eje. Cada cara mira lejos del centro del corte.
function revolve(x, y, s, section, n, color) {
  const verts = [], faces = [], k = section.length;
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    for (const [dy, r] of section) verts.push([x + r * Math.cos(t), y + s * dy, WHEEL_R + r * Math.sin(t)]);
  }
  const [cy, cr] = center(section.map(([dy, r]) => [dy, r, 0]));
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n, t = ((i + 0.5) / n) * Math.PI * 2;
    const ref = [x + cr * Math.cos(t), y + s * cy, WHEEL_R + cr * Math.sin(t)];
    for (let a = 0; a < k; a++) {
      const b = (a + 1) % k;
      const idx = [i * k + a, i * k + b, j * k + b, j * k + a];
      faces.push({ idx, color, n: normal(idx.map((v) => verts[v]), ref) });
    }
  }
  return { verts, faces };
}

// Llanta, del lado de afuera: un aro de metal que sobresale de la goma, la cara un poco hundida adentro del aro
// (con los rayos dibujados en la textura) y la tuerca central, del color de los detalles del equipo.
function rim(x, out, s, nut) {
  const lip = revolve(x, out, s, [[0, 0.226], [0, 0.25], [0.012, 0.25], [0.02, 0.243], [0.02, 0.233], [0.012, 0.226]], 32, RIM);
  const face = cylinder(x, WHEEL_R, 0.229, out, out + s * 0.008, 32, RIM, RIM_FACE);
  const hub = cylinder(x, WHEEL_R, 0.042, out, out + s * 0.03, 6, nut, nut);
  return [lip, face, hub];
}

// Lado de adentro de la rueda: el interior de la llanta, en sombra, y en el medio el tambor de carbono (chato)
// que tapa el freno, con la toma de aire que le lleva aire fresco (adelante, a la altura del eje; atrás,
// más chica y abajo). El tambor y la toma van montados en la mangueta: doblan con la rueda pero no giran (fixed).
function inner(x, inn, s, front) {
  const barrel = cylinder(x, WHEEL_R, 0.229, inn, inn - s * 0.004, 32, BARREL, BARREL);
  const ring = (r, dy) => [...Array(24).keys()].map((i) => {
    const t = (i / 24) * Math.PI * 2;
    return [x + r * Math.cos(t), inn - s * dy, WHEEL_R + r * Math.sin(t)];
  });
  const drum = loft([ring(0.165, -0.01), ring(0.165, 0.025), ring(0.155, 0.04), ring(0.12, 0.05)], CARBON);
  // la toma: un caño ovalado que sale del frente del tambor y mira hacia adelante, con la boca oscura
  const [dx, dz, ry, rz] = front ? [0.21, 0.0, 0.018, 0.04] : [0.19, -0.08, 0.015, 0.03];
  const duct = loft([
    ellipse(x + 0.08, inn - s * 0.025, ry * 0.9, WHEEL_R + dz, rz * 0.9),
    ellipse(x + dx - 0.015, inn - s * 0.025, ry, WHEEL_R + dz, rz),
    ellipse(x + dx, inn - s * 0.025, ry * 1.1, WHEEL_R + dz + 0.003, rz * 1.08),
  ], CARBON, COCKPIT);
  for (const p of [drum, duct]) p.fixed = true;
  return [barrel, drum, duct];
}

// rueda: goma y llanta, de los dos lados. Guarda su centro para girarla y, las de adelante, dónde está el eje
// sobre el que doblan (pivot: corrimiento en y desde el centro hasta la punta de los brazos de la suspensión, así
// los brazos siguen unidos al tambor cuando la rueda dobla)
function wheel(x, s, yc, width, front, nut) {
  const y = s * yc, out = s * (yc + width / 2), inn = s * (yc - width / 2);
  const info = { x, y, z: WHEEL_R, front, pivot: -s * (width / 2 + HUB_IN) };
  const parts = [tyre(x, y, width), ...rim(x, out, s, nut), ...inner(x, inn, s, front)];
  for (const p of parts) p.wheel = info;
  return parts;
}

// Casco: cortes horizontales apilados de arriba hacia abajo, con la visera oscura que lo envuelve por delante y un
// alerón chico arriba, atrás. Todo gira junto alrededor del cuello (head: el pivote) para que el piloto mire hacia
// donde va. Se oculta en la vista de cabina, porque ahí está la cámara.
// el piloto va sentado bien abajo: la parte de arriba del casco asoma apenas por encima del halo que lo protege
const HELMET = { x: -0.08, z: 0.69, rx: 0.15, ry: 0.12, rz: 0.13 };
// Un casco de verdad no es una pelota: abajo no se cierra (se angosta menos que arriba y termina en una base
// plana, donde entra el cuello) y adelante, debajo de la visera, la mentonera baja casi recta, siguiendo la misma
// superficie (sin escalón), en vez de curvarse hacia adentro como la nuca.
// Punto de la superficie a la altura w (de -1 abajo a 1 arriba), en el ángulo phi alrededor del eje vertical
// (0 = adelante); out > 1 lo saca un poco hacia afuera (para la visera).
function helmetAt(phi, w, out = 1) {
  const { x: hx, z: hz, rx, ry, rz } = HELMET;
  const chin = Math.max(0, Math.cos(phi)) ** 2; // 1 adelante, 0 a los costados y atrás
  const k = Math.sqrt(Math.max(0, 1 - (w < 0 ? (w / (1.25 + 0.9 * chin)) ** 2 : w * w))) * out;
  return [hx + rx * k * Math.cos(phi), ry * k * Math.sin(phi), hz + rz * w];
}
// Volante: se arma de frente (la cara mira hacia -x, al piloto) y se inclina sobre su columna, que baja hacia
// adelante STEERING.tilt rad. Todas sus piezas llevan `column` (el pivote y el eje), así el render las gira con la
// dirección. La pantalla (slot 6) muestra la marcha y las luces de cambio: la dibuja cockpit.js en cada cuadro.
export const STEERING = { x: 0.3, z: 0.6, tilt: 0.35, turn: 1 }; // turn: rad que gira con el volante a fondo
export const SCREEN_TEX = { size: 1, screen: true }; // la textura la pone el juego (m.screen)
const GRIP = rgb(20, 20, 22), BUTTONS = ['#e23b3b', '#2c9be0', '#f2c230', '#41c46a'];
// suit: color del buzo (los antebrazos); glove: el de los guantes
function steeringParts(suit, glove) {
  const { x: px, z: pz, tilt } = STEERING, c = Math.cos(tilt), s = Math.sin(tilt);
  // el eje apunta del volante hacia el piloto: así, doblando a la derecha (giro +), la parte de arriba va a la derecha
  const column = { x: px, y: 0, z: pz, ax: -c, ay: 0, az: s };
  // de la pieza armada de frente (x hacia adelante, z hacia arriba) a su lugar, inclinada sobre la columna
  const place = (part) => {
    const tr = ([x, y, z]) => [px + x * c + z * s, y, pz - x * s + z * c];
    const rot = ([x, y, z]) => [x * c + z * s, y, -x * s + z * c];
    part.verts = part.verts.map(tr);
    for (const f of part.faces) f.n = rot(f.n);
    return { ...part, column };
  };
  const parts = [
    // cuerpo de carbono, más angosto abajo, y las empuñaduras de goma a los costados
    loft([sec(-0.015, 0, 0.1, -0.05, 0.045, 0.02), sec(0.015, 0, 0.095, -0.045, 0.04, 0.02)], CARBON),
    // (redondas y finas, un poco curvas hacia afuera abajo, como las de verdad): anillos horizontales apilados
    ...[-1, 1].map((k) => loft([[0.035, 0.118, 0.012], [0.0, 0.126, 0.017], [-0.04, 0.126, 0.017], [-0.075, 0.12, 0.012]]
      .map(([z, y, r]) => [...Array(10).keys()].map((i) => {
        const t = (i / 10) * Math.PI * 2;
        return [r * Math.cos(t), k * y + r * Math.sin(t), z];
      })), GRIP)),
    // levas de cambio, detrás de las empuñaduras (side: 0 la izquierda, que baja; 1 la derecha, que sube): las tira
    // el piloto al cambiar (pull: cuánto se mueve la pieza con ese tirón)
    ...[-1, 1].map((k) => ({ ...box(0.024, 0.03, k * 0.1, 0.035, -0.02, 0.035, CARBON, 0.005), side: (k + 1) / 2, pull: 1 })),
    // botones de colores a los costados de la pantalla
    ...BUTTONS.map((b, i) => box(-0.019, -0.015, (i % 2 ? 1 : -1) * 0.075, 0.009, i < 2 ? 0.0 : -0.03, (i < 2 ? 0.0 : -0.03) + 0.018, hex(b), 0.004)),
  ];
  // la pantalla: una placa oscura sobre la cara; su tapa de adelante (la que mira al piloto) lleva la textura
  const screen = box(-0.019, -0.015, 0, 0.05, -0.022, 0.034, COCKPIT, 0.004);
  const face = screen.faces[0];
  face.tex = SCREEN_TEX;
  face.slot = 6;
  face.uv = face.idx.map((i) => {
    const [, y, z] = screen.verts[i];
    return [(y + 0.05) / 0.1, (0.034 - z) / 0.056];
  });
  parts.push(screen);
  // las manos del piloto, agarradas de las empuñaduras: giran con el volante, así se ve cuánto dobla cada uno.
  // Mate, como la tela. El dorso es un óvalo apoyado del lado de afuera de la empuñadura; los cuatro dedos la rodean
  // por delante (del índice, arriba, al meñique, más corto) y el pulgar se apoya sobre la cara del volante, junto a
  // los botones. Después, el puño del guante, con una tira del color del buzo, que sigue en el antebrazo.
  // El índice y el mayor siguen hasta apoyarse detrás de la leva y al cambiar la tiran junto con ella; el resto
  // de la mano acompaña un poco (pull)
  const GY = 0.126; // centro de la empuñadura, a cada lado
  const blob = (cx, cy, cz, rx, ry, rz) => loft([...Array(9).keys()].map((i) => {
    const w = -0.94 + (1.88 * i) / 8, r = Math.sqrt(1 - w * w);
    return [...Array(14).keys()].map((j) => {
      const a = (j / 14) * Math.PI * 2;
      return [cx + rx * r * Math.cos(a), cy + ry * r * Math.sin(a), cz + rz * w];
    });
  }), glove);
  // arco alrededor de la empuñadura a la altura z, de un ángulo a otro (0: adelante; +: hacia afuera)
  const around = (k, z, r, a0, a1) => [...Array(5).keys()].map((i) => {
    const a = a0 + ((a1 - a0) * i) / 4;
    return [r * Math.cos(a), k * (GY + r * Math.sin(a)), z];
  });
  for (const k of [-1, 1]) {
    parts.push(...[
      [blob(-0.012, k * 0.14, -0.016, 0.027, 0.023, 0.05), 0.4], // el dorso y la palma
      // índice y mayor: rodean la empuñadura y se apoyan detrás de la leva
      ...[[0.016, 0.0105], [-0.004, 0.0105]].map(([z, r]) =>
        [tube([...around(k, z, 0.026, 2.1, 0.5), [0.037, k * 0.118, z], [0.038, k * 0.104, z]], r, glove, 6), 1]),
      // anular y meñique: rodean la empuñadura por debajo de la leva
      ...[[-0.028, 0.01, -1.25], [-0.049, 0.009, -1.05]].map(([z, r, end]) => [tube(around(k, z, 0.026, 2.1, end), r, glove, 6), 0.6]),
      // el pulgar: ancho en la base, metida en la palma, se afina hasta la punta redondeada, apoyada sobre la cara
      [tube([[-0.018, k * 0.13, -0.02], [-0.023, k * 0.12, -0.008], [-0.025, k * 0.112, 0.002], [-0.025, k * 0.106, 0.01],
        [-0.024, k * 0.103, 0.0145], [-0.023, k * 0.102, 0.017]],
      [0.0125, 0.0105, 0.0088, 0.0078, 0.0058, 0.0028], glove, 10), 0.4],
      [tube([[-0.03, k * 0.142, -0.042], [-0.07, k * 0.15, -0.07]], 0.029, glove, 8), 0.2], // el puño del guante
      [tube([[-0.036, k * 0.143, -0.046], [-0.047, k * 0.145, -0.053]], 0.0305, suit, 8), 0.2], // la tira del puño
    ].map(([p, pull]) => ({ ...p, suit: true, side: (k + 1) / 2, pull })));
  }
  const placed = parts.map(place);
  // los brazos: el antebrazo va de la muñeca (que gira entera con el volante) al codo (que queda quieto, al costado
  // del cuerpo); en el medio gira de a poco (follow: cuánto sigue al volante cada vértice), así se dobla en vez de
  // salirse de la cabina. El brazo, del hombro al codo, no se mueve (y no se ve desde la cabina, como los hombros)
  for (const k of [-1, 1]) {
    const [wx, wy, wz] = [-0.065, k * 0.15, -0.068], wrist = [px + wx * c + wz * s, wy, pz - wx * s + wz * c];
    const elbow = [0.0, k * 0.235, 0.47], n = 6;
    const path = [...Array(n).keys()].map((i) => wrist.map((a, j) => a + (elbow[j] - a) * (i / (n - 1))));
    const arm = tube(path, 0.033, suit, 8);
    placed.push({ ...arm, column, suit: true, follow: arm.verts.map((_, i) => 1 - Math.floor(i / 8) / (n - 1)) });
    placed.push({ ...tube([[-0.15, k * 0.19, 0.52], elbow], 0.042, suit, 8), suit: true, tag: 'helmet' });
  }
  return placed;
}

const HELMET_LEVELS = [0.99, 0.94, 0.85, 0.72, 0.56, 0.38, 0.18, 0, -0.15, -0.3, -0.45, -0.58, -0.68, -0.75];
function helmetParts(color) {
  const { x: hx, z: hz, rz } = HELMET;
  const ring = (w, out) => [...Array(24).keys()].map((i) => helmetAt((i / 24) * Math.PI * 2, w, out));
  // el último corte, un poco más chico, redondea el borde de la base
  const rings = [...HELMET_LEVELS.map((w) => ring(w, 1)), ring(-0.79, 0.9)];
  const shell = loft(rings, color);
  // visera: una banda que sigue la superficie del casco de -78° a 78° alrededor del frente, apenas por fuera.
  // Es espejada, como los vidrios de los retrovisores (ver skin)
  const at = (phi, z, out) => helmetAt(phi, (z - hz) / rz, out);
  const visor = [];
  for (let i = 0; i <= 12; i++) {
    const phi = (-78 + i * 13) * (Math.PI / 180);
    // un poco más alta en el centro, como la abertura de los cascos de verdad
    const z0 = hz - 0.028 - 0.006 * Math.cos(phi), z1 = hz + 0.052 + 0.01 * Math.cos(phi * 1.3);
    // con un punto en el medio de la cara de afuera, que sigue la curva del casco (si no, el casco la atraviesa)
    visor.push([at(phi, z0, 0.97), at(phi, z0, 1.04), at(phi, (z0 + z1) / 2, 1.04), at(phi, z1, 1.04), at(phi, z1, 0.97)]);
  }
  // alerón: una plaquita sobre la parte de atrás, apenas inclinada
  const spoiler = plate(-0.17, hz + 0.12, -0.225, hz + 0.105, 0.065, 0.012, color);
  const pivot = { x: hx, y: 0, z: hz - rz }; // el cuello: ahí gira y se inclina
  return [shell, loft(visor, VISOR), spoiler].map((p) => ({ ...p, tag: 'helmet', head: pivot }));
}

// Texturas: cada cara se proyecta sobre el plano al que más mira (desde arriba, de costado o de frente)
// y de ahí salen sus coordenadas en la textura (u, v, en texeles), una por vértice.
// Las caras del color de la carrocería llevan la decoración; las de carbono, el tejido; los flancos de las gomas,
// su dibujo (centrado en la rueda, así gira con ella); la banda y los hombros, el caucho gastado (sus coordenadas
// vienen de tyre()). El resto queda de un solo color.
// La cara de la llanta lleva sus rayos, centrados en la rueda como el flanco.
// slot: qué textura es, para el renderer de WebGL (1 decoración, 2 carbono, 3 flanco, 4 banda, 5 llanta)
let carbon = null, sidewall = null, tread = null, rimTex = null;

function skin(parts, body, livery, sharp = 1) {
  carbon ??= carbonTexture();
  sidewall ??= sidewallTexture();
  tread ??= treadTexture();
  rimTex ??= rimTexture();
  for (const part of parts) {
    for (const f of part.faces) {
      const pts = f.idx.map((i) => part.verts[i]);
      const ax = Math.abs(f.n[0]), ay = Math.abs(f.n[1]), az = Math.abs(f.n[2]);
      const top = az >= ax && az >= ay, side = !top && ay >= ax;
      let uv = null;
      if (f.color === body) {
        if (top) uv = pts.map(([x, y]) => [(x + HALF_L) * LIVERY_S * sharp, (TOP + (y + HALF_W) * LIVERY_S) * sharp]);
        else if (side) {
          const row = f.n[1] > 0 ? SIDE_R : SIDE_L;
          uv = pts.map(([x, , z]) => [(x + HALF_L) * LIVERY_S * sharp, (row + (TALL - z) * LIVERY_S) * sharp]);
        }
        if (uv) Object.assign(f, { tex: livery, slot: 1, dens: LIVERY_S * sharp });
      } else if (f.color === CARBON) {
        uv = pts.map(([x, y, z]) => (top ? [x, y] : side ? [x, z] : [y, z]).map((c) => c * CARBON_S));
        Object.assign(f, { tex: carbon, slot: 2, dens: CARBON_S });
      } else if (f.color === SIDEWALL && part.wheel && side) {
        const { x: wx, z: wz } = part.wheel, m = SIDEWALL_SIZE / 2;
        uv = pts.map(([x, , z]) => [m + (x - wx) * SIDEWALL_S, m - (z - wz) * SIDEWALL_S]);
        Object.assign(f, { tex: sidewall, slot: 3, dens: SIDEWALL_S });
      } else if (f.color === RIM_FACE && part.wheel && side) {
        const { x: wx, z: wz } = part.wheel, m = RIM_SIZE / 2;
        uv = pts.map(([x, , z]) => [m + (x - wx) * RIM_S, m - (z - wz) * RIM_S]);
        Object.assign(f, { tex: rimTex, slot: 5, dens: RIM_S });
      } else if (f.tread) {
        uv = f.uv.map(([u, v]) => [u * TREAD_SIZE, v * TREAD_SIZE]);
        Object.assign(f, { tex: tread, slot: 4, dens: TREAD_SIZE * 2.5 });
      }
      if (uv) f.uv = uv;
      // cuánto brilla y refleja: pintura y casco con barniz, carbono un poco, gomas, cockpit y buzo nada
      // (el vidrio de los espejos, 2: refleja de frente también, como un espejo; la visera, 3: igual, pero un reflejo
      // borroso, sin horizonte marcado)
      f.gloss = f.color === MIRROR ? 2 : f.color === VISOR ? 3 : f.color === body || part.head ? 1 : f.color === CARBON ? 0.35
        : part.suit || [TYRE, SIDEWALL, COCKPIT].includes(f.color) ? 0 : 0.6;
    }
  }
  return parts;
}

// Arma el auto con el color de la carrocería, el del casco y el de los detalles de la decoración (en '#rrggbb')
// y su número.
// Devuelve una lista de piezas { verts: [[x,y,z]...], faces: [{ idx, color, n, gloss, tex?, uv?, dens? }], wheel?, head?, tag? }.
// cámara de arriba (la "T"): como en la F1, negra en el primer auto de cada equipo y amarilla en el segundo
export const TCAM = ['#161616', '#f2e600'];

// sharp: decoración con más resolución (para el auto propio, que desde la cabina se ve de muy cerca)
export function carModel(color = '#d8261c', helmet = '#ffd400', number = '16', accent = '#f4f4f4', tcam = TCAM[0], { sharp = 1 } = {}) {
  const body = hex(color), head = hex(helmet);
  const parts = [];
  const add = (...p) => parts.push(...p);
  const both = (fn) => { fn(1); fn(-1); };

  // piso y difusor. Visto de arriba el piso no es un rectángulo: nace angosto detrás de las ruedas de adelante con
  // el borde redondeado, se abre hasta su ancho máximo al costado de los pontones y antes de las ruedas de atrás se
  // mete hacia adentro en curva, para dejarles lugar; atrás sigue el difusor, entre las dos ruedas
  // (cada estación: x y medio ancho)
  // (adelante nace pegado a los costados de la trompa y se abre en una curva cóncava, cada vez más rápido, hasta
  // su ancho de siempre; las aletas van más afuera, sobre su propia base)
  const FLOOR = [[1.42, 0.15], [1.32, 0.18], [1.22, 0.23], [1.13, 0.3], [1.05, 0.4], [0.98, 0.52], [0.92, 0.63],
    [0.85, 0.71], [0.72, 0.76], [0.45, 0.8], [-0.4, 0.8], [-0.8, 0.77],
    [-1.05, 0.69], [-1.25, 0.57], [-1.45, 0.5], [-1.95, 0.48]];
  add(loft(FLOOR.map(([x, hw]) => sec(x, 0, hw, 0.03, 0.08, 0.025)), CARBON));
  // aletas detrás de las ruedas de adelante, que ordenan el aire sucio que sale de la rueda y lo mandan por fuera
  // de los pontones. Vistas de arriba van en diagonal: la grande nace casi en el borde de afuera de la rueda y se
  // cierra un poco hacia atrás, por fuera del piso, parada sobre su propia base (una plancha angosta, aparte del
  // piso); las dos chicas, más bajas y más cerradas, van paradas sobre el piso.
  // fin(s, adelante [x, y], atrás [x, y], perfil [u, z] con u de 0 (adelante) a 1 (atrás), radios)
  const fin = (s, [xa, ya], [xb, yb], profile, radii, t = 0.012) => {
    const len = Math.hypot(xb - xa, yb - ya), nx = -(yb - ya) / len, ny = (xb - xa) / len;
    const side = (o) => rounded(0, profile.map(([u, z]) => [u * len, z]), radii, 3)
      .map(([, u, z]) => [xa + (xb - xa) * (u / len) + nx * o, s * (ya + (yb - ya) * (u / len) + ny * o), z]);
    return loft([side(-t / 2), side(t / 2)], CARBON);
  };
  // base de una aleta: una plancha angosta (medio ancho w) a lo largo de la aleta, con las puntas redondeadas
  const foot = (s, [xa, ya], [xb, yb], w) => {
    const len = Math.hypot(xb - xa, yb - ya), ux = (xb - xa) / len, uy = (yb - ya) / len;
    const ring = (u) => {
      const k = Math.min(1, Math.sqrt(Math.max(0, 1 - ((2 * u) / len - 1) ** 8))) * w; // se angosta en las puntas
      const cx = xa + ux * u, cy = ya + uy * u;
      return [[-1, 0.03], [1, 0.03], [1, 0.045], [-1, 0.045]].map(([o, z]) => [cx - uy * o * k, s * (cy + ux * o * k), z]);
    };
    return loft([...Array(9).keys()].map((i) => ring((i / 8) * len)), CARBON);
  };
  both((s) => {
    add(foot(s, [1.07, 0.935], [0.69, 0.88], 0.04));
    // la base se une al piso: atrás, una plancha que se abre desde el borde del piso hasta la aleta, y adelante
    // una lámina fina que cruza el hueco. La plancha de atrás no es un bloque: vista de arriba nace en punta junto a
    // la base y se abre hacia atrás en curva hasta meterse en el piso, y de costado su techo baja en rampa desde la
    // altura del piso hasta la de la base, así se lee como una sola pieza con los dos.
    // (cada corte: x, borde de adentro, ya metido en el piso, y de afuera, sobre la base de la aleta)
    add(loft([[0.9, 0.86, 0.9], [0.86, 0.8, 0.905], [0.82, 0.75, 0.9], [0.77, 0.72, 0.895], [0.71, 0.71, 0.885],
      [0.68, 0.72, 0.88]].map(([x, yin, yout]) => rounded(x, [[yin, 0.03], [yout, 0.03], [yout, 0.045], [yin, 0.08]]
      .map(([y, z]) => [s * y, z]), [0.003, 0.006, 0.006, 0.003])), CARBON));
    add(loft([sec(0.98, s * 0.73, 0.2, 0.035, 0.048, 0.006), sec(0.93, s * 0.76, 0.17, 0.035, 0.048, 0.006)], CARBON));
    add(fin(s, [1.05, 0.935], [0.71, 0.88], [[0, 0.06], [1, 0.06], [1, 0.3], [0.8, 0.38], [0.08, 0.46], [0, 0.4]],
      [0.01, 0.02, 0.04, 0.12, 0.04, 0.02], 0.014));
    add(fin(s, [0.87, 0.66], [0.66, 0.6], [[0, 0.06], [1, 0.06], [1, 0.2], [0.1, 0.27], [0, 0.22]], [0.01, 0.01, 0.03, 0.03, 0.02]));
    add(fin(s, [0.94, 0.56], [0.74, 0.5], [[0, 0.06], [1, 0.06], [1, 0.17], [0.1, 0.22], [0, 0.18]], [0.01, 0.01, 0.03, 0.03, 0.02]));
  });
  add(loft([sec(-1.95, 0, 0.48, 0.03, 0.1, 0.03), sec(-2.55, 0, 0.46, 0.1, 0.35, 0.05)], CARBON));

  // monocasco y trompa: una sola pieza que se angosta y baja hacia adelante. Donde va el piloto queda baja: la
  // cabina es un hueco entre dos paredes (abajo), con el tablero adelante, así el volante queda adentro
  add(loft([
    sec(-0.45, 0, 0.42, 0.1, 0.5, 0.1),
    sec(0.42, 0, 0.37, 0.12, 0.5, 0.1),
    sec(0.5, 0, 0.36, 0.12, 0.64, 0.13),
    // de perfil el lomo es una sola curva convexa suave, de la cabina a la punta: casi plano atrás y cayendo de a
    // poco más rápido hacia adelante (sin quiebre a la altura de las ruedas ni tramo recto)
    sec(1.15, 0, 0.26, 0.16, 0.635, 0.11),
    sec(1.45, 0, 0.23, 0.16, 0.606, 0.1),
    sec(1.7, 0, 0.2, 0.16, 0.557, 0.09),
    sec(1.95, 0, 0.17, 0.15, 0.493, 0.08),
    sec(2.1, 0, 0.16, 0.145, 0.448, 0.075),
    sec(2.4, 0, 0.135, 0.13, 0.345, 0.06),
    sec(2.62, 0, 0.12, 0.12, 0.259, 0.05),
    // la punta: ancha hasta el final, como un hocico, y redondeada hasta el borde de ataque del alerón
    sec(2.74, 0, 0.11, 0.112, 0.209, 0.045),
    sec(2.82, 0, 0.097, 0.108, 0.174, 0.035),
    sec(2.87, 0, 0.078, 0.108, 0.151, 0.022),
    sec(2.9, 0, 0.045, 0.112, 0.138, 0.012),
  ], body));
  // las paredes de la cabina y adentro el piso y el tablero, oscuros. Por fuera, el costado de la cabina es el
  // techo de los pontones (que a la altura de la cabina arranca del borde de la abertura); la pared es sólo la cara
  // de adentro, una lámina fina que queda tapada por el pontón
  const wall = (x, top, s) => rounded(x, [[0.24, 0.45], [0.29, 0.45], [0.29, top - 0.02], [0.24, top]].map(([y, z]) => [s * y, z]), [0.01, 0.01, 0.01, 0.01]);
  both((s) => add(loft([wall(-0.45, 0.7, s), wall(0.46, 0.645, s)], body)));
  add(box(-0.45, 0.46, 0, 0.245, 0.45, 0.52, COCKPIT, 0.02));
  add(loft([sec(0.4, 0, 0.245, 0.5, 0.6, 0.02), sec(0.47, 0, 0.245, 0.5, 0.645, 0.02)], COCKPIT));
  // pontones a los costados: toma de aire adelante y se van cerrando hacia atrás, hasta morir contra la cubierta
  // del motor (la "botella de Coca-Cola"). No son tubos sueltos: el lado de adentro queda metido en el monocasco
  // y el techo es una rampa que baja desde el hombro del chasis hacia afuera, así la carrocería sigue de corrido
  // hasta el borde del pontón. A la altura de la cabina el techo arranca del borde de la abertura: es el costado
  // de la cabina. Abajo, el costado se mete hacia adentro (el undercut) y deja ver el piso.
  // Cada estación: x, borde de adentro (in) y de afuera (out), altura del techo adentro y afuera, piso y undercut.
  const POD = [
    // la boca nace del costado del chasis: su borde de adentro queda metido en el monocasco
    { x: 0.58, in: 0.24, out: 0.63, top: 0.56, edge: 0.52, bot: 0.16, cut: 0.12 },
    { x: 0.46, in: 0.23, out: 0.66, top: 0.6, edge: 0.54, bot: 0.13, cut: 0.14 },
    { x: 0.3, in: 0.25, out: 0.67, top: 0.69, edge: 0.55, bot: 0.12, cut: 0.16 },
    // detrás de la cabina se cierran en una curva convexa (vistos de arriba: aguantan el ancho y se cierran cada
    // vez más rápido) y el techo cae hacia el piso, así llegan finos y bajos a las ruedas de atrás
    { x: -0.3, in: 0.25, out: 0.65, top: 0.7, edge: 0.49, bot: 0.12, cut: 0.15 },
    { x: -0.75, in: 0.23, out: 0.6, top: 0.6, edge: 0.4, bot: 0.12, cut: 0.12 },
    { x: -1.15, in: 0.2, out: 0.52, top: 0.47, edge: 0.3, bot: 0.12, cut: 0.08 },
    { x: -1.5, in: 0.15, out: 0.42, top: 0.36, edge: 0.22, bot: 0.12, cut: 0.05 },
    { x: -1.8, in: 0.1, out: 0.31, top: 0.3, edge: 0.19, bot: 0.12, cut: 0.03 },
    // la cola se pega a la base del cubremotor: el techo arranca a la altura de su hombro y se afina con él
    { x: -2.05, in: 0.05, out: 0.15, top: 0.29, edge: 0.21, bot: 0.13, cut: 0.01 },
    { x: -2.3, in: 0.03, out: 0.075, top: 0.27, edge: 0.23, bot: 0.15, cut: 0.005 },
  ];
  // altura del techo del pontón (sin los redondeos) en x, a la distancia y del centro, y cuánto cae hacia afuera
  const podRoof = (x, y) => {
    let i = POD.findIndex((st) => st.x <= x);
    if (i <= 0) i = i < 0 ? POD.length - 1 : 1;
    const a = POD[i - 1], b = POD[i], w = Math.min(1, Math.max(0, (a.x - x) / (a.x - b.x)));
    const lerp = (k) => a[k] + (b[k] - a[k]) * w;
    const slope = (lerp('top') - lerp('edge')) / (lerp('out') - lerp('in'));
    return { z: lerp('top') - (y - lerp('in')) * slope, slope };
  };
  // cubierta del motor y toma de aire, de una sola forma: cada corte es una carpa angosta. Abajo queda metida en
  // los pontones y el flanco arranca justo donde termina el techo de cada pontón (el hombro, casi sin redondear),
  // así la carrocería sube de corrido desde el borde del pontón hasta la cresta. Detrás de la cabeza la cresta es
  // la toma de aire; hacia atrás baja de a poco y se afina en la aleta, hasta morir antes del alerón. Adelante,
  // los hombros suben a cada lado de la cabeza hasta donde se apoya el halo y de ahí bajan hacia atrás.
  // Cada estación: x, medio ancho y altura de abajo, del hombro (donde arranca el flanco) y de la cresta.
  // Con roof, el flanco cae recto desde el hombro hasta el techo del pontón y ahí dobla en ángulo recto con un
  // radio chico (FILLET), en una pestaña que sigue el techo del pontón y se mete en él: la arista queda marcada
  // pero la luz pasa de una cara a la otra de a poco.
  const FILLET = 0.018;
  const tent = ({ x, bw, bz, sw, sz, tw, tz }, d = 0, roof = false) => {
    if (!roof) {
      return rounded(x, [[bw - d, bz + d], [sw - d, sz], [tw - d, tz - d], [-tw + d, tz - d], [-sw + d, sz], [-bw + d, bz + d]],
        [0.03, 0.04, tw * 0.9, tw * 0.9, 0.04, 0.03]);
    }
    const { z, slope } = podRoof(x, sw), zj = z + 0.004, L = 0.06;
    const half = [[bw, bz], [sw + L, zj - L * (slope + 0.25)], [sw, zj], [sw, sz], [tw, tz]];
    return rounded(x, [...half, ...half.map(([y, zz]) => [-y, zz]).reverse()],
      [0.03, 0.005, FILLET, 0.07, tw * 0.9, tw * 0.9, 0.07, FILLET, 0.005, 0.03], 5);
  };
  add(loft([
    // el frente, detrás del apoyacabeza: la cresta queda adentro de la toma y los hombros, donde se apoya el halo
    { x: -0.42, bw: 0.4, bz: 0.1, sw: 0.32, sz: 0.775, tw: 0.065, tz: 0.8 },
    { x: -0.6, bw: 0.38, bz: 0.1, sw: 0.3, sz: 0.75, tw: 0.09, tz: 0.97 },
    { x: -0.95, bw: 0.3, bz: 0.1, sw: 0.25, sz: 0.62, tw: 0.08, tz: 0.95 },
    { x: -1.25, bw: 0.22, bz: 0.1, sw: 0.2, sz: 0.47, tw: 0.06, tz: 0.86 },
    { x: -1.55, bw: 0.17, bz: 0.11, sw: 0.155, sz: 0.36, tw: 0.04, tz: 0.74 },
    { x: -1.95, bw: 0.12, bz: 0.13, sw: 0.105, sz: 0.3, tw: 0.02, tz: 0.56 },
    { x: -2.3, bw: 0.07, bz: 0.18, sw: 0.06, sz: 0.28, tw: 0.012, tz: 0.41 },
  ].map((st) => tent(st, 0, true)), body));
  // la boca de la toma, sobre la cabeza del piloto: es la punta de la cresta, que se estira hacia adelante por
  // encima del apoyacabeza y termina en la misma forma que tiene la cubierta (no es una pieza agregada).
  // Está inclinada como la de los pontones, con un labio alrededor y adentro un bloque oscuro
  const MOUTH_AT = { x: -0.3, bw: 0.085, bz: 0.69, sw: 0.105, sz: 0.8, tw: 0.075, tz: 0.955 };
  const tilt = (ring) => ring.map(([x, y, z]) => [x + (z - 0.8) * 0.25, y, z]);
  const LIP = 0.018;
  const scoop = loft([
    tilt(tent({ ...MOUTH_AT, x: -0.32 }, LIP)),
    tilt(tent({ ...MOUTH_AT, x: -0.29 }, LIP / 3)),
    tilt(tent(MOUTH_AT)),
    tent({ x: -0.6, bw: 0.1, bz: 0.67, sw: 0.125, sz: 0.8, tw: 0.088, tz: 0.968 }),
  ], body);
  // el frente del labio mira hacia adelante (loft lo orientaría hacia afuera del eje)
  for (const f of scoop.faces.slice(2, 2 + scoop.verts.length / 4)) if (f.n[0] < 0) f.n = f.n.map((c) => -c);
  add(scoop);
  add(loft([tent({ ...MOUTH_AT, x: -0.6 }, LIP), tilt(tent({ ...MOUTH_AT, x: -0.315 }, LIP))], COCKPIT));
  // cámara de TV en forma de T: un parante finito y arriba una barra a lo ancho, del color que distingue al auto
  add(box(-0.42, -0.34, 0, 0.025, 0.95, 1.07, hex(tcam), 0.01));
  add(box(-0.45, -0.31, 0, 0.17, 1.07, 1.11, hex(tcam), 0.018));
  // pontones a los costados (sus estaciones, POD, van más arriba: la cubierta del motor se apoya en ellas)
  // sección del pontón en una estación, achicada d metros hacia adentro (para la boca)
  const podSec = (st, s, x = st.x, d = 0) => rounded(x, [
    [st.in + d, st.bot + d],
    [st.out - st.cut - d / 2, st.bot + d],
    [st.out - d, st.bot + st.cut + d / 2],
    [st.out - d, st.edge - d],
    [st.in + d, st.top - d],
  ].map(([y, z]) => [s * y, z]), [0.02, 0.04, 0.06, 0.12, 0.03]);
  const POD_RING = 25; // puntos de cada sección (5 esquinas de 5 puntos)
  // la boca está inclinada: arriba avanza más que abajo, como en los de verdad
  const lean = (ring) => ring.map(([x, y, z]) => [x + (z - 0.35) * 0.35, y, z]);
  const MOUTH = 0.035; // ancho del labio que rodea la abertura
  both((s) => {
    const [mouth, ...rest] = POD;
    const pod = loft([
      lean(podSec(mouth, s, mouth.x - 0.02, MOUTH)),
      lean(podSec(mouth, s, mouth.x + 0.01, MOUTH / 3)),
      lean(podSec(mouth, s, mouth.x - 0.04)),
      ...rest.map((st) => podSec(st, s)),
    ], body, CARBON);
    // el frente del labio mira hacia adelante y hacia la boca (loft lo orientaría hacia afuera del eje)
    for (const f of pod.faces.slice(2, 2 + POD_RING)) if (f.n[0] < 0) f.n = f.n.map((c) => -c);
    add(pod);
    // la abertura: un bloque oscuro que tapa la boca por dentro del labio
    add(loft([podSec(mouth, s, mouth.x - 0.35, MOUTH), lean(podSec(mouth, s, mouth.x - 0.015, MOUTH))], COCKPIT));
  });
  // espejos sobre su soporte: el vidrio mira hacia atrás, hundido en un marco, y la carcasa se redondea hacia
  // adelante como una cáscara
  both((s) => {
    const shell = (x, k) => sec(x, s * 0.54, 0.08 * k, 0.67 - 0.05 * k, 0.67 + 0.05 * k, 0.035 * k);
    const mirror = loft([shell(0.43, 0.85), shell(0.42, 1), shell(0.46, 1), shell(0.5, 0.88), shell(0.53, 0.62), shell(0.545, 0.3)], body, MIRROR);
    // el vidrio (la primera tapa) mira hacia atrás; la punta de adelante es carcasa
    const [glass, tip] = mirror.faces;
    if (glass.n[0] > 0) glass.n = glass.n.map((c) => -c);
    // posición sobre el vidrio, de -1 a 1 (el renderer la usa para curvar el reflejo, como un espejo convexo)
    glass.uv = glass.idx.map((i) => [(mirror.verts[i][1] - s * 0.54) / 0.068, (mirror.verts[i][2] - 0.67) / 0.0425]);
    tip.color = body;
    add(mirror);
    add(tube([[0.47, s * 0.46, 0.66], [0.5, s * 0.36, 0.6]], 0.012, CARBON, 8));
  });

  // piloto: hombros con el buzo del color del equipo y el collar HANS de carbono detrás de la nuca
  add({ ...box(-0.34, -0.02, 0, 0.2, 0.46, 0.55, hex(color, 0.7), 0.07), tag: 'helmet', suit: true });
  add({ ...loft([sec(-0.3, 0, 0.15, 0.49, 0.59, 0.05), sec(-0.17, 0, 0.13, 0.51, 0.6, 0.05)], CARBON), tag: 'helmet' });
  add(...helmetParts(head));
  add(...steeringParts(hex(color, 0.7), hex(accent, 0.62)));
  // apoyacabeza acolchado alrededor del casco y un borde de carbono que rodea la abertura de la cabina
  add(loft([sec(-0.45, 0, 0.25, 0.6, 0.72, 0.05), sec(-0.3, 0, 0.25, 0.6, 0.72, 0.05)], PADDING));
  both((s) => add(loft([sec(-0.42, s * 0.205, 0.045, 0.6, 0.715, 0.03), sec(-0.2, s * 0.205, 0.04, 0.6, 0.7, 0.03)], PADDING)));
  const rim = [];
  for (let i = 0; i <= 40; i++) {
    const t = (i / 40) * Math.PI * 2; // un óvalo de esquinas redondeadas sobre el borde de las paredes
    const cx = Math.cos(t), cy = Math.sin(t);
    const x = 0.45 * Math.sign(cx) * Math.abs(cx) ** 0.4;
    rim.push([x, 0.245 * Math.sign(cy) * Math.abs(cy) ** 0.4, 0.703 - 0.055 * (x + 0.45) / 0.9]);
  }
  add(tube(rim, 0.012, CARBON, 6));
  // halo: un arco por encima del casco que se apoya en un pilar central adelante y atrás, detrás de la cabeza,
  // sobre los hombros del cubremotor, casi sin bajar. De perfil sube de a poco hacia adelante
  // (visto desde arriba es media elipse: adelante en x = 0,4, a la altura de los espejos, y atrás en x = -0,4)
  const HALO_R = 0.024;
  const haloAt = (t) => [-0.4 + 0.8 * Math.cos(t), 0.29 * Math.sin(t), 0.78 + 0.08 * Math.max(0, Math.cos(t)) ** 0.8];
  const halo = [];
  for (let i = 0; i <= 40; i++) halo.push(haloAt(-Math.PI / 2 + (i / 40) * Math.PI));
  add(tube(halo, HALO_R, CARBON, 12));
  // el pilar no cae vertical: baja inclinado hacia adelante (PILLAR_LEAN metros hacia adelante por cada metro
  // que baja) desde el frente del arco hasta clavarse en la trompa
  const PILLAR_R = 0.017, PILLAR_LEAN = 0.9, PILLAR_DROP = 0.32;
  const [px, , pz] = haloAt(0);
  const pillarX = (z) => px + PILLAR_LEAN * (pz - z); // x del eje del pilar a la altura z
  // (arranca un poco debajo del eje del arco, para que no asome por encima)
  add(tube([[pillarX(pz - 0.025), 0, pz - 0.025], [pillarX(pz - PILLAR_DROP), 0, pz - PILLAR_DROP]], PILLAR_R, CARBON, 10));
  // unión del pilar con el arco: una lámina a los dos lados del pilar, que baja desde el arco con un borde
  // cóncavo (un cuarto de elipse) que arranca tangente al arco y termina tangente al pilar, así el pilar se abre
  // en curva hacia arriba en vez de formar una T. Sigue la inclinación del pilar.
  const FILLET_W = 0.09, FILLET_DROP = 0.1;
  const fillet = [];
  for (let j = 0; j <= 24; j++) {
    const y = -FILLET_W + (j / 24) * 2 * FILLET_W;
    const [x, , z] = haloAt(Math.asin(y / 0.29));
    const g = Math.max(0, Math.abs(y) - PILLAR_R) / (FILLET_W - PILLAR_R); // 0 junto al pilar, 1 en el arco
    const drop = FILLET_DROP * (1 - Math.sqrt(1 - (1 - g) ** 2));
    // arriba va por el eje del arco (queda adentro del tubo) y abajo se corre hacia el pilar
    const bottom = pillarX(z - drop) * (1 - g) + x * g;
    fillet.push([[bottom - 0.02, y, z - drop], [bottom + 0.02, y, z - drop], [x + 0.02, y, z], [x - 0.02, y, z]]);
  }
  add(loft(fillet, CARBON));

  // alerón delantero: tres elementos con perfil de ala, bien juntos (cada flap arranca apenas arriba y detrás del
  // borde de fuga del anterior), que llegan hasta el lado de adentro de las ruedas. Visto de frente, en el medio
  // son cóncavos: suben hacia la trompa, cada vez más empinados; hacia afuera son convexos: se levantan
  // redondeados, como un hombro, hasta la placa. curve(y, hump, rise): cuánto suben a lo ancho. Visto desde arriba tienen flecha: el centro va más
  // adelante y las puntas se redondean hacia atrás (sweep: cuánto retrocede el borde de ataque a lo ancho). Las
  // placas laterales bajan hacia adelante con el borde redondeado
  const FW = 0.63; // medio ancho de los planos: el lado de adentro de las ruedas delanteras
  const curve = (y, hump, rise) => {
    const u = Math.abs(y / FW);
    const t = Math.min(1, u / 0.45), o = Math.max(0, (u - 0.35) / 0.65);
    return hump * (1 - t) ** 2 + rise * (1 - (1 - o) ** 2);
  };
  const k = (y) => Math.abs(y / FW) ** 3;
  const sweep = (y) => 0.1 * (y / FW) ** 2 + 0.12 * (y / FW) ** 12;
  add(wing(FW, (y) => ({ le: [2.9 - sweep(y), 0.065 + curve(y, 0.04, 0.025)], te: [2.45 - 0.03 * k(y), 0.08 + curve(y, 0.045, 0.03)], t: 0.03 }), CARBON, 15));
  add(wing(FW, (y) => ({ le: [2.5 - 0.6 * sweep(y), 0.105 + curve(y, 0.045, 0.035)], te: [2.27 - 0.04 * k(y), 0.15 + curve(y, 0.05, 0.045)], t: 0.024 }), body, 15));
  add(wing(FW, (y) => ({ le: [2.33 - 0.4 * sweep(y), 0.16 + curve(y, 0.05, 0.045)], te: [2.15 - 0.04 * k(y), 0.21 + curve(y, 0.055, 0.055)], t: 0.02 }), body, 15));
  both((s) => add(endplate(s * (FW + 0.01), [[2.12, 0.04], [2.7, 0.04], [2.7, 0.1], [2.44, 0.3], [2.14, 0.32]],
    [0.015, 0.03, 0.05, 0.12, 0.03], 0.02, CARBON)));
  // y de cada placa salen dos aletas hacia el costado, hasta la parte de afuera de la goma: abajo, sobre el piso,
  // una casi plana que apenas sube y se va hacia atrás en la punta; arriba, una chica casi horizontal
  const blade = (s, n, at, color) => loft([...Array(n).keys()].map((i) => {
    const u = i / (n - 1), { y, le, te, t } = at(u);
    return airfoil(s * y, le, te, t, 0.02);
  }), color);
  both((s) => add(blade(s, 7, (u) => ({
    y: FW + 0.01 + 0.34 * u, le: [2.62 - 0.1 * u * u, 0.075 + 0.025 * u * u], te: [2.2 - 0.03 * u, 0.085 + 0.035 * u * u], t: 0.02,
  }), CARBON)));
  both((s) => add(blade(s, 5, (u) => ({
    y: FW + 0.01 + 0.32 * u, le: [2.42 - 0.05 * u, 0.25 - 0.015 * u], te: [2.2 - 0.02 * u, 0.28 - 0.01 * u], t: 0.016,
  }), body)));

  // alerón trasero: plano principal y flap con perfil de ala (un poco más bajos en el centro, como una cuchara),
  // placas laterales con el borde de arriba redondeado, ala baja y pilar; abajo, la luz de lluvia. Va casi encima
  // del eje trasero (sobresale poco detrás de las ruedas); la placa baja hacia atrás hasta el ala baja, que queda
  // detrás de la cubierta, sobre el difusor
  const spoon = (y) => -0.02 * (1 - (y / 0.51) ** 2);
  add(wing(0.51, (y) => ({ le: [-2.02, 0.765 + spoon(y)], te: [-2.31, 0.81 + spoon(y)], t: 0.045 }), CARBON));
  add(wing(0.51, (y) => ({ le: [-2.25, 0.865 + spoon(y)], te: [-2.45, 0.965 + spoon(y)], t: 0.03 }), body));
  // vistas de atrás, las placas suben inclinadas hacia afuera desde el ala baja y arriba se paran derechas
  const EP_BEND = [[0.34, -0.2], [0.58, -0.06], [0.7, 0], [1.1, 0]];
  both((s) => add(...endplate(s * 0.52, [[-2.62, 0.34], [-2.28, 0.34], [-1.98, 0.62], [-1.98, 0.92], [-2.11, 1.01], [-2.49, 1.01]],
    [0.06, 0.1, 0.08, 0.08, 0.05, 0.05], 0.02, body, EP_BEND)));
  add(wing(0.33, () => ({ le: [-2.33, 0.36], te: [-2.6, 0.4], t: 0.035 }), CARBON));
  add(box(-2.42, -2.12, 0, 0.03, 0.4, 0.78, CARBON, 0.01));
  add(box(-2.64, -2.58, 0, 0.05, 0.25, 0.32, RAIN_LIGHT));

  // suspensión (dos triángulos por rueda, de la carrocería a la mangueta, adentro de la llanta) y ruedas. Además,
  // la barra que lleva la carga al amortiguador: adelante empuja (pushrod, del triángulo de abajo hacia arriba del
  // chasis) y atrás tira (pullrod, del de arriba hacia abajo); adelante, también la barra de la dirección.
  // Cada triángulo nace adentro de la carrocería: in, el ancho donde se clava cada pata (la de atrás y la de
  // adelante), y z, la altura de los dos triángulos (adelante el de arriba va bajo, para no asomar sobre la trompa)
  for (const [x, y, w, front, inn, zs] of [[1.65, 0.8, 0.33, true, [0.2, 0.15], [0.25, 0.41]], [-1.7, 0.79, 0.42, false, [0.1, 0.15], [0.25, 0.45]]]) {
    both((s) => {
      const hub = s * (y - w / 2 - HUB_IN);
      for (const z of zs) {
        // brazos de sección ovalada y chata, como los perfiles de los de verdad
        add(tube([[x - 0.32, s * inn[0], z], [x, hub, z + 0.02]], 0.022, CARBON, 10, 0.45));
        add(tube([[x + 0.12, s * inn[1], z], [x, hub, z + 0.02]], 0.022, CARBON, 10, 0.45));
      }
      if (front) {
        add(tube([[x - 0.03, hub - s * 0.09, 0.28], [x - 0.12, s * 0.17, 0.47]], 0.014, CARBON, 8));
        add(tube([[x + 0.1, s * 0.19, 0.36], [x + 0.1, hub, 0.37]], 0.012, CARBON, 8, 0.6));
      } else {
        add(tube([[x + 0.03, hub - s * 0.09, 0.45], [x + 0.2, s * 0.15, 0.17]], 0.014, CARBON, 8));
      }
      add(...wheel(x, s, y, w, front, hex(accent)));
    });
  }
  return skin(parts, body, liveryTexture(color, accent, number, sharp), sharp);
}
