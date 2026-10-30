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
const MIRROR = rgb(120, 140, 160);
const RAIN_LIGHT = rgb(255, 60, 60);
const VISOR = rgb(20, 22, 28);
const CARBON_S = 400; // texeles de carbono por metro (cada celda del tejido, 2 cm)

export const WHEEL_R = 0.36; // radio de las ruedas (m)
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

// tubo que pasa por los puntos de path: de sección cuadrada (medio lado t) o, con sides > 4, redondo (radio t).
// flat < 1 lo aplasta en la dirección "hacia arriba" (sección ovalada, como un perfil)
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
    return corners.map(([s, q]) => [p[0] + (ux * s + vx * q * flat) * t, p[1] + (uy * s + vy * q * flat) * t, p[2] + (uz * s + vz * q * flat) * t]);
  });
  return loft(rings, color);
}

// placa fina (alerones): de una sección en x0 a otra en x1, cada una con su altura de abajo y su espesor
const plate = (x0, z0, x1, z1, hw, t, color, yc = 0) => loft([sec(x0, yc, hw, z0, z0 + t), sec(x1, yc, hw, z1, z1 + t)], color);
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

// rueda: goma y llanta. Guarda su centro para girarla y doblarla.
function wheel(x, s, yc, width, front, nut) {
  const y = s * yc, out = s * (yc + width / 2);
  const info = { x, y, z: WHEEL_R, front };
  const parts = [tyre(x, y, width), ...rim(x, out, s, nut)];
  for (const p of parts) p.wheel = info;
  return parts;
}

