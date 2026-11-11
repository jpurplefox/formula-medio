// Menu views: the chosen car, with its livery, and a track's layout.

import { GLRenderer } from '../render/glrenderer.js';
import { SHADOW } from '../render/renderer.js';

// ---------- the car ----------
// The same model seen in the race (carmodel.js), drawn on the GPU with the same program as in the
// game (glrenderer.js: soft light, reflections and filtered textures) on a separate canvas, and copied onto the menu's
// over its shadow. Without WebGL, it is painted in 2D face by face, back to front, with flat light.

const SUN = norm([0.35, 0.55, 0.75]); // where the light is, in camera space (right, up, toward you)
const DIST = 14; // camera distance to the car (m): the closer, the more noticeable the perspective

function norm([x, y, z]) {
  const l = Math.hypot(x, y, z) || 1;
  return [x / l, y / l, z / l];
}

// view: { yaw, pitch } (rad): where it is viewed from, orbiting around the car (yaw 0 = from the side, the right
// side; positive = toward the nose) and from what height (pitch 0 = at ground level)
let viewer; // the views' GLRenderer (a single one for all), null if there is no WebGL
export function drawCar(canvas, model, { yaw = 0.6, pitch = 0.32, zoom = 1 } = {}) {
  const dpr = Math.min(2, devicePixelRatio || 1);
  const w = Math.round(canvas.clientWidth * dpr),
    h = Math.round(canvas.clientHeight * dpr);
  if (!w || !h) return;
  if (canvas.width !== w || canvas.height !== h) Object.assign(canvas, { width: w, height: h });
  const g = canvas.getContext('2d');
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.clearRect(0, 0, w, h);
  // the car (5.8 m long) fills almost the whole width
  const k = Math.min(w / 7, h / 3.1) * zoom;

  if (viewer === undefined) viewer = GLRenderer.create(document.createElement('canvas'), 1, 1, { modelsOnly: true });
  if (viewer) {
    // the viewer rotates the car instead of the camera: yaw 0 here (from the side) is the car crosswise, -90°
    const project = viewer.showcase(model, { yaw: -yaw - Math.PI / 2, pitch, dist: DIST, P: k * DIST }, w, h);
    shadow(g, project, k);
    g.drawImage(viewer.canvas, 0, 0);
    return;
  }

  // camera axes: e (from the car toward the camera), r (screen right) and u (up)
  const cp = Math.cos(pitch),
    sp = Math.sin(pitch),
    cy = Math.cos(yaw),
    sy = Math.sin(yaw);
  const e = [cp * sy, -cp * cy, sp];
  const r = [-cy, -sy, 0];
  const u = [-sp * sy, sp * cy, cp];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cx = w / 2,
    cz = h * 0.5,
    Z0 = 0.45; // Z0: car height that ends up in the center (m)
  const project = ([x, y, z]) => {
    const p = [x, y, z - Z0];
    const d = dot(p, e),
      f = DIST / (DIST - d);
    return [cx + dot(p, r) * k * f, cz - dot(p, u) * k * f, d];
  };

  shadow(g, project, k);

  // the faces facing the camera, from the farthest to the nearest
  const faces = [];
  for (const part of model) {
    const pts = part.verts.map(project);
    for (const f of part.faces) {
      if (dot(f.n, e) < -0.02) continue;
      const ps = f.idx.map((i) => pts[i]);
      let depth = 0;
      for (const p of ps) depth += p[2];
      faces.push({ f, ps, depth: depth / ps.length });
    }
  }
  faces.sort((a, b) => a.depth - b.depth);

  const patterns = new Map();
  const pad = 0.6 * dpr; // each face is enlarged a bit, so no thin lines are left between them
  for (const { f, ps } of faces) {
    let mx = 0,
      my = 0;
    for (const p of ps) {
      mx += p[0];
      my += p[1];
    }
    mx /= ps.length;
    my /= ps.length;
    g.beginPath();
    ps.forEach(([x, y], i) => {
      const dx = x - mx,
        dy = y - my,
        l = Math.hypot(dx, dy) || 1;
      g[i ? 'lineTo' : 'moveTo'](x + (dx / l) * pad, y + (dy / l) * pad);
    });
    g.closePath();
    // light: diffuse plus a highlight, depending on where the face points (in camera space)
    const n = [dot(f.n, r), dot(f.n, u), dot(f.n, e)];
    const diffuse = Math.max(0, dot(n, SUN));
    const light = 0.42 + 0.68 * diffuse;
    const gloss = Math.min(1, f.gloss ?? 0.5);
    const spec = gloss * Math.max(0, dot(n, norm([SUN[0], SUN[1], SUN[2] + 1]))) ** 24;
    const art = f.tex?.art;
    const fill = art && f.uv && affine(f.uv, ps);
    if (fill) {
      if (!patterns.has(art)) patterns.set(art, g.createPattern(art, 'no-repeat'));
      const pattern = patterns.get(art);
      pattern.setTransform(fill);
      g.fillStyle = pattern;
      g.fill();
      g.fillStyle = light < 1 ? `rgba(0, 0, 0, ${1 - light})` : `rgba(255, 255, 255, ${(light - 1) * 0.6})`;
      g.fill();
    } else {
      const c = f.color >>> 0,
        s = Math.min(1.25, light);
      g.fillStyle = `rgb(${(c & 255) * s}, ${((c >> 8) & 255) * s}, ${((c >> 16) & 255) * s})`;
      g.fill();
    }
    if (spec > 0.01) {
      g.fillStyle = `rgba(255, 255, 255, ${Math.min(0.7, spec)})`;
      g.fill();
    }
  }
}

