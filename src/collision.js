// Choques con impulsos, como en un motor de física 2D.
// Cada auto tiene masa (todos iguales, así que se toma 1) y momento de inercia, y entre autos es un juego de piezas
// (las zonas de damage.js: alerones, ruedas, pontones; 5,6 × 2 m en total). Contra los muros, tres círculos.
// Su velocidad en el mundo es la de marcha (car.speed, hacia donde apunta) más la de costado (car.slip),
// y gira a car.omega (lo que dobla con el volante más car.spin, el giro que le dejan los golpes).
// En un choque se calcula el punto de contacto y se aplica un impulso según la velocidad con que se acercan
// ahí los dos cuerpos: con un poco de rebote y de rozamiento. Si el contacto está fuera del centro, el auto gira.
// Mientras dos cuerpos sólo se apoyan (no se acercan) no hay impulso: se deslizan sin frenarse.
// Todo se calcula en metros y m/s; las posiciones de los autos están en celdas (track.meters metros cada una).
// Cada golpe le pasa a damage.js dónde pegó y qué tan fuerte (car.damageLevel dice si rompe algo).
//
// Rueda contra rueda no es como chapa contra chapa: la goma agarra mucho más y gira. De costado, la parte de la
// goma que se toca se mueve más rápido que el auto (arriba del eje, hasta el doble), así que la diferencia de
// velocidad entre los dos se agranda: el más rápido arrastra al más lento y los dos se tuercen. Y si una rueda
// delantera le pega de atrás a una trasera del de adelante, sus caras se mueven en sentidos opuestos (la de
// adelante de una baja, la de atrás de la otra sube): la de atrás se trepa y el auto vuela. Acá, como todo es
// plano, el que se trepa pierde velocidad, queda girando y se rompe la suspensión; al de adelante lo empuja.

import { sampleField } from './track.js';
import { applyHit, ZONES } from './damage.js';

const HALF_L = 2.8; // medio largo del auto, de punta a punta de los alerones (m)
const HALF_W = 1.0; // medio ancho, con las ruedas (m)
const INERTIA = ((2 * HALF_L) ** 2 + (2 * HALF_W) ** 2) / 12; // momento de inercia por unidad de masa (m²)
const CAR_BOUNCE = 0.25; // rebote entre autos (0 = se quedan pegados, 1 = rebote perfecto)
const CAR_FRICTION = 0.35; // rozamiento entre carrocerías
const WALL_BOUNCE = 0.15;
const WALL_FRICTION = 0.3;
const WALL_PROBES = [2.0, 0, -2.0]; // contra los muros, el auto son tres círculos a lo largo (m del centro)
const WALL_R = 1.0; // radio de esos círculos (m)
const MAX_SPIN = 8; // giro máximo que puede dejar un golpe (rad/s)
const TYRE_FRICTION = 1; // rozamiento goma contra goma
const TYRE_SURFACE = 1.6; // cuánto más rápido que el auto se mueve la parte de la goma que se toca
const LAUNCH_HIT = 4; // m/s: desde acá, una delantera que le pega de atrás a una trasera se trepa
const LAUNCH_SPEED = 0.6; // y el que se trepa queda con esta parte de su velocidad
const LAUNCH_SPIN = 4; // girando hasta esto (rad/s)
const LAUNCH_DAMAGE = 2; // y su suspensión recibe el golpe multiplicado por esto

// piezas de choque entre autos: centro y medio largo y ancho, en m (marco del auto)
const PIECES = ZONES.map((z) => ({ zone: z, cx: (z.x[0] + z.x[1]) / 2, cy: (z.y[0] + z.y[1]) / 2, hx: (z.x[1] - z.x[0]) / 2, hy: (z.y[1] - z.y[0]) / 2 }));

// Para medir los golpes (tools/damage_hits.js): se la llama con (auto, zona, intensidad, zona del otro o null)
let hitLog = null;
export const logHits = (fn) => (hitLog = fn);