// Casco: un elipsoide con la visera oscura que lo envuelve por delante y un alerón chico arriba, atrás.
// Todo gira junto alrededor del cuello (head: el pivote) para que el piloto mire hacia donde va.
// Se oculta en la vista de cabina, porque ahí está la cámara.
const HELMET = { x: -0.08, z: 0.8, rx: 0.15, ry: 0.12, rz: 0.13 };
function helmetParts(color) {
  const { x: hx, z: hz, rx, ry, rz } = HELMET;
  const rings = [];
  for (let i = 1; i < 12; i++) {
    const p = (i / 12) * Math.PI;
    rings.push(ellipse(hx + rx * Math.cos(p), 0, ry * Math.sin(p), hz, rz * Math.sin(p), 16));
  }
  const shell = loft(rings, color);
  // visera: una banda que sigue la superficie del casco de -70° a 70° alrededor del frente, apenas por fuera
  const at = (phi, z, out) => {
    const k = Math.sqrt(Math.max(0, 1 - ((z - hz) / rz) ** 2)) * out;
    return [hx + rx * k * Math.cos(phi), ry * k * Math.sin(phi), z];
  };
  const visor = [];
  for (let i = 0; i <= 10; i++) {
    const phi = (-70 + i * 14) * (Math.PI / 180);
    // un poco más alta en el centro, como la abertura de los cascos de verdad
    const z0 = 0.79, z1 = 0.85 + 0.008 * Math.cos(phi * 1.3);
    // con un punto en el medio de la cara de afuera, que sigue la curva del casco (si no, el casco la atraviesa)
    visor.push([at(phi, z0, 0.97), at(phi, z0, 1.04), at(phi, (z0 + z1) / 2, 1.04), at(phi, z1, 1.04), at(phi, z1, 0.97)]);
  }
  // alerón: una plaquita sobre la parte de atrás, apenas inclinada
  const spoiler = plate(-0.17, 0.92, -0.225, 0.905, 0.065, 0.012, color);
  const pivot = { x: hx, y: 0, z: hz };
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

function skin(parts, body, livery) {
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
        if (top) uv = pts.map(([x, y]) => [(x + HALF_L) * LIVERY_S, TOP + (y + HALF_W) * LIVERY_S]);
        else if (side) {
          const row = f.n[1] > 0 ? SIDE_R : SIDE_L;
          uv = pts.map(([x, , z]) => [(x + HALF_L) * LIVERY_S, row + (TALL - z) * LIVERY_S]);
        }
        if (uv) Object.assign(f, { tex: livery, slot: 1, dens: LIVERY_S });
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
      // (el vidrio de los espejos, 2: refleja de frente también, como un espejo)
      f.gloss = f.color === MIRROR ? 2 : f.color === body || part.head ? 1 : f.color === CARBON ? 0.35
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

export function carModel(color = '#d8261c', helmet = '#ffd400', number = '16', accent = '#f4f4f4', tcam = TCAM[0]) {
  const body = hex(color), head = hex(helmet);
  const parts = [];
  const add = (...p) => parts.push(...p);
  const both = (fn) => { fn(1); fn(-1); };

  // piso y difusor
  add(box(-1.95, 1.1, 0, 0.85, 0.03, 0.08, CARBON, 0.03));
  add(loft([sec(-1.95, 0, 0.7, 0.03, 0.1, 0.03), sec(-2.55, 0, 0.6, 0.1, 0.35, 0.05)], CARBON));

  // monocasco y trompa: una sola pieza que se angosta y baja hacia adelante
  add(loft([
    sec(-0.45, 0, 0.42, 0.1, 0.7, 0.14),
    sec(0.3, 0, 0.38, 0.12, 0.66, 0.13),
    sec(1.15, 0, 0.26, 0.16, 0.56, 0.11),
    sec(1.7, 0, 0.2, 0.16, 0.46, 0.09),
    sec(2.2, 0, 0.14, 0.14, 0.34, 0.07),
    sec(2.62, 0, 0.09, 0.12, 0.23, 0.045),
  ], body));
  // abertura de la cabina (oscura, apenas por encima del monocasco)
  add(box(-0.45, 0.2, 0, 0.26, 0.55, 0.672, COCKPIT, 0.08));
  // cubierta del motor
  add(loft([
    sec(-0.45, 0, 0.42, 0.1, 0.74, 0.15),
    sec(-1.2, 0, 0.34, 0.1, 0.66, 0.14),
    sec(-1.9, 0, 0.18, 0.14, 0.48, 0.08),
    sec(-2.3, 0, 0.08, 0.2, 0.38, 0.04),
  ], body));
  // toma de aire sobre la cabeza del piloto, con la cámara de TV arriba; hacia atrás se afina en una aleta que
  // baja de a poco sobre la cubierta del motor hasta morir antes del alerón
  add(loft([
    sec(-2.3, 0, 0.012, 0.36, 0.4, 0.006),
    sec(-1.95, 0, 0.02, 0.42, 0.56, 0.01),
    sec(-1.55, 0, 0.05, 0.5, 0.74, 0.03),
    sec(-1.15, 0, 0.11, 0.58, 0.92, 0.06),
    sec(-0.85, 0, 0.17, 0.62, 1.02, 0.08),
    sec(-0.55, 0, 0.15, 0.64, 1.0, 0.08),
    sec(-0.3, 0, 0.12, 0.66, 0.92, 0.06),
  ], body, CARBON));
  // cámara de TV en forma de T: un parante finito y arriba una barra a lo ancho, del color que distingue al auto
  add(box(-0.42, -0.34, 0, 0.025, 0.95, 1.07, hex(tcam), 0.01));
  add(box(-0.45, -0.31, 0, 0.17, 1.07, 1.11, hex(tcam), 0.018));
  // pontones a los costados: toma de aire adelante y se van cerrando hacia atrás. La boca tiene un labio redondeado
  // que sobresale de la abertura oscura, y está inclinada: arriba avanza más que abajo, como en los de verdad.
  const lean = (ring) => ring.map(([x, y, z]) => [x + (z - 0.35) * 0.35, y, z]);
  both((s) => {
    const pod = loft([
      lean(sec(0.78, s * 0.6, 0.16, 0.19, 0.51, 0.08)),
      lean(sec(0.81, s * 0.6, 0.185, 0.16, 0.54, 0.1)),
      lean(sec(0.76, s * 0.605, 0.2, 0.14, 0.56, 0.11)),
      sec(0.62, s * 0.61, 0.21, 0.13, 0.58, 0.13),
      sec(0.35, s * 0.62, 0.22, 0.12, 0.6, 0.14),
      sec(-0.5, s * 0.6, 0.2, 0.12, 0.55, 0.14),
      sec(-1.3, s * 0.45, 0.12, 0.12, 0.34, 0.08),
      sec(-1.8, s * 0.35, 0.06, 0.12, 0.24, 0.04),
    ], body, CARBON);
    // el frente del labio mira hacia adelante y hacia la boca (loft lo orientaría hacia afuera del eje)
    for (const f of pod.faces.slice(2, 2 + 16)) if (f.n[0] < 0) f.n = f.n.map((c) => -c);
    add(pod);
  });
  // la abertura: un bloque oscuro que tapa la boca por dentro del labio
  both((s) => add(loft([sec(0.45, s * 0.6, 0.16, 0.19, 0.51, 0.08), lean(sec(0.785, s * 0.6, 0.16, 0.19, 0.51, 0.08))], COCKPIT)));
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
  add({ ...box(-0.34, -0.02, 0, 0.2, 0.58, 0.69, hex(color, 0.7), 0.07), tag: 'helmet', suit: true });
  add({ ...loft([sec(-0.3, 0, 0.15, 0.62, 0.73, 0.05), sec(-0.17, 0, 0.13, 0.64, 0.75, 0.05)], CARBON), tag: 'helmet' });
  add(...helmetParts(head));
  // halo: un arco sobre la cabeza que se apoya atrás y en un pilar central adelante
  // (visto desde arriba es media elipse: adelante en x = 0,58 y atrás, a los costados de la cabeza)
  const haloAt = (t) => [-0.15 + 0.73 * Math.cos(t), 0.29 * Math.sin(t), 0.74 + 0.12 * Math.cos(t)];
  const halo = [];
  for (let i = 0; i <= 28; i++) halo.push(haloAt(-Math.PI / 2 + (i / 28) * Math.PI));
  add(tube(halo, 0.016, CARBON, 10));
  add(tube([[0.62, 0, 0.5], [0.6, 0, 0.75]], 0.018, CARBON, 10));
  // unión del pilar con el arco: una lámina que sigue al arco y baja hasta el pilar con un borde cóncavo,
  // así el pilar se abre en curva hacia arriba en vez de formar una T
  const FILLET_W = 0.15, FILLET_DROP = 0.14;
  const fillet = [];
  for (let j = 0; j <= 16; j++) {
    const y = -FILLET_W + (j / 16) * 2 * FILLET_W;
    const [x, , z] = haloAt(Math.asin(y / 0.29));
    const f = 1 - Math.abs(y) / FILLET_W; // 1 en el pilar, 0 donde se funde con el arco
    const cx = x + 0.02 * f; // en el medio, alineada con el pilar
    const bottom = z - FILLET_DROP * f * f;
    fillet.push([[cx - 0.016, y, bottom], [cx + 0.016, y, bottom], [cx + 0.016, y, z], [cx - 0.016, y, z]]);
  }
  add(loft(fillet, CARBON));

  // alerón delantero: tres elementos escalonados y las placas laterales
  add(plate(2.82, 0.06, 2.45, 0.07, 1.0, 0.03, CARBON));
  add(plate(2.52, 0.12, 2.3, 0.16, 0.95, 0.025, body));
  add(plate(2.38, 0.2, 2.2, 0.25, 0.9, 0.022, body));
  both((s) => add(box(2.18, 2.84, s * 0.98, 0.02, 0.05, 0.32, CARBON, 0.01)));

  // alerón trasero: plano principal y flap inclinados, placas, ala baja y pilar; abajo, la luz de lluvia
  add(plate(-2.4, 0.76, -2.65, 0.8, 0.5, 0.04, CARBON));
  add(plate(-2.6, 0.86, -2.78, 0.95, 0.5, 0.03, body));
  both((s) => add(box(-2.82, -2.35, s * 0.52, 0.02, 0.36, 1.0, body, 0.01)));
  add(plate(-2.35, 0.36, -2.6, 0.4, 0.45, 0.03, CARBON));
  add(box(-2.5, -2.2, 0, 0.03, 0.4, 0.78, CARBON, 0.01));
  add(box(-2.64, -2.58, 0, 0.05, 0.25, 0.32, RAIN_LIGHT));

  // suspensión (dos triángulos por rueda, de la carrocería al centro de la rueda) y ruedas
  for (const [x, y, w, front] of [[1.65, 0.8, 0.33, true], [-1.7, 0.79, 0.42, false]]) {
    both((s) => {
      const hub = s * (y - w / 2 - 0.04);
      for (const z of [0.25, 0.45]) {
        // brazos de sección ovalada y chata, como los perfiles de los de verdad
        add(tube([[x - 0.32, s * 0.22, z], [x, hub, z + 0.02]], 0.022, CARBON, 10, 0.45));
        add(tube([[x + 0.12, s * 0.22, z], [x, hub, z + 0.02]], 0.022, CARBON, 10, 0.45));
      }
      add(...wheel(x, s, y, w, front, hex(accent)));
    });
  }
  return skin(parts, body, liveryTexture(color, accent, number));
}
