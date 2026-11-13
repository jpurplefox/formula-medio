// Collisions with impulses, as in a 2D physics engine.
// Each car has mass (all the same, so it is taken as 1) and moment of inertia; between cars it is a set of pieces
// (the zones in damage.js: wings, wheels, sidepods; 5.6 × 2 m in total). Against the walls, three circles.
// Its velocity in the world is the forward one (car.speed, where it points) plus the sideways one (car.slip),
// and it yaws at car.omega.
// In a collision the contact point is computed and an impulse is applied according to the speed at which the two
// bodies approach each other there: with a little bounce and friction. If the contact is off center, the car spins.
// While two bodies only rest against each other (not approaching) there is no impulse: they slide without slowing.
// Everything is computed in meters and m/s; car positions are in cells (track.meters meters each).
// Each hit tells damage.js where it struck and how hard (car.damageLevel says whether it breaks anything).
//
// Wheel against wheel is not like bodywork against bodywork: the rubber grips much more and it rotates. Sideways,
// the part of the tyre that touches moves faster than the car (above the axle, up to twice as fast), so the speed
// difference between the two grows: the faster one drags the slower one and both get twisted. And if a front wheel
// hits a rear wheel of the car ahead from behind, their faces move in opposite directions (the front of one goes
// down, the back of the other goes up): the one behind climbs and the car flies. Here, since everything is flat, the
// one that climbs loses speed, is left spinning and breaks its suspension; the car ahead gets pushed.

import { sampleField } from './track.js';
import { applyHit, ZONES } from './damage.js';

export const HALF_L = 2.8; // half the car's length, from wing tip to wing tip (m)
export const HALF_W = 1.0; // half the width, with the wheels (m)
const INERTIA = ((2 * HALF_L) ** 2 + (2 * HALF_W) ** 2) / 12; // moment of inertia per unit mass (m²)
const CAR_BOUNCE = 0.25; // bounce between cars (0 = they stick together, 1 = perfect bounce)
const CAR_FRICTION = 0.35; // friction between bodyworks
const WALL_BOUNCE = 0.15;
const WALL_FRICTION = 0.3;
const WALL_PROBES = [2.0, 0, -2.0]; // against the walls, the car is three circles along its length (m from the center)
const WALL_R = 1.0; // radius of those circles (m)
const MAX_SPIN = 8; // maximum yaw rate a hit can leave (rad/s)
const TYRE_FRICTION = 1; // rubber-on-rubber friction
const TYRE_SURFACE = 1.6; // how much faster than the car the touching part of the tyre moves
const LAUNCH_HIT = 4; // m/s: from here on, a front wheel hitting a rear wheel from behind climbs
const LAUNCH_SPEED = 0.6; // and the one that climbs keeps this fraction of its speed
const LAUNCH_SPIN = 4; // spinning up to this (rad/s)
const LAUNCH_DAMAGE = 2; // and its suspension takes the hit multiplied by this

// collision pieces between cars: center and half length and width, in m (car frame)
const PIECES = ZONES.map((z) => ({
  zone: z,
  cx: (z.x[0] + z.x[1]) / 2,
  cy: (z.y[0] + z.y[1]) / 2,
  hx: (z.x[1] - z.x[0]) / 2,
  hy: (z.y[1] - z.y[0]) / 2,
}));

// To measure hits (tools/damage_hits.js): called with (car, zone, intensity, the other car's zone or null)
let hitLog = null;
export const logHits = (fn) => (hitLog = fn);

// a hit of intensity hit at point r (m from the center, in the world) of the car: logs it and breaks the car
function hurt(car, r, hit, other) {
  const ca = Math.cos(car.angle),
    sa = Math.sin(car.angle);
  const lx = r[0] * ca + r[1] * sa,
    ly = -r[0] * sa + r[1] * ca;
  hitLog?.(car, lx, ly, hit, other);
  if (car.damageLevel && car.damageLevel !== 'off')
    car.damage = applyHit(car.damage, lx, ly, hit, other, car.damageLevel);
}

const cross = (ax, ay, bx, by) => ax * by - ay * bx;

// car velocity in the world (m/s)
function velocity(car) {
  const ca = Math.cos(car.angle),
    sa = Math.sin(car.angle);
  return [ca * car.speed - sa * car.slip, sa * car.speed + ca * car.slip];
}

// Applies an impulse (px, py, per unit mass) at a point (rx, ry) meters from the car's center
function push(car, rx, ry, px, py) {
  const ca = Math.cos(car.angle),
    sa = Math.sin(car.angle);
  const [vx, vy] = velocity(car);
  const nx = vx + px,
    ny = vy + py;
  car.speed = nx * ca + ny * sa;
  car.slip = -nx * sa + ny * ca;
  car.omega = Math.max(-MAX_SPIN, Math.min(MAX_SPIN, car.omega + cross(rx, ry, px, py) / INERTIA));
}

