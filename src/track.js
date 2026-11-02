// Convierte la imagen de un trazado en un mapa de celdas, al estilo Wolfenstein 3D:
// cada celda es pasto, pista o muro, y además tiene altura y (si corresponde) piano.

import { airDensity, DEFAULT_TUNE } from './dynamics.js';

export const T = { GRASS: 0, ROAD: 1, WALL: 3 };
export const KERB_W = 0.9; // ancho del piano (en celdas)

const N8 = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
const N4 = N8.slice(0, 4);

export function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`No se pudo cargar ${src}`));
    img.src = src;
  });
}

// elevation (opcional): perfil de alturas generado por tools/elevation.py
export function buildTrack(img, def, elevation = null) {
  return buildTrackFromMask(imageMask(img, def), def, elevation);
}

// Lo mismo, a partir de la máscara de la imagen (imageMask) ya calculada: no necesita el navegador,
// así también se puede armar el circuito en Node (para entrenar la IA, ver rl/)
export function buildTrackFromMask({ W, H, road: dark }, def, elevation = null) {
  // De la imagen sacamos sólo el recorrido: la línea central y el ancho de la pista
  const raw = cleanRoad(dark, def, W, H);
  const path = traceCenterline(raw, startLine(raw, def, W, H), W, H, def.smooth ?? 3);
  // la línea de largada, sobre la pista definitiva
  const start = (road) => startLine(road, def, W, H);
  return buildTrackFromPath(path, W, H, def, elevation, start);
}

// A partir del trazado sacado de la telemetría (tools/layout.py): la línea central en metros desde la largada y
// las alturas. Cada celda mide CELL_M metros; alrededor queda lugar para el pasto, los muros y los árboles.
// def.rotate (grados): gira el trazado, para que el mapa quede orientado como el dibujo de siempre
const CELL_M = 2, LAYOUT_MARGIN = 45; // celdas
export function buildTrackFromLayout(layout, def) {
  const a = ((def.rotate ?? 0) * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  const turned = layout.points.map(([x, y]) => [x * c - y * s, x * s + y * c]);
  const x0 = Math.min(...turned.map((p) => p[0])), y0 = Math.min(...turned.map((p) => p[1]));
  const pts = turned.map(([x, y]) => [(x - x0) / CELL_M + LAYOUT_MARGIN, (y - y0) / CELL_M + LAYOUT_MARGIN]);
  const W = Math.ceil(Math.max(...pts.map((p) => p[0])) + LAYOUT_MARGIN);
  const H = Math.ceil(Math.max(...pts.map((p) => p[1])) + LAYOUT_MARGIN);
  const n = pts.length;
  const path = {
    n, x: Float64Array.from(pts, (p) => p[0]), y: Float64Array.from(pts, (p) => p[1]),
    wrap: (b) => ((b % n) + n) % n,
    // la telemetría no trae los bordes (ver tools/layout.py): el ancho es el del circuito
    halfWidth: (def.widthMeters ?? 14) / 2 / CELL_M,
  };
  // largada: el primer punto, mirando hacia el siguiente
  const dx = path.x[1] - path.x[0], dy = path.y[1] - path.y[0], l = Math.hypot(dx, dy);
  const start = (road) => ({ x: path.x[0], y: path.y[0], dx: dx / l, dy: dy / l, half: lineHalf(road, W, H, path.x[0], path.y[0], dx / l, dy / l, def) });
  const elevation = { lapLengthMeters: layout.lapLengthMeters, heightsMeters: layout.heightsMeters };
  return buildTrackFromPath(path, W, H, def, elevation, start);
}

// path: línea central (en celdas, desde la largada), con el medio ancho en cada punto (halfWidths) o uno solo
// (halfWidth); start(road): la línea de largada sobre la pista ya armada
function buildTrackFromPath(path, W, H, def, elevation, start) {
  // Escala real: cuántos metros mide una celda, según el largo real de la vuelta
  // (de la telemetría si la hay; si no, el que diga el circuito o 4 km)
  const lapMeters = elevation?.lapLengthMeters ?? def.lengthMeters ?? 4000;
  const st = stations(path);
  const length = st[path.n]; // largo de la línea central, en celdas
  const meters = lapMeters / length;
  const halfWidths = path.halfWidths ?? new Float32Array(path.n).fill(def.widthMeters ? def.widthMeters / 2 / meters : path.halfWidth);
  const halfWidth = [...halfWidths].sort((a, b) => a - b)[path.n >> 1]; // el típico

  // 2) Reconstruimos la pista como una cinta de ancho constante alrededor de la línea central:
  //    bordes suaves, sin las ondulaciones ni mordiscos que trae la imagen pixelada
  // Cada celda guarda además su posición sobre la línea central (station) y de qué lado está (lat)
  const { road, sdf, station, lat } = ribbon(path, st, halfWidths, W, H);

  // 3) Con la pista definitiva calculamos todo lo demás
  const { dist, tiles, line, progress, maxProgress } = layout(road, sdf, def, W, H, start(road));
  const runoff = def.runoff ?? 3;

  // Largamos unas celdas detrás de la línea
  const spawn = { x: line.x - line.dx * 6, y: line.y - line.dy * 6, angle: Math.atan2(line.dy, line.dx) };

  const curv = curvature(path);
  const { left: kerbLeft, right: kerbRight } = kerbFlags(path, st, curv);
  const height = computeHeight(elevation, (def.elevationScale ?? 1) / meters, station, length, sdf, -(runoff + 1), W, H);

  const trees = placeTrees(dist, tiles, W, H, runoff);
  for (const t of trees) t.z = sampleField(height, W, t.x, t.y);
  const boards = brakeBoards(path, st, curv, meters, sdf, W, H);
  for (const b of boards) b.z = sampleField(height, W, b.x, b.y);

  return {
    W, H, meters, runoff, halfWidth, halfWidths, tiles, road, sdf, station, lat, length, kerbLeft, kerbRight, height,
    path: { n: path.n, x: path.x, y: path.y, st }, // línea central: puntos y su posición acumulada
    progress, maxProgress, line, spawn, trees, boards, scale: def.scale ?? 3, name: def.name,
    // el aire (más arriba, menos denso) y la puesta a punto por defecto de los autos ahí (dynamics.js)
    air: airDensity(def.altitude ?? 0), tune: def.tune ?? DEFAULT_TUNE,
  };
}

// Píxeles oscuros de la imagen reducida (1 = puede ser pista): la única parte que necesita el navegador
export function imageMask(img, def) {
  const scale = def.scale ?? 3;
  const W = Math.ceil(img.width / scale);
  const H = Math.ceil(img.height / scale);
  const threshold = def.threshold ?? 90;
  // Reducimos la imagen: cada píxel resultante es el promedio de scale×scale píxeles
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, W, H);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, W, H);
  // retoques a mano, en píxeles de la imagen: `paint` repasa en negro tramos de pista que el dibujo tapa
  // (p. ej. con la bandera a cuadros): [[x0, y0, x1, y1, ancho], ...]
  ctx.save();
  ctx.scale(W / img.width, H / img.height);
  ctx.strokeStyle = '#000';
  ctx.lineCap = 'round';
  for (const [x0, y0, x1, y1, width] of def.paint ?? []) {
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
  }
  ctx.restore();
  const px = ctx.getImageData(0, 0, W, H).data;

  const road = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) {
    const lum = 0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2];
    road[i] = lum < threshold ? 1 : 0;
  }
  return { W, H, road };
}

