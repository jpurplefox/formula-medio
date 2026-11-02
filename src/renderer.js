// Render "Voxel Space" (la técnica de Comanche, 1992), primo del raycaster de Wolfenstein 3D.
// Por cada columna de pantalla se lanza un rayo sobre el mapa, de cerca hacia lejos.
// En cada paso se lee la altura del terreno y se pinta la porción de columna que todavía
// no estaba tapada (y-buffer). Así las lomas tapan lo que tienen detrás.
// Orden de dibujo: cielo → terreno (con muros como escalones) → sprites y modelos 3D, de lejos a cerca.

import { KERB_W, stationAt, kerbAmount, sampleField } from './track.js';
import { asphaltTexture, grassTexture, macroNoise, sample, wallTexture } from './textures.js';
import { RUBBER_DARK, RubberMap } from './rubber.js';

export const MAX_DIST = 140;
export const FOG_START = 25;
export const FOG_END = 130;
export const Z_NEAR = 0.6;
export const WALL_H = 0.32; // altura de los muros (en celdas)
export const WALL_T = 0.5; // espesor de los muros (en celdas)
export const WALL_STRIPE = 1.2; // largo de cada franja del muro (en celdas)
export const KERB_H = 0.07; // altura del lomo del piano (en celdas)
export const LINE_W = 0.22; // ancho de la línea blanca de borde (en celdas)
export const STRIPE = 1.6; // largo de cada franja del piano (en celdas)
export const GUIDE_W = 0.2; // medio ancho de la trazada ideal (en celdas)
export const ROAD_TPC = 64; // texeles de asfalto por celda (la textura se repite cada 4 celdas, ~10 m)
export const GRASS_TPC = 32; // texeles de césped por celda
export const GRASS_BAND = 2.2; // ancho de cada franja del corte de césped (en celdas)
export const MACRO_TPC = 2; // muestras de la variación grande por celda (se repite cada 32 celdas, ~80 m)
export const PLANE_LEN = 0.7; // medio ancho del plano de la cámara a distancia 1: campo de visión de unos 70°
const NCHK = MAX_DIST + 2; // marcas de profundidad por columna para recortar sprites
export const NEAR_RISE = 0.2; // cuánto puede subir el terreno (o un muro) cerca de la cámara (en celdas), para saber dónde arrancar los rayos
const MAX_STEP_GROWTH = 0.025; // a lo lejos, cuánto crece el paso máximo de los rayos por cada celda de distancia
export const MODEL_NEAR = 0.05; // las caras de los modelos se recortan a esta distancia de la cámara (en celdas)
export const BODY_PIVOT_Z = 0.3; // m: altura del eje sobre el que rola y cabecea la carrocería (centro de rolido)
export const SUN = [0.45, 0.6, 0.66]; // hacia dónde está el sol (arriba a la izquierda del mapa, como el sombreado del terreno)
export const SHADOW_SHIFT = 0.35; // cuánto se corre la sombra del auto, alejándose del sol (m)
// contorno de la sombra del auto visto desde arriba (m): alerón delantero, cuerpo, alerón trasero
export const SHADOW = [[2.75, -0.95], [2.75, 0.95], [1.9, 1.0], [-2.0, 1.0], [-2.75, 0.55], [-2.75, -0.55], [-2.0, -1.0], [1.9, -1.0]];

export const rgb = (r, g, b) => (0xff000000 | (b << 16) | (g << 8) | r) >>> 0;

const FR = 196, FG = 214, FB = 230;
const FOG = rgb(FR, FG, FB);
const KERB_RED = rgb(200, 30, 30);
const KERB_WHITE = rgb(235, 235, 235);
const EDGE_WHITE = rgb(225, 225, 225);
const LINE_BLACK = rgb(20, 20, 20);
const LINE_WHITE = rgb(245, 245, 245);
const WALL_TOP = rgb(150, 150, 155);

function mix(c, f) {
  if (f <= 0) return c;
  if (f >= 256) return FOG;
  const r = c & 255, g = (c >>> 8) & 255, b = (c >>> 16) & 255;
  return 0xff000000 | ((b + (((FB - b) * f) >> 8)) << 16) | ((g + (((FG - g) * f) >> 8)) << 8) | (r + (((FR - r) * f) >> 8));
}

function shade(c, k) {
  const r = Math.min(255, (c & 255) * k), g = Math.min(255, ((c >>> 8) & 255) * k), b = Math.min(255, ((c >>> 16) & 255) * k);
  return rgb(r | 0, g | 0, b | 0);
}

function blend(a, b, t) {
  const r = (a & 255) * (1 - t) + (b & 255) * t;
  const g = ((a >>> 8) & 255) * (1 - t) + ((b >>> 8) & 255) * t;
  const bl = ((a >>> 16) & 255) * (1 - t) + ((b >>> 16) & 255) * t;
  return rgb(r | 0, g | 0, bl | 0);
}

// color de una zona del borde según la distancia s al límite de la pista
function zone(s, outer, grass, kerb, road, edge) {
  if (s < outer) return grass;
  if (s < 0) return kerb;
  if (s < LINE_W) return edge;
  return road;
}

function fogFactor(d) {
  if (d <= FOG_START) return 0;
  if (d >= FOG_END) return 256;
  const t = (d - FOG_START) / (FOG_END - FOG_START);
  return (t * t * 256) | 0;
}