// un golpe de intensidad hit en el punto r (m desde el centro, en el mundo) del auto: lo anota y lo rompe
function hurt(car, r, hit, other) {
  const ca = Math.cos(car.angle), sa = Math.sin(car.angle);
  const lx = r[0] * ca + r[1] * sa, ly = -r[0] * sa + r[1] * ca;
  hitLog?.(car, lx, ly, hit, other);
  if (car.damageLevel && car.damageLevel !== 'off') car.damage = applyHit(car.damage, lx, ly, hit, other, car.damageLevel);
}

const cross = (ax, ay, bx, by) => ax * by - ay * bx;

// velocidad del auto en el mundo (m/s)
function velocity(car) {
  const ca = Math.cos(car.angle), sa = Math.sin(car.angle);
  return [ca * car.speed - sa * car.slip, sa * car.speed + ca * car.slip];
}

// Aplica un impulso (px, py, por unidad de masa) en un punto a (rx, ry) metros del centro del auto
function push(car, rx, ry, px, py) {
  const ca = Math.cos(car.angle), sa = Math.sin(car.angle);
  const [vx, vy] = velocity(car);
  const nx = vx + px, ny = vy + py;
  car.speed = nx * ca + ny * sa;
  car.slip = -nx * sa + ny * ca;
  const dw = cross(rx, ry, px, py) / INERTIA;
  car.spin = Math.max(-MAX_SPIN, Math.min(MAX_SPIN, car.spin + dw));
  car.omega += dw;
}

// Impulso en un contacto con normal n (de A hacia B) y punto a rA de A y rB de B (b = null: muro, que no se mueve).
// Devuelve la intensidad del golpe (m/s), para sacudir la cámara.
function impulse(a, b, rA, rB, nx, ny, bounce, friction, surface = 1) {
  const pointVel = (car, r) => {
    const [vx, vy] = velocity(car);
    return [vx - car.omega * r[1], vy + car.omega * r[0]];
  };
  const va = pointVel(a, rA);
  const vb = b ? pointVel(b, rB) : [0, 0];
  const rvx = vb[0] - va[0], rvy = vb[1] - va[1];
  const vn = rvx * nx + rvy * ny;
  if (vn >= 0) return 0; // se están separando (o sólo apoyados)
  const tx = -ny, ty = nx;
  const share = (r, ax, ay) => cross(r[0], r[1], ax, ay) ** 2 / INERTIA;
  const kn = 1 + share(rA, nx, ny) + (b ? 1 + share(rB, nx, ny) : 0);
  const kt = 1 + share(rA, tx, ty) + (b ? 1 + share(rB, tx, ty) : 0);
  const j = (-(1 + bounce) * vn) / kn;
  const jt = Math.max(-friction * j, Math.min(friction * j, (-(rvx * tx + rvy * ty) * surface) / kt));
  const px = j * nx + jt * tx, py = j * ny + jt * ty;
  push(a, rA[0], rA[1], -px, -py);
  if (b) push(b, rB[0], rB[1], px, py);
  return j;
}

