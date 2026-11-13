// 3D model of the formula car, built in code from rounded pieces (sections joined together, tubes and wheels).
// Coordinates in meters, with the origin on the ground below the center of the car:
// x forward, y to the right, z up.
// Each piece is a series of sections (rings of points) joined by faces; each face's normal is computed
// when the model is built and points outward, so the renderer knows which faces are visible and how the sun lights
// them.

import { rgb } from './renderer.js';
import { carbonTexture } from './textures.js';
import {
  HALF_L,
  HALF_W,
  LIVERY_S,
  SIDE_L,
  SIDE_R,
  SIDEWALL_S,
  SIDEWALL_SIZE,
  TALL,
  TOP,
  TREAD_SIZE,
  RIM_S,
  RIM_SIZE,
  liveryTexture,
  plainDesign,
  rimTexture,
  sidewallTexture,
  treadTexture,
} from './livery.js';

const CARBON = rgb(34, 34, 38);
const COCKPIT = rgb(16, 16, 18);
const TYRE = rgb(26, 26, 28);
const SIDEWALL = rgb(52, 52, 56);
const RIM = rgb(118, 120, 128);
const RIM_FACE = rgb(90, 94, 102); // rim face (carries the texture with the spokes)
const BARREL = rgb(44, 45, 50); // the inside of the rim, on the inner side (in shadow)
const MIRROR = rgb(120, 140, 160);
const PADDING = rgb(32, 33, 38); // cockpit padding
const RAIN_LIGHT = rgb(255, 60, 60);
const VISOR = rgb(20, 22, 28);
const CARBON_S = 400; // carbon texels per meter (each weave cell, 2 cm)

export const WHEEL_R = 0.36; // wheel radius (m)
const HUB_IN = -0.05; // the tip of the suspension arms, inward from the tyre's side (m):
// negative, it sits inside the rim, where the upright goes
const WHEEL_SEGMENTS = 32; // sides of each wheel's polygon
const SHOULDER_R = 0.05; // tyre shoulder radius (m): the rounded edge between the tread and the sidewall
const SHOULDER_STEPS = 4; // rings used to round each shoulder
const TREAD_TILES = 4; // times the tread texture wraps around the wheel

// color '#rrggbb', multiplied by k (k < 1 darkens it)
function hex(s, k = 1) {
  const n = parseInt(s.slice(1), 16);
  return rgb((n >> 16) * k, ((n >> 8) & 255) * k, (n & 255) * k);
}

// rectangular section with rounded corners (radius r, n segments per corner), perpendicular to the x axis:
// centered at yc, with half width hw, between z0 and z1
function sec(x, yc, hw, z0, z1, r = 0, n = 3) {
  r = Math.min(r, hw, (z1 - z0) / 2);
  const corners = [
    [yc + hw - r, z0 + r, -Math.PI / 2],
    [yc + hw - r, z1 - r, 0],
    [yc - hw + r, z1 - r, Math.PI / 2],
    [yc - hw + r, z0 + r, Math.PI],
  ];
  const pts = [];
  for (const [cy, cz, a0] of corners) {
    for (let i = 0; i <= n; i++) {
      const a = a0 + (i / n) * (Math.PI / 2);
      pts.push([x, cy + r * Math.cos(a), cz + r * Math.sin(a)]);
    }
  }
  return pts;
}

// section perpendicular to the x axis shaped like a convex polygon (points [y, z]) with rounded corners:
// radii[i] is the radius of corner i (it shrinks if it doesn't fit the neighboring sides), n segments per corner
function rounded(x, poly, radii, n = 4) {
  const pts = [],
    k = poly.length;
  for (let i = 0; i < k; i++) {
    const p = poly[i],
      a = poly[(i + k - 1) % k],
      b = poly[(i + 1) % k];
    const la = Math.hypot(a[0] - p[0], a[1] - p[1]),
      lb = Math.hypot(b[0] - p[0], b[1] - p[1]);
    const ua = [(a[0] - p[0]) / la, (a[1] - p[1]) / la],
      ub = [(b[0] - p[0]) / lb, (b[1] - p[1]) / lb];
    const half = Math.acos(Math.max(-1, Math.min(1, ua[0] * ub[0] + ua[1] * ub[1]))) / 2;
    // the arc touches both sides at a distance t from the corner
    const r = Math.min(radii[i], 0.45 * Math.min(la, lb) * Math.tan(half)),
      t = r / Math.tan(half);
    const bis = [ua[0] + ub[0], ua[1] + ub[1]],
      lbis = Math.hypot(...bis);
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

// ellipse perpendicular to the x axis, with radii ry and rz, with n points
function ellipse(x, yc, ry, zc, rz, n = 12) {
  return [...Array(n).keys()].map((i) => {
    const a = (i / n) * Math.PI * 2;
    return [x, yc + ry * Math.cos(a), zc + rz * Math.sin(a)];
  });
}

const center = (ring) =>
  ring.reduce((c, p) => [c[0] + p[0] / ring.length, c[1] + p[1] / ring.length, c[2] + p[2] / ring.length], [0, 0, 0]);

// normal of a polygon (Newell's method), oriented to point away from the point ref
function normal(pts, ref) {
  let nx = 0,
    ny = 0,
    nz = 0,
    cx = 0,
    cy = 0,
    cz = 0;
  for (let a = 0; a < pts.length; a++) {
    const p = pts[a],
      q = pts[(a + 1) % pts.length];
    nx += (p[1] - q[1]) * (p[2] + q[2]);
    ny += (p[2] - q[2]) * (p[0] + q[0]);
    nz += (p[0] - q[0]) * (p[1] + q[1]);
    cx += p[0];
    cy += p[1];
    cz += p[2];
  }
  const k = pts.length;
  if (nx * (cx / k - ref[0]) + ny * (cy / k - ref[1]) + nz * (cz / k - ref[2]) < 0) {
    nx = -nx;
    ny = -ny;
    nz = -nz;
  }
  const len = Math.hypot(nx, ny, nz) || 1;
  return [nx / len, ny / len, nz / len];
}

// Piece that joins two or more sections (with the same number of points), closed with caps at the ends.
// side(i): color of side i (for the tyre bands)
function loft(rings, color, capColor = color, side = null) {
  const k = rings[0].length,
    m = rings.length;
  const verts = rings.flat();
  const centers = rings.map(center);
  const faces = [];
  const face = (idx, c, ref) =>
    faces.push({
      idx,
      color: c,
      n: normal(
        idx.map((i) => verts[i]),
        ref,
      ),
    });
  const all = [...Array(k).keys()];
  // the caps face outward from the piece: away from the neighboring section
  face(all, capColor, centers[1]);
  face(
    all.map((i) => (m - 1) * k + i),
    capColor,
    centers[m - 2],
  );
  for (let r = 0; r < m - 1; r++) {
    const a = centers[r],
      b = centers[r + 1];
    const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
    for (let i = 0; i < k; i++) {
      const j = (i + 1) % k;
      face([r * k + i, r * k + j, (r + 1) * k + j, (r + 1) * k + i], side ? side(i) : color, mid);
    }
  }
  return { verts, faces };
}

// tube through the points of path: square section (half side t) or, with sides > 4, round (radius t; with
// one radius per point, it narrows or widens along the way). flat < 1 squashes it in the "up" direction (oval section,
// like an airfoil)
function tube(path, t, color, sides = 4, flat = 1) {
  const rings = path.map((p, i) => {
    const a = path[Math.max(0, i - 1)],
      b = path[Math.min(path.length - 1, i + 1)];
    let dx = b[0] - a[0],
      dy = b[1] - a[1],
      dz = b[2] - a[2];
    const l = Math.hypot(dx, dy, dz) || 1;
    dx /= l;
    dy /= l;
    dz /= l;
    // two directions perpendicular to the tube: one horizontal and one "up"
    let ux = -dy,
      uy = dx,
      uz = 0;
    const lu = Math.hypot(ux, uy);
    if (lu < 1e-6) {
      ux = 1;
      uy = 0;
    } else {
      ux /= lu;
      uy /= lu;
    }
    const vx = dy * uz - dz * uy,
      vy = dz * ux - dx * uz,
      vz = dx * uy - dy * ux;
    const corners =
      sides > 4
        ? [...Array(sides).keys()].map((i) => [
            Math.cos((i / sides) * Math.PI * 2),
            Math.sin((i / sides) * Math.PI * 2),
          ])
        : [
            [1, 1],
            [-1, 1],
            [-1, -1],
            [1, -1],
          ];
    const r = Array.isArray(t) ? t[i] : t;
    return corners.map(([s, q]) => [
      p[0] + (ux * s + vx * q * flat) * r,
      p[1] + (uy * s + vy * q * flat) * r,
      p[2] + (uz * s + vz * q * flat) * r,
    ]);
  });
  return loft(rings, color);
}

// thin plate (the helmet's wing): from a section at x0 to another at x1, each with its bottom height and thickness
const plate = (x0, z0, x1, z1, hw, t, color, yc = 0) =>
  loft([sec(x0, yc, hw, z0, z0 + t), sec(x1, yc, hw, z1, z1 + t)], color);

// Wing airfoil (section in the x-z plane, at height y): from the leading edge `le` ([x, z], front) to the trailing
// edge `te`, with maximum thickness t (m) near the front and cambered downward, like the inverted wings of an F1 car
// that push the car into the ground. n points per face, closer together at the edges.
function airfoil(y, le, te, t, camber = 0.05, n = 6) {
  const c = Math.hypot(te[0] - le[0], te[1] - le[1]);
  const ux = (te[0] - le[0]) / c,
    uz = (te[1] - le[1]) / c;
  const nx = uz * Math.sign(-ux),
    nz = -ux * Math.sign(-ux); // perpendicular to the chord, upward
  // half thickness of a 4-digit NACA airfoil (maximum 0.5 at 30 % of the chord), with a closed trailing edge
  const half = (u) =>
    (t / 0.2) * (0.2969 * Math.sqrt(u) - 0.126 * u - 0.3516 * u * u + 0.2843 * u ** 3 - 0.1036 * u ** 4);
  const at = (u, side) => {
    const off = -camber * c * 4 * u * (1 - u) + side * half(u);
    return [le[0] + ux * c * u + nx * off, y, le[1] + uz * c * u + nz * off];
  };
  const us = [...Array(n + 1).keys()].map((i) => (1 - Math.cos((Math.PI * i) / n)) / 2);
  return [
    ...us.map((u) => at(u, 1)),
    ...us
      .slice(1, -1)
      .reverse()
      .map((u) => at(u, -1)),
  ];
}

// Wing from tip to tip (y from -hw to hw): wing(y) gives { le, te, t } at each station, so it can change across the
// span
function wing(hw, at, color, stations = 7) {
  return loft(
    [...Array(stations).keys()].map((i) => {
      const y = -hw + (2 * hw * i) / (stations - 1),
        { le, te, t } = at(y);
      return airfoil(y, le, te, t);
    }),
    color,
  );
}

// clips a polygon [x, z] to the band za <= z <= zb
function band(pts, za, zb) {
  const cut = (poly, inside, z) =>
    poly.flatMap((p, i) => {
      const q = poly[(i + 1) % poly.length],
        a = inside(p[1]),
        b = inside(q[1]);
      const cross = a !== b ? [[p[0] + ((z - p[1]) / (q[1] - p[1])) * (q[0] - p[0]), z]] : [];
      return a ? [p, ...cross] : cross;
    });
  return cut(
    cut(pts, (z) => z >= za, za),
    (z) => z <= zb,
    zb,
  );
}

// wing endplate: in profile, a convex polygon with rounded corners (points [x, z]),
// of thickness t centered at y. bend ([z, dy] from bottom to top) bends it as seen from behind: shifts the plate dy
// outward (or inward, if negative) at each height; between two heights it is a flat slanted segment
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
    const [za, da] = bend[i],
      [zb, db] = bend[i + 1];
    const pts = band(outline, i ? za : -Infinity, i < bend.length - 2 ? zb : Infinity);
    if (pts.length > 2) parts.push(piece(pts, za, da, zb, db));
  }
  return parts;
}
const box = (x0, x1, yc, hw, z0, z1, color, r = 0) =>
  loft([sec(x0, yc, hw, z0, z1, r), sec(x1, yc, hw, z0, z1, r)], color);