// Iluminación por pendiente: las laderas que miran al "sol" se aclaran y las otras se oscurecen
function lightField(track) {
  const { W, H, height } = track;
  const light = new Float32Array(W * H).fill(1);
  const lx = -0.6, ly = -0.8; // el sol viene de arriba a la izquierda del mapa
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      const gx = (height[i + 1] - height[i - 1]) / 2;
      const gy = (height[i + W] - height[i - W]) / 2;
      light[i] = Math.max(0.65, Math.min(1.3, 1 - (gx * lx + gy * ly) * 4));
    }
  }
  return light;
}

export class Renderer {
  // canvas: el canvas donde se dibuja. En un worker no hay canvas: se pasa { width, height } y sólo se dibuja
  // en memoria (cielo y terreno de un rango de columnas).
  constructor(canvas) {
    this.w = canvas.width;
    this.h = canvas.height;
    if (canvas.getContext) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.image = this.ctx.createImageData(this.w, this.h);
      this.buf = new Uint32Array(this.image.data.buffer);
      // buffers de los modelos 3D: color y 1/profundidad (z-buffer) de lo que se va dibujando de cada modelo
      this.mcol = new Uint32Array(this.w * this.h);
      this.miz = new Float32Array(this.w * this.h);
      // el cielo y el terreno se reparten entre varios workers (uno por núcleo), si el navegador los tiene
      this.pool = TerrainPool.create(this.w, this.h);
    } else {
      this.buf = new Uint32Array(this.w * this.h);
    }
    this.setZoom(1);

    // por columna: hasta qué fila llegaba el terreno dibujado a cada profundidad entera
    this.clip = new Int16Array(this.w * NCHK);

    this.asphalt = asphaltTexture();
    this.grass = grassTexture();
    this.macro = macroNoise();
    this.wall = wallTexture();