function cleanRoad(dark, def, W, H) {
  let road = dark;
  // Líneas finas pegadas al trazado (calle de boxes, variantes viejas, el mástil de la bandera): se borran
  // achicando todo `open` celdas y volviendo a agrandarlo; la pista, que es más gruesa, sobrevive
  if (def.open) road = openThin(road, W, H, def.open);
  // Los números de las curvas y otros textos quedan como islas: nos quedamos
  // sólo con el componente conectado más grande, que es el trazado.
  road = largestComponent(road, W, H);
  // Y rellenamos los huecos chicos dentro de la pista (p. ej. la bandera a cuadros)
  fillHoles(road, W, H, 400);
  road = closeGaps(road, W, H, def.close ?? 2);

  if (def.widen) {
    const d = distanceFrom(road, W, H, def.widen);
    for (let i = 0; i < W * H; i++) road[i] = d[i] >= 0 ? 1 : 0;
  }
  return road;
}

// A partir de la pista: tipo de cada celda, línea de largada y progreso de vuelta.
// El muro es la franja que está a más de `runoff` celdas del borde (según sdf, que es continuo).
function layout(road, sdf, def, W, H, line) {
  const runoff = def.runoff ?? 3;
  const dist = distanceFrom(road, W, H, 255);
  const tiles = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const s = sdf[i];
      const border = x === 0 || y === 0 || x === W - 1 || y === H - 1;
      if (border) tiles[i] = T.WALL;
      else if (road[i]) tiles[i] = T.ROAD;
      else if (s < -runoff && s >= -(runoff + 2)) tiles[i] = T.WALL;
      else tiles[i] = T.GRASS;
    }
  }
  const drivable = (i) => sdf[i] >= -runoff && tiles[i] !== T.WALL;

  const progress = computeProgress(drivable, W, H, line);
  let maxProgress = 0;
  for (let i = 0; i < W * H; i++) if (progress[i] > maxProgress) maxProgress = progress[i];
  return { dist, tiles, line, progress, maxProgress };
}