// cylinder with its axis along y (wheels and rims)
function cylinder(x, z, r, y0, y1, n, color, capColor, side) {
  const ring = (y) =>
    [...Array(n).keys()].map((i) => {
      const t = (i / n) * Math.PI * 2;
      return [x + r * Math.cos(t), y, z + r * Math.sin(t)];
    });
  return loft([ring(y0), ring(y1)], color, capColor, side);
}

// Tyre: rings around the axis that follow the profile from one side to the other. The tread is flat and the shoulders
// are rounded in a quarter circle down to the sidewall (the caps, with the sidewall artwork).
// Each face of the tread and shoulders carries its coordinates in the tread texture: u around the wheel,
// v across, following the profile.
function tyre(x, y, width) {
  const hw = width / 2,
    rs = SHOULDER_R,
    n = WHEEL_SEGMENTS;
  // profile: [offset across, radius], from one sidewall to the other
  const profile = [];
  for (let i = SHOULDER_STEPS; i >= 0; i--) {
    const a = (i / SHOULDER_STEPS) * (Math.PI / 2);
    profile.push([-(hw - rs + rs * Math.sin(a)), WHEEL_R - rs + rs * Math.cos(a)]);
  }
  for (let i = 0; i <= SHOULDER_STEPS; i++) {
    const a = (i / SHOULDER_STEPS) * (Math.PI / 2);
    profile.push([hw - rs + rs * Math.sin(a), WHEEL_R - rs + rs * Math.cos(a)]);
  }
  const rings = profile.map(([dy, r]) =>
    [...Array(n).keys()].map((i) => {
      const t = (i / n) * Math.PI * 2;
      return [x + r * Math.cos(t), y + dy, WHEEL_R + r * Math.sin(t)];
    }),
  );
  const part = loft(rings, TYRE, SIDEWALL);
  // v: distance traveled along the profile, from 0 to 1
  const along = [0];
  for (let i = 1; i < profile.length; i++)
    along.push(along[i - 1] + Math.hypot(profile[i][0] - profile[i - 1][0], profile[i][1] - profile[i - 1][1]));
  const total = along[along.length - 1];
  // the first two faces are the caps; then come n for each segment of the profile
  part.faces.slice(2).forEach((f, k) => {
    const r = (k / n) | 0,
      i = k % n;
    const u0 = (i / n) * TREAD_TILES,
      u1 = ((i + 1) / n) * TREAD_TILES;
    const v0 = along[r] / total,
      v1 = along[r + 1] / total;
    Object.assign(f, {
      tread: true,
      uv: [
        [u0, v0],
        [u1, v0],
        [u1, v1],
        [u0, v1],
      ],
    });
  });
  return part;
}

// Solid of revolution around the wheel axis: section is the cross-section (a convex polygon of points
// [outward offset, radius]) rotated around the axis. Each face points away from the center of the cross-section.
function revolve(x, y, s, section, n, color) {
  const verts = [],
    faces = [],
    k = section.length;
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    for (const [dy, r] of section) verts.push([x + r * Math.cos(t), y + s * dy, WHEEL_R + r * Math.sin(t)]);
  }
  const [cy, cr] = center(section.map(([dy, r]) => [dy, r, 0]));
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n,
      t = ((i + 0.5) / n) * Math.PI * 2;
    const ref = [x + cr * Math.cos(t), y + s * cy, WHEEL_R + cr * Math.sin(t)];
    for (let a = 0; a < k; a++) {
      const b = (a + 1) % k;
      const idx = [i * k + a, i * k + b, j * k + b, j * k + a];
      faces.push({
        idx,
        color,
        n: normal(
          idx.map((v) => verts[v]),
          ref,
        ),
      });
    }
  }
  return { verts, faces };
}

// Rim, on the outer side: a metal lip that sticks out of the tyre, the face slightly recessed inside the lip
// (with the spokes drawn in the texture) and the center nut, in the team's detail color.
function rim(x, out, s, nut) {
  const lip = revolve(
    x,
    out,
    s,
    [
      [0, 0.226],
      [0, 0.25],
      [0.012, 0.25],
      [0.02, 0.243],
      [0.02, 0.233],
      [0.012, 0.226],
    ],
    32,
    RIM,
  );
  const face = cylinder(x, WHEEL_R, 0.229, out, out + s * 0.008, 32, RIM, RIM_FACE);
  const hub = cylinder(x, WHEEL_R, 0.042, out, out + s * 0.03, 6, nut, nut);
  return [lip, face, hub];
}