    this.mountains = new Float32Array(1024);
    for (let i = 0; i < 1024; i++) {
      const a = (i / 1024) * Math.PI * 2;
      this.mountains[i] = 0.5 + 0.25 * Math.sin(a * 3 + 1) + 0.15 * Math.sin(a * 7 + 2) + 0.1 * Math.sin(a * 17);
    }
    this.lightFor = new WeakMap();
    this.guide = null; // trazada ideal ({ offset, color } por celda de la línea central), o null
    this.rubber = null; // la goma sobre el asfalto (RubberMap de rubber.js, o lo que se le copió a un worker)
  }

  // models: autos 3D, cada uno { model, x, y, z, angle, pitch, roll, dive, steer, spin, head, alpha, shadow, hide, meters }
  // (pitch: la pendiente, inclina todo el auto; roll y dive: rolido y cabeceo de la carrocería sobre la suspensión)
  // (steer: ángulo de las ruedas delanteras; head: hacia dónde gira la cabeza el piloto, en rad, + a la derecha;
  // wear y shine: desgaste y brillo de las gomas, 0..1, sólo con WebGL)
  // (hide: la etiqueta de las piezas que no se dibujan, por ejemplo el casco visto desde adentro)
  // zoom: 1 = campo de visión normal; 2 = la mitad de ancho (todo se ve el doble de grande), como un teleobjetivo
  setZoom(zoom) {
    this.planeLen = PLANE_LEN / zoom;
    this.P = this.w / 2 / this.planeLen; // píxeles por unidad a distancia 1
  }

  // Devuelve una promesa: el cielo y el terreno pueden estar dibujándose en los workers.
  // cam: { x, y, z, ground, angle, pitch, zoom? }
  async render(track, cam, sprites, models = []) {
    this.setZoom(cam.zoom || 1);
    const dirX = Math.cos(cam.angle), dirY = Math.sin(cam.angle);
    const planeX = -dirY * this.planeLen, planeY = dirX * this.planeLen;
    const horizon = this.h / 2 + (cam.pitch || 0);

    if (!(this.pool && (await this.pool.draw(this, track, cam, horizon)))) {
      this.drawColumns(track, cam, horizon, 0, this.w);
    }
    this.drawSprites(track, cam, sprites, models, dirX, dirY, planeX, planeY, horizon);

    this.ctx.putImageData(this.image, 0, 0);
  }

  // cielo y terreno de las columnas x0..x1 (en un worker, sólo su parte de la pantalla)
  drawColumns(track, cam, horizon, x0, x1) {
    const dirX = Math.cos(cam.angle), dirY = Math.sin(cam.angle);
    const planeX = -dirY * this.planeLen, planeY = dirX * this.planeLen;
    if (!this.lightFor.has(track)) this.lightFor.set(track, lightField(track));
    this.drawSky(cam.angle, horizon, x0, x1);
    this.drawTerrain(track, cam, dirX, dirY, planeX, planeY, horizon, x0, x1);
  }

  drawSky(angle, horizon, x0, x1) {
    const { w, h, buf } = this;
    const top = rgb(70, 130, 210);
    const hy = Math.min(h, Math.max(0, Math.ceil(horizon)));
    const skyRow = new Uint32Array(hy);
    for (let y = 0; y < hy; y++) {
      const t = y / Math.max(1, horizon);
      skyRow[y] = mix(top, (t * t * 256) | 0);
    }
    const mtn = rgb(110, 135, 160);
    for (let x = x0; x < x1; x++) {
      const a = angle + Math.atan(((2 * x) / w - 1) * this.planeLen);
      const i = ((((a / (Math.PI * 2)) * 1024) | 0) % 1024 + 1024) % 1024;
      const mh = this.mountains[i] * h * 0.09;
      for (let y = 0; y < hy; y++) {
        const dy = horizon - y;
        buf[y * w + x] = dy < mh ? mix(mtn, ((1 - dy / mh) * 200) | 0) : skyRow[y];
      }
      // lo que quede debajo del horizonte sin terreno es niebla lejana
      for (let y = hy; y < h; y++) buf[y * w + x] = FOG;
    }
  }

  drawTerrain(track, cam, dirX, dirY, planeX, planeY, horizon, x0, x1) {
    const { w, h, buf, P, clip } = this;
    const { W, H, height, sdf, lat, kerbLeft, kerbRight } = track;
    // el muro es la franja continua que empieza a `runoff` celdas del borde de la pista
    const wallIn = -track.runoff, wallOut = wallIn - WALL_T;
    const light = this.lightFor.get(track);
    const camZ = cam.z;
    const invCP = 1 / (Math.max(0.3, cam.z - cam.ground) * P);
    const pl = this.planeLen;
    // lo que está más cerca que esto queda debajo del borde de la pantalla (aunque el piso suba un poco o haya un muro):
    // los rayos arrancan ahí
    const zStart = Math.max(Z_NEAR, ((camZ - cam.ground - NEAR_RISE) * P) / (h - horizon));
    const lazyStation = this.guide || this.rubber;

    for (let x = x0; x < x1; x++) {
      const cx = (2 * x) / w - 1;
      const rdx = dirX + planeX * cx, rdy = dirY + planeY * cx;
      const base = x * NCHK;
      let ybuf = h;
      let chk = 0;
      let wasWall = false;
      let prevS = NaN, prevZ = 0, prevG = 0;
      let wallDone = false; // el muro actual ya se dibujó entero al entrar

      for (let z = zStart; z < MAX_DIST && ybuf > 0;) {
        while (chk <= z && chk < NCHK) clip[base + chk++] = ybuf;

        // paso adaptativo: fino cerca (≈1 píxel de pantalla), más largo lejos
        let step = z * z * invCP;
        if (step < 0.01) step = 0.01;
        const maxStep = 0.15 + z * MAX_STEP_GROWTH;
        if (step > maxStep) step = maxStep;

        const fx = cam.x + rdx * z, fy = cam.y + rdy * z;
        let ground, isWall = false, ix, iy, i;
        let s = -1e9, k = 0, st = -1, side = 0, kerbShade = 1;
        if (fx < 1 || fy < 1 || fx >= W - 1 || fy >= H - 1) {
          ix = Math.min(W - 1, Math.max(0, fx | 0));
          iy = Math.min(H - 1, Math.max(0, fy | 0));
          i = iy * W + ix;
          ground = height[i];
        } else {
          ix = fx | 0;
          iy = fy | 0;
          i = iy * W + ix;
          const gx = fx - 0.5, gy = fy - 0.5;
          const x0 = gx | 0, y0 = gy | 0;
          const u = gx - x0, v = gy - y0;
          const j = y0 * W + x0;
          const a = (1 - u) * (1 - v), b = u * (1 - v), c = (1 - u) * v, d = u * v;
          ground = height[j] * a + height[j + 1] * b + height[j + W] * c + height[j + W + 1] * d;
          s = sdf[j] * a + sdf[j + 1] * b + sdf[j + W] * c + sdf[j + W + 1] * d;
          // cerca del borde: dónde estamos sobre la línea central y de qué lado, para saber si hay piano
          // (en el resto de la pista, para la trazada y la goma, se calcula recién si la muestra se pinta)
          if (s > -KERB_W - 1 && s < 1) {
            st = stationAt(track, fx, fy);
            side = lat[j] * a + lat[j + 1] * b + lat[j + W] * c + lat[j + W + 1] * d;
            if (st >= 0) k = kerbAmount(side > 0 ? kerbRight : kerbLeft, st);
          }
          // el piano es un lomo por fuera del borde: sube desde el pasto, hace cumbre y baja hacia la pista
          const kw = KERB_W * k;
          if (k > 0 && s < 0 && s > -kw) {
            const t = (s + kw) / kw;
            ground += KERB_H * k * Math.sin(Math.PI * t);
            kerbShade = 1 - 0.22 * Math.cos(Math.PI * t); // la cara que mira a la pista, más iluminada
          }
          // muro: estamos dentro de la franja, o el paso la cruzó entera (pasa a lo lejos, con pasos largos)
          isWall = (s < wallIn && s > wallOut) || (prevS > wallIn && s <= wallOut);
        }

        // la cara del muro va donde el rayo cruza exactamente el borde de la franja, no en la muestra
        const entering = isWall && !wasWall && prevS > wallIn;
        let zf = z;
        let top = isWall ? ground + WALL_H : ground;
        if (entering) {
          const t = (prevS - wallIn) / (prevS - s);
          zf = prevZ + (z - prevZ) * t;
          top = prevG + (ground - prevG) * t + WALL_H;
        }
        const syf = horizon + ((camZ - top) * P) / zf;
        let sy = Math.ceil(syf);
        if (sy < 0) sy = 0;

        if (!isWall) wallDone = false;
        if (isWall && wallDone) {
          // el muro ya se dibujó entero (cara y tapa) al entrar: estas muestras no agregan nada
        } else if (sy < ybuf) {
          const f = fogFactor(z);
          if (entering) {
            // cara frontal del guardrail, con su textura: a lo largo, según la posición sobre la línea central;
            // a lo alto, desde el borde de arriba de la cara hasta el piso
            const a = Math.max(0, stationAt(track, cam.x + rdx * zf, cam.y + rdy * zf));
            const wt = this.wall.size;
            const faceH = (WALL_H * P) / zf;
            const u = a * (wt / (2 * WALL_STRIPE));
            const fp = Math.max(((zf * pl) / w) * (wt / (2 * WALL_STRIPE)), wt / faceH);
            for (let y = sy; y < ybuf; y++) {
              const v = Math.min(wt - 1, ((y - syf) / faceH) * wt);
              buf[y * w + x] = mix(sample(this.wall, u, v, fp), f);
            }
            // tapa: desde la cara hasta donde el rayo sale de la franja (según cuánto cambia s por paso)
            const dsdz = (s - prevS) / (z - prevZ);
            const zx = zf + Math.min(3, dsdz < -1e-4 ? WALL_T / -dsdz : WALL_T);
            let syx = Math.ceil(horizon + ((camZ - top) * P) / zx);
            if (syx < 0) syx = 0;
            const cTop = mix(WALL_TOP, f);
            for (let y = syx; y < sy; y++) buf[y * w + x] = cTop;
            sy = Math.min(sy, syx);
            wallDone = true;
          } else {
            let c;
            if (isWall) {
              // la cámara arrancó dentro del muro: lo pintamos muestra a muestra
              c = WALL_TOP;
            } else {
              const fw = Math.max(0.03, (z * pl) / w, step * 0.5);
              if (st < 0 && s >= 1 && lazyStation) {
                const gx = fx - 0.5, gy = fy - 0.5;
                const x0 = gx | 0, y0 = gy | 0;
                const u = gx - x0, v = gy - y0;
                const j = y0 * W + x0;
                st = stationAt(track, fx, fy);
                side = (lat[j] * (1 - u) + lat[j + 1] * u) * (1 - v) + (lat[j + W] * (1 - u) + lat[j + W + 1] * u) * v;
              }
              c = this.groundColor(track, fx, fy, fw, s, k, st, side, light[i] * kerbShade);
            }
            c = mix(c, f);
            for (let y = sy; y < ybuf; y++) buf[y * w + x] = c;
          }
          ybuf = sy;
        }
        wasWall = isWall;
        prevS = s;
        prevZ = z;
        prevG = ground;
        z += step;
      }
      while (chk < NCHK) clip[base + chk++] = ybuf;
    }
  }

  // El "shader" del piso: dado un punto del mundo, devuelve su color ya iluminado.
  // s = distancia con signo al borde (positiva = sobre la pista), k = cuánto piano hay acá (0..1),
  // st = posición sobre la línea central (para las franjas del piano), side = distancia de costado a la línea central,
  // lit = luz del terreno en este punto (pendiente y lomo del piano).
  // De afuera hacia adentro: pasto | piano (sólo en curvas, por fuera del límite) | línea blanca | asfalto.
  // Es lo que más se ejecuta del render: sólo calcula el pasto o el asfalto si van a hacer falta, y cada color
  // se ilumina una sola vez.
  groundColor(track, fx, fy, fw, s, k, st, side, lit) {
    const { line } = track;
    // variación de brillo a gran escala, igual para pasto y asfalto
    const mc = this.macro;
    const light = lit * mc.data[((((fy * MACRO_TPC) | 0) & (mc.size - 1)) * mc.size) + (((fx * MACRO_TPC) | 0) & (mc.size - 1))];
    const isKerb = k > 0.02;
    const outer = isKerb ? -KERB_W * k : 0; // borde exterior de lo pintado (en las puntas, más angosto)

    let grass = 0;
    if (s < outer + fw) {
      // césped con franjas del corte, en diagonal; cerca del cambio de franja se mezclan para que no serruche
      const ph = (fx + fy) * (0.7071 / GRASS_BAND);
      const fr = ph - Math.floor(ph);
      const e = Math.min(0.5, fw / GRASS_BAND);
      let band = Math.floor(ph) & 1 ? 1 : 0;
      if (fr < e) band = band + (1 - 2 * band) * ((e - fr) / (2 * e));
      else if (fr > 1 - e) band = band + (1 - 2 * band) * ((fr - 1 + e) / (2 * e));
      grass = shade(sample(this.grass, fx * GRASS_TPC, fy * GRASS_TPC, fw * GRASS_TPC), light * (0.9 + band * 0.2));
      if (s < outer - fw) return grass;
    }

    let roadC = sample(this.asphalt, fx * ROAD_TPC, fy * ROAD_TPC, fw * ROAD_TPC);
    // goma: por donde pasaron las ruedas el asfalto está más oscuro
    const dark = this.rubber && st >= 0 ? RUBBER_DARK * RubberMap.sample(this.rubber, st, side) : 0;
    roadC = shade(roadC, light * (1 - dark));
    // línea de largada a cuadros
    const ax = fx - line.x, ay = fy - line.y;
    const a = ax * line.dx + ay * line.dy;
    if (a > -0.7 && a < 0.7) {
      const l = -ax * line.dy + ay * line.dx;
      if (l < line.half && l > -line.half) {
        roadC = shade(((((a + 0.7) * 2) | 0) + (((l + 200) * 2) | 0)) & 1 ? LINE_WHITE : LINE_BLACK, lit);
      }
    }
    // trazada ideal: una franja pintada sobre el asfalto, con el color que le toca en este cuadro
    const guide = this.guide;
    if (guide && s > 0 && st >= 0) {
      const u = st | 0;
      const d = Math.abs(side - guide.offset[u]);
      if (d < GUIDE_W + fw) roadC = blend(roadC, shade(guide.color[u], lit), 0.8 * Math.min(1, (GUIDE_W + fw - d) / (2 * fw)));
    }
    if (s > LINE_W + fw) return roadC;

    let kerbC = EDGE_WHITE;
    if (isKerb) {
      // franjas perpendiculares a la pista, según la posición sobre la línea central
      const ph = st / STRIPE;
      const fr = ph - Math.floor(ph);
      const cur = Math.floor(ph) & 1 ? KERB_RED : KERB_WHITE;
      const other = cur === KERB_RED ? KERB_WHITE : KERB_RED;
      const e = Math.min(0.5, fw / STRIPE);
      const ow = fr < e ? (e - fr) / (2 * e) : fr > 1 - e ? (fr - 1 + e) / (2 * e) : 0;
      kerbC = ow > 0 ? blend(cur, other, ow) : cur;
    }
    kerbC = shade(kerbC, lit);
    const edgeC = shade(EDGE_WHITE, lit);

    // antialiasing: cerca de un cambio de zona, mezclamos los dos colores
    let edge = outer;
    if (isKerb && Math.abs(s) < Math.abs(s - edge)) edge = 0;
    if (Math.abs(s - LINE_W) < Math.abs(s - edge)) edge = LINE_W;
    const zs = s - edge;
    if (zs > -fw && zs < fw) {
      const inner = zone(edge + fw, outer, grass, kerbC, roadC, edgeC);
      const outerC = zone(edge - fw, outer, grass, kerbC, roadC, edgeC);
      return blend(outerC, inner, (zs + fw) / (2 * fw));
    }
    return zone(s, outer, grass, kerbC, roadC, edgeC);
  }

  drawSprites(track, cam, sprites, models, dirX, dirY, planeX, planeY, horizon) {
    const { w, h, buf, P, clip } = this;
    const camZ = cam.z;
    const pl2 = this.planeLen * this.planeLen;
    const visible = [];
    for (const s of sprites) {
      const rx = s.x - cam.x, ry = s.y - cam.y;
      const depth = rx * dirX + ry * dirY;
      if (depth < 0.3 || depth > FOG_END) continue;
      const camX = (rx * planeX + ry * planeY) / (pl2 * depth);
      if (camX < -1.5 || camX > 1.5) continue;
      visible.push({ s, depth, camX });
    }
    // los modelos se ordenan junto con los sprites por la profundidad de su centro
    for (const m of models) {
      const rx = m.x - cam.x, ry = m.y - cam.y;
      const depth = rx * dirX + ry * dirY;
      if (depth < -3 || depth > FOG_END) continue;
      // lejos y fuera de la pantalla: no se dibuja (cerca puede asomar aunque el centro esté afuera)
      if (depth > 4 && Math.abs((rx * planeX + ry * planeY) / (pl2 * depth)) > 1.6) continue;
      visible.push({ s: m, depth, model: true });
    }
    visible.sort((a, b) => b.depth - a.depth);

    for (const { s, depth, camX, model } of visible) {
      if (model) {
        this.drawModel(track, cam, s, dirX, dirY, horizon);
        continue;
      }
      const tex = s.tex;
      const sw = (s.width * P) / depth;
      const sh = (s.height * P) / depth;
      const screenX = ((camX + 1) * w) / 2;
      const bottom = horizon + ((camZ - (s.z || 0)) * P) / depth;
      const top = bottom - sh;
      const x0 = Math.max(0, Math.ceil(screenX - sw / 2));
      const x1 = Math.min(w, Math.ceil(screenX + sw / 2));
      const f = fogFactor(depth);
      const alpha = s.alpha ?? 1;
      const di = Math.min(NCHK - 1, depth | 0);
      for (let x = x0; x < x1; x++) {
        // el terreno más cercano que el sprite lo tapa desde esta fila hacia abajo
        const yClip = clip[x * NCHK + di];
        const tx = Math.min(tex.w - 1, (((x - (screenX - sw / 2)) / sw) * tex.w) | 0);
        const y0 = Math.max(0, Math.ceil(top));
        const y1 = Math.min(yClip, h, Math.ceil(bottom));
        for (let y = y0; y < y1; y++) {
          const ty = Math.min(tex.h - 1, (((y - top) / sh) * tex.h) | 0);
          const c = tex.data[ty * tex.w + tx];
          if (c >>> 24 < 128) continue;
          const o = y * w + x;
          const col = mix(c | 0xff000000, f);
          buf[o] = alpha < 1 ? blend(buf[o], col, alpha) : col;
        }
      }
    }
  }

  // Un modelo 3D (el auto): se ubican sus vértices en el mundo, se proyectan con la misma cámara que el terreno
  // y se pintan sus caras con sombreado plano. Cada píxel guarda su profundidad (z-buffer) para que las piezas
  // de adelante tapen a las de atrás, y se compara con las marcas del terreno para que las lomas y los muros lo tapen.
  drawModel(track, cam, m, dirX, dirY, horizon) {
    const { w, h, buf, P, clip, mcol, miz } = this;
    const k = 1 / m.meters; // metros → celdas
    const ca = Math.cos(m.angle), sa = Math.sin(m.angle);
    const cp = Math.cos(m.pitch || 0), sp = Math.sin(m.pitch || 0);
    // ejes del auto en el mundo: adelante y arriba (con la pendiente) y derecha
    const Fx = ca * cp, Fy = sa * cp, Fz = sp;
    const Rx = -sa, Ry = ca, Rz = 0;
    const Ux = -ca * sp, Uy = -sa * sp, Uz = cp;
    // la carrocería (todo menos las ruedas) rola y cabecea sobre la suspensión, alrededor de BODY_PIVOT_Z
    const cr = Math.cos(m.roll || 0), sr = Math.sin(m.roll || 0), cd = Math.cos(m.dive || 0), sd = Math.sin(m.dive || 0);
    const lean = (lx, ly, lz, z0 = BODY_PIVOT_Z) => {
      const z = lz - z0;
      const y1 = ly * cr - z * sr, z1 = ly * sr + z * cr;
      return [lx * cd + z1 * sd, y1, z0 + z1 * cd - lx * sd];
    };
    // a coordenadas de cámara: d = profundidad, s = a la derecha, u = arriba; ta, tb = coordenadas en la textura
    const toCam = (X, Y, Z, ta = 0, tb = 0) => {
      const dx = X - cam.x, dy = Y - cam.y;
      return { d: dx * dirX + dy * dirY, s: dy * dirX - dx * dirY, u: Z - cam.z, ta, tb };
    };
    // en pantalla, 1/d y las coordenadas de textura divididas por d varían linealmente: se interpolan así
    // y en cada píxel se vuelve a dividir (corrección de perspectiva)
    const project = (p) => ({ x: w / 2 + (p.s * P) / p.d, y: horizon - (p.u * P) / p.d, iz: 1 / p.d, ia: p.ta / p.d, ib: p.tb / p.d });

    // sombra: el contorno del auto apoyado sobre el terreno, que oscurece lo que ya está dibujado
    if (m.shadow) {
      const ox = SHADOW_SHIFT * SUN[0] * k, oy = SHADOW_SHIFT * SUN[1] * k;
      const pts = SHADOW.map(([lx, ly]) => {
        const X = m.x + (ca * lx - sa * ly) * k + ox, Y = m.y + (sa * lx + ca * ly) * k + oy;
        return toCam(X, Y, sampleField(track.height, track.W, X, Y) + 0.02 * k);
      });
      const poly = clipNear(pts);
      if (poly.length > 2) {
        scan(poly.map(project), w, h, (x, y, iz) => {
          if (y >= clip[x * NCHK + Math.min(NCHK - 1, (1 / iz) | 0)]) return;
          buf[y * w + x] = shade(buf[y * w + x], 1 - 0.38 * (m.alpha ?? 1));
        });
      }
    }

    // 1) cada cara visible, recortada y proyectada, con su color ya iluminado y con niebla
    const polys = [];
    let bx0 = w, by0 = h, bx1 = -1, by1 = -1;
    const cs = Math.cos(m.spin || 0), ss = Math.sin(m.spin || 0);
    const st = m.steer || 0, cst = Math.cos(st), sst = Math.sin(st);
    // la rueda gira sobre su eje y, si es delantera, dobla con la dirección (sirve para puntos y para normales);
    // lo montado en la mangueta (fixed) sólo dobla
    const turn = (wh, lx, ly, lz, fixed) => {
      if (!fixed) {
        const ax = lx - wh.x, az = lz - wh.z;
        lx = wh.x + ax * cs + az * ss;
        lz = wh.z - ax * ss + az * cs;
      }
      if (wh.front) {
        // dobla sobre el eje de la mangueta, en la punta de los brazos de la suspensión
        const py = wh.y + (wh.pivot || 0), bx = lx - wh.x, by = ly - py;
        lx = wh.x + bx * cst - by * sst;
        ly = py + bx * sst + by * cst;
      }
      return [lx, ly, lz];
    };
    // la cabeza gira alrededor del cuello
    const ch = Math.cos(m.head || 0), sh = Math.sin(m.head || 0);
    // y se inclina con las fuerzas (headTilt: hacia el costado, como el rolido, y hacia adelante)
    const [hr, hp] = m.headTilt || [0, 0], chr = Math.cos(hr), shr = Math.sin(hr), chp = Math.cos(hp), shp = Math.sin(hp);
    const look = (hd, lx, ly, lz) => {
      const bx = lx - hd.x, by = ly - hd.y, bz = lz - (hd.z || 0);
      const x = bx * ch - by * sh, y = bx * sh + by * ch, y1 = y * chr - bz * shr, z1 = y * shr + bz * chr;
      return [hd.x + x * chp + z1 * shp, hd.y + y1, (hd.z || 0) + z1 * chp - x * shp];
    };
    // el volante gira alrededor de su columna (Rodrigues)
    // (f: qué parte del giro sigue; los antebrazos lo siguen de a poco, de la muñeca al codo)
    const wt = m.wheelTurn || 0;
    const column = (co, lx, ly, lz, f = 1) => {
      const ct = Math.cos(wt * f), stn = Math.sin(wt * f);
      const ax = co.ax, ay = co.ay, az = co.az, vx = lx - co.x, vy = ly - co.y, vz = lz - co.z;
      const d = (ax * vx + ay * vy + az * vz) * (1 - ct);
      return [co.x + vx * ct + (ay * vz - az * vy) * stn + ax * d, co.y + vy * ct + (az * vx - ax * vz) * stn + ay * d,
        co.z + vz * ct + (ax * vy - ay * vx) * stn + az * d];
    };
    // al cambiar, las levas y las manos se acercan al piloto sobre la columna
    const pulled = (co, part, [x, y, z]) => {
      const off = part.pull === undefined ? 0 : (m.paddle?.[part.side] || 0) * part.pull;
      return [x + co.ax * off, y + co.ay * off, z + co.az * off];
    };
    for (const part of m.model) {
      if (part.tag && part.tag === m.hide) continue;
      const wh = part.wheel, hd = part.head, co = part.column;
      const n = part.verts.length;
      const wx = new Float64Array(n), wy = new Float64Array(n), wz = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        const v = part.verts[i];
        const [lx, ly, lz] = wh ? turn(wh, ...v, part.fixed) : lean(...(hd ? look(hd, ...v) : co ? pulled(co, part, column(co, ...v, part.follow?.[i])) : v));
        wx[i] = m.x + (Fx * lx + Rx * ly + Ux * lz) * k;
        wy[i] = m.y + (Fy * lx + Ry * ly + Uy * lz) * k;
        wz[i] = m.z + (Fz * lx + Rz * ly + Uz * lz) * k;
      }
      for (const face of part.faces) {
        const idx = face.idx;
        // normal de la cara (viene del modelo, apuntando hacia afuera) llevada al mundo, y centro de la cara
        let [lx, ly, lz] = face.n;
        if (wh) [lx, ly, lz] = turn({ x: 0, y: 0, z: 0, front: wh.front }, lx, ly, lz, part.fixed);
        else {
          if (hd) [lx, ly, lz] = look({ x: 0, y: 0, z: 0 }, lx, ly, lz);
          if (co) [lx, ly, lz] = column({ ...co, x: 0, y: 0, z: 0 }, lx, ly, lz, part.follow ? idx.reduce((a, i) => a + part.follow[i], 0) / idx.length : 1);
          [lx, ly, lz] = lean(lx, ly, lz, 0);
        }
        const nx = Fx * lx + Rx * ly + Ux * lz, ny = Fy * lx + Ry * ly + Uy * lz, nz = Fz * lx + Rz * ly + Uz * lz;
        let fx = 0, fy = 0, fz = 0;
        for (const i of idx) { fx += wx[i]; fy += wy[i]; fz += wz[i]; }
        fx /= idx.length; fy /= idx.length; fz /= idx.length;
        // si mira para el otro lado de la cámara, no se ve
        if (nx * (fx - cam.x) + ny * (fy - cam.y) + nz * (fz - cam.z) >= 0) continue;
        // en el mapa y crece hacia abajo: el sol está hacia -x, -y
        const sun = -nx * SUN[0] - ny * SUN[1] + nz * SUN[2];
        const light = 0.5 + 0.6 * Math.max(0, sun) + 0.12 * nz;
        // la pantalla del volante, sin WebGL, queda apagada (su color)
        const tex = face.slot === 6 ? null : face.tex;
        const uv = tex ? face.uv : null;
        const poly = clipNear(idx.map((i, a) => (uv ? toCam(wx[i], wy[i], wz[i], uv[a][0], uv[a][1]) : toCam(wx[i], wy[i], wz[i]))));
        if (poly.length < 3) continue;
        const depth = (fx - cam.x) * dirX + (fy - cam.y) * dirY;
        const pts = poly.map(project);
        for (const p of pts) {
          if (p.x < bx0) bx0 = p.x;
          if (p.x > bx1) bx1 = p.x;
          if (p.y < by0) by0 = p.y;
          if (p.y > by1) by1 = p.y;
        }
        const fog = fogFactor(depth);
        // texeles que cubre un píxel de pantalla, para elegir el mipmap
        const fp = tex ? (face.dens * depth * m.meters) / P : 0;
        polys.push({ pts, color: mix(shade(face.color, light), fog), tex, fp, light, fog });
      }
    }
    if (!polys.length) return;

    // 2) se pintan en los buffers del modelo, quedándose en cada píxel con la cara más cercana
    bx0 = Math.max(0, Math.floor(bx0)); by0 = Math.max(0, Math.floor(by0));
    bx1 = Math.min(w - 1, Math.ceil(bx1)); by1 = Math.min(h - 1, Math.ceil(by1));
    if (bx0 > bx1 || by0 > by1) return;
    for (let y = by0; y <= by1; y++) miz.fill(0, y * w + bx0, y * w + bx1 + 1);
    for (const { pts, color, tex, fp, light, fog } of polys) {
      scan(pts, w, h, (x, y, iz, ia, ib) => {
        const o = y * w + x;
        if (iz <= miz[o]) return;
        // ¿lo tapa el terreno? (una loma o un muro más cerca que este punto)
        if (y >= clip[x * NCHK + Math.min(NCHK - 1, (1 / iz) | 0)]) return;
        miz[o] = iz;
        mcol[o] = tex ? mix(shade(sample(tex, ia / iz, ib / iz, fp), light), fog) : color;
      });
    }

    // 3) se pasa a la imagen; el fantasma, semitransparente
    const alpha = m.alpha ?? 1;
    for (let y = by0; y <= by1; y++) {
      for (let o = y * w + bx0, end = y * w + bx1; o <= end; o++) {
        if (miz[o] > 0) buf[o] = alpha < 1 ? blend(buf[o], mcol[o], alpha) : mcol[o];
      }
    }
  }
}