// Muros: tres círculos a lo largo del auto. Si alguno se mete en el muro, se saca el auto y se aplica el impulso
// en ese punto: un roce en ángulo casi no frena y endereza el auto contra el muro; de frente, frena y rebota.
export function collideWalls(car, track) {
  const M = track.meters, { sdf, W } = track;
  const limit = -track.runoff + WALL_R / M; // el centro del círculo no puede estar más afuera que esto (celdas)
  const e = 0.5;
  let hit = 0;
  for (let pass = 0; pass < 2; pass++) {
    for (const off of WALL_PROBES) {
      const ca = Math.cos(car.angle), sa = Math.sin(car.angle);
      const px = car.x + (ca * off) / M, py = car.y + (sa * off) / M;
      const depth = limit - sampleField(sdf, W, px, py);
      if (depth <= 0) continue;
      // normal del muro hacia la pista: hacia donde crece la distancia al borde
      let nx = sampleField(sdf, W, px + e, py) - sampleField(sdf, W, px - e, py);
      let ny = sampleField(sdf, W, px, py + e) - sampleField(sdf, W, px, py - e);
      const len = Math.hypot(nx, ny) || 1;
      nx /= len;
      ny /= len;
      car.x += nx * depth;
      car.y += ny * depth;
      // punto de contacto: el borde del círculo que toca el muro
      const r = [ca * off - nx * WALL_R, sa * off - ny * WALL_R];
      // el muro es "B" y el auto "A": la normal tiene que ir del auto hacia el muro
      const j = impulse(car, null, r, null, -nx, -ny, WALL_BOUNCE, WALL_FRICTION);
      if (j > 0) hurt(car, r, j, null);
      hit = Math.max(hit, j);
    }
  }
  if (hit > 0) car.bump = Math.max(car.bump, Math.min(1, hit / 25));
  return hit;
}

// Una pieza de un auto en el mundo (m): centro, ejes y medidas
function box(car, piece, M) {
  const ca = Math.cos(car.angle), sa = Math.sin(car.angle);
  return {
    piece, car, ca, sa, hx: piece.hx, hy: piece.hy,
    x: car.x * M + ca * piece.cx - sa * piece.cy, y: car.y * M + sa * piece.cx + ca * piece.cy,
  };
}

// esquinas de una pieza
function corners(b) {
  return [[1, 1], [1, -1], [-1, -1], [-1, 1]].map(([l, w]) => [b.x + b.ca * b.hx * l - b.sa * b.hy * w, b.y + b.sa * b.hx * l + b.ca * b.hy * w]);
}

// ¿el punto p está dentro de la pieza? (con un poco de tolerancia)
function inside(b, p) {
  const dx = p[0] - b.x, dy = p[1] - b.y;
  return Math.abs(dx * b.ca + dy * b.sa) <= b.hx + 0.05 && Math.abs(-dx * b.sa + dy * b.ca) <= b.hy + 0.05;
}

// Dos piezas con el test de ejes separadores (si en alguno de los cuatro ejes las sombras no se pisan, no se tocan).
// El eje donde menos se pisan da la normal (de A hacia B) y cuánto se meten.
function overlap(A, B) {
  const dx = B.x - A.x, dy = B.y - A.y;
  const extent = (b, ax, ay) => b.hx * Math.abs(b.ca * ax + b.sa * ay) + b.hy * Math.abs(-b.sa * ax + b.ca * ay);
  let best = Infinity, nx = 0, ny = 0, owner = null;
  for (const b of [A, B]) {
    for (const [ax, ay] of [[b.ca, b.sa], [-b.sa, b.ca]]) {
      const d = dx * ax + dy * ay;
      const o = extent(A, ax, ay) + extent(B, ax, ay) - Math.abs(d);
      if (o <= 0) return null;
      if (o < best) [best, nx, ny, owner] = [o, d < 0 ? -ax : ax, d < 0 ? -ay : ay, b];
    }
  }
  return { depth: best, nx, ny, owner };
}

// punto de contacto: el promedio de las esquinas de cada pieza que quedaron dentro de la otra (con los autos
// alineados, trompa contra cola, queda en el medio de la zona que se toca). Si ninguna quedó adentro (se cruzan
// dos lados), la esquina de la otra pieza que más se mete en la dueña del eje.
function contact(A, B, { nx, ny, owner }) {
  const ca = corners(A), cb = corners(B);
  let touching = [...cb.filter((p) => inside(A, p)), ...ca.filter((p) => inside(B, p))];
  if (!touching.length) {
    const pts = owner === A ? cb : ca;
    const sign = owner === A ? 1 : -1; // las de B se meten hacia -n; las de A, hacia +n
    touching = [pts.reduce((m, p) => (sign * (p[0] * nx + p[1] * ny) < sign * (m[0] * nx + m[1] * ny) ? p : m))];
  }
  return [0, 1].map((c) => touching.reduce((sum, p) => sum + p[c], 0) / touching.length);
}