// shadow on the ground: the car's footprint (the same shadow as in the game), enlarged and blurred
function shadow(g, project, k) {
  g.save();
  g.filter = `blur(${Math.round(k * 0.14)}px)`;
  g.fillStyle = 'rgba(0, 0, 0, 0.6)';
  g.beginPath();
  for (const [x, y] of SHADOW) g.lineTo(...project([x * 1.08, y * 1.15, 0]));
  g.closePath();
  g.fill();
  g.restore();
}

// the transform (as a DOMMatrix) that takes texture coordinates uv to the screen, derived from the first three
// points of the face (that are not collinear)
function affine(uv, ps) {
  const [[u0, v0], [u1, v1], [u2, v2]] = uv;
  const [[x0, y0], [x1, y1], [x2, y2]] = ps;
  const du1 = u1 - u0,
    dv1 = v1 - v0,
    du2 = u2 - u0,
    dv2 = v2 - v0;
  const det = du1 * dv2 - du2 * dv1;
  if (Math.abs(det) < 1e-6) return null;
  const dx1 = x1 - x0,
    dy1 = y1 - y0,
    dx2 = x2 - x0,
    dy2 = y2 - y0;
  const a = (dx1 * dv2 - dx2 * dv1) / det,
    c = (dx2 * du1 - dx1 * du2) / det;
  const b = (dy1 * dv2 - dy2 * dv1) / det,
    d = (dy2 * du1 - dy1 * du2) / det;
  return new DOMMatrix([a, b, c, d, x0 - a * u0 - c * v0, y0 - b * u0 - d * v0]);
}

// ---------- the layout ----------
const layouts = new Map(); // the centerline of each track (tracks/*.layout.json), downloaded once

// a track's centerline, rotated like the game map (track.js): [[x, y], ...] in meters, and the length
export async function trackShape(def) {
  if (!def.layout) return null;
  if (!layouts.has(def.id)) {
    // if the download fails (the server sometimes drops one when they are all requested together), it retries once
    // and, if it fails again, it isn't cached: the next time it is drawn it is requested again
    const get = () => fetch(def.layout).then((r) => r.json());
    layouts.set(
      def.id,
      get()
        .catch(get)
        .then((layout) => {
          const a = ((def.rotate ?? 0) * Math.PI) / 180,
            c = Math.cos(a),
            s = Math.sin(a);
          return {
            points: layout.points.map(([x, y]) => [x * c - y * s, x * s + y * c]),
            length: layout.lapLengthMeters,
          };
        })
        .catch((err) => {
          layouts.delete(def.id);
          throw err;
        }),
    );
  }
  return layouts.get(def.id);
}