// Inner side of the wheel: the inside of the rim, in shadow, and in the middle the (flat) carbon drum
// that covers the brake, with the duct that brings it fresh air (front, at axle height; rear,
// smaller and lower). The drum and the duct are mounted on the upright: they steer with the wheel but don't spin
// (fixed).
function inner(x, inn, s, front) {
  const barrel = cylinder(x, WHEEL_R, 0.229, inn, inn - s * 0.004, 32, BARREL, BARREL);
  const ring = (r, dy) =>
    [...Array(24).keys()].map((i) => {
      const t = (i / 24) * Math.PI * 2;
      return [x + r * Math.cos(t), inn - s * dy, WHEEL_R + r * Math.sin(t)];
    });
  const drum = loft([ring(0.165, -0.01), ring(0.165, 0.025), ring(0.155, 0.04), ring(0.12, 0.05)], CARBON);
  // the duct: an oval pipe coming out of the front of the drum and facing forward, with a dark mouth
  const [dx, dz, ry, rz] = front ? [0.21, 0.0, 0.018, 0.04] : [0.19, -0.08, 0.015, 0.03];
  const duct = loft(
    [
      ellipse(x + 0.08, inn - s * 0.025, ry * 0.9, WHEEL_R + dz, rz * 0.9),
      ellipse(x + dx - 0.015, inn - s * 0.025, ry, WHEEL_R + dz, rz),
      ellipse(x + dx, inn - s * 0.025, ry * 1.1, WHEEL_R + dz + 0.003, rz * 1.08),
    ],
    CARBON,
    COCKPIT,
  );
  for (const p of [drum, duct]) p.fixed = true;
  return [barrel, drum, duct];
}

// wheel: tyre and rim, on both sides. Stores its center to spin it and, for the front ones, where the axis
// they steer around is (pivot: offset in y from the center to the tip of the suspension arms, so
// the arms stay attached to the drum when the wheel steers)
function wheel(x, s, yc, width, front, nut) {
  const y = s * yc,
    out = s * (yc + width / 2),
    inn = s * (yc - width / 2);
  const info = { x, y, z: WHEEL_R, front, pivot: -s * (width / 2 + HUB_IN) };
  const parts = [tyre(x, y, width), ...rim(x, out, s, nut), ...inner(x, inn, s, front)];
  for (const p of parts) p.wheel = info;
  return parts;
}

// Helmet: horizontal slices stacked from top to bottom, with the dark visor wrapping around the front and a
// small wing on top, at the back. Everything turns together around the neck (head: the pivot) so the driver looks
// where he is going. It is hidden in the cockpit view, because the camera is there.
// the driver sits very low: the top of the helmet barely shows above the halo that protects him
const HELMET = { x: -0.08, z: 0.69, rx: 0.15, ry: 0.12, rz: 0.13 };
// A real helmet is not a ball: at the bottom it doesn't close (it narrows less than at the top and ends in a flat
// base, where the neck goes in) and at the front, below the visor, the chin guard drops almost straight, following
// the same surface (no step), instead of curving inward like the back of the head.
// Point on the surface at height w (from -1 at the bottom to 1 at the top), at angle phi around the vertical axis
// (0 = front); out > 1 pushes it slightly outward (for the visor).
function helmetAt(phi, w, out = 1) {
  const { x: hx, z: hz, rx, ry, rz } = HELMET;
  const chin = Math.max(0, Math.cos(phi)) ** 2; // 1 at the front, 0 at the sides and back
  const k = Math.sqrt(Math.max(0, 1 - (w < 0 ? (w / (1.25 + 0.9 * chin)) ** 2 : w * w))) * out;
  return [hx + rx * k * Math.cos(phi), ry * k * Math.sin(phi), hz + rz * w];
}
// Steering wheel: built facing forward (the face looks toward -x, at the driver) and tilted on its column, which
// drops forward by STEERING.tilt rad. All its pieces carry `column` (the pivot and the axis), so the renderer turns
// them with the steering. The display (slot 6) shows the gear and the shift lights: cockpit.js draws it every frame.
export const STEERING = { x: 0.3, z: 0.6, tilt: 0.35, turn: 1 }; // turn: rad it turns with the wheel at full lock
const SCREEN_TEX = { size: 1, screen: true }; // the game supplies the texture (m.screen)
const GRIP = rgb(20, 20, 22),
  BUTTONS = ['#e23b3b', '#2c9be0', '#f2c230', '#41c46a'];
