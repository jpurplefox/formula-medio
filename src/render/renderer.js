// "Voxel Space" rendering (the Comanche technique, 1992), a cousin of the Wolfenstein 3D raycaster.
// For each screen column a ray is cast over the map, from near to far.
// At each step it reads the terrain height and paints the part of the column that was not
// covered yet (y-buffer). That way hills hide what is behind them.
// Drawing order: sky → terrain (with walls as steps) → sprites and 3D models, from far to near.

import {
  DEFAULT_KERB,
  KERB_H,
  KERB_STYLE,
  RIDGE,
  SAUSAGE_H,
  SAUSAGE_W,
  edgeReach,
  kerbLift,
  stationAt,
  kerbAmount,
  runoffAt,
  sampleField,
} from '../sim/track.js';
import { asphaltTexture, grassTexture, gravelTexture, macroNoise, sample, wallTexture } from './textures.js';
import { RUBBER_DARK, RubberMap } from '../sim/rubber.js';

export const MAX_DIST = 140;
export const FOG_START = 25;
export const FOG_END = 130;
export const Z_NEAR = 0.6;
export const WALL_H = 0.32; // wall height (in cells)
export const WALL_T = 0.5; // wall thickness (in cells)
export const WALL_STRIPE = 1.2; // length of each wall stripe (in cells)
export { KERB_H }; // kerb hump height (in cells; it is in track.js, with the rest of the kerb)
export const LINE_W = 0.22; // width of the white edge line (in cells)
export const GUIDE_W = 0.2; // half width of the racing line (in cells)
export const ROAD_TPC = 64; // asphalt texels per cell (the texture tiles every 4 cells, ~10 m)
export const GRASS_TPC = 32; // grass texels per cell
export const GRAVEL_TPC = 48; // gravel texels per cell
export const RUNOFF_LIGHT = 1.15; // the paved runoff, lighter than the track (it has no rubber)
export const GRASS_BAND = 2.2; // width of each mowing stripe of the grass (in cells)
export const MACRO_TPC = 2; // samples of the large-scale variation per cell (it tiles every 32 cells, ~80 m)
export const PLANE_LEN = 0.7; // half width of the camera plane at distance 1: field of view of about 70°
const NCHK = MAX_DIST + 2; // depth marks per column for clipping sprites
export const NEAR_RISE = 0.2; // how far terrain (or a wall) can rise near the camera (cells), to know where rays start
const MAX_STEP_GROWTH = 0.025; // in the distance, how much the maximum ray step grows per cell of distance
export const MODEL_NEAR = 0.05; // model faces are clipped at this distance from the camera (in cells)
export const BODY_PIVOT_Z = 0.3; // m: height of the axis the bodywork rolls and pitches on (roll center)
export const SUN = [0.45, 0.6, 0.66]; // where the sun is (top left of the map, like the terrain shading)
export const SHADOW_SHIFT = 0.35; // how far the car's shadow shifts, away from the sun (m)
// outline of the car's shadow seen from above (m): front wing, body, rear wing
export const SHADOW = [
  [2.75, -0.95],
  [2.75, 0.95],
  [1.9, 1.0],
  [-2.0, 1.0],
  [-2.75, 0.55],
  [-2.75, -0.55],
  [-2.0, -1.0],
  [1.9, -1.0],
];

export const rgb = (r, g, b) => (0xff000000 | (b << 16) | (g << 8) | r) >>> 0;

const FR = 196,
  FG = 214,
  FB = 230;
const FOG = rgb(FR, FG, FB);
const EDGE_WHITE = rgb(225, 225, 225);
const KERB_GREEN = rgb(46, 135, 80); // abrasive green band behind the kerb
const SAUSAGE_YELLOW = rgb(245, 196, 20);
const DIRT = rgb(120, 96, 62); // dirt the wheels bring in from the grass
const KERB_RUBBER = rgb(25, 25, 25);
// kerb wear: where there is rubber (on the track side) and dirt (on the grass side)
export const KERB_RUBBER_MAX = 0.45; // the most the rubber darkens
export const KERB_DIRT_MAX = 0.5; // the most the dirt covers
export const WEAR_CELL = 0.4; // length of each mark (cells)
// random value (0..1) fixed for each integer, the same as in the glrenderer.js shader
export const hash = (i) => {
  const x = Math.sin(i * 12.9898) * 43758.5453;
  return x - Math.floor(x);
};
const smooth = (a, b, x) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const LINE_BLACK = rgb(20, 20, 20);
const LINE_WHITE = rgb(245, 245, 245);
const WALL_TOP = rgb(150, 150, 155);

// the track's kerb colors, already packed (computed once per track)
const kerbCache = new WeakMap();
function kerbColors(track) {
  let c = kerbCache.get(track);
  if (!c) kerbCache.set(track, (c = (track.kerbColors ?? DEFAULT_KERB).map(([r, g, b]) => rgb(r, g, b))));
  return c;
}

function mix(c, f) {
  if (f <= 0) return c;
  if (f >= 256) return FOG;
  const r = c & 255,
    g = (c >>> 8) & 255,
    b = (c >>> 16) & 255;
  return (
    0xff000000 | ((b + (((FB - b) * f) >> 8)) << 16) | ((g + (((FG - g) * f) >> 8)) << 8) | (r + (((FR - r) * f) >> 8))
  );
}