// Recorta un polígono (en coordenadas de cámara) para quedarse con la parte delante de la cámara
function clipNear(pts) {
  const out = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    const ina = a.d >= MODEL_NEAR, inb = b.d >= MODEL_NEAR;
    if (ina) out.push(a);
    if (ina !== inb) {
      const t = (MODEL_NEAR - a.d) / (b.d - a.d);
      const l = (k) => a[k] + (b[k] - a[k]) * t;
      out.push({ d: MODEL_NEAR, s: l('s'), u: l('u'), ta: l('ta'), tb: l('tb') });
    }
  }
  return out;
}

// Rellena un polígono convexo en pantalla, fila por fila, tomando los píxeles cuyo centro cae adentro.
// Interpola 1/profundidad (iz) y las coordenadas de textura divididas por la profundidad (ia, ib), que varían
// linealmente en la pantalla. plot(x, y, iz, ia, ib) por cada píxel.
function scan(pts, w, h, plot) {
  let top = Infinity, bottom = -Infinity;
  for (const p of pts) {
    if (p.y < top) top = p.y;
    if (p.y > bottom) bottom = p.y;
  }
  const n = pts.length;
  const ya = Math.max(0, Math.ceil(top - 0.5)), yb = Math.min(h - 1, Math.ceil(bottom - 0.5) - 1);
  for (let y = ya; y <= yb; y++) {
    const yc = y + 0.5;
    let xl = Infinity, xr = -Infinity, zl = 0, zr = 0, al = 0, ar = 0, bl = 0, br = 0;
    for (let i = 0; i < n; i++) {
      const a = pts[i], b = pts[(i + 1) % n];
      if (a.y <= yc === b.y <= yc) continue;
      const t = (yc - a.y) / (b.y - a.y);
      const x = a.x + (b.x - a.x) * t;
      if (x < xl) { xl = x; zl = a.iz + (b.iz - a.iz) * t; al = a.ia + (b.ia - a.ia) * t; bl = a.ib + (b.ib - a.ib) * t; }
      if (x > xr) { xr = x; zr = a.iz + (b.iz - a.iz) * t; ar = a.ia + (b.ia - a.ia) * t; br = a.ib + (b.ib - a.ib) * t; }
    }
    if (!(xl < xr)) continue;
    const span = xr - xl;
    const dz = (zr - zl) / span, da = (ar - al) / span, db = (br - bl) / span;
    const xa = Math.max(0, Math.ceil(xl - 0.5)), xb = Math.min(w - 1, Math.ceil(xr - 0.5) - 1);
    for (let x = xa; x <= xb; x++) {
      const f = x + 0.5 - xl;
      plot(x, y, zl + f * dz, al + f * da, bl + f * db);
    }
  }
}