// Línea de largada: punto (sobre la pista), dirección de carrera y medio ancho
function startLine(road, def, W, H) {
  const scale = def.scale ?? 3;
  let sx = def.start.x / scale;
  let sy = def.start.y / scale;
  let dx = def.towards.x - def.start.x;
  let dy = def.towards.y - def.start.y;
  const len = Math.hypot(dx, dy) || 1;
  dx /= len;
  dy /= len;
  [sx, sy] = snapToRoad(road, W, H, sx, sy);
  return { x: sx, y: sy, dx, dy, half: lineHalf(road, W, H, sx, sy, dx, dy, def) };
}

// Medio ancho de la línea de largada: hasta donde llega la pista hacia los costados, más el pasto
function lineHalf(road, W, H, sx, sy, dx, dy, def) {
  let half = 1;
  for (const s of [1, -1]) {
    let k = 0;
    while (k < 60 && road[idx(W, H, sx - dy * s * k, sy + dx * s * k)]) k++;
    half = Math.max(half, k + (def.runoff ?? 3) + 1);
  }
  return half;
}

// Recorre la pista desde la largada como un "caminante": avanza un paso, mide hasta dónde
// llega la pista hacia cada costado y se centra. Así sigue las horquillas sin cortar camino.
// smooth: pasadas de suavizado de la línea central (más en imágenes chicas, donde las líneas quedan escalonadas)
function traceCenterline(road, line, W, H, smooth) {
  const onRoad = (x, y) => road[idx(W, H, x, y)] === 1;
  const reach = (x, y, nx, ny) => {
    let t = 0;
    while (t < 40 && onRoad(x + nx * t, y + ny * t)) t += 0.25;
    return t;
  };
  let px = line.x, py = line.y, dx = line.dx, dy = line.dy;
  const xs = [], ys = [], widths = [];
  for (let iter = 0; iter < 20000; iter++) {
    // centrarse en la sección transversal
    for (let k = 0; k < 2; k++) {
      const a = reach(px, py, -dy, dx), b = reach(px, py, dy, -dx);
      px += (-dy * (a - b)) / 2;
      py += (dx * (a - b)) / 2;
      if (k === 1) widths.push(a + b);
    }
    xs.push(px);
    ys.push(py);
    const n = xs.length;
    // vuelta cerrada: de vuelta en la largada, a menos de media pista (la bandera a cuadros puede correr un poco
    // el centro, y si no se la reconoce acá el recorrido sigue y da otra vuelta)
    if (n > 50 && Math.hypot(px - xs[0], py - ys[0]) < Math.max(1.5, widths[widths.length - 1] / 2)) break;
    // rumbo: hacia dónde venimos avanzando, suavizado
    if (n > 4) {
      let ndx = px - xs[n - 5], ndy = py - ys[n - 5];
      const l = Math.hypot(ndx, ndy) || 1;
      dx = dx * 0.5 + (ndx / l) * 0.5;
      dy = dy * 0.5 + (ndy / l) * 0.5;
      const l2 = Math.hypot(dx, dy) || 1;
      dx /= l2;
      dy /= l2;
    }
    px += dx;
    py += dy;
  }
  let x = Float64Array.from(xs), y = Float64Array.from(ys);
  const n = x.length;
  const wrap = (b) => ((b % n) + n) % n;
  for (let pass = 0; pass < smooth; pass++) {
    const nx = new Float64Array(n), ny = new Float64Array(n);
    for (let b = 0; b < n; b++) {
      for (let k = -3; k <= 3; k++) { nx[b] += x[wrap(b + k)]; ny[b] += y[wrap(b + k)]; }
      nx[b] /= 7;
      ny[b] /= 7;
    }
    x = nx;
    y = ny;
  }
  // ancho típico: la mediana de lo medido (las curvas y la bandera dan valores atípicos)
  widths.sort((a, b) => a - b);
  const halfWidth = widths[widths.length >> 1] / 2;
  return { n, x, y, wrap, halfWidth };
}

// Largo acumulado de la línea central en cada punto, en celdas (st[n] = largo total)
function stations({ n, x, y, wrap }) {
  const st = new Float64Array(n + 1);
  for (let b = 0; b < n; b++) st[b + 1] = st[b] + Math.hypot(x[wrap(b + 1)] - x[b], y[wrap(b + 1)] - y[b]);
  return st;
}

