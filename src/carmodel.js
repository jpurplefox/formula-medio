// Modelo 3D del auto de fórmula, armado en código con piezas redondeadas (secciones unidas entre sí, tubos y ruedas).
// Coordenadas en metros, con el origen en el piso debajo del centro del auto:
// x hacia adelante, y hacia la derecha, z hacia arriba.
// Cada pieza es una serie de secciones (anillos de puntos) unidas por caras; la normal de cada cara se calcula
// al armar el modelo y apunta hacia afuera, así el renderer sabe qué caras se ven y cómo las ilumina el sol.

import { rgb } from './renderer.js';
import { carbonTexture } from './textures.js';
import { HALF_L, HALF_W, LIVERY_S, SIDE_L, SIDE_R, SIDEWALL_S, SIDEWALL_SIZE, TALL, TOP, liveryTexture, sidewallTexture } from './livery.js';

const CARBON = rgb(34, 34, 38);
const COCKPIT = rgb(16, 16, 18);
const TYRE = rgb(26, 26, 28);
const TYRE_ALT = rgb(40, 40, 44); // franjas de la banda de rodadura, para que se vea girar
const SIDEWALL = rgb(52, 52, 56);
const RIM = rgb(118, 120, 128);
const MIRROR = rgb(120, 140, 160);
const RAIN_LIGHT = rgb(255, 60, 60);
const VISOR = rgb(20, 22, 28);
const CARBON_S = 400; // texeles de carbono por metro (cada celda del tejido, 2 cm)

export const WHEEL_R = 0.36; // radio de las ruedas (m)
const WHEEL_SEGMENTS = 24; // lados del polígono de cada rueda

function hex(s) {
  const n = parseInt(s.slice(1), 16);
  return rgb(n >> 16, (n >> 8) & 255, n & 255);
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

// tubo de sección cuadrada (medio lado t) que pasa por los puntos de path
function tube(path, t, color) {
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
    return [[1, 1], [-1, 1], [-1, -1], [1, -1]].map(([s, q]) => [p[0] + (ux * s + vx * q) * t, p[1] + (uy * s + vy * q) * t, p[2] + (uz * s + vz * q) * t]);
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

// rueda: goma con franjas y la llanta del lado de afuera. Guarda su centro para girarla y doblarla.
function wheel(x, s, yc, width, front) {
  const y = s * yc, out = s * (yc + width / 2);
  const tyre = cylinder(x, WHEEL_R, WHEEL_R, y - width / 2, y + width / 2, WHEEL_SEGMENTS, TYRE, SIDEWALL, (i) => ((i / 3) | 0) & 1 ? TYRE_ALT : TYRE);
  const rim = cylinder(x, WHEEL_R, 0.23, out, out + s * 0.012, 16, CARBON, RIM);
  const info = { x, y, z: WHEEL_R, front };
  tyre.wheel = info;
  rim.wheel = info;
  return [tyre, rim];
}

// Texturas: cada cara se proyecta sobre el plano al que más mira (desde arriba, de costado o de frente)
// y de ahí salen sus coordenadas en la textura (u, v, en texeles), una por vértice.
// Las caras del color de la carrocería llevan la decoración; las de carbono, el tejido; los flancos de las gomas,
// su dibujo (centrado en la rueda, así gira con ella). El resto queda de un solo color.
let carbon = null, sidewall = null;

function skin(parts, body, livery) {
  carbon ??= carbonTexture();
  sidewall ??= sidewallTexture();
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
        if (uv) Object.assign(f, { tex: livery, dens: LIVERY_S });
      } else if (f.color === CARBON) {
        uv = pts.map(([x, y, z]) => (top ? [x, y] : side ? [x, z] : [y, z]).map((c) => c * CARBON_S));
        Object.assign(f, { tex: carbon, dens: CARBON_S });
      } else if (f.color === SIDEWALL && part.wheel && side) {
        const { x: wx, z: wz } = part.wheel, m = SIDEWALL_SIZE / 2;
        uv = pts.map(([x, , z]) => [m + (x - wx) * SIDEWALL_S, m - (z - wz) * SIDEWALL_S]);
        Object.assign(f, { tex: sidewall, dens: SIDEWALL_S });
      }
      if (uv) f.uv = uv;
    }
  }
  return parts;
}

