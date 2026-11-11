// Vistas del menú: el auto elegido, con su decoración, y el trazado de un circuito.

import { GLRenderer } from '../render/glrenderer.js';
import { SHADOW } from '../render/renderer.js';

// ---------- el auto ----------
// El mismo modelo que se ve en la carrera (carmodel.js), dibujado con la placa de video y el mismo programa que en
// el juego (glrenderer.js: luz suave, reflejos y texturas filtradas) en un canvas aparte, y copiado al del menú
// sobre su sombra. Sin WebGL, se pinta en 2D cara por cara, de atrás hacia adelante, con luz plana.

const SUN = norm([0.35, 0.55, 0.75]); // hacia dónde está la luz, en el espacio de la cámara (derecha, arriba, hacia vos)
const DIST = 14; // distancia de la cámara al auto (m): cuanto más cerca, más se nota la perspectiva

function norm([x, y, z]) {
  const l = Math.hypot(x, y, z) || 1;
  return [x / l, y / l, z / l];
}

// view: { yaw, pitch } (rad): desde dónde se mira, girando alrededor del auto (yaw 0 = de costado, del lado
// derecho; positivo = hacia la trompa) y desde qué altura (pitch 0 = a ras del piso)
let viewer; // el GLRenderer de las vistas (uno solo para todas), null si no hay WebGL
export function drawCar(canvas, model, { yaw = 0.6, pitch = 0.32, zoom = 1 } = {}) {
  const dpr = Math.min(2, devicePixelRatio || 1);
  const w = Math.round(canvas.clientWidth * dpr),
    h = Math.round(canvas.clientHeight * dpr);
  if (!w || !h) return;
  if (canvas.width !== w || canvas.height !== h) Object.assign(canvas, { width: w, height: h });
  const g = canvas.getContext('2d');
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.clearRect(0, 0, w, h);
  // el auto (5,8 m de largo) ocupa casi todo el ancho
  const k = Math.min(w / 7, h / 3.1) * zoom;

  if (viewer === undefined) viewer = GLRenderer.create(document.createElement('canvas'), 1, 1, { modelsOnly: true });
  if (viewer) {
    // el visor gira el auto en vez de la cámara: yaw 0 de acá (de costado) es el auto cruzado, -90°
    const project = viewer.showcase(model, { yaw: -yaw - Math.PI / 2, pitch, dist: DIST, P: k * DIST }, w, h);
    shadow(g, project, k);
    g.drawImage(viewer.canvas, 0, 0);
    return;
  }

  // ejes de la cámara: e (del auto hacia la cámara), r (derecha de la pantalla) y u (arriba)
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
    Z0 = 0.45; // Z0: altura del auto que queda en el centro (m)
  const project = ([x, y, z]) => {
    const p = [x, y, z - Z0];
    const d = dot(p, e),
      f = DIST / (DIST - d);
    return [cx + dot(p, r) * k * f, cz - dot(p, u) * k * f, d];
  };

  shadow(g, project, k);

  // las caras que miran hacia la cámara, de la más lejana a la más cercana
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
  const pad = 0.6 * dpr; // cada cara se agranda un poco, así no quedan rayitas entre una y otra
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
    // luz: difusa y un brillo, según hacia dónde mira la cara (en el espacio de la cámara)
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

// sombra en el piso: la planta del auto (la misma sombra que en el juego), agrandada y borrosa
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

// la transformación (como DOMMatrix) que lleva las coordenadas de textura uv a la pantalla, sacada de los tres
// primeros puntos de la cara (que no estén en línea)
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

// ---------- el trazado ----------
const layouts = new Map(); // la línea central de cada circuito (tracks/*.layout.json), se baja una vez

// la línea central de un circuito, girada como el mapa del juego (track.js): [[x, y], ...] en metros, y el largo
export async function trackShape(def) {
  if (!def.layout) return null;
  if (!layouts.has(def.id)) {
    // si la descarga falla (el servidor a veces corta alguna cuando se piden todas juntas), se reintenta una vez y,
    // si vuelve a fallar, no queda guardada: la próxima vez que se dibuje se pide de nuevo
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

// Dibuja el trazado entrando en el canvas: la pista, la largada (a cuadros) y una flecha con el sentido de giro.
// points: [[x, y], ...]; dot (de 0 a 1): dónde va un punto que da la vuelta, si se quiere uno
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
  // a lo ancho llega hasta WIDE del lugar: los trazados largos y finitos (Montreal), que se estiran de punta a punta,
  // si no se ven más grandes que los demás
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

  // largada: una franja a cuadros cruzando la pista, y una flecha corta con el sentido
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
  // la flecha va un poco más adelante, al costado de la pista
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