const WIDE = 0.8;

// Draws the layout to fit the canvas: the track, the start (checkered) and an arrow with the direction of travel.
// points: [[x, y], ...]; dot (0 to 1): where a dot going around the lap goes, if one is wanted
export function drawShape(canvas, points, { color = '#f2f2f2', dot = null, accent = '#ffd400', line = 1 } = {}) {
  const dpr = Math.min(2, devicePixelRatio || 1);
  const w = Math.round(canvas.clientWidth * dpr),
    h = Math.round(canvas.clientHeight * dpr);
  if (!w || !h) return;
  if (canvas.width !== w || canvas.height !== h) Object.assign(canvas, { width: w, height: h });
  const g = canvas.getContext('2d');
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.clearRect(0, 0, w, h);
  if (!points?.length) return;
  const xs = points.map((p) => p[0]),
    ys = points.map((p) => p[1]);
  const x0 = Math.min(...xs),
    x1 = Math.max(...xs),
    y0 = Math.min(...ys),
    y1 = Math.max(...ys);
  const m = Math.max(8 * dpr, Math.min(w, h) * 0.08);
  // widthwise it fills up to WIDE of the space: otherwise long thin layouts (Montreal), which stretch end to end,
  // look bigger than the others
  const k = Math.min((WIDE * (w - 2 * m)) / (x1 - x0 || 1), (h - 2 * m) / (y1 - y0 || 1));
  const ox = (w - (x1 - x0) * k) / 2,
    oy = (h - (y1 - y0) * k) / 2;
  const P = ([x, y]) => [ox + (x - x0) * k, oy + (y - y0) * k];
  const lw = Math.max(2, Math.min(w, h) * 0.022) * line;
  g.lineJoin = g.lineCap = 'round';
  const path = () => {
    g.beginPath();
    points.forEach((p, i) => g[i ? 'lineTo' : 'moveTo'](...P(p)));
    g.closePath();
  };
  path();
  g.strokeStyle = 'rgba(0, 0, 0, 0.6)';
  g.lineWidth = lw * 2.4;
  g.stroke();
  g.strokeStyle = color;
  g.lineWidth = lw;
  g.stroke();

  // start: a checkered strip across the track, and a short arrow with the direction
  const at = (i) => P(points[((i % points.length) + points.length) % points.length]);
  const [sx, sy] = at(0),
    [nx, ny] = at(3);
  const a = Math.atan2(ny - sy, nx - sx);
  g.save();
  g.translate(sx, sy);
  g.rotate(a);
  const cell = lw * 0.55;
  for (let i = -2; i < 2; i++) {
    for (let j = 0; j < 2; j++) {
      g.fillStyle = (i + j) % 2 ? '#111' : '#fff';
      g.fillRect(j * cell - cell, i * cell, cell, cell);
    }
  }
  // the arrow goes a bit further ahead, beside the track
  g.translate(lw * 4, -lw * 2.2);
  g.fillStyle = accent;
  g.beginPath();
  g.moveTo(lw * 1.6, 0);
  g.lineTo(-lw * 0.6, -lw * 0.9);
  g.lineTo(-lw * 0.6, lw * 0.9);
  g.closePath();
  g.fill();
  g.restore();

  if (dot != null) {
    const f = dot * points.length,
      i = Math.floor(f),
      t = f - i;
    const [ax, ay] = at(i),
      [bx, by] = at(i + 1);
    g.beginPath();
    g.arc(ax + (bx - ax) * t, ay + (by - ay) * t, lw * 1.1, 0, Math.PI * 2);
    g.fillStyle = accent;
    g.fill();
    g.strokeStyle = '#000';
    g.lineWidth = Math.max(1, lw * 0.3);
    g.stroke();
  }
}