// Impulse at a contact with normal n (from A to B) and point at rA from A and rB from B (b = null: a wall, which
// doesn't move). Returns the hit intensity (m/s), to shake the camera.
function impulse(a, b, rA, rB, nx, ny, bounce, friction, surface = 1) {
  const pointVel = (car, r) => {
    const [vx, vy] = velocity(car);
    return [vx - car.omega * r[1], vy + car.omega * r[0]];
  };
  const va = pointVel(a, rA);
  const vb = b ? pointVel(b, rB) : [0, 0];
  const rvx = vb[0] - va[0],
    rvy = vb[1] - va[1];
  const vn = rvx * nx + rvy * ny;
  if (vn >= 0) return 0; // they are separating (or just resting)
  const tx = -ny,
    ty = nx;
  const share = (r, ax, ay) => cross(r[0], r[1], ax, ay) ** 2 / INERTIA;
  const kn = 1 + share(rA, nx, ny) + (b ? 1 + share(rB, nx, ny) : 0);
  const kt = 1 + share(rA, tx, ty) + (b ? 1 + share(rB, tx, ty) : 0);
  const j = (-(1 + bounce) * vn) / kn;
  const jt = Math.max(-friction * j, Math.min(friction * j, (-(rvx * tx + rvy * ty) * surface) / kt));
  const px = j * nx + jt * tx,
    py = j * ny + jt * ty;
  push(a, rA[0], rA[1], -px, -py);
  if (b) push(b, rB[0], rB[1], px, py);
  return j;
}

// Walls: three circles along the car. If one gets into the wall, the car is pushed out and the impulse is applied at
// that point: a glancing touch barely slows the car and straightens it along the wall; head-on, it brakes and bounces.
export function collideWalls(car, track) {
  const M = track.meters,
    { sdf, W } = track;
  const limit = -track.runoff + WALL_R / M; // the circle's center can't be farther out than this (cells)
  const e = 0.5;
  let hit = 0;
  for (let pass = 0; pass < 2; pass++) {
    for (const off of WALL_PROBES) {
      const ca = Math.cos(car.angle),
        sa = Math.sin(car.angle);
      const px = car.x + (ca * off) / M,
        py = car.y + (sa * off) / M;
      const depth = limit - sampleField(sdf, W, px, py);
      if (depth <= 0) continue;
      // wall normal toward the track: where the distance to the edge grows
      let nx = sampleField(sdf, W, px + e, py) - sampleField(sdf, W, px - e, py);
      let ny = sampleField(sdf, W, px, py + e) - sampleField(sdf, W, px, py - e);
      const len = Math.hypot(nx, ny) || 1;
      nx /= len;
      ny /= len;
      car.x += nx * depth;
      car.y += ny * depth;
      // contact point: the edge of the circle touching the wall
      const r = [ca * off - nx * WALL_R, sa * off - ny * WALL_R];
      // the wall is "B" and the car "A": the normal has to go from the car to the wall
      const j = impulse(car, null, r, null, -nx, -ny, WALL_BOUNCE, WALL_FRICTION);
      if (j > 0) hurt(car, r, j, null);
      hit = Math.max(hit, j);
    }
  }
  if (hit > 0) car.bump = Math.max(car.bump, Math.min(1, hit / 25));
  return hit;
}

// A car piece in the world (m): center, axes and size
function box(car, piece, M) {
  const ca = Math.cos(car.angle),
    sa = Math.sin(car.angle);
  return {
    piece,
    car,
    ca,
    sa,
    hx: piece.hx,
    hy: piece.hy,
    x: car.x * M + ca * piece.cx - sa * piece.cy,
    y: car.y * M + sa * piece.cx + ca * piece.cy,
  };
}

// corners of a piece
function corners(b) {
  return [
    [1, 1],
    [1, -1],
    [-1, -1],
    [-1, 1],
  ].map(([l, w]) => [b.x + b.ca * b.hx * l - b.sa * b.hy * w, b.y + b.sa * b.hx * l + b.ca * b.hy * w]);
}

// is point p inside the piece? (with a little tolerance)
function inside(b, p) {
  const dx = p[0] - b.x,
    dy = p[1] - b.y;
  return Math.abs(dx * b.ca + dy * b.sa) <= b.hx + 0.05 && Math.abs(-dx * b.sa + dy * b.ca) <= b.hy + 0.05;
}

// Two pieces with the separating axis test (if on any of the four axes the projections don't overlap, they don't
// touch). The axis with the least overlap gives the normal (from A to B) and the penetration depth.
function overlap(A, B) {
  const dx = B.x - A.x,
    dy = B.y - A.y;
  const extent = (b, ax, ay) => b.hx * Math.abs(b.ca * ax + b.sa * ay) + b.hy * Math.abs(-b.sa * ax + b.ca * ay);
  let best = Infinity,
    nx = 0,
    ny = 0,
    owner = null;
  for (const b of [A, B]) {
    for (const [ax, ay] of [
      [b.ca, b.sa],
      [-b.sa, b.ca],
    ]) {
      const d = dx * ax + dy * ay;
      const o = extent(A, ax, ay) + extent(B, ax, ay) - Math.abs(d);
      if (o <= 0) return null;
      if (o < best) [best, nx, ny, owner] = [o, d < 0 ? -ax : ax, d < 0 ? -ay : ay, b];
    }
  }
  return { depth: best, nx, ny, owner };
}