// Reparte el cielo y el terreno entre varios workers (src/terrainworker.js): cada uno dibuja una franja de
// columnas de la pantalla en su propio núcleo y devuelve sus píxeles y sus marcas de profundidad.
// Si algo falla (el navegador no tiene workers de módulos, por ejemplo), se vuelve a dibujar todo acá.
class TerrainPool {
  static create(w, h) {
    if (typeof Worker === 'undefined') return null;
    const n = Math.max(1, Math.min(6, (navigator.hardwareConcurrency || 2) - 1));
    if (n < 2) return null;
    try {
      return new TerrainPool(w, h, n);
    } catch {
      return null;
    }
  }

  constructor(w, h, n) {
    this.w = w;
    this.h = h;
    this.track = null;
    this.failed = false;
    this.parts = [];
    for (let k = 0; k < n; k++) {
      const x0 = Math.round((k * w) / n), x1 = Math.round(((k + 1) * w) / n);
      const worker = new Worker(new URL('./terrainworker.js', import.meta.url), { type: 'module' });
      // buffers que van y vuelven en cada cuadro (se transfieren, no se copian)
      const part = { worker, x0, x1, pix: new Uint32Array((x1 - x0) * h), clip: new Int16Array((x1 - x0) * NCHK), done: null };
      worker.onmessage = (e) => part.done?.(e.data);
      worker.onerror = () => {
        this.failed = true;
        part.done?.(null);
      };
      worker.postMessage({ type: 'init', w, h, x0, x1 });
      this.parts.push(part);
    }
  }