const PIECE_REACH = Math.max(...PIECES.map((p) => Math.hypot(p.hx, p.hy)));

// Entre autos: de todas las piezas que se tocan, la que más se mete; se separan los autos y se aplica el impulso
// ahí (dos veces, por si después quedan otras dos piezas metidas)
export function collideCars(cars, track, isSolid) {
  const M = track.meters;
  for (let i = 0; i < cars.length; i++) {
    for (let j = i + 1; j < cars.length; j++) {
      const a = cars[i], b = cars[j];
      const dx = (b.x - a.x) * M, dy = (b.y - a.y) * M;
      if (dx * dx + dy * dy > 4 * (HALF_L * HALF_L + HALF_W * HALF_W)) continue;
      for (let pass = 0; pass < 2; pass++) {
        const boxesA = PIECES.map((p) => box(a, p, M)), boxesB = PIECES.map((p) => box(b, p, M));
        let worst = null;
        for (const A of boxesA) {
          for (const B of boxesB) {
            if (Math.hypot(B.x - A.x, B.y - A.y) > 2 * PIECE_REACH) continue;
            const o = overlap(A, B);
            if (o && (!worst || o.depth > worst.o.depth)) worst = { A, B, o };
          }
        }
        if (!worst) break;
        const { A, B, o } = worst, { nx, ny } = o;
        const cp = contact(A, B, o);
        // se separan (cada uno la mitad, o todo el que puede si el otro está contra el muro)
        const sep = o.depth / M;
        const aFree = !isSolid(track, a.x - nx * sep, a.y - ny * sep), bFree = !isSolid(track, b.x + nx * sep, b.y + ny * sep);
        const ka = aFree ? (bFree ? 0.5 : 1) : 0, kb = bFree ? (aFree ? 0.5 : 1) : 0;
        a.x -= nx * sep * ka; a.y -= ny * sep * ka;
        b.x += nx * sep * kb; b.y += ny * sep * kb;
        const rA = [cp[0] - a.x * M, cp[1] - a.y * M], rB = [cp[0] - b.x * M, cp[1] - b.y * M];
        const za = A.piece.zone, zb = B.piece.zone, tyres = za.part === 'wheel' && zb.part === 'wheel';
        const hit = tyres ? impulse(a, b, rA, rB, nx, ny, CAR_BOUNCE, TYRE_FRICTION, TYRE_SURFACE) : impulse(a, b, rA, rB, nx, ny, CAR_BOUNCE, CAR_FRICTION);
        if (hit <= 0) continue;
        const k = Math.min(1, hit / 15);
        a.bump = Math.max(a.bump, k);
        b.bump = Math.max(b.bump, k);
        // ¿una delantera que le pegó de atrás a una trasera? Se trepa
        const climbs = (car, mine, theirs, n) => tyres && mine.wheel < 2 && theirs.wheel >= 2 && hit > LAUNCH_HIT
          && Math.cos(car.angle) * n[0] + Math.sin(car.angle) * n[1] > 0.7;
        const launched = climbs(a, za, zb, [nx, ny]) ? a : climbs(b, zb, za, [-nx, -ny]) ? b : null;
        hurt(a, rA, launched === a ? hit * LAUNCH_DAMAGE : hit, zb);
        hurt(b, rB, launched === b ? hit * LAUNCH_DAMAGE : hit, za);
        if (launched) {
          launched.speed *= LAUNCH_SPEED;
          const turn = (Math.random() < 0.5 ? -1 : 1) * LAUNCH_SPIN * (0.5 + 0.5 * Math.random());
          launched.spin = Math.max(-MAX_SPIN, Math.min(MAX_SPIN, launched.spin + turn));
          launched.bump = 1;
        }
      }
    }
  }
}