function shade(c, k) {
  const r = Math.min(255, (c & 255) * k),
    g = Math.min(255, ((c >>> 8) & 255) * k),
    b = Math.min(255, ((c >>> 16) & 255) * k);
  return rgb(r | 0, g | 0, b | 0);
}

function blend(a, b, t) {
  const r = (a & 255) * (1 - t) + (b & 255) * t;
  const g = ((a >>> 8) & 255) * (1 - t) + ((b >>> 8) & 255) * t;
  const bl = ((a >>> 16) & 255) * (1 - t) + ((b >>> 16) & 255) * t;
  return rgb(r | 0, g | 0, bl | 0);
}

// color of a roadside zone given the distance s to the track limit
// sb, gb, kb, lb: edges of the roadside bands (from outside in: sausage kerb, green, kerb, white line);
// c: their colors, plus grass and asphalt
function zone(s, sb, gb, kb, lb, c) {
  if (s < sb) return c.grass;
  if (s < gb) return c.sausage;
  if (s < kb) return c.green;
  if (s < 0) return c.kerb;
  if (s < lb) return c.edge;
  return c.road;
}

function fogFactor(d) {
  if (d <= FOG_START) return 0;
  if (d >= FOG_END) return 256;
  const t = (d - FOG_START) / (FOG_END - FOG_START);
  return (t * t * 256) | 0;
}