// Arma el auto con el color de la carrocería, el del casco y el de los detalles de la decoración (en '#rrggbb')
// y su número.
// Devuelve una lista de piezas { verts: [[x,y,z]...], faces: [{ idx, color, n, tex?, uv?, dens? }], wheel?, tag? }.
export function carModel(color = '#d8261c', helmet = '#ffd400', number = '16', accent = '#f4f4f4') {
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
  // toma de aire sobre la cabeza del piloto, con la cámara de TV arriba
  add(loft([sec(-0.85, 0, 0.17, 0.62, 1.02, 0.08), sec(-0.55, 0, 0.15, 0.64, 1.0, 0.08), sec(-0.3, 0, 0.12, 0.66, 0.92, 0.06)], body, CARBON));
  add(box(-0.45, -0.3, 0, 0.08, 0.99, 1.04, CARBON, 0.02));
  // pontones a los costados: toma de aire adelante y se van cerrando hacia atrás
  both((s) => add(loft([
    sec(0.75, s * 0.6, 0.2, 0.14, 0.56, 0.1),
    sec(0.35, s * 0.62, 0.22, 0.12, 0.6, 0.14),
    sec(-0.5, s * 0.6, 0.2, 0.12, 0.55, 0.14),
    sec(-1.3, s * 0.45, 0.12, 0.12, 0.34, 0.08),
    sec(-1.8, s * 0.35, 0.06, 0.12, 0.24, 0.04),
  ], body, CARBON)));
  // espejos sobre su soporte; el vidrio mira hacia atrás
  both((s) => {
    add(loft([sec(0.42, s * 0.54, 0.08, 0.62, 0.72, 0.03), sec(0.52, s * 0.54, 0.075, 0.625, 0.715, 0.03)], body, MIRROR));
    add(tube([[0.47, s * 0.46, 0.66], [0.5, s * 0.36, 0.6]], 0.012, CARBON));
  });

  // casco: un elipsoide (se oculta en la vista de cabina, porque ahí está la cámara)
  const hx = -0.08, hrx = 0.15;
  const rings = [];
  for (let i = 1; i < 8; i++) {
    const p = (i / 8) * Math.PI;
    rings.push(ellipse(hx + hrx * Math.cos(p), 0, 0.12 * Math.sin(p), 0.8, 0.13 * Math.sin(p)));
  }
  add({ ...loft(rings, head), tag: 'helmet' });
  add({ ...loft([sec(0.0, 0, 0.085, 0.8, 0.855, 0.025), sec(0.075, 0, 0.07, 0.805, 0.85, 0.02)], VISOR), tag: 'helmet' });
  // halo: un arco sobre la cabeza que se apoya atrás y en un pilar central adelante
  // (visto desde arriba es media elipse: adelante en x = 0,58 y atrás, a los costados de la cabeza)
  const haloAt = (t) => [-0.15 + 0.73 * Math.cos(t), 0.29 * Math.sin(t), 0.74 + 0.12 * Math.cos(t)];
  const halo = [];
  for (let i = 0; i <= 28; i++) halo.push(haloAt(-Math.PI / 2 + (i / 28) * Math.PI));
  add(tube(halo, 0.014, CARBON));
  add(tube([[0.62, 0, 0.5], [0.6, 0, 0.75]], 0.016, CARBON));
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
        add(tube([[x - 0.32, s * 0.22, z], [x, hub, z + 0.02]], 0.016, CARBON));
        add(tube([[x + 0.12, s * 0.22, z], [x, hub, z + 0.02]], 0.016, CARBON));
      }
      add(...wheel(x, s, y, w, front));
    });
  }
  return skin(parts, body, liveryTexture(color, accent, number));
}
