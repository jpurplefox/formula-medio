// Choques con impulsos, como en un motor de física 2D.
// Cada auto es un rectángulo de 5,6 × 2 m con masa (todos iguales, así que se toma 1) y momento de inercia.
// Su velocidad en el mundo es la de marcha (car.speed, hacia donde apunta) más la de costado (car.slip),
// y gira a car.omega (lo que dobla con el volante más car.spin, el giro que le dejan los golpes).
// En un choque se calcula el punto de contacto y se aplica un impulso según la velocidad con que se acercan
// ahí los dos cuerpos: con un poco de rebote y de rozamiento. Si el contacto está fuera del centro, el auto gira.
// Mientras dos cuerpos sólo se apoyan (no se acercan) no hay impulso: se deslizan sin frenarse.
// Todo se calcula en metros y m/s; las posiciones de los autos están en celdas (track.meters metros cada una).

import { sampleField } from './track.js';

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
function impulse(a, b, rA, rB, nx, ny, bounce, friction) {
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
  const jt = Math.max(-friction * j, Math.min(friction * j, -(rvx * tx + rvy * ty) / kt));
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
      hit = Math.max(hit, impulse(car, null, r, null, -nx, -ny, WALL_BOUNCE, WALL_FRICTION));
    }
  }
  if (hit > 0) car.bump = Math.max(car.bump, Math.min(1, hit / 25));
  return hit;
}

// esquinas del rectángulo de un auto, en metros
function corners(car, M) {
  const cx = car.x * M, cy = car.y * M;
  const ca = Math.cos(car.angle), sa = Math.sin(car.angle);
  return [[1, 1], [1, -1], [-1, -1], [-1, 1]].map(([l, w]) => [cx + ca * HALF_L * l - sa * HALF_W * w, cy + sa * HALF_L * l + ca * HALF_W * w]);
}

// ¿el punto p (en metros) está dentro del rectángulo del auto? (con un poco de tolerancia)
function inside(car, p, M) {
  const ca = Math.cos(car.angle), sa = Math.sin(car.angle);
  const dx = p[0] - car.x * M, dy = p[1] - car.y * M;
  return Math.abs(dx * ca + dy * sa) <= HALF_L + 0.05 && Math.abs(-dx * sa + dy * ca) <= HALF_W + 0.05;
}

// Entre autos: rectángulos con el test de ejes separadores (si en alguno de los cuatro ejes de los dos
// rectángulos las sombras no se pisan, no se tocan). El eje donde menos se pisan da la normal del choque,
// y la esquina más metida del otro auto, el punto de contacto.
export function collideCars(cars, track, isSolid) {
  const M = track.meters;
  for (let i = 0; i < cars.length; i++) {
    for (let j = i + 1; j < cars.length; j++) {
      const a = cars[i], b = cars[j];
      const dx = (b.x - a.x) * M, dy = (b.y - a.y) * M;
      if (dx * dx + dy * dy > 4 * (HALF_L * HALF_L + HALF_W * HALF_W)) continue;
      const axes = [a, b].flatMap((c) => {
        const ca = Math.cos(c.angle), sa = Math.sin(c.angle);
        return [[ca, sa, c], [-sa, ca, c]];
      });
      const extent = (c, ax, ay) => {
        const ca = Math.cos(c.angle), sa = Math.sin(c.angle);
        return HALF_L * Math.abs(ca * ax + sa * ay) + HALF_W * Math.abs(-sa * ax + ca * ay);
      };
      let best = Infinity, nx = 0, ny = 0, owner = null;
      for (const [ax, ay, c] of axes) {
        const d = dx * ax + dy * ay;
        const overlap = extent(a, ax, ay) + extent(b, ax, ay) - Math.abs(d);
        if (overlap <= 0) { best = -1; break; }
        if (overlap < best) {
          best = overlap;
          const s = d < 0 ? -1 : 1;
          nx = ax * s;
          ny = ay * s;
          owner = c;
        }
      }
      if (best <= 0) continue;
      // punto de contacto: el promedio de las esquinas de cada auto que quedaron dentro del otro (con los autos
      // alineados, trompa contra cola, queda en el medio de la zona que se toca). Si ninguna esquina quedó adentro
      // (se cruzan dos lados), la esquina del otro auto que más se mete en el dueño del eje.
      const ca = corners(a, M), cb = corners(b, M);
      let touching = [...cb.filter((p) => inside(a, p, M)), ...ca.filter((p) => inside(b, p, M))];
      if (!touching.length) {
        const pts = owner === a ? cb : ca;
        const sign = owner === a ? 1 : -1; // las de B se meten hacia -n; las de A, hacia +n
        touching = [pts.reduce((m, p) => (sign * (p[0] * nx + p[1] * ny) < sign * (m[0] * nx + m[1] * ny) ? p : m))];
      }
      const cp = [0, 1].map((c) => touching.reduce((sum, p) => sum + p[c], 0) / touching.length);
      // se separan (cada uno la mitad, o todo el que puede si el otro está contra el muro)
      const sep = best / M;
      const aFree = !isSolid(track, a.x - nx * sep, a.y - ny * sep), bFree = !isSolid(track, b.x + nx * sep, b.y + ny * sep);
      const ka = aFree ? (bFree ? 0.5 : 1) : 0, kb = bFree ? (aFree ? 0.5 : 1) : 0;
      a.x -= nx * sep * ka; a.y -= ny * sep * ka;
      b.x += nx * sep * kb; b.y += ny * sep * kb;
      const rA = [cp[0] - a.x * M, cp[1] - a.y * M], rB = [cp[0] - b.x * M, cp[1] - b.y * M];
      const hit = impulse(a, b, rA, rB, nx, ny, CAR_BOUNCE, CAR_FRICTION);
      if (hit > 0) {
        const k = Math.min(1, hit / 15);
        a.bump = Math.max(a.bump, k);
        b.bump = Math.max(b.bump, k);
      }
    }
  }
}