// Pista como cinta de ancho fijo. Para cada celda busca el punto más cercano de la línea central y guarda:
//   sdf     = medio ancho − distancia (positiva sobre la pista)
//   station = posición de ese punto a lo largo de la línea central, en celdas desde la largada (-1 si lejos)
//   lat     = distancia con signo hacia el costado (positiva a la derecha del sentido de carrera)
function ribbon({ n, x, y, wrap }, st, halfWidths, W, H) {
  const R = Math.max(...halfWidths) + 12;
  const d = new Float32Array(W * H).fill(R);
  const half = new Float32Array(W * H); // el medio ancho en el punto más cercano de la línea central
  const station = new Float32Array(W * H).fill(-1);
  const lat = new Float32Array(W * H);
  for (let b = 0; b < n; b++) {
    const ax = x[b], ay = y[b], bx = x[wrap(b + 1)], by = y[wrap(b + 1)];
    const ex = bx - ax, ey = by - ay;
    const len2 = ex * ex + ey * ey || 1e-9;
    const len = Math.sqrt(len2);
    const x0 = Math.max(0, Math.floor(Math.min(ax, bx) - R)), x1 = Math.min(W - 1, Math.ceil(Math.max(ax, bx) + R));
    const y0 = Math.max(0, Math.floor(Math.min(ay, by) - R)), y1 = Math.min(H - 1, Math.ceil(Math.max(ay, by) + R));
    for (let cy = y0; cy <= y1; cy++) {
      for (let cx = x0; cx <= x1; cx++) {
        const px = cx + 0.5 - ax, py = cy + 0.5 - ay;
        const t = Math.max(0, Math.min(1, (px * ex + py * ey) / len2));
        const dd = Math.hypot(px - ex * t, py - ey * t);
        const i = cy * W + cx;
        if (dd < d[i]) {
          d[i] = dd;
          half[i] = halfWidths[b] * (1 - t) + halfWidths[wrap(b + 1)] * t;
          station[i] = st[b] + t * len;
          lat[i] = (py * ex - px * ey) / len;
        }
      }
    }
  }
  const sdf = new Float32Array(W * H);
  const road = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) {
    sdf[i] = half[i] - d[i];
    road[i] = sdf[i] > 0 ? 1 : 0;
  }
  return { road, sdf, station, lat };
}

// Medio ancho de la pista (celdas) en una posición st de la línea central
export function halfWidthAt(track, st) {
  const { halfWidths, path: { n, st: s } } = track;
  let lo = 0, hi = n;
  const u = ((st % s[n]) + s[n]) % s[n];
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (s[mid] <= u) lo = mid; else hi = mid;
  }
  const t = (u - s[lo]) / Math.max(1e-9, s[lo + 1] - s[lo]);
  return halfWidths[lo] * (1 - t) + halfWidths[(lo + 1) % n] * t;
}

// Posición sobre la línea central en un punto cualquiera, interpolada.
// Donde salta (en la largada, o entre dos tramos de pista cercanos) usa la celda más cercana.
export function stationAt(track, x, y) {
  const { W, station } = track;
  const gx = x - 0.5, gy = y - 0.5;
  const x0 = Math.floor(gx), y0 = Math.floor(gy);
  const u = gx - x0, v = gy - y0;
  const j = y0 * W + x0;
  const a = station[j], b = station[j + 1], c = station[j + W], d = station[j + W + 1];
  const lo = Math.min(a, b, c, d), hi = Math.max(a, b, c, d);
  if (lo < 0 || hi - lo > 4) return station[Math.floor(y) * W + Math.floor(x)];
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}

// Cuánto piano hay en este punto (0 = nada, 1 = ancho completo; en las puntas va de 0 a 1).
// El piano va por fuera del borde: sdf entre -KERB_W·k y 0.
export function kerbAt(track, x, y) {
  const st = stationAt(track, x, y);
  if (st < 0) return 0;
  return kerbAmount(sampleField(track.lat, track.W, x, y) > 0 ? track.kerbRight : track.kerbLeft, st);
}

// Qué hay en un punto: 'road' (la pista), 'kerb' (el piano, por fuera del borde) o 'grass'. Las propiedades de
// cada superficie (agarre, freno) están en SURFACES de car.js; para poner otro material al costado de la pista
// (grava, asfalto) alcanza con devolverlo acá donde corresponda y agregarlo allá.
export function surfaceAt(track, x, y) {
  const edge = sampleField(track.sdf, track.W, x, y);
  if (edge >= 0) return 'road';
  return edge > -KERB_W * kerbAt(track, x, y) ? 'kerb' : 'grass';
}