// contact point: the average of the corners of each piece that ended up inside the other (with the cars aligned,
// nose to tail, it lands in the middle of the touching area). If none ended up inside (two edges cross), the corner
// of the other piece that goes deepest into the axis owner.
function contact(A, B, { nx, ny, owner }) {
  const ca = corners(A),
    cb = corners(B);
  let touching = [...cb.filter((p) => inside(A, p)), ...ca.filter((p) => inside(B, p))];
  if (!touching.length) {
    const pts = owner === A ? cb : ca;
    const sign = owner === A ? 1 : -1; // B's corners go in toward -n; A's, toward +n
    touching = [pts.reduce((m, p) => (sign * (p[0] * nx + p[1] * ny) < sign * (m[0] * nx + m[1] * ny) ? p : m))];
  }
  return [0, 1].map((c) => touching.reduce((sum, p) => sum + p[c], 0) / touching.length);
}

const PIECE_REACH = Math.max(...PIECES.map((p) => Math.hypot(p.hx, p.hy)));

// Between cars: of all the touching pieces, the deepest one; the cars are separated and the impulse is applied
// there (twice, in case two other pieces are still overlapping afterward)
export function collideCars(cars, track, isSolid) {
  const M = track.meters;
  for (let i = 0; i < cars.length; i++) {
    for (let j = i + 1; j < cars.length; j++) {
      const a = cars[i],
        b = cars[j];
      const dx = (b.x - a.x) * M,
        dy = (b.y - a.y) * M;
      if (dx * dx + dy * dy > 4 * (HALF_L * HALF_L + HALF_W * HALF_W)) continue;
      for (let pass = 0; pass < 2; pass++) {
        const boxesA = PIECES.map((p) => box(a, p, M)),
          boxesB = PIECES.map((p) => box(b, p, M));
        let worst = null;
        for (const A of boxesA) {
          for (const B of boxesB) {
            if (Math.hypot(B.x - A.x, B.y - A.y) > 2 * PIECE_REACH) continue;
            const o = overlap(A, B);
            if (o && (!worst || o.depth > worst.o.depth)) worst = { A, B, o };
          }
        }
        if (!worst) break;
        const { A, B, o } = worst,
          { nx, ny } = o;
        const cp = contact(A, B, o);
        // they are separated (each by half, or all by the one that can move if the other is against the wall)
        const sep = o.depth / M;
        const aFree = !isSolid(track, a.x - nx * sep, a.y - ny * sep),
          bFree = !isSolid(track, b.x + nx * sep, b.y + ny * sep);
        const ka = aFree ? (bFree ? 0.5 : 1) : 0,
          kb = bFree ? (aFree ? 0.5 : 1) : 0;
        a.x -= nx * sep * ka;
        a.y -= ny * sep * ka;
        b.x += nx * sep * kb;
        b.y += ny * sep * kb;
        const rA = [cp[0] - a.x * M, cp[1] - a.y * M],
          rB = [cp[0] - b.x * M, cp[1] - b.y * M];
        const za = A.piece.zone,
          zb = B.piece.zone,
          tyres = za.part === 'wheel' && zb.part === 'wheel';
        const hit = tyres
          ? impulse(a, b, rA, rB, nx, ny, CAR_BOUNCE, TYRE_FRICTION, TYRE_SURFACE)
          : impulse(a, b, rA, rB, nx, ny, CAR_BOUNCE, CAR_FRICTION);
        if (hit <= 0) continue;
        const k = Math.min(1, hit / 15);
        a.bump = Math.max(a.bump, k);
        b.bump = Math.max(b.bump, k);
        // a front wheel that hit a rear wheel from behind? It climbs
        const climbs = (car, mine, theirs, n) =>
          tyres &&
          mine.wheel < 2 &&
          theirs.wheel >= 2 &&
          hit > LAUNCH_HIT &&
          Math.cos(car.angle) * n[0] + Math.sin(car.angle) * n[1] > 0.7;
        const launched = climbs(a, za, zb, [nx, ny]) ? a : climbs(b, zb, za, [-nx, -ny]) ? b : null;
        hurt(a, rA, launched === a ? hit * LAUNCH_DAMAGE : hit, zb);
        hurt(b, rB, launched === b ? hit * LAUNCH_DAMAGE : hit, za);
        if (launched) {
          launched.speed *= LAUNCH_SPEED;
          const turn = (Math.random() < 0.5 ? -1 : 1) * LAUNCH_SPIN * (0.5 + 0.5 * Math.random());
          launched.omega = Math.max(-MAX_SPIN, Math.min(MAX_SPIN, launched.omega + turn));
          launched.bump = 1;
        }
      }
    }
  }
}