  // Dibuja cielo y terreno en r.buf y r.clip. Devuelve false si no se pudo (y hay que dibujar en el hilo principal).
  async draw(r, track, cam, horizon) {
    if (this.failed) return false;
    const offset = (r.guide && r.guide.offset) || null;
    if (track !== this.track || offset !== this.offset) {
      // el circuito (y por dónde pasa la trazada) se manda una sola vez, copiado a cada worker
      const { W, H, height, sdf, lat, station, kerbLeft, kerbRight, runoff, line } = track;
      const data = { W, H, height, sdf, lat, station, kerbLeft, kerbRight, runoff, line };
      for (const p of this.parts) p.worker.postMessage({ type: 'track', track: data, offset });
      this.track = track;
      this.offset = offset;
    }
    const frame = {
      type: 'frame',
      cam: { x: cam.x, y: cam.y, z: cam.z, ground: cam.ground, angle: cam.angle },
      zoom: cam.zoom || 1,
      horizon,
      guideColor: r.guide ? r.guide.color.slice() : null,
      // la goma: una copia cuando cambia (cada medio segundo), si no `true` (la misma de antes) o null (sin goma)
      rubber: r.rubber ? true : null,
    };
    const m = r.rubber;
    if (m && (m !== this.rubberMap || m.version !== this.rubberVersion)) {
      frame.rubber = { length: m.length, rows: m.rows, lanes: m.lanes, span: m.span, bytes: m.bytes };
      this.rubberMap = m;
      this.rubberVersion = m.version;
    }
    const results = await Promise.all(this.parts.map((p) => new Promise((resolve) => {
      p.done = resolve;
      p.worker.postMessage({ ...frame, pix: p.pix, clip: p.clip }, [p.pix.buffer, p.clip.buffer]);
    })));
    if (results.includes(null)) return false;
    const { w, h } = this;
    results.forEach(({ pix, clip }, k) => {
      const p = this.parts[k];
      const sw = p.x1 - p.x0;
      for (let y = 0; y < h; y++) r.buf.set(pix.subarray(y * sw, (y + 1) * sw), y * w + p.x0);
      r.clip.set(clip, p.x0 * NCHK);
      p.pix = pix;
      p.clip = clip;
    });
    return true;
  }
}