export function kerbAmount(amounts, st) {
  const n = amounts.length;
  const i = Math.floor(st), t = st - i;
  return amounts[i % n] * (1 - t) + amounts[(i + 1) % n] * t;
}

// Pianos como en un circuito real: del lado de adentro donde la curva es cerrada,
// y del lado de afuera a la salida de las curvas más fuertes. En las rectas, nada.
// Se decide con la curvatura de la línea central y se guarda por cada celda de recorrido.
const KERB_INSIDE = 1 / 28; // curvatura mínima para piano interno (radio < 28 celdas)
const KERB_EXIT = 1 / 16; // curvatura mínima para piano externo a la salida
const KERB_MIN = 5; // largo mínimo de un piano y de un hueco entre pianos (celdas)
const KERB_RAMP = 3; // largo de la punta de cada piano, donde crece de 0 al ancho completo (celdas)

// Curvatura de la línea central en cada punto (radianes por celda; positiva = curva a la derecha), suavizada
export function curvature({ n, x, y, wrap }) {
  const K = 6;
  const heading = new Float64Array(n);
  for (let b = 0; b < n; b++) heading[b] = Math.atan2(y[wrap(b + K)] - y[wrap(b - K)], x[wrap(b + K)] - x[wrap(b - K)]);
  let curv = new Float64Array(n);
  for (let b = 0; b < n; b++) {
    let d = heading[wrap(b + K)] - heading[wrap(b - K)];
    d = Math.atan2(Math.sin(d), Math.cos(d));
    curv[b] = d / (2 * K); // los puntos de la línea central están a ~1 celda entre sí
  }
  for (let pass = 0; pass < 2; pass++) {
    const c2 = new Float64Array(n);
    for (let b = 0; b < n; b++) {
      for (let k = -4; k <= 4; k++) c2[b] += curv[wrap(b + k)];
      c2[b] /= 9;
    }
    curv = c2;
  }
  return curv;
}

function kerbFlags({ n, wrap }, st, curv) {
  const L = Math.ceil(st[n]) + 1;
  const left = new Uint8Array(L), right = new Uint8Array(L);
  let b = 0;
  for (let u = 0; u < L; u++) {
    while (b < n - 1 && st[b + 1] <= u) b++;
    const k = curv[b];
    if (k > KERB_INSIDE) right[u] = 1;
    if (k < -KERB_INSIDE) left[u] = 1;
    for (let back = 3; back <= 18; back++) {
      const kb = curv[wrap(b - back)];
      if (kb > KERB_EXIT) left[u] = 1;
      if (kb < -KERB_EXIT) right[u] = 1;
    }
  }
  return { left: taper(cleanRuns(left)), right: taper(cleanRuns(right)) };
}

// Carteles de distancia antes de las curvas fuertes (200, 150, 100 y 50 m hasta el punto donde empieza la curva),
// del lado de afuera, que es por donde viene el auto antes de doblar.
// Una curva es "fuerte" si su radio mínimo es chico y antes tiene una recta larga donde se llega rápido.
const BOARD_DISTANCES = [200, 150, 100, 50]; // metros
const BOARD_RADIUS = 110; // radio máximo de la curva (m) para que lleve carteles
const BOARD_STRAIGHT = 250; // recta mínima antes de la curva (m)
const BOARD_TURN_IN = 260; // radio (m) a partir del cual consideramos que la curva empezó
const BOARD_OFFSET = 2; // distancia del cartel al borde de la pista (celdas)