// Slope lighting: slopes facing the "sun" get lighter and the others darker
function lightField(track) {
  const { W, H, height } = track;
  const light = new Float32Array(W * H).fill(1);
  const lx = -0.6,
    ly = -0.8; // the sun comes from the top left of the map
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
  // canvas: the canvas to draw on. In a worker there is no canvas: { width, height } is passed and it only draws
  // in memory (sky and terrain for a range of columns).
  constructor(canvas) {
    this.w = canvas.width;
    this.h = canvas.height;
    if (canvas.getContext) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.image = this.ctx.createImageData(this.w, this.h);
      this.buf = new Uint32Array(this.image.data.buffer);
      // 3D model buffers: color and 1/depth (z-buffer) of what is drawn of each model
      this.mcol = new Uint32Array(this.w * this.h);
      this.miz = new Float32Array(this.w * this.h);
      // the sky and terrain are split among several workers (one per core), if the browser has them
      this.pool = TerrainPool.create(this.w, this.h);
    } else {
      this.buf = new Uint32Array(this.w * this.h);
    }
    this.setZoom(1);

    // per column: down to which row the drawn terrain reached at each integer depth
    this.clip = new Int16Array(this.w * NCHK);

    this.asphalt = asphaltTexture();
    this.grass = grassTexture();
    this.gravel = gravelTexture();
    this.macro = macroNoise();
    this.wall = wallTexture();

    this.mountains = new Float32Array(1024);
    for (let i = 0; i < 1024; i++) {
      const a = (i / 1024) * Math.PI * 2;
      this.mountains[i] = 0.5 + 0.25 * Math.sin(a * 3 + 1) + 0.15 * Math.sin(a * 7 + 2) + 0.1 * Math.sin(a * 17);
    }
    this.lightFor = new WeakMap();
    this.guide = null; // racing line ({ offset, color } per centerline cell), or null
    this.rubber = null; // the rubber on the asphalt (RubberMap from rubber.js, or what was copied to a worker)
  }

  // models: 3D cars, each { model, x, y, z, angle, pitch, roll, dive, steer, spin, head, alpha, shadow, hide, meters }
  // (pitch: the slope, tilts the whole car; roll and dive: roll and pitch of the bodywork on the suspension)
  // (steer: front wheel angle; head: where the driver turns his head, in rad, + to the right;
  // wear and shine: tyre wear and shine, 0..1, only with WebGL)
  // (hide: the tag of the pieces that are not drawn, for example the helmet seen from inside)
  // zoom: 1 = normal field of view; 2 = half the width (everything looks twice as large), like a telephoto lens
  setZoom(zoom) {
    this.planeLen = PLANE_LEN / zoom;
    this.P = this.w / 2 / this.planeLen; // pixels per unit at distance 1
  }

  // Returns a promise: the sky and terrain may be drawing in the workers.
  // cam: { x, y, z, ground, angle, pitch, zoom? }
  async render(track, cam, sprites, models = []) {
    this.setZoom(cam.zoom || 1);
    const dirX = Math.cos(cam.angle),
      dirY = Math.sin(cam.angle);
    const planeX = -dirY * this.planeLen,
      planeY = dirX * this.planeLen;
    const horizon = this.h / 2 + (cam.pitch || 0);

    if (!(this.pool && (await this.pool.draw(this, track, cam, horizon)))) {
      this.drawColumns(track, cam, horizon, 0, this.w);
    }
    this.drawSprites(track, cam, sprites, models, dirX, dirY, planeX, planeY, horizon);

    this.ctx.putImageData(this.image, 0, 0);
  }

  // sky and terrain for columns x0..x1 (in a worker, only its part of the screen)
  drawColumns(track, cam, horizon, x0, x1) {
    const dirX = Math.cos(cam.angle),
      dirY = Math.sin(cam.angle);
    const planeX = -dirY * this.planeLen,
      planeY = dirX * this.planeLen;
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
      const i = (((((a / (Math.PI * 2)) * 1024) | 0) % 1024) + 1024) % 1024;
      const mh = this.mountains[i] * h * 0.09;
      for (let y = 0; y < hy; y++) {
        const dy = horizon - y;
        buf[y * w + x] = dy < mh ? mix(mtn, ((1 - dy / mh) * 200) | 0) : skyRow[y];
      }
      // whatever is left below the horizon without terrain is distant fog
      for (let y = hy; y < h; y++) buf[y * w + x] = FOG;
    }
  }

  drawTerrain(track, cam, dirX, dirY, planeX, planeY, horizon, x0, x1) {
    const { w, h, buf, P, clip } = this;
    const { W, H, height, sdf, lat, kerbLeft, kerbRight, sausageLeft, sausageRight } = track;
    const style = track.kerbStyle ?? KERB_STYLE,
      reach = edgeReach(style);
    const near = Math.max(reach + 1, track.runoff + 0.5); // how far we need to know where we are
    // the wall is the continuous band that starts `runoff` cells from the track edge
    const wallIn = -track.runoff,
      wallOut = wallIn - WALL_T;
    const light = this.lightFor.get(track);
    const camZ = cam.z;
    const invCP = 1 / (Math.max(0.3, cam.z - cam.ground) * P);
    const pl = this.planeLen;
    // whatever is closer than this is below the bottom edge of the screen (even if the ground rises a bit or there is a
    // wall): the rays start there
    const zStart = Math.max(Z_NEAR, ((camZ - cam.ground - NEAR_RISE) * P) / (h - horizon));
    const lazyStation = this.guide || this.rubber;

    for (let x = x0; x < x1; x++) {
      const cx = (2 * x) / w - 1;
      const rdx = dirX + planeX * cx,
        rdy = dirY + planeY * cx;
      const base = x * NCHK;
      let ybuf = h;
      let chk = 0;
      let wasWall = false;
      let prevS = NaN,
        prevZ = 0,
        prevG = 0;
      let wallDone = false; // the current wall was fully drawn on entering

      for (let z = zStart; z < MAX_DIST && ybuf > 0;) {
        while (chk <= z && chk < NCHK) clip[base + chk++] = ybuf;

        // adaptive step: fine up close (≈1 screen pixel), longer far away
        let step = z * z * invCP;
        if (step < 0.01) step = 0.01;
        const maxStep = 0.15 + z * MAX_STEP_GROWTH;
        if (step > maxStep) step = maxStep;

        const fx = cam.x + rdx * z,
          fy = cam.y + rdy * z;
        let ground,
          isWall = false,
          ix,
          iy,
          i;
        let s = -1e9,
          k = 0,
          q = 0,
          st = -1,
          side = 0,
          kerbShade = 1;
        if (fx < 1 || fy < 1 || fx >= W - 1 || fy >= H - 1) {
          ix = Math.min(W - 1, Math.max(0, fx | 0));
          iy = Math.min(H - 1, Math.max(0, fy | 0));
          i = iy * W + ix;
          ground = height[i];
        } else {
          ix = fx | 0;
          iy = fy | 0;
          i = iy * W + ix;
          const gx = fx - 0.5,
            gy = fy - 0.5;
          const x0 = gx | 0,
            y0 = gy | 0;
          const u = gx - x0,
            v = gy - y0;
          const j = y0 * W + x0;
          const a = (1 - u) * (1 - v),
            b = u * (1 - v),
            c = (1 - u) * v,
            d = u * v;
          ground = height[j] * a + height[j + 1] * b + height[j + W] * c + height[j + W + 1] * d;
          s = sdf[j] * a + sdf[j + 1] * b + sdf[j + W] * c + sdf[j + W + 1] * d;
          // near the edge and in the runoff: where we are on the centerline and on which side, to know if
          // there is a kerb (and green and sausage kerb) and what is outside (on the rest of the track, for the racing
          // line and the rubber, it is computed only if the sample gets painted)
          if (s > -near && s < 1) {
            st = stationAt(track, fx, fy);
            side = lat[j] * a + lat[j + 1] * b + lat[j + W] * c + lat[j + W + 1] * d;
            if (st >= 0) {
              k = kerbAmount(side > 0 ? kerbRight : kerbLeft, st);
              if (sausageLeft) q = kerbAmount(side > 0 ? sausageRight : sausageLeft, st);
            }
          }
          // the kerb is a hump outside the edge (with a sawtooth, see kerbLift); behind it, the green (flat) and, in
          // some corners, the sausage kerb: another hump, taller and narrower
          if (k > 0 && s < 0) {
            const kb = -style.width * k,
              gb = kb - style.green * k,
              sb = gb - SAUSAGE_W * q;
            if (s > kb) {
              ground += kerbLift(s, kb, k, st);
              kerbShade = 1 - 0.22 * Math.cos((Math.PI * (s - kb)) / -kb); // track-facing side, brighter
            } else if (q > 0.02 && s < gb && s > sb) {
              const t = (s - sb) / (gb - sb);
              ground += SAUSAGE_H * q * Math.sin(Math.PI * t);
              kerbShade = 1 - 0.3 * Math.cos(Math.PI * t);
            }
          }
          // wall: we are inside the band, or the step crossed it entirely (far away, with long steps)
          isWall = (s < wallIn && s > wallOut) || (prevS > wallIn && s <= wallOut);
        }

        // the wall face goes where the ray exactly crosses the edge of the band, not at the sample
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
          // the wall was fully drawn (face and top) on entering: these samples add nothing
        } else if (sy < ybuf) {
          const f = fogFactor(z);
          if (entering) {
            // front face of the barrier, with its texture: along, by position on the centerline;
            // vertically, from the top edge of the face down to the ground
            const a = Math.max(0, stationAt(track, cam.x + rdx * zf, cam.y + rdy * zf));
            const wt = this.wall.size;
            const faceH = (WALL_H * P) / zf;
            const u = a * (wt / (2 * WALL_STRIPE));
            const fp = Math.max(((zf * pl) / w) * (wt / (2 * WALL_STRIPE)), wt / faceH);
            for (let y = sy; y < ybuf; y++) {
              const v = Math.min(wt - 1, ((y - syf) / faceH) * wt);
              buf[y * w + x] = mix(sample(this.wall, u, v, fp), f);
            }
            // top: from the face to where the ray leaves the band (by how much s changes per step)
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
              // the camera started inside the wall: we paint it sample by sample
              c = WALL_TOP;
            } else {
              const fw = Math.max(0.03, (z * pl) / w, step * 0.5);
              if (st < 0 && s >= 1 && lazyStation) {
                const gx = fx - 0.5,
                  gy = fy - 0.5;
                const x0 = gx | 0,
                  y0 = gy | 0;
                const u = gx - x0,
                  v = gy - y0;
                const j = y0 * W + x0;
                st = stationAt(track, fx, fy);
                side = (lat[j] * (1 - u) + lat[j + 1] * u) * (1 - v) + (lat[j + W] * (1 - u) + lat[j + W + 1] * u) * v;
              }
              c = this.groundColor(track, fx, fy, fw, s, k, st, side, light[i] * kerbShade, q);
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

  // The ground "shader": given a world point, returns its color already lit.
  // s = signed distance to the edge (positive = on the track), k = how much kerb there is here (0..1),
  // st = position on the centerline (for the kerb stripes), side = lateral distance to the centerline,
  // lit = terrain light at this point (slope and kerb hump).
  // From outside in: grass, gravel or runoff asphalt | kerb (only in corners, outside the limit) | white line |
  // asphalt. It is the most executed part of the renderer: it only computes the grass or the asphalt if they will be
  // needed, and each color is lit only once.
  groundColor(track, fx, fy, fw, s, k, st, side, lit, q = 0) {
    const { line } = track;
    const style = track.kerbStyle ?? KERB_STYLE;
    // large-scale brightness variation, the same for grass and asphalt
    const mc = this.macro;
    const light =
      lit * mc.data[(((fy * MACRO_TPC) | 0) & (mc.size - 1)) * mc.size + (((fx * MACRO_TPC) | 0) & (mc.size - 1))];
    const isKerb = k > 0.02,
      isSausage = isKerb && q > 0.02;
    // edges of the painted parts (narrower at the ends): kerb, green, sausage kerb, and the white line inside
    const kb = isKerb ? -style.width * k : 0;
    const gb = isKerb ? kb - style.green * k : 0;
    const outer = isSausage ? gb - SAUSAGE_W * q : gb,
      lb = isKerb && !style.line ? 0 : LINE_W;

    let grass = 0;
    if (s < outer + fw) {
      // the outside: grass, gravel or asphalt (lighter than the track's: it has no rubber), depending on the runoff
      // on that side in that segment (RUNOFF in track.js), up to the wall; beyond it, grass
      const mat = st >= 0 && s > -track.runoff ? runoffAt(side > 0 ? track.runoffRight : track.runoffLeft, st) : 0;
      if (mat === 2)
        grass = shade(sample(this.asphalt, fx * ROAD_TPC, fy * ROAD_TPC, fw * ROAD_TPC), light * RUNOFF_LIGHT);
      else if (mat === 1) grass = shade(sample(this.gravel, fx * GRAVEL_TPC, fy * GRAVEL_TPC, fw * GRAVEL_TPC), light);
      else {
        // grass with diagonal mowing stripes; near a stripe change they blend so it doesn't look jagged
        const ph = (fx + fy) * (0.7071 / GRASS_BAND);
        const fr = ph - Math.floor(ph);
        const e = Math.min(0.5, fw / GRASS_BAND);
        let band = Math.floor(ph) & 1 ? 1 : 0;
        if (fr < e) band = band + (1 - 2 * band) * ((e - fr) / (2 * e));
        else if (fr > 1 - e) band = band + (1 - 2 * band) * ((fr - 1 + e) / (2 * e));
        grass = shade(sample(this.grass, fx * GRASS_TPC, fy * GRASS_TPC, fw * GRASS_TPC), light * (0.9 + band * 0.2));
      }
      if (s < outer - fw) return grass;
    }

    const asphalt = sample(this.asphalt, fx * ROAD_TPC, fy * ROAD_TPC, fw * ROAD_TPC);
    // rubber: where the wheels have passed the asphalt (and the kerb) is darker
    const dark = this.rubber && st >= 0 ? RUBBER_DARK * RubberMap.sample(this.rubber, st, side) : 0;
    let roadC = shade(asphalt, light * (1 - dark));
    // checkered start line
    const ax = fx - line.x,
      ay = fy - line.y;
    const a = ax * line.dx + ay * line.dy;
    if (a > -0.7 && a < 0.7) {
      const l = -ax * line.dy + ay * line.dx;
      if (l < line.half && l > -line.half) {
        roadC = shade(((((a + 0.7) * 2) | 0) + (((l + 200) * 2) | 0)) & 1 ? LINE_WHITE : LINE_BLACK, lit);
      }
    }
    // racing line: a band painted on the asphalt, with the color it gets this frame
    const guide = this.guide;
    if (guide && s > 0 && st >= 0) {
      const u = st | 0;
      const d = Math.abs(side - guide.offset[u]);
      if (d < GUIDE_W + fw)
        roadC = blend(roadC, shade(guide.color[u], lit), 0.8 * Math.min(1, (GUIDE_W + fw - d) / (2 * fw)));
    }
    if (s > lb + fw) return roadC;

    let kerbC = EDGE_WHITE,
      greenC = KERB_GREEN,
      sausageC = SAUSAGE_YELLOW;
    if (isKerb) {
      // stripes perpendicular to the track, by position on the centerline
      // the track's colors repeat in order; at the edge between stripes it blends with the neighbor
      const cols = kerbColors(track);
      const n = cols.length,
        stripe = style.stripe;
      const ph = st / stripe;
      const i = Math.floor(ph);
      const fr = ph - i;
      const cur = cols[((i % n) + n) % n];
      const e = Math.min(0.5, fw / stripe);
      const ow = fr < e ? (e - fr) / (2 * e) : fr > 1 - e ? (fr - 1 + e) / (2 * e) : 0;
      const other = cols[(((fr < e ? i - 1 : i + 1) % n) + n) % n];
      kerbC = ow > 0 ? blend(cur, other, ow) : cur;
      // wear: rubber marks on the track side and dirt on the grass side (from afar, the average)
      const t = Math.max(0, Math.min(1, (s - kb) / -kb));
      const fade = Math.max(0, Math.min(1, 1 - fw / WEAR_CELL));
      const cell = Math.floor(st / WEAR_CELL) + (side > 0 ? 7919 : 0);
      const n1 = 0.5 + (hash(cell) - 0.5) * fade,
        n2 = 0.5 + (hash(cell + 101) - 0.5) * fade;
      kerbC = blend(kerbC, KERB_RUBBER, KERB_RUBBER_MAX * smooth(0.35, 1, t) * n1);
      kerbC = blend(kerbC, DIRT, KERB_DIRT_MAX * (1 - smooth(0, 0.4, t)) * n2 * n2);
      // sawtooth: the steep face of each step is in shadow (from afar it can't be told apart)
      const r = st / RIDGE - Math.floor(st / RIDGE);
      const ridge = 1 + ((r < 0.8 ? 1.05 : 0.75) - 1) * Math.max(0, Math.min(1, 1 - (2 * fw) / RIDGE));
      kerbC = shade(kerbC, light * (1 - dark) * ridge);
      // the green: paint on the asphalt (the grain shows)
      greenC = shade(blend(asphalt, KERB_GREEN, 0.75), light);
      if (isSausage) sausageC = shade(SAUSAGE_YELLOW, lit); // the sausage kerb, yellow
    }
    const edgeC = shade(EDGE_WHITE, lit);
    const c = { grass, sausage: sausageC, green: greenC, kerb: kerbC, edge: edgeC, road: roadC };

    // antialiasing: near a zone change, we blend the two colors
    let edge = outer;
    const near = (e) => {
      if (Math.abs(s - e) < Math.abs(s - edge)) edge = e;
    };
    if (isKerb) {
      near(gb);
      near(kb);
      near(0);
    }
    near(lb);
    const zs = s - edge;
    if (zs > -fw && zs < fw)
      return blend(zone(edge - fw, outer, gb, kb, lb, c), zone(edge + fw, outer, gb, kb, lb, c), (zs + fw) / (2 * fw));
    return zone(s, outer, gb, kb, lb, c);
  }

  drawSprites(track, cam, sprites, models, dirX, dirY, planeX, planeY, horizon) {
    const { w, h, buf, P, clip } = this;
    const camZ = cam.z;
    const pl2 = this.planeLen * this.planeLen;
    const visible = [];
    for (const s of sprites) {
      const rx = s.x - cam.x,
        ry = s.y - cam.y;
      const depth = rx * dirX + ry * dirY;
      if (depth < 0.3 || depth > FOG_END) continue;
      const camX = (rx * planeX + ry * planeY) / (pl2 * depth);
      if (camX < -1.5 || camX > 1.5) continue;
      visible.push({ s, depth, camX });
    }
    // models are sorted together with the sprites by the depth of their center
    for (const m of models) {
      const rx = m.x - cam.x,
        ry = m.y - cam.y;
      const depth = rx * dirX + ry * dirY;
      if (depth < -3 || depth > FOG_END) continue;
      // far away and off screen: not drawn (up close it may show even if the center is outside)
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
        // the terrain closer than the sprite hides it from this row down
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

  // A 3D model (the car): its vertices are placed in the world, projected with the same camera as the terrain
  // and its faces painted with flat shading. Each pixel stores its depth (z-buffer) so the front pieces
  // hide the back ones, and it is compared with the terrain marks so hills and walls hide it.
  drawModel(track, cam, m, dirX, dirY, horizon) {
    const { w, h, buf, P, clip, mcol, miz } = this;
    const k = 1 / m.meters; // meters → cells
    const ca = Math.cos(m.angle),
      sa = Math.sin(m.angle);
    const cp = Math.cos(m.pitch || 0),
      sp = Math.sin(m.pitch || 0);
    // car axes in the world: forward and up (with the slope) and right
    const Fx = ca * cp,
      Fy = sa * cp,
      Fz = sp;
    const Rx = -sa,
      Ry = ca,
      Rz = 0;
    const Ux = -ca * sp,
      Uy = -sa * sp,
      Uz = cp;
    // the bodywork (everything except the wheels) rolls and pitches on the suspension, around BODY_PIVOT_Z
    const cr = Math.cos(m.roll || 0),
      sr = Math.sin(m.roll || 0),
      cd = Math.cos(m.dive || 0),
      sd = Math.sin(m.dive || 0);
    const lean = (lx, ly, lz, z0 = BODY_PIVOT_Z) => {
      const z = lz - z0;
      const y1 = ly * cr - z * sr,
        z1 = ly * sr + z * cr;
      return [lx * cd + z1 * sd, y1, z0 + z1 * cd - lx * sd];
    };
    // to camera coordinates: d = depth, s = right, u = up; ta, tb = texture coordinates
    const toCam = (X, Y, Z, ta = 0, tb = 0) => {
      const dx = X - cam.x,
        dy = Y - cam.y;
      return { d: dx * dirX + dy * dirY, s: dy * dirX - dx * dirY, u: Z - cam.z, ta, tb };
    };
    // on screen, 1/d and the texture coordinates divided by d vary linearly: they are interpolated like that
    // and divided again at each pixel (perspective correction)
    const project = (p) => ({
      x: w / 2 + (p.s * P) / p.d,
      y: horizon - (p.u * P) / p.d,
      iz: 1 / p.d,
      ia: p.ta / p.d,
      ib: p.tb / p.d,
    });

    // shadow: the car's outline resting on the terrain, darkening what is already drawn
    if (m.shadow) {
      const ox = SHADOW_SHIFT * SUN[0] * k,
        oy = SHADOW_SHIFT * SUN[1] * k;
      const pts = SHADOW.map(([lx, ly]) => {
        const X = m.x + (ca * lx - sa * ly) * k + ox,
          Y = m.y + (sa * lx + ca * ly) * k + oy;
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

    // 1) each visible face, clipped and projected, with its color already lit and with fog
    const polys = [];
    let bx0 = w,
      by0 = h,
      bx1 = -1,
      by1 = -1;
    const cs = Math.cos(m.spin || 0),
      ss = Math.sin(m.spin || 0);
    const st = m.steer || 0,
      cst = Math.cos(st),
      sst = Math.sin(st);
    // the wheel spins on its axis and, if it is a front one, steers (works for points and for normals);
    // what is mounted on the upright (fixed) only steers
    const turn = (wh, lx, ly, lz, fixed) => {
      if (!fixed) {
        const ax = lx - wh.x,
          az = lz - wh.z;
        lx = wh.x + ax * cs + az * ss;
        lz = wh.z - ax * ss + az * cs;
      }
      if (wh.front) {
        // steers around the upright's axis, at the tip of the suspension arms
        const py = wh.y + (wh.pivot || 0),
          bx = lx - wh.x,
          by = ly - py;
        lx = wh.x + bx * cst - by * sst;
        ly = py + bx * sst + by * cst;
      }
      return [lx, ly, lz];
    };
    // the head turns around the neck
    const ch = Math.cos(m.head || 0),
      sh = Math.sin(m.head || 0);
    // and tilts with the forces (headTilt: sideways, like roll, and forward)
    const [hr, hp] = m.headTilt || [0, 0],
      chr = Math.cos(hr),
      shr = Math.sin(hr),
      chp = Math.cos(hp),
      shp = Math.sin(hp);
    const look = (hd, lx, ly, lz) => {
      const bx = lx - hd.x,
        by = ly - hd.y,
        bz = lz - (hd.z || 0);
      const x = bx * ch - by * sh,
        y = bx * sh + by * ch,
        y1 = y * chr - bz * shr,
        z1 = y * shr + bz * chr;
      return [hd.x + x * chp + z1 * shp, hd.y + y1, (hd.z || 0) + z1 * chp - x * shp];
    };
    // the steering wheel turns around its column (Rodrigues)
    // (f: what fraction of the turn it follows; the forearms follow it gradually, from the wrist to the elbow)
    const wt = m.wheelTurn || 0;
    const column = (co, lx, ly, lz, f = 1) => {
      const ct = Math.cos(wt * f),
        stn = Math.sin(wt * f);
      const ax = co.ax,
        ay = co.ay,
        az = co.az,
        vx = lx - co.x,
        vy = ly - co.y,
        vz = lz - co.z;
      const d = (ax * vx + ay * vy + az * vz) * (1 - ct);
      return [
        co.x + vx * ct + (ay * vz - az * vy) * stn + ax * d,
        co.y + vy * ct + (az * vx - ax * vz) * stn + ay * d,
        co.z + vz * ct + (ax * vy - ay * vx) * stn + az * d,
      ];
    };
    // when shifting, the paddles and hands move toward the driver along the column
    const pulled = (co, part, [x, y, z]) => {
      const off = part.pull === undefined ? 0 : (m.paddle?.[part.side] || 0) * part.pull;
      return [x + co.ax * off, y + co.ay * off, z + co.az * off];
    };
    for (const part of m.model) {
      if (part.tag && part.tag === m.hide) continue;
      const wh = part.wheel,
        hd = part.head,
        co = part.column;
      const n = part.verts.length;
      const wx = new Float64Array(n),
        wy = new Float64Array(n),
        wz = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        const v = part.verts[i];
        const [lx, ly, lz] = wh
          ? turn(wh, ...v, part.fixed)
          : lean(...(hd ? look(hd, ...v) : co ? pulled(co, part, column(co, ...v, part.follow?.[i])) : v));
        wx[i] = m.x + (Fx * lx + Rx * ly + Ux * lz) * k;
        wy[i] = m.y + (Fy * lx + Ry * ly + Uy * lz) * k;
        wz[i] = m.z + (Fz * lx + Rz * ly + Uz * lz) * k;
      }
      for (const face of part.faces) {
        const idx = face.idx;
        // face normal (comes from the model, pointing outward) taken to the world, and face center
        let [lx, ly, lz] = face.n;
        if (wh) [lx, ly, lz] = turn({ x: 0, y: 0, z: 0, front: wh.front }, lx, ly, lz, part.fixed);
        else {
          if (hd) [lx, ly, lz] = look({ x: 0, y: 0, z: 0 }, lx, ly, lz);
          if (co)
            [lx, ly, lz] = column(
              { ...co, x: 0, y: 0, z: 0 },
              lx,
              ly,
              lz,
              part.follow ? idx.reduce((a, i) => a + part.follow[i], 0) / idx.length : 1,
            );
          [lx, ly, lz] = lean(lx, ly, lz, 0);
        }
        const nx = Fx * lx + Rx * ly + Ux * lz,
          ny = Fy * lx + Ry * ly + Uy * lz,
          nz = Fz * lx + Rz * ly + Uz * lz;
        let fx = 0,
          fy = 0,
          fz = 0;
        for (const i of idx) {
          fx += wx[i];
          fy += wy[i];
          fz += wz[i];
        }
        fx /= idx.length;
        fy /= idx.length;
        fz /= idx.length;
        // if it faces away from the camera, it is not visible
        if (nx * (fx - cam.x) + ny * (fy - cam.y) + nz * (fz - cam.z) >= 0) continue;
        // on the map y grows downward: the sun is toward -x, -y
        const sun = -nx * SUN[0] - ny * SUN[1] + nz * SUN[2];
        const light = 0.5 + 0.6 * Math.max(0, sun) + 0.12 * nz;
        // the steering wheel display, without WebGL, stays off (its color)
        const tex = face.slot === 6 ? null : face.tex;
        const uv = tex ? face.uv : null;
        const poly = clipNear(
          idx.map((i, a) => (uv ? toCam(wx[i], wy[i], wz[i], uv[a][0], uv[a][1]) : toCam(wx[i], wy[i], wz[i]))),
        );
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
        // texels covered by one screen pixel, to choose the mipmap
        const fp = tex ? (face.dens * depth * m.meters) / P : 0;
        polys.push({ pts, color: mix(shade(face.color, light), fog), tex, fp, light, fog });
      }
    }
    if (!polys.length) return;

    // 2) painted into the model buffers, keeping the nearest face at each pixel
    bx0 = Math.max(0, Math.floor(bx0));
    by0 = Math.max(0, Math.floor(by0));
    bx1 = Math.min(w - 1, Math.ceil(bx1));
    by1 = Math.min(h - 1, Math.ceil(by1));
    if (bx0 > bx1 || by0 > by1) return;
    for (let y = by0; y <= by1; y++) miz.fill(0, y * w + bx0, y * w + bx1 + 1);
    for (const { pts, color, tex, fp, light, fog } of polys) {
      scan(pts, w, h, (x, y, iz, ia, ib) => {
        const o = y * w + x;
        if (iz <= miz[o]) return;
        // is it hidden by the terrain? (a hill or a wall closer than this point)
        if (y >= clip[x * NCHK + Math.min(NCHK - 1, (1 / iz) | 0)]) return;
        miz[o] = iz;
        mcol[o] = tex ? mix(shade(sample(tex, ia / iz, ib / iz, fp), light), fog) : color;
      });
    }

    // 3) copied to the image; the ghost, semi-transparent
    const alpha = m.alpha ?? 1;
    for (let y = by0; y <= by1; y++) {
      for (let o = y * w + bx0, end = y * w + bx1; o <= end; o++) {
        if (miz[o] > 0) buf[o] = alpha < 1 ? blend(buf[o], mcol[o], alpha) : mcol[o];
      }
    }
  }
}

// Clips a polygon (in camera coordinates) to keep the part in front of the camera
function clipNear(pts) {
  const out = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i],
      b = pts[(i + 1) % pts.length];
    const ina = a.d >= MODEL_NEAR,
      inb = b.d >= MODEL_NEAR;
    if (ina) out.push(a);
    if (ina !== inb) {
      const t = (MODEL_NEAR - a.d) / (b.d - a.d);
      const l = (k) => a[k] + (b[k] - a[k]) * t;
      out.push({ d: MODEL_NEAR, s: l('s'), u: l('u'), ta: l('ta'), tb: l('tb') });
    }
  }
  return out;
}

// Fills a convex polygon on screen, row by row, taking the pixels whose center falls inside.
// Interpolates 1/depth (iz) and the texture coordinates divided by depth (ia, ib), which vary
// linearly on screen. plot(x, y, iz, ia, ib) for each pixel.
function scan(pts, w, h, plot) {
  let top = Infinity,
    bottom = -Infinity;
  for (const p of pts) {
    if (p.y < top) top = p.y;
    if (p.y > bottom) bottom = p.y;
  }
  const n = pts.length;
  const ya = Math.max(0, Math.ceil(top - 0.5)),
    yb = Math.min(h - 1, Math.ceil(bottom - 0.5) - 1);
  for (let y = ya; y <= yb; y++) {
    const yc = y + 0.5;
    let xl = Infinity,
      xr = -Infinity,
      zl = 0,
      zr = 0,
      al = 0,
      ar = 0,
      bl = 0,
      br = 0;
    for (let i = 0; i < n; i++) {
      const a = pts[i],
        b = pts[(i + 1) % n];
      if (a.y <= yc === b.y <= yc) continue;
      const t = (yc - a.y) / (b.y - a.y);
      const x = a.x + (b.x - a.x) * t;
      if (x < xl) {
        xl = x;
        zl = a.iz + (b.iz - a.iz) * t;
        al = a.ia + (b.ia - a.ia) * t;
        bl = a.ib + (b.ib - a.ib) * t;
      }
      if (x > xr) {
        xr = x;
        zr = a.iz + (b.iz - a.iz) * t;
        ar = a.ia + (b.ia - a.ia) * t;
        br = a.ib + (b.ib - a.ib) * t;
      }
    }
    if (!(xl < xr)) continue;
    const span = xr - xl;
    const dz = (zr - zl) / span,
      da = (ar - al) / span,
      db = (br - bl) / span;
    const xa = Math.max(0, Math.ceil(xl - 0.5)),
      xb = Math.min(w - 1, Math.ceil(xr - 0.5) - 1);
    for (let x = xa; x <= xb; x++) {
      const f = x + 0.5 - xl;
      plot(x, y, zl + f * dz, al + f * da, bl + f * db);
    }
  }
}

// Splits the sky and terrain among several workers (src/render/terrainworker.js): each one draws a strip of
// screen columns on its own core and returns its pixels and depth marks.
// If something fails (the browser has no module workers, for example), everything is drawn here again.
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
      const x0 = Math.round((k * w) / n),
        x1 = Math.round(((k + 1) * w) / n);
      const worker = new Worker(new URL('./terrainworker.js', import.meta.url), { type: 'module' });
      // buffers that go back and forth every frame (transferred, not copied)
      const part = {
        worker,
        x0,
        x1,
        pix: new Uint32Array((x1 - x0) * h),
        clip: new Int16Array((x1 - x0) * NCHK),
        done: null,
      };
      worker.onmessage = (e) => part.done?.(e.data);
      worker.onerror = () => {
        this.failed = true;
        part.done?.(null);
      };
      worker.postMessage({ type: 'init', w, h, x0, x1 });
      this.parts.push(part);
    }
  }

  // Draws sky and terrain into r.buf and r.clip. Returns false if it couldn't (and it must be drawn on the main
  // thread).
  async draw(r, track, cam, horizon) {
    if (this.failed) return false;
    const offset = (r.guide && r.guide.offset) || null;
    if (track !== this.track || offset !== this.offset) {
      // the track (and where the racing line runs) is sent only once, copied to each worker
      const {
        W,
        H,
        height,
        sdf,
        lat,
        station,
        kerbLeft,
        kerbRight,
        sausageLeft,
        sausageRight,
        kerbStyle,
        kerbColors,
        runoffLeft,
        runoffRight,
        runoff,
        line,
      } = track;
      const data = {
        W,
        H,
        height,
        sdf,
        lat,
        station,
        kerbLeft,
        kerbRight,
        sausageLeft,
        sausageRight,
        kerbStyle,
        kerbColors,
        runoffLeft,
        runoffRight,
        runoff,
        line,
      };
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
      // the rubber: a copy when it changes (every half second), otherwise `true` (the same as before) or null (no
      // rubber)
      rubber: r.rubber ? true : null,
    };
    const m = r.rubber;
    if (m && (m !== this.rubberMap || m.version !== this.rubberVersion)) {
      frame.rubber = { length: m.length, rows: m.rows, lanes: m.lanes, span: m.span, bytes: m.bytes };
      this.rubberMap = m;
      this.rubberVersion = m.version;
    }
    const results = await Promise.all(
      this.parts.map(
        (p) =>
          new Promise((resolve) => {
            p.done = resolve;
            p.worker.postMessage({ ...frame, pix: p.pix, clip: p.clip }, [p.pix.buffer, p.clip.buffer]);
          }),
      ),
    );
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