// suit: color of the race suit (the forearms); glove: the gloves' color
function steeringParts(suit, glove) {
  const { x: px, z: pz, tilt } = STEERING,
    c = Math.cos(tilt),
    s = Math.sin(tilt);
  // the axis points from the steering wheel toward the driver: so, turning right (+ turn), the top goes right
  const column = { x: px, y: 0, z: pz, ax: -c, ay: 0, az: s };
  // from the piece built facing forward (x forward, z up) to its place, tilted on the column
  const place = (part) => {
    const tr = ([x, y, z]) => [px + x * c + z * s, y, pz - x * s + z * c];
    const rot = ([x, y, z]) => [x * c + z * s, y, -x * s + z * c];
    part.verts = part.verts.map(tr);
    for (const f of part.faces) f.n = rot(f.n);
    return { ...part, column };
  };
  const parts = [
    // carbon body, narrower at the bottom, and the rubber grips at the sides
    loft([sec(-0.015, 0, 0.1, -0.05, 0.045, 0.02), sec(0.015, 0, 0.095, -0.045, 0.04, 0.02)], CARBON),
    // (round and thin, slightly curved outward at the bottom, like the real ones): stacked horizontal rings
    ...[-1, 1].map((k) =>
      loft(
        [
          [0.035, 0.118, 0.012],
          [0.0, 0.126, 0.017],
          [-0.04, 0.126, 0.017],
          [-0.075, 0.12, 0.012],
        ].map(([z, y, r]) =>
          [...Array(10).keys()].map((i) => {
            const t = (i / 10) * Math.PI * 2;
            return [r * Math.cos(t), k * y + r * Math.sin(t), z];
          }),
        ),
        GRIP,
      ),
    ),
    // shift paddles, behind the grips (side: 0 the left one, downshift; 1 the right one, upshift): the driver
    // pulls them when shifting (pull: how much the piece moves with that pull)
    ...[-1, 1].map((k) => ({
      ...box(0.024, 0.03, k * 0.1, 0.035, -0.02, 0.035, CARBON, 0.005),
      side: (k + 1) / 2,
      pull: 1,
    })),
    // colored buttons at the sides of the display
    ...BUTTONS.map((b, i) =>
      box(
        -0.019,
        -0.015,
        (i % 2 ? 1 : -1) * 0.075,
        0.009,
        i < 2 ? 0.0 : -0.03,
        (i < 2 ? 0.0 : -0.03) + 0.018,
        hex(b),
        0.004,
      ),
    ),
  ];
  // the display: a dark plate on the face; its front cap (the one facing the driver) carries the texture
  const screen = box(-0.019, -0.015, 0, 0.05, -0.022, 0.034, COCKPIT, 0.004);
  const face = screen.faces[0];
  face.tex = SCREEN_TEX;
  face.slot = 6;
  face.uv = face.idx.map((i) => {
    const [, y, z] = screen.verts[i];
    return [(y + 0.05) / 0.1, (0.034 - z) / 0.056];
  });
  parts.push(screen);
  // the driver's hands, holding the grips: they turn with the steering wheel, so you can see how much each one steers.
  // Matte, like fabric. The back of the hand is an oval resting on the outer side of the grip; the four fingers wrap
  // around it in front (from the index, on top, to the shorter little finger) and the thumb rests on the face of the
  // wheel, next to the buttons. Then the glove cuff, with a strip in the suit color, which continues into the forearm.
  // The index and middle fingers reach behind the paddle and pull it along when shifting; the rest
  // of the hand follows a little (pull)
  const GY = 0.126; // center of the grip, on each side
  const blob = (cx, cy, cz, rx, ry, rz) =>
    loft(
      [...Array(9).keys()].map((i) => {
        const w = -0.94 + (1.88 * i) / 8,
          r = Math.sqrt(1 - w * w);
        return [...Array(14).keys()].map((j) => {
          const a = (j / 14) * Math.PI * 2;
          return [cx + rx * r * Math.cos(a), cy + ry * r * Math.sin(a), cz + rz * w];
        });
      }),
      glove,
    );
  // arc around the grip at height z, from one angle to another (0: forward; +: outward)
  const around = (k, z, r, a0, a1) =>
    [...Array(5).keys()].map((i) => {
      const a = a0 + ((a1 - a0) * i) / 4;
      return [r * Math.cos(a), k * (GY + r * Math.sin(a)), z];
    });
  for (const k of [-1, 1]) {
    parts.push(
      ...[
        [blob(-0.012, k * 0.14, -0.016, 0.027, 0.023, 0.05), 0.4], // the back of the hand and the palm
        // index and middle fingers: wrap around the grip and rest behind the paddle
        ...[
          [0.016, 0.0105],
          [-0.004, 0.0105],
        ].map(([z, r]) => [
          tube([...around(k, z, 0.026, 2.1, 0.5), [0.037, k * 0.118, z], [0.038, k * 0.104, z]], r, glove, 6),
          1,
        ]),
        // ring and little fingers: wrap around the grip below the paddle
        ...[
          [-0.028, 0.01, -1.25],
          [-0.049, 0.009, -1.05],
        ].map(([z, r, end]) => [tube(around(k, z, 0.026, 2.1, end), r, glove, 6), 0.6]),
        // the thumb: wide at the base, tucked into the palm, tapers to the rounded tip, resting on the face
        [
          tube(
            [
              [-0.018, k * 0.13, -0.02],
              [-0.023, k * 0.12, -0.008],
              [-0.025, k * 0.112, 0.002],
              [-0.025, k * 0.106, 0.01],
              [-0.024, k * 0.103, 0.0145],
              [-0.023, k * 0.102, 0.017],
            ],
            [0.0125, 0.0105, 0.0088, 0.0078, 0.0058, 0.0028],
            glove,
            10,
          ),
          0.4,
        ],
        [
          tube(
            [
              [-0.03, k * 0.142, -0.042],
              [-0.07, k * 0.15, -0.07],
            ],
            0.029,
            glove,
            8,
          ),
          0.2,
        ], // the glove cuff
        [
          tube(
            [
              [-0.036, k * 0.143, -0.046],
              [-0.047, k * 0.145, -0.053],
            ],
            0.0305,
            suit,
            8,
          ),
          0.2,
        ], // the cuff strip
      ].map(([p, pull]) => ({ ...p, suit: true, side: (k + 1) / 2, pull })),
    );
  }
  const placed = parts.map(place);
  // the arms: the forearm goes from the wrist (which turns fully with the steering wheel) to the elbow (which stays
  // still, at the side of the body); in between it turns gradually (follow: how much each vertex follows the wheel), so
  // it bends instead of leaving the cockpit. The upper arm, shoulder to elbow, doesn't move (and isn't seen from the
  // cockpit, like the shoulders)
  for (const k of [-1, 1]) {
    const [wx, wy, wz] = [-0.065, k * 0.15, -0.068],
      wrist = [px + wx * c + wz * s, wy, pz - wx * s + wz * c];
    const elbow = [0.0, k * 0.235, 0.47],
      n = 6;
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
  // the last slice, a bit smaller, rounds the edge of the base
  const rings = [...HELMET_LEVELS.map((w) => ring(w, 1)), ring(-0.79, 0.9)];
  const shell = loft(rings, color);
  // visor: a band that follows the helmet surface from -78° to 78° around the front, just outside it.
  // It is mirrored, like the glass of the rear-view mirrors (see skin)
  const at = (phi, z, out) => helmetAt(phi, (z - hz) / rz, out);
  const visor = [];
  for (let i = 0; i <= 12; i++) {
    const phi = (-78 + i * 13) * (Math.PI / 180);
    // a bit taller in the center, like the opening of real helmets
    const z0 = hz - 0.028 - 0.006 * Math.cos(phi),
      z1 = hz + 0.052 + 0.01 * Math.cos(phi * 1.3);
    // with a point in the middle of the outer face, which follows the helmet's curve (otherwise the helmet pokes
    // through it)
    visor.push([
      at(phi, z0, 0.97),
      at(phi, z0, 1.04),
      at(phi, (z0 + z1) / 2, 1.04),
      at(phi, z1, 1.04),
      at(phi, z1, 0.97),
    ]);
  }
  // wing: a small plate on the back, slightly tilted
  const spoiler = plate(-0.17, hz + 0.12, -0.225, hz + 0.105, 0.065, 0.012, color);
  const pivot = { x: hx, y: 0, z: hz - rz }; // the neck: it turns and tilts there
  return [shell, loft(visor, VISOR), spoiler].map((p) => ({ ...p, tag: 'helmet', head: pivot }));
}

// Textures: each face is projected onto the plane it faces most (from above, from the side or from the front)
// and that gives its texture coordinates (u, v, in texels), one per vertex.
// Faces in the bodywork color carry the livery; carbon ones, the weave; the tyre sidewalls,
// their artwork (centered on the wheel, so it spins with it); the tread and shoulders, the worn rubber (their
// coordinates come from tyre()). The rest stays a single color.
// The rim face carries its spokes, centered on the wheel like the sidewall.
// slot: which texture it is, for the WebGL renderer (1 livery, 2 carbon, 3 sidewall, 4 tread, 5 rim)
let carbon = null,
  sidewall = null,
  tread = null,
  rimTex = null;

function skin(parts, body, livery, sharp = 1) {
  carbon ??= carbonTexture();
  sidewall ??= sidewallTexture();
  tread ??= treadTexture();
  rimTex ??= rimTexture();
  for (const part of parts) {
    for (const f of part.faces) {
      const pts = f.idx.map((i) => part.verts[i]);
      const ax = Math.abs(f.n[0]),
        ay = Math.abs(f.n[1]),
        az = Math.abs(f.n[2]);
      const top = az >= ax && az >= ay,
        side = !top && ay >= ax;
      let uv = null;
      if (f.color === body) {
        // whatever faces down (the undersides of the sidepods, seen from the side) follows the side artwork,
        // not the top one
        if (top && f.n[2] > 0)
          uv = pts.map(([x, y]) => [(x + HALF_L) * LIVERY_S * sharp, (TOP + (y + HALF_W) * LIVERY_S) * sharp]);
        else if (side || top) {
          const row = (f.n[1] || center(pts)[1]) > 0 ? SIDE_R : SIDE_L;
          uv = pts.map(([x, , z]) => [(x + HALF_L) * LIVERY_S * sharp, (row + (TALL - z) * LIVERY_S) * sharp]);
        }
        if (uv) Object.assign(f, { tex: livery, slot: 1, dens: LIVERY_S * sharp });
      } else if (f.color === CARBON) {
        uv = pts.map(([x, y, z]) => (top ? [x, y] : side ? [x, z] : [y, z]).map((c) => c * CARBON_S));
        Object.assign(f, { tex: carbon, slot: 2, dens: CARBON_S });
      } else if (f.color === SIDEWALL && part.wheel && side) {
        const { x: wx, z: wz } = part.wheel,
          m = SIDEWALL_SIZE / 2;
        uv = pts.map(([x, , z]) => [m + (x - wx) * SIDEWALL_S, m - (z - wz) * SIDEWALL_S]);
        Object.assign(f, { tex: sidewall, slot: 3, dens: SIDEWALL_S });
      } else if (f.color === RIM_FACE && part.wheel && side) {
        const { x: wx, z: wz } = part.wheel,
          m = RIM_SIZE / 2;
        uv = pts.map(([x, , z]) => [m + (x - wx) * RIM_S, m - (z - wz) * RIM_S]);
        Object.assign(f, { tex: rimTex, slot: 5, dens: RIM_S });
      } else if (f.tread) {
        uv = f.uv.map(([u, v]) => [u * TREAD_SIZE, v * TREAD_SIZE]);
        Object.assign(f, { tex: tread, slot: 4, dens: TREAD_SIZE * 2.5 });
      }
      if (uv) f.uv = uv;
      // how much it shines and reflects: paint and helmet with clear coat, carbon a little, tyres, cockpit and suit
      // none (the mirror glass, 2: also reflects head-on, like a mirror; the visor, 3: the same, but a blurry
      // reflection, with no sharp horizon)
      f.gloss =
        f.color === MIRROR
          ? 2
          : f.color === VISOR
            ? 3
            : f.color === body || part.head
              ? 1
              : f.color === CARBON
                ? 0.35
                : part.suit || [TYRE, SIDEWALL, COCKPIT].includes(f.color)
                  ? 0
                  : 0.6;
    }
  }
  return parts;
}

// Builds the car with the bodywork color, the helmet color and the livery detail color (as '#rrggbb')
// and its number.
// Returns a list of pieces { verts: [[x,y,z]...], faces: [{ idx, color, n, gloss, tex?, uv?, dens? }], wheel?, head?,
// tag? }. roof camera (the "T"): as in F1, black on each team's first car and yellow on the second
export const TCAM = ['#161616', '#f2e600'];

// sharp: higher-resolution livery (for the player's own car, which is seen very close up from the cockpit); design:
// the team's paint and sponsors (teamliveries.js; otherwise, a band in the accent color)
export function carModel(
  color = '#d8261c',
  helmet = '#ffd400',
  number = '16',
  accent = '#f4f4f4',
  tcam = TCAM[0],
  { sharp = 1, design = null } = {},
) {
  const body = hex(color),
    head = hex(helmet);
  const parts = [];
  const add = (...p) => parts.push(...p);
  const both = (fn) => {
    fn(1);
    fn(-1);
  };

  // floor and diffuser. Seen from above the floor is not a rectangle: it starts narrow behind the front wheels with
  // a rounded edge, opens up to its maximum width beside the sidepods and, before the rear wheels, it
  // curves inward to make room for them; at the back comes the diffuser, between the two wheels
  // (each station: x and half width)
  // (at the front it starts flush with the sides of the nose and opens in a concave curve, faster and faster, up to
  // its usual width; the fins go further out, on their own base)
  const FLOOR = [
    [1.42, 0.15],
    [1.32, 0.18],
    [1.22, 0.23],
    [1.13, 0.3],
    [1.05, 0.4],
    [0.98, 0.52],
    [0.92, 0.63],
    [0.85, 0.71],
    [0.72, 0.76],
    [0.45, 0.8],
    [-0.4, 0.8],
    [-0.8, 0.77],
    [-1.05, 0.69],
    [-1.25, 0.57],
    [-1.45, 0.5],
    [-1.95, 0.48],
  ];
  add(
    loft(
      FLOOR.map(([x, hw]) => sec(x, 0, hw, 0.03, 0.08, 0.025)),
      CARBON,
    ),
  );
  // fins behind the front wheels, which tidy up the dirty air coming off the wheel and send it around the outside
  // of the sidepods. Seen from above they run diagonally: the big one starts almost at the outer edge of the wheel and
  // closes in a bit toward the back, outside the floor, standing on its own base (a narrow plate, separate from the
  // floor); the two small ones, lower and more closed, stand on the floor.
  // fin(s, front [x, y], back [x, y], profile [u, z] with u from 0 (front) to 1 (back), radii)
  const fin = (s, [xa, ya], [xb, yb], profile, radii, t = 0.012) => {
    const len = Math.hypot(xb - xa, yb - ya),
      nx = -(yb - ya) / len,
      ny = (xb - xa) / len;
    const side = (o) =>
      rounded(
        0,
        profile.map(([u, z]) => [u * len, z]),
        radii,
        3,
      ).map(([, u, z]) => [xa + (xb - xa) * (u / len) + nx * o, s * (ya + (yb - ya) * (u / len) + ny * o), z]);
    return loft([side(-t / 2), side(t / 2)], CARBON);
  };
  // base of a fin: a narrow plate (half width w) along the fin, with rounded ends
  const foot = (s, [xa, ya], [xb, yb], w) => {
    const len = Math.hypot(xb - xa, yb - ya),
      ux = (xb - xa) / len,
      uy = (yb - ya) / len;
    const ring = (u) => {
      const k = Math.min(1, Math.sqrt(Math.max(0, 1 - ((2 * u) / len - 1) ** 8))) * w; // narrows at the ends
      const cx = xa + ux * u,
        cy = ya + uy * u;
      return [
        [-1, 0.03],
        [1, 0.03],
        [1, 0.045],
        [-1, 0.045],
      ].map(([o, z]) => [cx - uy * o * k, s * (cy + ux * o * k), z]);
    };
    return loft(
      [...Array(9).keys()].map((i) => ring((i / 8) * len)),
      CARBON,
    );
  };
  both((s) => {
    add(foot(s, [1.07, 0.935], [0.69, 0.88], 0.04));
    // the base joins the floor: at the back, a plate that opens from the edge of the floor to the fin, and at the front
    // a thin sheet that crosses the gap. The back plate is not a block: seen from above it starts as a point next to
    // the base and opens backward in a curve until it merges into the floor, and from the side its top ramps down from
    // the floor height to the base height, so it reads as one piece with both.
    // (each slice: x, inner edge, already inside the floor, and outer edge, on the fin's base)
    add(
      loft(
        [
          [0.9, 0.86, 0.9],
          [0.86, 0.8, 0.905],
          [0.82, 0.75, 0.9],
          [0.77, 0.72, 0.895],
          [0.71, 0.71, 0.885],
          [0.68, 0.72, 0.88],
        ].map(([x, yin, yout]) =>
          rounded(
            x,
            [
              [yin, 0.03],
              [yout, 0.03],
              [yout, 0.045],
              [yin, 0.08],
            ].map(([y, z]) => [s * y, z]),
            [0.003, 0.006, 0.006, 0.003],
          ),
        ),
        CARBON,
      ),
    );
    add(loft([sec(0.98, s * 0.73, 0.2, 0.035, 0.048, 0.006), sec(0.93, s * 0.76, 0.17, 0.035, 0.048, 0.006)], CARBON));
    add(
      fin(
        s,
        [1.05, 0.935],
        [0.71, 0.88],
        [
          [0, 0.06],
          [1, 0.06],
          [1, 0.3],
          [0.8, 0.38],
          [0.08, 0.46],
          [0, 0.4],
        ],
        [0.01, 0.02, 0.04, 0.12, 0.04, 0.02],
        0.014,
      ),
    );
    add(
      fin(
        s,
        [0.87, 0.66],
        [0.66, 0.6],
        [
          [0, 0.06],
          [1, 0.06],
          [1, 0.2],
          [0.1, 0.27],
          [0, 0.22],
        ],
        [0.01, 0.01, 0.03, 0.03, 0.02],
      ),
    );
    add(
      fin(
        s,
        [0.94, 0.56],
        [0.74, 0.5],
        [
          [0, 0.06],
          [1, 0.06],
          [1, 0.17],
          [0.1, 0.22],
          [0, 0.18],
        ],
        [0.01, 0.01, 0.03, 0.03, 0.02],
      ),
    );
  });
  add(loft([sec(-1.95, 0, 0.48, 0.03, 0.1, 0.03), sec(-2.55, 0, 0.46, 0.1, 0.35, 0.05)], CARBON));

  // monocoque and nose: a single piece that narrows and drops toward the front. Where the driver sits it is low: the
  // cockpit is a gap between two walls (below), with the dashboard in front, so the steering wheel sits inside
  add(
    loft(
      [
        sec(-0.45, 0, 0.42, 0.1, 0.5, 0.1),
        sec(0.42, 0, 0.37, 0.12, 0.5, 0.1),
        sec(0.5, 0, 0.36, 0.12, 0.64, 0.13),
        // in profile the spine is a single smooth convex curve, from the cockpit to the tip: almost flat at the back
        // and dropping gradually faster toward the front (no break at the wheels and no straight section)
        sec(1.15, 0, 0.26, 0.16, 0.635, 0.11),
        sec(1.45, 0, 0.23, 0.16, 0.606, 0.1),
        sec(1.7, 0, 0.2, 0.16, 0.557, 0.09),
        sec(1.95, 0, 0.17, 0.15, 0.493, 0.08),
        sec(2.1, 0, 0.16, 0.145, 0.448, 0.075),
        sec(2.4, 0, 0.135, 0.13, 0.345, 0.06),
        sec(2.62, 0, 0.12, 0.12, 0.259, 0.05),
        // the tip: wide to the end, like a snout, and rounded up to the leading edge of the wing
        sec(2.74, 0, 0.11, 0.112, 0.209, 0.045),
        sec(2.82, 0, 0.097, 0.108, 0.174, 0.035),
        sec(2.87, 0, 0.078, 0.108, 0.151, 0.022),
        sec(2.9, 0, 0.045, 0.112, 0.138, 0.012),
      ],
      body,
    ),
  );
  // the cockpit walls and, inside, the floor and dashboard, dark. On the outside, the side of the cockpit is the
  // roof of the sidepods (which, alongside the cockpit, starts at the edge of the opening); the wall is only the inner
  // face, a thin sheet hidden by the sidepod
  const wall = (x, top, s) =>
    rounded(
      x,
      [
        [0.24, 0.45],
        [0.29, 0.45],
        [0.29, top - 0.02],
        [0.24, top],
      ].map(([y, z]) => [s * y, z]),
      [0.01, 0.01, 0.01, 0.01],
    );
  both((s) => add(loft([wall(-0.45, 0.7, s), wall(0.46, 0.645, s)], body)));
  add(box(-0.45, 0.46, 0, 0.245, 0.45, 0.52, COCKPIT, 0.02));
  add(loft([sec(0.4, 0, 0.245, 0.5, 0.6, 0.02), sec(0.47, 0, 0.245, 0.5, 0.645, 0.02)], COCKPIT));
  // sidepods at the sides: air intake in front, closing in toward the back until they die against the engine
  // cover (the "Coke bottle"). They are not loose tubes: the inner side sits inside the monocoque
  // and the roof is a ramp that drops from the chassis shoulder outward, so the bodywork flows continuously
  // to the edge of the sidepod. Alongside the cockpit the roof starts at the edge of the opening: it is the side
  // of the cockpit. Below, the side tucks inward (the undercut) and reveals the floor.
  // Each station: x, inner (in) and outer (out) edge, roof height inside and outside, floor and undercut.
  const POD = [
    // the mouth starts from the side of the chassis: its inner edge sits inside the monocoque
    { x: 0.58, in: 0.24, out: 0.63, top: 0.56, edge: 0.52, bot: 0.16, cut: 0.12 },
    { x: 0.46, in: 0.23, out: 0.66, top: 0.6, edge: 0.54, bot: 0.13, cut: 0.14 },
    { x: 0.3, in: 0.25, out: 0.67, top: 0.69, edge: 0.55, bot: 0.12, cut: 0.16 },
    // behind the cockpit they close in a convex curve (seen from above: they hold their width and close
    // faster and faster) and the roof drops toward the floor, so they reach the rear wheels thin and low
    { x: -0.3, in: 0.25, out: 0.65, top: 0.7, edge: 0.49, bot: 0.12, cut: 0.15 },
    { x: -0.75, in: 0.23, out: 0.6, top: 0.6, edge: 0.4, bot: 0.12, cut: 0.12 },
    { x: -1.15, in: 0.2, out: 0.52, top: 0.47, edge: 0.3, bot: 0.12, cut: 0.08 },
    { x: -1.5, in: 0.15, out: 0.42, top: 0.36, edge: 0.22, bot: 0.12, cut: 0.05 },
    { x: -1.8, in: 0.1, out: 0.31, top: 0.3, edge: 0.19, bot: 0.12, cut: 0.03 },
    // the tail sticks to the base of the engine cover: the roof starts at its shoulder height and tapers with it
    { x: -2.05, in: 0.05, out: 0.15, top: 0.29, edge: 0.21, bot: 0.13, cut: 0.01 },
    { x: -2.3, in: 0.03, out: 0.075, top: 0.27, edge: 0.23, bot: 0.15, cut: 0.005 },
  ];
  // height of the sidepod roof (without the roundings) at x, at distance y from the center, and how much it drops
  // outward
  const podRoof = (x, y) => {
    let i = POD.findIndex((st) => st.x <= x);
    if (i <= 0) i = i < 0 ? POD.length - 1 : 1;
    const a = POD[i - 1],
      b = POD[i],
      w = Math.min(1, Math.max(0, (a.x - x) / (a.x - b.x)));
    const lerp = (k) => a[k] + (b[k] - a[k]) * w;
    const slope = (lerp('top') - lerp('edge')) / (lerp('out') - lerp('in'));
    return { z: lerp('top') - (y - lerp('in')) * slope, slope };
  };
  // engine cover and air intake, in a single shape: each slice is a narrow tent. At the bottom it sits inside
  // the sidepods and the flank starts right where each sidepod's roof ends (the shoulder, almost unrounded),
  // so the bodywork rises continuously from the edge of the sidepod to the crest. Behind the head the crest is
  // the air intake; toward the back it drops gradually and thins into the fin, dying out before the wing. At the front,
  // the shoulders rise on each side of the head up to where the halo rests and from there they drop toward the back.
  // Each station: x, half width and bottom height, shoulder height (where the flank starts) and crest height.
  // With roof, the flank drops straight from the shoulder to the sidepod roof and there it bends at a right angle with
  // a small radius (FILLET), into a flange that follows the sidepod roof and sinks into it: the edge stays sharp
  // but the light passes gradually from one face to the other.
  const FILLET = 0.018;
  const tent = ({ x, bw, bz, sw, sz, tw, tz }, d = 0, roof = false) => {
    if (!roof) {
      return rounded(
        x,
        [
          [bw - d, bz + d],
          [sw - d, sz],
          [tw - d, tz - d],
          [-tw + d, tz - d],
          [-sw + d, sz],
          [-bw + d, bz + d],
        ],
        [0.03, 0.04, tw * 0.9, tw * 0.9, 0.04, 0.03],
      );
    }
    const { z, slope } = podRoof(x, sw),
      zj = z + 0.004,
      L = 0.06;
    const half = [
      [bw, bz],
      [sw + L, zj - L * (slope + 0.25)],
      [sw, zj],
      [sw, sz],
      [tw, tz],
    ];
    return rounded(
      x,
      [...half, ...half.map(([y, zz]) => [-y, zz]).reverse()],
      [0.03, 0.005, FILLET, 0.07, tw * 0.9, tw * 0.9, 0.07, FILLET, 0.005, 0.03],
      5,
    );
  };
  add(
    loft(
      [
        // the front, behind the headrest: the crest sits inside the intake, and the shoulders, where the halo rests
        { x: -0.42, bw: 0.4, bz: 0.1, sw: 0.32, sz: 0.775, tw: 0.065, tz: 0.8 },
        { x: -0.6, bw: 0.38, bz: 0.1, sw: 0.3, sz: 0.75, tw: 0.09, tz: 0.97 },
        { x: -0.95, bw: 0.3, bz: 0.1, sw: 0.25, sz: 0.62, tw: 0.08, tz: 0.95 },
        { x: -1.25, bw: 0.22, bz: 0.1, sw: 0.2, sz: 0.47, tw: 0.06, tz: 0.86 },
        { x: -1.55, bw: 0.17, bz: 0.11, sw: 0.155, sz: 0.36, tw: 0.04, tz: 0.74 },
        { x: -1.95, bw: 0.12, bz: 0.13, sw: 0.105, sz: 0.3, tw: 0.02, tz: 0.56 },
        { x: -2.3, bw: 0.07, bz: 0.18, sw: 0.06, sz: 0.28, tw: 0.012, tz: 0.41 },
      ].map((st) => tent(st, 0, true)),
      body,
    ),
  );
  // the intake mouth, above the driver's head: it is the tip of the crest, which stretches forward over
  // the headrest and ends in the same shape as the cover (it is not an added piece).
  // It is slanted like the sidepod ones, with a lip around it and a dark block inside
  const MOUTH_AT = { x: -0.3, bw: 0.085, bz: 0.69, sw: 0.105, sz: 0.8, tw: 0.075, tz: 0.955 };
  const tilt = (ring) => ring.map(([x, y, z]) => [x + (z - 0.8) * 0.25, y, z]);
  const LIP = 0.018;
  const scoop = loft(
    [
      tilt(tent({ ...MOUTH_AT, x: -0.32 }, LIP)),
      tilt(tent({ ...MOUTH_AT, x: -0.29 }, LIP / 3)),
      tilt(tent(MOUTH_AT)),
      tent({ x: -0.6, bw: 0.1, bz: 0.67, sw: 0.125, sz: 0.8, tw: 0.088, tz: 0.968 }),
    ],
    body,
  );
  // the front of the lip faces forward (loft would orient it away from the axis)
  for (const f of scoop.faces.slice(2, 2 + scoop.verts.length / 4)) if (f.n[0] < 0) f.n = f.n.map((c) => -c);
  add(scoop);
  add(loft([tent({ ...MOUTH_AT, x: -0.6 }, LIP), tilt(tent({ ...MOUTH_AT, x: -0.315 }, LIP))], COCKPIT));
  // T-shaped TV camera: a thin post and on top a crosswise bar, in the color that identifies the car
  add(box(-0.42, -0.34, 0, 0.025, 0.95, 1.07, hex(tcam), 0.01));
  add(box(-0.45, -0.31, 0, 0.17, 1.07, 1.11, hex(tcam), 0.018));
  // sidepods at the sides (their stations, POD, are further up: the engine cover rests on them)
  // sidepod section at a station, shrunk d meters inward (for the mouth)
  const podSec = (st, s, x = st.x, d = 0) =>
    rounded(
      x,
      [
        [st.in + d, st.bot + d],
        [st.out - st.cut - d / 2, st.bot + d],
        [st.out - d, st.bot + st.cut + d / 2],
        [st.out - d, st.edge - d],
        [st.in + d, st.top - d],
      ].map(([y, z]) => [s * y, z]),
      [0.02, 0.04, 0.06, 0.12, 0.03],
    );
  const POD_RING = 25; // points of each section (5 corners of 5 points)
  // the mouth is slanted: the top reaches further forward than the bottom, like the real ones
  const lean = (ring) => ring.map(([x, y, z]) => [x + (z - 0.35) * 0.35, y, z]);
  const MOUTH = 0.035; // width of the lip around the opening
  both((s) => {
    const [mouth, ...rest] = POD;
    const pod = loft(
      [
        lean(podSec(mouth, s, mouth.x - 0.02, MOUTH)),
        lean(podSec(mouth, s, mouth.x + 0.01, MOUTH / 3)),
        lean(podSec(mouth, s, mouth.x - 0.04)),
        ...rest.map((st) => podSec(st, s)),
      ],
      body,
      CARBON,
    );
    // the front of the lip faces forward and toward the mouth (loft would orient it away from the axis)
    for (const f of pod.faces.slice(2, 2 + POD_RING)) if (f.n[0] < 0) f.n = f.n.map((c) => -c);
    add(pod);
    // the opening: a dark block that covers the mouth from inside the lip
    add(loft([podSec(mouth, s, mouth.x - 0.35, MOUTH), lean(podSec(mouth, s, mouth.x - 0.015, MOUTH))], COCKPIT));
  });
  // mirrors on their mount: the glass faces backward, recessed in a frame, and the housing rounds off toward
  // the front like a shell
  both((s) => {
    const shell = (x, k) => sec(x, s * 0.54, 0.08 * k, 0.67 - 0.05 * k, 0.67 + 0.05 * k, 0.035 * k);
    const mirror = loft(
      [shell(0.43, 0.85), shell(0.42, 1), shell(0.46, 1), shell(0.5, 0.88), shell(0.53, 0.62), shell(0.545, 0.3)],
      body,
      MIRROR,
    );
    // the glass (the first cap) faces backward; the front tip is housing
    const [glass, tip] = mirror.faces;
    if (glass.n[0] > 0) glass.n = glass.n.map((c) => -c);
    // position on the glass, from -1 to 1 (the renderer uses it to curve the reflection, like a convex mirror)
    glass.uv = glass.idx.map((i) => [(mirror.verts[i][1] - s * 0.54) / 0.068, (mirror.verts[i][2] - 0.67) / 0.0425]);
    tip.color = body;
    add(mirror);
    add(
      tube(
        [
          [0.47, s * 0.46, 0.66],
          [0.5, s * 0.36, 0.6],
        ],
        0.012,
        CARBON,
        8,
      ),
    );
  });

  // driver: shoulders with the suit in the team color and the carbon HANS collar behind the neck
  add({ ...box(-0.34, -0.02, 0, 0.2, 0.46, 0.55, hex(color, 0.7), 0.07), tag: 'helmet', suit: true });
  add({ ...loft([sec(-0.3, 0, 0.15, 0.49, 0.59, 0.05), sec(-0.17, 0, 0.13, 0.51, 0.6, 0.05)], CARBON), tag: 'helmet' });
  add(...helmetParts(head));
  add(...steeringParts(hex(color, 0.7), hex(accent, 0.62)));
  // padded headrest around the helmet and a carbon rim around the cockpit opening
  add(loft([sec(-0.45, 0, 0.25, 0.6, 0.72, 0.05), sec(-0.3, 0, 0.25, 0.6, 0.72, 0.05)], PADDING));
  both((s) =>
    add(loft([sec(-0.42, s * 0.205, 0.045, 0.6, 0.715, 0.03), sec(-0.2, s * 0.205, 0.04, 0.6, 0.7, 0.03)], PADDING)),
  );
  const rim = [];
  for (let i = 0; i <= 40; i++) {
    const t = (i / 40) * Math.PI * 2; // an oval with rounded corners on the edge of the walls
    const cx = Math.cos(t),
      cy = Math.sin(t);
    const x = 0.45 * Math.sign(cx) * Math.abs(cx) ** 0.4;
    rim.push([x, 0.245 * Math.sign(cy) * Math.abs(cy) ** 0.4, 0.703 - (0.055 * (x + 0.45)) / 0.9]);
  }
  add(tube(rim, 0.012, CARBON, 6));
  // halo: an arch over the helmet resting on a central pillar at the front and, at the back, behind the head,
  // on the shoulders of the engine cover, barely dropping. In profile it rises gradually toward the front
  // (seen from above it is half an ellipse: in front at x = 0.4, level with the mirrors, and at the back at x = -0.4)
  const HALO_R = 0.024;
  const haloAt = (t) => [-0.4 + 0.8 * Math.cos(t), 0.29 * Math.sin(t), 0.78 + 0.08 * Math.max(0, Math.cos(t)) ** 0.8];
  const halo = [];
  for (let i = 0; i <= 40; i++) halo.push(haloAt(-Math.PI / 2 + (i / 40) * Math.PI));
  add(tube(halo, HALO_R, CARBON, 12));
  // the pillar is not vertical: it slants forward as it drops (PILLAR_LEAN meters forward for each meter
  // it drops) from the front of the arch until it plunges into the nose
  const PILLAR_R = 0.017,
    PILLAR_LEAN = 0.9,
    PILLAR_DROP = 0.32;
  const [px, , pz] = haloAt(0);
  const pillarX = (z) => px + PILLAR_LEAN * (pz - z); // x of the pillar axis at height z
  // (it starts a bit below the arch axis, so it doesn't stick out above)
  add(
    tube(
      [
        [pillarX(pz - 0.025), 0, pz - 0.025],
        [pillarX(pz - PILLAR_DROP), 0, pz - PILLAR_DROP],
      ],
      PILLAR_R,
      CARBON,
      10,
    ),
  );
  // pillar-to-arch joint: a sheet on both sides of the pillar, dropping from the arch with a
  // concave edge (a quarter ellipse) that starts tangent to the arch and ends tangent to the pillar, so the pillar
  // flares upward in a curve instead of forming a T. It follows the pillar's slant.
  const FILLET_W = 0.09,
    FILLET_DROP = 0.1;
  const fillet = [];
  for (let j = 0; j <= 24; j++) {
    const y = -FILLET_W + (j / 24) * 2 * FILLET_W;
    const [x, , z] = haloAt(Math.asin(y / 0.29));
    const g = Math.max(0, Math.abs(y) - PILLAR_R) / (FILLET_W - PILLAR_R); // 0 next to the pillar, 1 at the arch
    const drop = FILLET_DROP * (1 - Math.sqrt(1 - (1 - g) ** 2));
    // at the top it follows the arch axis (inside the tube) and at the bottom it shifts toward the pillar
    const bottom = pillarX(z - drop) * (1 - g) + x * g;
    fillet.push([
      [bottom - 0.02, y, z - drop],
      [bottom + 0.02, y, z - drop],
      [x + 0.02, y, z],
      [x - 0.02, y, z],
    ]);
  }
  add(loft(fillet, CARBON));

  // front wing: three elements with airfoil sections, close together (each flap starts just above and behind the
  // trailing edge of the previous one), reaching the inner side of the wheels. Seen from the front, in the middle
  // they are concave: they rise toward the nose, steeper and steeper; further out they are convex: they lift
  // rounded, like a shoulder, up to the endplate. curve(y, hump, rise): how much they rise across. Seen from above they
  // are swept: the center is further forward and the tips curve back (sweep: how much the leading edge recedes across
  // the span). The endplates drop toward the front with a rounded edge
  const FW = 0.63; // half width of the planes: the inner side of the front wheels
  const curve = (y, hump, rise) => {
    const u = Math.abs(y / FW);
    const t = Math.min(1, u / 0.45),
      o = Math.max(0, (u - 0.35) / 0.65);
    return hump * (1 - t) ** 2 + rise * (1 - (1 - o) ** 2);
  };
  const k = (y) => Math.abs(y / FW) ** 3;
  const sweep = (y) => 0.1 * (y / FW) ** 2 + 0.12 * (y / FW) ** 12;
  add(
    wing(
      FW,
      (y) => ({
        le: [2.9 - sweep(y), 0.065 + curve(y, 0.04, 0.025)],
        te: [2.45 - 0.03 * k(y), 0.08 + curve(y, 0.045, 0.03)],
        t: 0.03,
      }),
      CARBON,
      15,
    ),
  );
  add(
    wing(
      FW,
      (y) => ({
        le: [2.5 - 0.6 * sweep(y), 0.105 + curve(y, 0.045, 0.035)],
        te: [2.27 - 0.04 * k(y), 0.15 + curve(y, 0.05, 0.045)],
        t: 0.024,
      }),
      body,
      15,
    ),
  );
  add(
    wing(
      FW,
      (y) => ({
        le: [2.33 - 0.4 * sweep(y), 0.16 + curve(y, 0.05, 0.045)],
        te: [2.15 - 0.04 * k(y), 0.21 + curve(y, 0.055, 0.055)],
        t: 0.02,
      }),
      body,
      15,
    ),
  );
  both((s) =>
    add(
      endplate(
        s * (FW + 0.01),
        [
          [2.12, 0.04],
          [2.7, 0.04],
          [2.7, 0.1],
          [2.44, 0.3],
          [2.14, 0.32],
        ],
        [0.015, 0.03, 0.05, 0.12, 0.03],
        0.02,
        CARBON,
      ),
    ),
  );
  // and from each endplate two fins go outward, to the outer side of the tyre: below, on the floor,
  // an almost flat one that barely rises and sweeps back at the tip; above, a small almost horizontal one
  const blade = (s, n, at, color) =>
    loft(
      [...Array(n).keys()].map((i) => {
        const u = i / (n - 1),
          { y, le, te, t } = at(u);
        return airfoil(s * y, le, te, t, 0.02);
      }),
      color,
    );
  both((s) =>
    add(
      blade(
        s,
        7,
        (u) => ({
          y: FW + 0.01 + 0.34 * u,
          le: [2.62 - 0.1 * u * u, 0.075 + 0.025 * u * u],
          te: [2.2 - 0.03 * u, 0.085 + 0.035 * u * u],
          t: 0.02,
        }),
        CARBON,
      ),
    ),
  );
  both((s) =>
    add(
      blade(
        s,
        5,
        (u) => ({
          y: FW + 0.01 + 0.32 * u,
          le: [2.42 - 0.05 * u, 0.25 - 0.015 * u],
          te: [2.2 - 0.02 * u, 0.28 - 0.01 * u],
          t: 0.016,
        }),
        body,
      ),
    ),
  );

  // rear wing: main plane and flap with airfoil sections (a bit lower in the center, like a spoon),
  // endplates with a rounded top edge, beam wing and pillar; below, the rain light. It sits almost above
  // the rear axle (it sticks out little behind the wheels); the endplate drops toward the back to the beam wing, which
  // sits behind the cover, over the diffuser
  const spoon = (y) => -0.02 * (1 - (y / 0.51) ** 2);
  add(wing(0.51, (y) => ({ le: [-2.02, 0.765 + spoon(y)], te: [-2.31, 0.81 + spoon(y)], t: 0.045 }), CARBON));
  add(wing(0.51, (y) => ({ le: [-2.25, 0.865 + spoon(y)], te: [-2.45, 0.965 + spoon(y)], t: 0.03 }), body));
  // seen from behind, the endplates rise slanting outward from the beam wing and stand upright at the top
  const EP_BEND = [
    [0.34, -0.2],
    [0.58, -0.06],
    [0.7, 0],
    [1.1, 0],
  ];
  both((s) =>
    add(
      ...endplate(
        s * 0.52,
        [
          [-2.62, 0.34],
          [-2.28, 0.34],
          [-1.98, 0.62],
          [-1.98, 0.92],
          [-2.11, 1.01],
          [-2.49, 1.01],
        ],
        [0.06, 0.1, 0.08, 0.08, 0.05, 0.05],
        0.02,
        body,
        EP_BEND,
      ),
    ),
  );
  add(wing(0.33, () => ({ le: [-2.33, 0.36], te: [-2.6, 0.4], t: 0.035 }), CARBON));
  add(box(-2.42, -2.12, 0, 0.03, 0.4, 0.78, CARBON, 0.01));
  add(box(-2.64, -2.58, 0, 0.05, 0.25, 0.32, RAIN_LIGHT));

  // suspension (two wishbones per wheel, from the bodywork to the upright, inside the rim) and wheels. Also,
  // the rod that takes the load to the damper: at the front it pushes (pushrod, from the lower wishbone to the top of
  // the chassis) and at the back it pulls (pullrod, from the upper one downward); at the front, also the steering arm.
  // Each wishbone starts inside the bodywork: in, the width where each leg plugs in (the rear and the
  // front one), and z, the height of both wishbones (at the front the upper one sits low, so it doesn't show above the
  // nose)
  for (const [x, y, w, front, inn, zs] of [
    [1.65, 0.8, 0.33, true, [0.2, 0.15], [0.25, 0.41]],
    [-1.7, 0.79, 0.42, false, [0.1, 0.15], [0.25, 0.45]],
  ]) {
    both((s) => {
      const hub = s * (y - w / 2 - HUB_IN);
      for (const z of zs) {
        // wishbones with a flat oval section, like the airfoil profiles of the real ones
        add(
          tube(
            [
              [x - 0.32, s * inn[0], z],
              [x, hub, z + 0.02],
            ],
            0.022,
            CARBON,
            10,
            0.45,
          ),
        );
        add(
          tube(
            [
              [x + 0.12, s * inn[1], z],
              [x, hub, z + 0.02],
            ],
            0.022,
            CARBON,
            10,
            0.45,
          ),
        );
      }
      if (front) {
        add(
          tube(
            [
              [x - 0.03, hub - s * 0.09, 0.28],
              [x - 0.12, s * 0.17, 0.47],
            ],
            0.014,
            CARBON,
            8,
          ),
        );
        add(
          tube(
            [
              [x + 0.1, s * 0.19, 0.36],
              [x + 0.1, hub, 0.37],
            ],
            0.012,
            CARBON,
            8,
            0.6,
          ),
        );
      } else {
        add(
          tube(
            [
              [x + 0.03, hub - s * 0.09, 0.45],
              [x + 0.2, s * 0.15, 0.17],
            ],
            0.014,
            CARBON,
            8,
          ),
        );
      }
      add(...wheel(x, s, y, w, front, hex(accent)));
    });
  }
  return skin(parts, body, liveryTexture(color, design ?? plainDesign(color, accent), number, sharp), sharp);
}