function brakeBoards(path, st, curv, meters, sdf, W, H) {
  const { n, x, y, wrap } = path;
  const length = st[n];
  const strong = 1 / (BOARD_RADIUS / meters);
  const turnIn = 1 / (BOARD_TURN_IN / meters);
  // tramos de curva: puntos seguidos con curvatura (del mismo lado) por encima de turnIn
  const corners = [];
  const bent = (b) => Math.abs(curv[b]) > turnIn;
  let start = 0;
  while (bent(start) && start < n) start++; // arrancamos en una recta para no partir una curva al medio
  for (let k = 0; k < n; k++) {
    const b = wrap(start + k);
    if (!bent(b)) continue;
    const sign = Math.sign(curv[b]);
    let peak = 0, end = k;
    while (end < n && bent(wrap(start + end)) && Math.sign(curv[wrap(start + end)]) === sign) {
      peak = Math.max(peak, Math.abs(curv[wrap(start + end)]));
      end++;
    }
    corners.push({ b, sign, peak, from: st[b], to: st[wrap(start + end - 1)] });
    k = end - 1;
  }
  const boards = [];
  corners.forEach((c, i) => {
    if (c.peak < strong) return;
    // recta previa: desde el final de la curva anterior que también sea cerrada
    const prev = corners[(i - 1 + corners.length) % corners.length];
    const straight = (c.from - prev.to + length) % length;
    if (straight * meters < BOARD_STRAIGHT) return;
    for (const d of BOARD_DISTANCES) {
      const target = (c.from - d / meters + length) % length;
      // punto de la línea central en esa posición
      let b = 0;
      while (b < n - 1 && st[b + 1] <= target) b++;
      const dx = x[wrap(b + 3)] - x[wrap(b - 3)], dy = y[wrap(b + 3)] - y[wrap(b - 3)];
      const len = Math.hypot(dx, dy) || 1;
      // normal hacia la derecha de la marcha (y crece hacia abajo); el cartel va del lado contrario a la curva
      const nx = -dy / len, ny = dx / len;
      const side = -c.sign;
      // buscamos el borde de la pista y nos alejamos un poco más
      let off = 0;
      while (off < 30 && sampleField(sdf, W, x[b] + nx * side * off, y[b] + ny * side * off) > 0) off += 0.25;
      off += BOARD_OFFSET;
      const bx = x[b] + nx * side * off, by = y[b] + ny * side * off;
      // si cae sobre otra parte de la pista (o fuera del mapa), no va
      if (bx < 2 || by < 2 || bx >= W - 2 || by >= H - 2 || sampleField(sdf, W, bx, by) > -1) continue;
      boards.push({ x: bx, y: by, meters: d });
    }
  });
  return boards;
}

// De marcas 0/1 a cantidad de piano, con puntas en rampa al empezar y al terminar
function taper(flags) {
  const L = flags.length;
  const out = new Float32Array(L);
  let start = -1;
  for (let u = 0; u <= L; u++) {
    const on = u < L && flags[u] === 1;
    if (on && start < 0) start = u;
    if (!on && start >= 0) {
      for (let k = start; k < u; k++) out[k] = Math.min(1, (Math.min(k - start, u - 1 - k) + 0.5) / KERB_RAMP);
      start = -1;
    }
  }
  return out;
}

// Saca pianos muy cortos y tapa huecos muy cortos entre pianos
function cleanRuns(flags) {
  const L = flags.length;
  for (const value of [0, 1]) {
    let start = -1;
    for (let u = 0; u <= L; u++) {
      const isVal = u < L && flags[u] === value;
      if (isVal && start < 0) start = u;
      if (!isVal && start >= 0) {
        if (u - start < KERB_MIN && start > 0 && u < L) flags.fill(1 - value, start, u);
        start = -1;
      }
    }
  }
  return flags;
}

// Altura de cada celda, en celdas. Sobre la pista (y hasta el muro) sale del perfil de la telemetría
// según la posición sobre la línea central, así la pista queda pareja de lado a lado.
// Más allá, el terreno se extiende y se suaviza en lomas.
// cellsPerMeter: escala del mapa (ya incluye la exageración de alturas, si hay)
function computeHeight(elevation, cellsPerMeter, station, length, sdf, limit, W, H) {
  const height = new Float32Array(W * H);
  if (!elevation) return height;
  const hs = elevation.heightsMeters;
  const m = hs.length;
  const profile = (f) => {
    const t = (((f % 1) + 1) % 1) * m;
    const i = Math.floor(t), u = t - i;
    return (hs[i % m] * (1 - u) + hs[(i + 1) % m] * u) * cellsPerMeter;
  };

  // valores fijos sobre la pista, propagados al resto por cercanía
  const known = new Uint8Array(W * H);
  const queue = new Int32Array(W * H);
  let head = 0, tail = 0;
  for (let i = 0; i < W * H; i++) {
    if (station[i] >= 0 && sdf[i] >= limit) {
      height[i] = profile(station[i] / length);
      known[i] = 1;
      queue[tail++] = i;
    }
  }
  const seen = known.slice();
  while (head < tail) {
    const j = queue[head++];
    const x = j % W, y = (j / W) | 0;
    for (const [dx, dy] of N4) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const k = ny * W + nx;
      if (!seen[k]) { seen[k] = 1; height[k] = height[j]; queue[tail++] = k; }
    }
  }
  // suavizado que respeta la pista: el terreno queda en lomas suaves entre tramos
  const fixed = height.slice();
  for (let pass = 0; pass < 6; pass++) {
    boxBlurInPlace(height, W, H, 6);
    for (let i = 0; i < W * H; i++) if (known[i]) height[i] = fixed[i];
  }
  return height;
}

function boxBlurInPlace(a, W, H, r) {
  const tmp = new Float32Array(Math.max(W, H));
  for (let y = 0; y < H; y++) {
    let sum = 0;
    const row = y * W;
    for (let x = -r; x <= r; x++) sum += a[row + Math.min(W - 1, Math.max(0, x))];
    for (let x = 0; x < W; x++) {
      tmp[x] = sum / (2 * r + 1);
      sum += a[row + Math.min(W - 1, x + r + 1)] - a[row + Math.max(0, x - r)];
    }
    for (let x = 0; x < W; x++) a[row + x] = tmp[x];
  }
  for (let x = 0; x < W; x++) {
    let sum = 0;
    for (let y = -r; y <= r; y++) sum += a[Math.min(H - 1, Math.max(0, y)) * W + x];
    for (let y = 0; y < H; y++) {
      tmp[y] = sum / (2 * r + 1);
      sum += a[Math.min(H - 1, y + r + 1) * W + x] - a[Math.max(0, y - r) * W + x];
    }
    for (let y = 0; y < H; y++) a[y * W + x] = tmp[y];
  }
}

// Interpola un campo definido en el centro de las celdas (bilineal).
// Es lo que hace que los bordes se vean curvos y no en escalones.
export function sampleField(field, W, x, y) {
  const gx = x - 0.5, gy = y - 0.5;
  const x0 = Math.floor(gx), y0 = Math.floor(gy);
  const u = gx - x0, v = gy - y0;
  const i = y0 * W + x0;
  const a = field[i], b = field[i + 1], c = field[i + W], d = field[i + W + 1];
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}

function idx(W, H, x, y) {
  const ix = Math.floor(x), iy = Math.floor(y);
  if (ix < 0 || iy < 0 || ix >= W || iy >= H) return -1;
  return iy * W + ix;
}

function largestComponent(mask, W, H) {
  const label = new Int32Array(W * H);
  const stack = new Int32Array(W * H);
  let best = 0, bestSize = 0, next = 0;
  for (let i = 0; i < W * H; i++) {
    if (!mask[i] || label[i]) continue;
    next++;
    let size = 0, sp = 0;
    stack[sp++] = i;
    label[i] = next;
    while (sp) {
      const j = stack[--sp];
      size++;
      const x = j % W, y = (j / W) | 0;
      for (const [dx, dy] of N8) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const k = ny * W + nx;
        if (mask[k] && !label[k]) { label[k] = next; stack[sp++] = k; }
      }
    }
    if (size > bestSize) { bestSize = size; best = next; }
  }
  const out = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) out[i] = label[i] === best ? 1 : 0;
  return out;
}

function fillHoles(mask, W, H, maxSize) {
  const seen = new Uint8Array(W * H);
  const stack = new Int32Array(W * H);
  const comp = [];
  for (let i = 0; i < W * H; i++) {
    if (mask[i] || seen[i]) continue;
    comp.length = 0;
    let sp = 0;
    stack[sp++] = i;
    seen[i] = 1;
    while (sp) {
      const j = stack[--sp];
      comp.push(j);
      const x = j % W, y = (j / W) | 0;
      for (const [dx, dy] of N4) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const k = ny * W + nx;
        if (!mask[k] && !seen[k]) { seen[k] = 1; stack[sp++] = k; }
      }
    }
    if (comp.length <= maxSize) for (const j of comp) mask[j] = 1;
  }
}

// Cierre morfológico: engorda la pista r celdas y después la afina r celdas.
// Tapa grietas angostas aunque toquen el exterior (la bandera sobresale de la pista).
function closeGaps(mask, W, H, r) {
  if (!r) return mask;
  const grown = distanceFrom(mask, W, H, r);
  const outside = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) outside[i] = grown[i] < 0 ? 1 : 0;
  const back = distanceFrom(outside, W, H, r);
  const out = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) out[i] = mask[i] || back[i] < 0 ? 1 : 0;
  return out;
}

// Apertura: borra lo que tenga menos de 2r+1 celdas de ancho y deja igual lo demás
function openThin(mask, W, H, r) {
  const outside = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) outside[i] = mask[i] ? 0 : 1;
  const near = distanceFrom(outside, W, H, r);
  const core = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) core[i] = mask[i] && near[i] < 0 ? 1 : 0;
  const grown = distanceFrom(core, W, H, r);
  const out = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) out[i] = mask[i] && grown[i] >= 0 ? 1 : 0;
  return out;
}

// Distancia (Chebyshev, en celdas) a la máscara; -1 si supera maxDist
function distanceFrom(mask, W, H, maxDist) {
  const dist = new Int16Array(W * H).fill(-1);
  const queue = new Int32Array(W * H);
  let head = 0, tail = 0;
  for (let i = 0; i < W * H; i++) if (mask[i]) { dist[i] = 0; queue[tail++] = i; }
  while (head < tail) {
    const j = queue[head++];
    const d = dist[j];
    if (d >= maxDist) continue;
    const x = j % W, y = (j / W) | 0;
    for (const [dx, dy] of N8) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const k = ny * W + nx;
      if (dist[k] < 0) { dist[k] = d + 1; queue[tail++] = k; }
    }
  }
  return dist;
}

function snapToRoad(road, W, H, x, y) {
  const i = idx(W, H, x, y);
  if (i >= 0 && road[i]) return [x, y];
  for (let r = 1; r < 40; r++) {
    for (let a = 0; a < 32; a++) {
      const nx = x + Math.cos((a / 32) * Math.PI * 2) * r;
      const ny = y + Math.sin((a / 32) * Math.PI * 2) * r;
      const k = idx(W, H, nx, ny);
      if (k >= 0 && road[k]) return [nx, ny];
    }
  }
  return [x, y];
}

// Progreso a lo largo de la vuelta: BFS desde la línea de largada hacia adelante,
// sin permitir cruzarla hacia atrás. Sirve para validar vueltas y detectar contramano.
// Es un Dijkstra con pasos diagonales de √2, para que la distancia sea "real" y no en escalones.
function computeProgress(drivable, W, H, line) {
  const progress = new Float32Array(W * H).fill(-1);
  const heap = new MinHeap();
  const along = (x, y) => (x + 0.5 - line.x) * line.dx + (y + 0.5 - line.y) * line.dy;
  const side = (x, y) => -(x + 0.5 - line.x) * line.dy + (y + 0.5 - line.y) * line.dx;
  const nearLine = (x, y) => Math.abs(side(x, y)) < line.half && Math.abs(along(x, y)) < 3;

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const a = along(x, y);
      if (drivable(i) && a >= 0 && a < 1 && Math.abs(side(x, y)) < line.half) {
        progress[i] = a;
        heap.push(i, a);
      }
    }
  }
  const done = new Uint8Array(W * H);
  while (heap.size) {
    const j = heap.pop();
    if (done[j]) continue;
    done[j] = 1;
    const x = j % W, y = (j / W) | 0;
    for (const [dx, dy] of N8) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const k = ny * W + nx;
      if (done[k] || !drivable(k)) continue;
      // las diagonales no pueden colarse entre dos celdas bloqueadas
      if (dx && dy && (!drivable(y * W + nx) || !drivable(ny * W + x))) continue;
      if (nearLine(nx, ny) && along(x, y) >= 0 && along(nx, ny) < 0) continue;
      const nd = progress[j] + (dx && dy ? Math.SQRT2 : 1);
      if (progress[k] < 0 || nd < progress[k]) {
        progress[k] = nd;
        heap.push(k, nd);
      }
    }
  }
  return progress;
}

class MinHeap {
  constructor() { this.ids = []; this.keys = []; }
  get size() { return this.ids.length; }
  push(id, key) {
    const { ids, keys } = this;
    let i = ids.length;
    ids.push(id);
    keys.push(key);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (keys[p] <= key) break;
      ids[i] = ids[p]; keys[i] = keys[p];
      i = p;
    }
    ids[i] = id; keys[i] = key;
  }
  pop() {
    const { ids, keys } = this;
    const top = ids[0];
    const id = ids.pop(), key = keys.pop();
    const n = ids.length;
    if (n) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && keys[c + 1] < keys[c]) c++;
        if (keys[c] >= key) break;
        ids[i] = ids[c]; keys[i] = keys[c];
        i = c;
      }
      ids[i] = id; keys[i] = key;
    }
    return top;
  }
}

function placeTrees(dist, tiles, W, H, runoff) {
  let seed = 1234567;
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const trees = [];
  for (let y = 2; y < H - 2; y++) {
    for (let x = 2; x < W - 2; x++) {
      const i = y * W + x;
      const d = dist[i];
      if (tiles[i] !== T.GRASS || (d >= 0 && d < runoff + 5)) continue;
      if (rand() < 0.006) trees.push({ x: x + rand(), y: y + rand(), scale: 0.8 + rand() * 0.7 });
    }
  }
  return trees;
}
