// WebGL 2 rendering: the same as renderer.js, but on the graphics card.
// - Sky and terrain: a "shader" that runs once per pixel. For each pixel it builds the camera ray and marches
//   over the height map until it hits the ground or a wall (step by step, then refining the exact point).
//   The step shrinks near the walls using the distance to the track edge, so no ray skips them.
//   The ground color (asphalt, grass, kerbs, racing line, rubber) is the same "shader" as in renderer.js, written in
//   GLSL.
// - Cars, trees and boards: triangles with the same projection as the terrain (a horizon that shifts instead of
//   tilting the camera) and the same depth, so the card's z-buffer resolves what covers what.
// The image resolution is the screen's (with a cap); the camera math stays in the same
// 960-wide "virtual pixels" the rest of the game uses.

import {
  DEFAULT_KERB,
  KERB_STYLE,
  MAX_KERB_COLORS,
  RIDGE,
  RIDGE_DEPTH,
  SAUSAGE_H,
  SAUSAGE_W,
  edgeReach,
  kerbAmount,
  stationAt,
} from '../sim/track.js';
import { RUBBER_DARK } from '../sim/rubber.js';
import { asphaltTexture, grassTexture, gravelTexture, macroNoise, wallTexture } from './textures.js';
import {
  FOG_END,
  FOG_START,
  GRASS_BAND,
  GRASS_TPC,
  GRAVEL_TPC,
  RUNOFF_LIGHT,
  GUIDE_W,
  KERB_H,
  LINE_W,
  MACRO_TPC,
  MAX_DIST,
  MODEL_NEAR,
  NEAR_RISE,
  PLANE_LEN,
  BODY_PIVOT_Z,
  ROAD_TPC,
  SHADOW,
  SHADOW_SHIFT,
  SUN,
  WALL_H,
  WALL_STRIPE,
  WALL_T,
  Z_NEAR,
  KERB_RUBBER_MAX,
  KERB_DIRT_MAX,
  WEAR_CELL,
} from './renderer.js';
import { sampleField } from '../sim/track.js';
import { lineFrame, pointAt } from '../sim/lineframe.js';

const FAR = MAX_DIST + 10; // the farthest stored in the z-buffer (in cells)
const MAX_SCALE = 1.5; // at most 1.5× the virtual pixels (1440×810): more isn't noticeable and heats the machine
const LINE_TEX_W = 1024; // width of the textures with per-cell centerline data
const GUIDE_LIFT = 0.1; // how much the racing line guide floats above the track (cells; the kerb hump is KERB_H)
const GUIDE_ALPHA = 0.6; // opacity of the racing line guide at its center
const ATTRIBS = ['aPos', 'aUV', 'aNormal', 'aColor', 'aTex', 'aWheel', 'aSmooth', 'aGloss'];
const STRIDE = 17; // floats per car vertex
const CREASE = 0.7; // cosine of the angle up to which neighboring faces are smoothed for the reflection (~45°)

const glsl = (n) => (Number.isInteger(n) ? `${n}.0` : String(n));
const rgbOf = (c) => [(c & 255) / 255, ((c >>> 8) & 255) / 255, ((c >>> 16) & 255) / 255];

// shared projection: from a world point (cells) to clip coordinates. The depth is the usual one
// on graphics cards (proportional to 1/distance), which interpolates exactly inside each triangle; the terrain writes
// the same (depthOf), so everything occludes correctly.
const DEPTH = 'float depthOf(float d) { return FAR * (d - NEAR) / (d * (FAR - NEAR)); }';
const PROJECT = `
uniform vec3 uCam; uniform vec2 uDir; uniform float uP, uHorizon; uniform vec2 uView;
const float NEAR = ${glsl(MODEL_NEAR)}, FAR = ${glsl(FAR)};
vec4 project(vec3 w, out float depth) {
  vec2 rel = w.xy - uCam.xy;
  float d = dot(rel, uDir);
  float s = rel.y * uDir.x - rel.x * uDir.y;
  float u = w.z - uCam.z;
  depth = d;
  return vec4(s * uP * 2.0 / uView.x, (1.0 - 2.0 * uHorizon / uView.y) * d + 2.0 * u * uP / uView.y,
              (d * (FAR + NEAR) - 2.0 * FAR * NEAR) / (FAR - NEAR), d);
}`;
const FOG = `
const vec3 FOG = vec3(196.0, 214.0, 230.0) / 255.0;
vec3 fog(vec3 c, float d) {
  float t = clamp((d - ${glsl(FOG_START)}) / ${glsl(FOG_END - FOG_START)}, 0.0, 1.0);
  return mix(c, FOG, t * t);
}`;

// ---------- sky and terrain ----------
const TERRAIN_VS = `#version 300 es
in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`;

const TERRAIN_FS = `#version 300 es
precision highp float;
precision highp sampler2D;
uniform sampler2D uField, uStation, uLine, uAsphalt, uGrass, uGravel, uWall, uMacro, uRubber;
uniform sampler2D uSausage; // how much sausage kerb there is in each cell (r, 0..1)
uniform vec4 uKerbStyle; // kerb width, length of each stripe, width of the green, white line (1) or not (0)
uniform vec2 uMap;
uniform int uLineN;
uniform vec2 uRubberSize; // lap length and distance from the centerline to the last lane (cells)
uniform float uRunoff;
uniform vec3 uKerb[${MAX_KERB_COLORS}]; // kerb stripe colors, in order (0..1)
uniform int uKerbN;
uniform vec4 uStart;
uniform float uStartHalf;
uniform int uFlags;
uniform vec3 uCam;
uniform float uGround, uZStart, uPlane, uP, uHorizon, uAngle, uScale;
uniform vec2 uDir, uView;
out vec4 outColor;
${FOG}
const float MAX_DIST = ${glsl(MAX_DIST)}, NEAR = ${glsl(MODEL_NEAR)}, FAR = ${glsl(FAR)};
${DEPTH}
const float WALL_H = ${glsl(WALL_H)}, WALL_T = ${glsl(WALL_T)}, WALL_STRIPE = ${glsl(WALL_STRIPE)};
const float KERB_H = ${glsl(KERB_H)}, LINE_W = ${glsl(LINE_W)}, RIDGE = ${glsl(RIDGE)}, RIDGE_DEPTH = ${glsl(RIDGE_DEPTH)};
const float SAUSAGE_W = ${glsl(SAUSAGE_W)}, SAUSAGE_H = ${glsl(SAUSAGE_H)};
const float KERB_RUBBER_MAX = ${glsl(KERB_RUBBER_MAX)}, KERB_DIRT_MAX = ${glsl(KERB_DIRT_MAX)}, WEAR_CELL = ${glsl(WEAR_CELL)};
const vec3 KERB_GREEN = vec3(46.0, 135.0, 80.0) / 255.0, SAUSAGE_YELLOW = vec3(245.0, 196.0, 20.0) / 255.0;
const vec3 DIRT = vec3(120.0, 96.0, 62.0) / 255.0, KERB_RUBBER = vec3(25.0) / 255.0;
const float RUBBER_DARK = ${glsl(RUBBER_DARK)};
const float ROAD_TPC = ${glsl(ROAD_TPC)}, GRAVEL_TPC = ${glsl(GRAVEL_TPC)}, RUNOFF_LIGHT = ${glsl(RUNOFF_LIGHT)}, GRASS_TPC = ${glsl(GRASS_TPC)}, GRASS_BAND = ${glsl(GRASS_BAND)}, MACRO_TPC = ${glsl(MACRO_TPC)};
const vec3 EDGE_WHITE = vec3(225.0) / 255.0;
const vec3 LINE_BLACK = vec3(20.0) / 255.0, LINE_WHITE = vec3(245.0) / 255.0, WALL_TOP = vec3(150.0, 150.0, 155.0) / 255.0;
const vec3 SKY_TOP = vec3(70.0, 130.0, 210.0) / 255.0, MOUNTAIN = vec3(110.0, 135.0, 160.0) / 255.0;

vec4 field(vec2 p) { return texture(uField, p / uMap); }
vec3 shade(vec3 c, float k) { return min(c * k, vec3(1.0)); }
float hash(float i) { return fract(sin(i * 12.9898) * 43758.5453); }
vec4 lineData(int i) { i = (i % uLineN + uLineN) % uLineN; return texelFetch(uLine, ivec2(i % ${LINE_TEX_W}, i / ${LINE_TEX_W}), 0); }

// position on the centerline (like stationAt in track.js): interpolated, except where it jumps
float stationAt(vec2 p) {
  vec2 g = p - 0.5;
  ivec2 i = ivec2(floor(g));
  vec2 f = g - floor(g);
  float a = texelFetch(uStation, i, 0).r, b = texelFetch(uStation, i + ivec2(1, 0), 0).r;
  float c = texelFetch(uStation, i + ivec2(0, 1), 0).r, d = texelFetch(uStation, i + ivec2(1, 1), 0).r;
  float lo = min(min(a, b), min(c, d)), hi = max(max(a, b), max(c, d));
  if (lo < 0.0 || hi - lo > 4.0) return texelFetch(uStation, ivec2(floor(p)), 0).r;
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

// what is beside the track (like edgeAt in track.js): the kerb is a hump outside the edge, with
// a sawtooth along it; behind it, the green (flat) and, in some corners, the sausage kerb, taller and narrower
float edgeBump(vec4 f, vec2 p) {
  float k = f.w, s = f.y;
  if (k <= 0.02 || s >= 0.0) return 0.0;
  float kb = -uKerbStyle.x * k;
  if (s > kb) {
    float r = fract(stationAt(p) / RIDGE);
    float saw = r < 0.8 ? r / 0.8 : (1.0 - r) / 0.2;
    return KERB_H * k * sin(3.14159265 * (s - kb) / -kb) * (1.0 - RIDGE_DEPTH * (1.0 - saw));
  }
  float gb = kb - uKerbStyle.z * k;
  if (s > gb) return 0.0;
  float q = texture(uSausage, p / uMap).r;
  float sb = gb - SAUSAGE_W * q;
  return q > 0.02 && s > sb ? SAUSAGE_H * q * sin(3.14159265 * (s - sb) / (gb - sb)) : 0.0;
}

// edges of the roadside bands (from outside in): b = sausage kerb, green, kerb, white line
vec3 zone(float s, vec4 b, vec3 grass, vec3 sausage, vec3 green, vec3 kerb, vec3 edge, vec3 road) {
  if (s < b.x) return grass;
  if (s < b.y) return sausage;
  if (s < b.z) return green;
  if (s < 0.0) return kerb;
  if (s < b.w) return edge;
  return road;
}

// the ground color (the same as groundColor in renderer.js); mat: what is in the runoff (RUNOFF in track.js)
vec3 ground(vec2 p, float fw, float s, float k, float q, float st, float side, float lit, float mat) {
  float light = lit * (0.88 + 0.24 * texture(uMacro, p * MACRO_TPC / 64.0).r);
  bool isKerb = k > 0.02, isSausage = isKerb && q > 0.02;
  float kb = isKerb ? -uKerbStyle.x * k : 0.0;
  float gb = isKerb ? kb - uKerbStyle.z * k : 0.0;
  float outer = isSausage ? gb - SAUSAGE_W * q : gb;
  float lb = isKerb && uKerbStyle.w < 0.5 ? 0.0 : LINE_W;
  vec4 b = vec4(outer, gb, kb, lb);
  vec3 grass = vec3(0.0);
  if (s < outer + fw) {
    // the outside: grass, gravel or asphalt (lighter than the track's: it has no rubber)
    if (mat > 1.5) {
      float ga = fw * ROAD_TPC / 256.0;
      grass = shade(textureGrad(uAsphalt, p * ROAD_TPC / 256.0, vec2(ga, 0.0), vec2(0.0, ga)).rgb, light * RUNOFF_LIGHT);
    } else if (mat > 0.5) {
      float gg = fw * GRAVEL_TPC / 128.0;
      grass = shade(textureGrad(uGravel, p * GRAVEL_TPC / 128.0, vec2(gg, 0.0), vec2(0.0, gg)).rgb, light);
    } else {
      float ph = (p.x + p.y) * (0.7071 / GRASS_BAND);
      float fr = fract(ph), e = min(0.5, fw / GRASS_BAND);
      float band = mod(floor(ph), 2.0);
      if (fr < e) band += (1.0 - 2.0 * band) * ((e - fr) / (2.0 * e));
      else if (fr > 1.0 - e) band += (1.0 - 2.0 * band) * ((fr - 1.0 + e) / (2.0 * e));
      float g = fw * GRASS_TPC / 128.0;
      grass = shade(textureGrad(uGrass, p * GRASS_TPC / 128.0, vec2(g, 0.0), vec2(0.0, g)).rgb, light * (0.9 + band * 0.2));
    }
    if (s < outer - fw) return grass;
  }
  float ga = fw * ROAD_TPC / 256.0;
  vec3 asphalt = textureGrad(uAsphalt, p * ROAD_TPC / 256.0, vec2(ga, 0.0), vec2(0.0, ga)).rgb;
  vec3 road = asphalt;
  float dark = 0.0;
  if ((uFlags & 2) != 0 && st >= 0.0) {
    // the rubber from the map (rubber.js): along by st, across by which side and how far
    float v = (side / uRubberSize.y + 1.0) * 0.5;
    if (v > 0.0 && v < 1.0) dark = RUBBER_DARK * texture(uRubber, vec2(v, st / uRubberSize.x)).r;
  }
  road = shade(road, light * (1.0 - dark));
  vec2 a2 = p - uStart.xy;
  float al = dot(a2, uStart.zw);
  if (al > -0.7 && al < 0.7) {
    float l = -a2.x * uStart.w + a2.y * uStart.z;
    if (abs(l) < uStartHalf) road = shade(mod(floor((al + 0.7) * 2.0) + floor((l + 200.0) * 2.0), 2.0) > 0.5 ? LINE_WHITE : LINE_BLACK, lit);
  }
  if (s > lb + fw) return road;
  vec3 kerbC = EDGE_WHITE, greenC = KERB_GREEN, sausageC = SAUSAGE_YELLOW;
  if (isKerb) {
    // stripes in the track's colors, in order; at the edge between stripes it blends with the neighbor
    float stripe = uKerbStyle.y;
    float ph = st / stripe, fr = fract(ph);
    int i = int(floor(ph));
    float e = min(0.5, fw / stripe);
    float ow = fr < e ? (e - fr) / (2.0 * e) : fr > 1.0 - e ? (fr - 1.0 + e) / (2.0 * e) : 0.0;
    int n = max(uKerbN, 1);
    int ci = ((i % n) + n) % n, oi = (((fr < e ? i - 1 : i + 1) % n) + n) % n;
    kerbC = mix(uKerb[ci], uKerb[oi], ow);
    // wear: rubber marks on the track side and dirt on the grass side (from afar, the average)
    float t = clamp((s - kb) / -kb, 0.0, 1.0);
    float fade = clamp(1.0 - fw / WEAR_CELL, 0.0, 1.0);
    float cell = floor(st / WEAR_CELL) + (side > 0.0 ? 7919.0 : 0.0);
    float n1 = 0.5 + (hash(cell) - 0.5) * fade, n2 = 0.5 + (hash(cell + 101.0) - 0.5) * fade;
    kerbC = mix(kerbC, KERB_RUBBER, KERB_RUBBER_MAX * smoothstep(0.35, 1.0, t) * n1);
    kerbC = mix(kerbC, DIRT, KERB_DIRT_MAX * (1.0 - smoothstep(0.0, 0.4, t)) * n2 * n2);
    // sawtooth: the steep face of each step is in shadow (from afar it can't be told apart)
    float r = fract(st / RIDGE);
    float ridge = 1.0 + ((r < 0.8 ? 1.05 : 0.75) - 1.0) * clamp(1.0 - 2.0 * fw / RIDGE, 0.0, 1.0);
    kerbC = shade(kerbC, light * (1.0 - dark) * ridge);
    // the green: paint on the asphalt (the grain shows); the sausage kerb, yellow
    greenC = shade(mix(asphalt, KERB_GREEN, 0.75), light);
    if (isSausage) sausageC = shade(SAUSAGE_YELLOW, lit);
  }
  vec3 edgeC = shade(EDGE_WHITE, lit);
  // antialiasing: near a zone change, we blend the two colors
  float edge = outer;
  if (isKerb) {
    if (abs(s - gb) < abs(s - edge)) edge = gb;
    if (abs(s - kb) < abs(s - edge)) edge = kb;
    if (abs(s) < abs(s - edge)) edge = 0.0;
  }
  if (abs(s - lb) < abs(s - edge)) edge = lb;
  float zs = s - edge;
  if (zs > -fw && zs < fw) return mix(zone(edge - fw, b, grass, sausageC, greenC, kerbC, edgeC, road), zone(edge + fw, b, grass, sausageC, greenC, kerbC, edgeC, road), (zs + fw) / (2.0 * fw));
  return zone(s, b, grass, sausageC, greenC, kerbC, edgeC, road);
}

void main() {
  // virtual pixel (and from the top, as in the rest of the game)
  vec2 px = gl_FragCoord.xy / uScale;
  float x = px.x, y = uView.y - px.y;
  float cx = 2.0 * x / uView.x - 1.0;
  vec2 rd = uDir + vec2(-uDir.y, uDir.x) * uPlane * cx;
  float rdl = length(rd);
  float drop = (y - uHorizon) / uP; // how much the ray drops per cell of distance
  float invCP = 1.0 / (max(0.3, uCam.z - uGround) * uP);
  float wallIn = -uRunoff, wallOut = wallIn - WALL_T;

  float d = uZStart, prev = d;
  bool hit = false;
  for (int i = 0; i < 400; i++) {
    vec4 f = field(uCam.xy + rd * d);
    float top = f.x + (f.y < wallIn && f.y > wallOut ? WALL_H : edgeBump(f, uCam.xy + rd * d));
    if (uCam.z - drop * d <= top) { hit = true; break; }
    // step: a few screen pixels, and never more than the distance to the wall band
    float band = f.y > wallIn ? f.y - wallIn : (f.y < wallOut ? wallOut - f.y : 0.0);
    float step = min(clamp(d * d * invCP * 2.0, 0.015, 0.2 + 0.025 * d), max(0.03, band / rdl));
    prev = d;
    d += step;
    if (d > MAX_DIST) break;
  }

  if (!hit) {
    // sky with distant mountains, or fog below the horizon
    vec3 c = FOG;
    if (y < uHorizon) {
      float a = uAngle + atan(cx * uPlane);
      float mh = (0.5 + 0.25 * sin(a * 3.0 + 1.0) + 0.15 * sin(a * 7.0 + 2.0) + 0.1 * sin(a * 17.0)) * uView.y * 0.09;
      float dy = uHorizon - y, t = y / max(1.0, uHorizon);
      c = dy < mh ? mix(MOUNTAIN, FOG, (1.0 - dy / mh) * 200.0 / 256.0) : mix(SKY_TOP, FOG, t * t);
    }
    outColor = vec4(c, 1.0);
    gl_FragDepth = 1.0;
    return;
  }
  // refine where the ray hits
  float a = prev, b = d;
  for (int k = 0; k < 7; k++) {
    float m = (a + b) * 0.5;
    vec4 f = field(uCam.xy + rd * m);
    float top = f.x + (f.y < wallIn && f.y > wallOut ? WALL_H : edgeBump(f, uCam.xy + rd * m));
    if (uCam.z - drop * m <= top) b = m; else a = m;
  }
  d = b;
  vec2 p = uCam.xy + rd * d;
  vec4 f = field(p);
  float s = f.y, zr = uCam.z - drop * d;
  bool wall = s < wallIn && s > wallOut;
  vec3 c;
  if (wall) {
    float top = f.x + WALL_H;
    if (top - zr > 0.01) {
      // barrier face, with its texture: along by position on the centerline, vertically from the top
      float st = max(0.0, stationAt(p));
      c = texture(uWall, vec2(st / (2.0 * WALL_STRIPE), (top - zr) / WALL_H)).rgb;
    } else c = WALL_TOP;
  } else {
    // slope lighting: slopes facing the sun get lighter
    float gx = (field(p + vec2(1.0, 0.0)).x - field(p - vec2(1.0, 0.0)).x) * 0.5;
    float gy = (field(p + vec2(0.0, 1.0)).x - field(p - vec2(0.0, 1.0)).x) * 0.5;
    float lit = clamp(1.0 - (gx * -0.6 + gy * -0.8) * 4.0, 0.65, 1.3);
    float st = stationAt(p), side = f.z, k = f.w, q = 0.0;
    if (k > 0.0 && s < 0.0) {
      // the kerb and sausage kerb humps: the face toward the track, more brightly lit
      float kb = -uKerbStyle.x * k, gb = kb - uKerbStyle.z * k;
      q = texture(uSausage, p / uMap).r;
      float sb = gb - SAUSAGE_W * q;
      if (s > kb) lit *= 1.0 - 0.22 * cos(3.14159265 * (s - kb) / -kb);
      else if (q > 0.02 && s < gb && s > sb) lit *= 1.0 - 0.3 * cos(3.14159265 * (s - sb) / (gb - sb));
    }
    float fw = max(0.03, d * uPlane / uView.x);
    // runoff on this side in this segment (up to the wall; beyond it, grass): in the 4th component of the
    // centerline, left + 4 · right
    float mat = 0.0;
    if (s < 0.0 && s > -uRunoff && st >= 0.0) {
      float w = lineData(int(floor(st))).w;
      mat = side > 0.0 ? floor(w / 4.0) : mod(w, 4.0);
    }
    c = ground(p, fw, s, k, q, st, side, lit, mat);
  }
  outColor = vec4(fog(c, d), 1.0);
  gl_FragDepth = clamp(depthOf(d), 0.0, 1.0);
}`;

// ---------- cars ----------
const MODEL_VS = `#version 300 es
in vec3 aPos, aNormal, aColor, aSmooth;
in vec2 aUV;
in float aTex, aWheel, aGloss;
uniform vec4 uWheels[4];
uniform vec2 uSpin, uSteer, uHead; // cosine and sine
uniform vec3 uNeck; // head pivot
uniform vec4 uHeadTilt; // the head tilts: cosine and sine sideways (like uBody) and forward
uniform vec2 uPaddle; // how much the driver pulls each paddle, left and right (m, toward him)
uniform vec3 uColumn, uColumnAxis; // the steering wheel turns around its column
uniform vec2 uTurn; // cosine and sine of how much the steering wheel turns
uniform vec3 uPos, uF, uR, uU;
uniform vec4 uBody; // bodywork: cosine and sine of roll (+: the right side rises) and pitch (+: the nose drops)
uniform float uK;
${PROJECT}
out vec3 vColor;
out vec2 vUV;
flat out int vTex;
out float vLight, vDepth, vBack, vGloss;
out vec3 vNormal, vView;
vec3 spin(vec3 n) { return vec3(n.x * uSpin.x + n.z * uSpin.y, n.y, -n.x * uSpin.y + n.z * uSpin.x); }
vec3 steer(vec3 n) { return vec3(n.x * uSteer.x - n.y * uSteer.y, n.x * uSteer.y + n.y * uSteer.x, n.z); }
vec3 look(vec3 n) { return vec3(n.x * uHead.x - n.y * uHead.y, n.x * uHead.y + n.y * uHead.x, n.z); }
vec3 tilt(vec3 n) {
  n = vec3(n.x, n.y * uHeadTilt.x - n.z * uHeadTilt.y, n.y * uHeadTilt.y + n.z * uHeadTilt.x);
  return vec3(n.x * uHeadTilt.z + n.z * uHeadTilt.w, n.y, n.z * uHeadTilt.z - n.x * uHeadTilt.w);
}
// rotation around the column axis (Rodrigues)
vec3 turnBy(vec3 n, vec2 t) { return n * t.x + cross(uColumnAxis, n) * t.y + uColumnAxis * dot(uColumnAxis, n) * (1.0 - t.x); }
vec3 turn(vec3 n) { return turnBy(n, uTurn); }
// the bodywork rolls on the long axis and pitches on the lateral axis, at the height of the roll center
vec3 lean(vec3 n) {
  n = vec3(n.x, n.y * uBody.x - n.z * uBody.y, n.y * uBody.y + n.z * uBody.x);
  return vec3(n.x * uBody.z + n.z * uBody.w, n.y, n.z * uBody.z - n.x * uBody.w);
}
const vec3 BODY_PIVOT = vec3(0.0, 0.0, ${glsl(BODY_PIVOT_Z)});
void main() {
  vec3 p = aPos, n = aNormal, sm = aSmooth;
  // the mirror glass is convex: the normal spreads toward the edges (aUV goes from -1 to 1 across the glass),
  // so the reflection changes from one side to the other and covers more
  if (aGloss > 1.5 && aGloss < 2.5) sm = normalize(sm + vec3(0.0, aUV.x, aUV.y) * 0.45);
  if (aWheel > 12.5) {
    // the paddles and hands: they turn with the steering wheel and, when shifting, move toward the driver along the
    // column (which doesn't change when turning); left from 13 to 14, right from 15 to 16, by how much each piece
    // follows the pull
    float c = aWheel - 13.0, side = c > 1.5 ? 1.0 : 0.0;
    p = uColumn + turn(p - uColumn) + uColumnAxis * mix(uPaddle.x, uPaddle.y, side) * (c - 2.0 * side);
    n = turn(n);
    sm = turn(sm);
  } else if (aWheel > 10.5) {
    // the driver's forearms: they follow the wheel gradually, from the wrist (aWheel 12: fully) to the elbow (11: not
    // at all)
    float a = atan(uTurn.y, uTurn.x) * (aWheel - 11.0);
    vec2 t = vec2(cos(a), sin(a));
    p = uColumn + turnBy(p - uColumn, t);
    n = turnBy(n, t);
    sm = turnBy(sm, t);
  } else if (aWheel > 6.5) {
    // mounted on the upright (the brake drum): it doesn't spin with the wheel, but steers with it
    vec4 wh = uWheels[int(aWheel + 0.5) - 7];
    if (wh.w != 0.0) {
      vec3 kp = wh.xyz + vec3(0.0, wh.w, 0.0);
      p = kp + steer(p - kp);
      n = steer(n);
      sm = steer(sm);
    }
  } else if (aWheel > 5.5) {
    // the steering wheel turns on its column
    p = uColumn + turn(p - uColumn);
    n = turn(n);
    sm = turn(sm);
  } else if (aWheel > 4.5) {
    // the driver's head turns around the neck and tilts with cornering and braking forces
    p = uNeck + tilt(look(p - uNeck));
    n = tilt(look(n));
    sm = tilt(look(sm));
  } else if (aWheel > 0.5) {
    // the wheel spins on its axis and, if it is a front one, steers
    vec4 wh = uWheels[int(aWheel + 0.5) - 1];
    p = wh.xyz + spin(p - wh.xyz);
    n = spin(n);
    sm = spin(sm);
    if (wh.w != 0.0) {
      vec3 kp = wh.xyz + vec3(0.0, wh.w, 0.0);
      p = kp + steer(p - kp);
      n = steer(n);
      sm = steer(sm);
    }
  }
  // everything except the wheels (which stay on the ground) moves with the suspension
  if (aWheel < 0.5 || (aWheel > 4.5 && aWheel < 6.5) || aWheel > 10.5) {
    p = BODY_PIVOT + lean(p - BODY_PIVOT);
    n = lean(n);
    sm = lean(sm);
  }
  vec3 world = uPos + (uF * p.x + uR * p.y + uU * p.z) * uK;
  vNormal = uF * sm.x + uR * sm.y + uU * sm.z;
  // lit with the smoothed normal, so rounded parts (halo, tyres, bodywork) don't look faceted;
  // sharp edges stay sharp (CREASE)
  vec3 face = uF * n.x + uR * n.y + uU * n.z;
  vec3 nw = vNormal;
  vView = world - uCam;
  vGloss = aGloss;
  float sun = -nw.x * ${glsl(SUN[0])} - nw.y * ${glsl(SUN[1])} + nw.z * ${glsl(SUN[2])};
  vLight = 0.5 + 0.6 * max(0.0, sun) + 0.12 * nw.z;
  vBack = dot(face, world - uCam) >= 0.0 ? 1.0 : 0.0; // face pointing the other way
  vColor = aColor;
  vUV = aUV;
  vTex = int(aTex + 0.5);
  gl_Position = project(world, vDepth);
}`;

const MODEL_FS = `#version 300 es
precision highp float;
uniform sampler2D uLivery, uCarbon, uSidewall, uTread, uRim, uScreen;
uniform float uAlpha, uWear, uShine; // tyres: how worn they are and how much new-tyre shine they have left (0..1)
uniform float uGlossK; // how much of the paint and carbon gloss (less for the player's own car seen from the cockpit)
in vec3 vColor;
in vec2 vUV;
flat in int vTex;
in float vLight, vDepth, vBack, vGloss;
in vec3 vNormal, vView;
out vec4 outColor;
${FOG}
const vec3 SKY_TOP = vec3(70.0, 130.0, 210.0) / 255.0;
const vec3 SUN_DIR = normalize(vec3(${glsl(-SUN[0])}, ${glsl(-SUN[1])}, ${glsl(SUN[2])}));
const vec3 ASPHALT = vec3(0.17, 0.18, 0.19), TREES = vec3(0.2, 0.3, 0.19);
const vec3 NEW_TREAD = vec3(0.15, 0.15, 0.17); // tread of a new tyre: smooth, no marks

// What is reflected in direction r: a made-up environment, but similar to the track's. Below, asphalt that gets
// lighter toward the horizon; at the horizon a band of trees of uneven height; above, the sky with the same
// gradient as the background. When turning, the band of trees slides along the sides of the car.
vec3 env(vec3 r) {
  if (r.z < 0.0) return mix(ASPHALT, FOG * 0.8, pow(1.0 + r.z, 8.0));
  float az = atan(r.y, r.x);
  float trees = 0.06 + 0.035 * (0.5 * sin(az * 7.0) + 0.3 * sin(az * 19.0 + 1.3) + 0.2 * sin(az * 43.0 + 0.7));
  if (r.z < trees) return TREES * (0.8 + 2.0 * r.z);
  return mix(FOG, SKY_TOP, pow(r.z, 0.5));
}
// What the helmet visor reflects: the same environment but blurred, a gradient from dark below to sky above.
// Since the visor curves both ways, a sharp horizon would look like a ring around it.
const vec3 VISOR_LOW = vec3(0.05, 0.06, 0.08);
vec3 visorEnv(vec3 r) {
  return mix(VISOR_LOW, mix(FOG, SKY_TOP, 0.6), smoothstep(-0.5, 0.6, r.z));
}

void main() {
  if (vBack > 0.5) discard;
  vec3 c = vTex == 1 ? texture(uLivery, vUV).rgb : vTex == 2 ? texture(uCarbon, vUV).rgb
    : vTex == 3 ? texture(uSidewall, vUV).rgb : vTex == 4 ? mix(NEW_TREAD, texture(uTread, vUV).rgb, uWear) : vTex == 5 ? texture(uRim, vUV).rgb : vColor;
  c = min(c * vLight, vec3(1.0));
  // the steering wheel display has its own light
  if (vTex == 6) c = texture(uScreen, vUV).rgb;
  // the tread of new tyres shines until it wears a little
  float gloss = vTex == 4 ? 0.5 * uShine : vGloss;
  if (gloss <= 1.0) gloss *= uGlossK; // the mirrors and the visor, the same
  if (gloss > 0.0) {
    // clear coat: reflects little head-on and a lot at grazing angles (Fresnel), and a small, strong highlight where
    // the sun bounces
    vec3 v = normalize(vView), n = normalize(vNormal);
    float facing = clamp(-dot(n, v), 0.0, 1.0);
    vec3 r = reflect(v, n);
    // mirror (gloss 2) and visor (gloss 3): they reflect almost everything, also head-on
    float k = gloss > 1.5 ? 0.85 : gloss * min(0.75, 0.12 + 0.88 * pow(1.0 - facing, 5.0));
    float sun = pow(max(dot(r, SUN_DIR), 0.0), 150.0) * 1.4 * min(gloss, 1.0);
    c = mix(c, gloss > 2.5 ? visorEnv(r) : env(r), k) + vec3(1.0, 0.97, 0.9) * sun;
  }
  outColor = vec4(fog(min(c, vec3(1.0)), vDepth), uAlpha);
}`;

// ---------- sprites (trees, boards) and shadows ----------
const FLAT_VS = `#version 300 es
in vec3 aPos;
in vec2 aUV;
${PROJECT}
out vec2 vUV;
out float vDepth;
void main() { vUV = aUV; gl_Position = project(aPos, vDepth); }`;

const SPRITE_FS = `#version 300 es
precision highp float;
uniform sampler2D uTex;
in vec2 vUV;
in float vDepth;
out vec4 outColor;
${FOG}
void main() {
  vec4 c = texture(uTex, vUV);
  if (c.a < 0.5) discard;
  outColor = vec4(fog(c.rgb, vDepth), 1.0);
}`;

// ---------- racing line guide ----------
// A ribbon that floats a little above the track, along the racing line. Each vertex takes its color (green,
// yellow or red depending on the braking needed) from the guide texture, which is updated every frame;
// the color is interpolated between cells and the edges fade out, so it doesn't look pixelated.
const GUIDE_VS = `#version 300 es
in vec3 aPos;
in vec2 aUV; // x: position on the centerline (cell); y: from -1 to 1, from one edge to the other
uniform sampler2D uGuide;
uniform int uLineN;
${PROJECT}
out vec3 vColor;
out float vDepth, vEdge;
void main() {
  int i = (int(aUV.x + 0.5) % uLineN + uLineN) % uLineN;
  vColor = texelFetch(uGuide, ivec2(i % ${LINE_TEX_W}, i / ${LINE_TEX_W}), 0).rgb;
  vEdge = aUV.y;
  gl_Position = project(aPos, vDepth);
}`;

const GUIDE_FS = `#version 300 es
precision highp float;
in vec3 vColor;
in float vDepth, vEdge;
out vec4 outColor;
${FOG}
void main() {
  float a = ${glsl(GUIDE_ALPHA)} * (1.0 - pow(abs(vEdge), 3.0));
  outColor = vec4(fog(vColor, vDepth), a);
}`;

const SHADOW_FS = `#version 300 es
precision highp float;
uniform float uAlpha;
out vec4 outColor;
void main() { outColor = vec4(0.0, 0.0, 0.0, uAlpha); }`;

export class GLRenderer {
  // returns null if the browser has no WebGL 2 (or something fails): then the CPU renderer (renderer.js) is used.
  // modelsOnly: only to show individual cars (showcase), with no track and a transparent background
  static create(canvas, w, h, { modelsOnly = false } = {}) {
    try {
      const gl = canvas.getContext('webgl2', { antialias: true, alpha: modelsOnly, depth: true });
      return gl ? new GLRenderer(canvas, gl, w, h, modelsOnly) : null;
    } catch (err) {
      console.warn('WebGL not available:', err);
      return null;
    }
  }

  constructor(canvas, gl, w, h, modelsOnly = false) {
    this.gl = gl;
    this.canvas = canvas;
    this.texCache = new WeakMap();
    this.modelCache = new WeakMap();
    if (modelsOnly) {
      this.models = this.program(MODEL_VS, MODEL_FS);
      return;
    }
    // virtual pixels (the ones the rest of the game uses) and the real image resolution
    this.w = w;
    this.h = h;
    this.scale = Math.min(
      MAX_SCALE,
      Math.max(1, Math.ceil(((window.devicePixelRatio || 1) * (canvas.clientWidth || w)) / w)),
    );
    canvas.width = w * this.scale;
    canvas.height = h * this.scale;
    this.setZoom(1);
    this.guide = null;
    this.rubber = null;

    this.terrain = this.program(TERRAIN_VS, TERRAIN_FS);
    this.models = this.program(MODEL_VS, MODEL_FS);
    this.sprites = this.program(FLAT_VS, SPRITE_FS);
    this.shadows = this.program(FLAT_VS, SHADOW_FS);
    this.guides = this.program(GUIDE_VS, GUIDE_FS);
    this.guideMeshes = new WeakMap();
    this.aniso = gl.getExtension('EXT_texture_filter_anisotropic');

    // a triangle covering the whole screen, for the terrain
    this.screen = gl.createVertexArray();
    gl.bindVertexArray(this.screen);
    this.buffer(new Float32Array([-1, -1, 3, -1, -1, 3]));
    this.attrib(this.terrain, 'aPos', 2, 2, 0);

    // geometry that changes every frame (sprites, shadows)
    this.dynamic = gl.createBuffer();
    this.flatVao = gl.createVertexArray();
    gl.bindVertexArray(this.flatVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.dynamic);
    this.attrib(this.sprites, 'aPos', 3, 5, 0);
    this.attrib(this.sprites, 'aUV', 2, 5, 3);
    gl.bindVertexArray(null);

    const repeatTex = (t) =>
      this.texture(new Uint8Array(t.levels[0].buffer, t.levels[0].byteOffset, t.levels[0].byteLength), t.size, t.size, {
        mip: true,
      });
    this.asphalt = repeatTex(asphaltTexture());
    this.grass = repeatTex(grassTexture());
    this.gravel = repeatTex(gravelTexture());
    this.wall = repeatTex(wallTexture());
    const macro = macroNoise();
    this.macro = this.texture(
      Uint8Array.from(macro.data, (v) => Math.round(((v - 0.88) / 0.24) * 255)),
      macro.size,
      macro.size,
      { format: 'R8' },
    );

    this.trackData = new WeakMap();
  }

  setZoom(zoom) {
    this.planeLen = PLANE_LEN / zoom;
    this.P = this.w / 2 / this.planeLen;
  }

  // ---------- WebGL utilities ----------
  program(vs, fs) {
    const gl = this.gl;
    const shader = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const p = gl.createProgram();
    gl.attachShader(p, shader(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, shader(gl.FRAGMENT_SHADER, fs));
    // attributes always in the same location, so several programs can use the same geometry
    ATTRIBS.forEach((name, i) => gl.bindAttribLocation(p, i, name));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    const uniforms = {};
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const name = gl.getActiveUniform(p, i).name.replace(/\[0\]$/, '');
      uniforms[name] = gl.getUniformLocation(p, name);
    }
    return { p, u: uniforms };
  }

  buffer(data) {
    const gl = this.gl,
      b = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, b);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    return b;
  }

  attrib(prog, name, size, stride, offset) {
    const gl = this.gl,
      loc = ATTRIBS.indexOf(name);
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride * 4, offset * 4);
  }

  // formats: RGBA8 (default), R8, RGBA16F (filtered), R32F and RGBA32F (unfiltered, read with texelFetch)
  texture(data, w, h, { format = 'RGBA8', mip = false, nearest = false, clamp = false } = {}) {
    const gl = this.gl,
      t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    const f = {
      RGBA8: [gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE],
      R8: [gl.R8, gl.RED, gl.UNSIGNED_BYTE],
      RGBA16F: [gl.RGBA16F, gl.RGBA, gl.FLOAT],
      R32F: [gl.R32F, gl.RED, gl.FLOAT],
      RGBA32F: [gl.RGBA32F, gl.RGBA, gl.FLOAT],
    }[format];
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    if (data instanceof HTMLCanvasElement) gl.texImage2D(gl.TEXTURE_2D, 0, f[0], f[1], f[2], data);
    else gl.texImage2D(gl.TEXTURE_2D, 0, f[0], w, h, 0, f[1], f[2], data);
    const filter = nearest ? gl.NEAREST : gl.LINEAR;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mip ? gl.LINEAR_MIPMAP_LINEAR : filter);
    const wrap = clamp ? gl.CLAMP_TO_EDGE : gl.REPEAT;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
    if (mip) {
      gl.generateMipmap(gl.TEXTURE_2D);
      if (this.aniso) gl.texParameterf(gl.TEXTURE_2D, this.aniso.TEXTURE_MAX_ANISOTROPY_EXT, 8);
    }
    return t;
  }

  // the rubber (rubber.js) in a texture of lanes (width) × rows (height), as the bytes are laid out: it is uploaded
  // again when the map changes
  rubberTexture(map) {
    const gl = this.gl;
    if (this.rubberMap !== map) {
      if (this.rubberTex) gl.deleteTexture(this.rubberTex);
      this.rubberTex = this.texture(map.bytes, map.lanes, map.rows, { format: 'R8' });
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      this.rubberMap = map;
      this.rubberVersion = map.version;
    } else if (this.rubberVersion !== map.version) {
      gl.bindTexture(gl.TEXTURE_2D, this.rubberTex);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, map.lanes, map.rows, gl.RED, gl.UNSIGNED_BYTE, map.bytes);
      this.rubberVersion = map.version;
    }
    return this.rubberTex;
  }

  bind(unit, tex, prog, name) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(prog.u[name], unit);
  }

  // ---------- track data, in textures ----------
  trackTextures(track) {
    let t = this.trackData.get(track);
    if (!t) {
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
        runoffLeft,
        runoffRight,
      } = track;
      const reach = edgeReach(track.kerbStyle ?? KERB_STYLE);
      // per cell: height, distance to the edge, lateral distance to the centerline and how much kerb there is (0..1);
      // separately, how much sausage kerb
      const f = new Float32Array(W * H * 4),
        sq = new Float32Array(W * H * 4);
      for (let i = 0; i < W * H; i++) {
        f[i * 4] = height[i];
        f[i * 4 + 1] = sdf[i];
        f[i * 4 + 2] = lat[i];
        if (sdf[i] > -reach - 1 && sdf[i] < 1) {
          const st = stationAt(track, (i % W) + 0.5, Math.floor(i / W) + 0.5);
          if (st >= 0) {
            f[i * 4 + 3] = kerbAmount(lat[i] > 0 ? kerbRight : kerbLeft, st);
            if (sausageLeft) sq[i * 4] = kerbAmount(lat[i] > 0 ? sausageRight : sausageLeft, st);
          }
        }
      }
      const n = kerbLeft.length,
        rows = Math.ceil(n / LINE_TEX_W);
      t = {
        field: this.texture(f, W, H, { format: 'RGBA16F', clamp: true }),
        sausage: this.texture(sq, W, H, { format: 'RGBA16F', clamp: true }),
        station: this.texture(Float32Array.from(station), W, H, { format: 'R32F', nearest: true, clamp: true }),
        n,
        rows,
        kerbLeft,
        kerbRight,
        runoffLeft,
        runoffRight,
        offset: undefined,
        line: null,
        guide: this.texture(new Uint8Array(LINE_TEX_W * rows * 4), LINE_TEX_W, rows, { nearest: true, clamp: true }),
      };
      this.trackData.set(track, t);
    }
    // per centerline cell: kerbs on each side, where the racing line runs (for the guide) and the runoffs
    const offset = (this.guide && this.guide.offset) || null;
    if (t.offset !== offset) {
      const d = new Float32Array(LINE_TEX_W * t.rows * 4);
      for (let i = 0; i < t.n; i++) {
        d[i * 4] = t.kerbLeft[i];
        d[i * 4 + 1] = t.kerbRight[i];
        d[i * 4 + 2] = offset ? offset[Math.min(i, offset.length - 1)] : 0;
        d[i * 4 + 3] = (t.runoffLeft?.[i] ?? 0) + 4 * (t.runoffRight?.[i] ?? 0);
      }
      if (t.line) this.gl.deleteTexture(t.line);
      t.line = this.texture(d, LINE_TEX_W, t.rows, { format: 'RGBA32F', nearest: true, clamp: true });
      t.offset = offset;
    }
    if (this.guide) {
      const gl = this.gl,
        c = this.guide.color;
      const rows = Math.ceil(Math.min(c.length, t.n) / LINE_TEX_W);
      const bytes = new Uint8Array(LINE_TEX_W * rows * 4);
      bytes.set(new Uint8Array(c.buffer, c.byteOffset, Math.min(c.length, t.n) * 4));
      gl.bindTexture(gl.TEXTURE_2D, t.guide);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, LINE_TEX_W, rows, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
    }
    return t;
  }

  // car and sprite textures (uploaded once)
  // the steering wheel display: the canvas the game draws every frame (without a canvas, off)
  screenTexture(canvas) {
    const gl = this.gl;
    if (!this.screenTex) {
      this.screenTex = this.texture(new Uint8Array([5, 7, 10, 255]), 1, 1, { clamp: true });
      this.screenOff = this.screenTex;
    }
    if (!canvas) return this.screenOff;
    if (this.screenOff === this.screenTex)
      this.screenTex = this.texture(canvas, canvas.width, canvas.height, { clamp: true });
    else {
      gl.bindTexture(gl.TEXTURE_2D, this.screenTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
    }
    return this.screenTex;
  }

  glTexture(tex) {
    let t = this.texCache.get(tex);
    if (!t) {
      if (tex.canvas) t = this.texture(tex.canvas, tex.w, tex.h, { mip: true, clamp: true });
      else
        t = this.texture(
          new Uint8Array(tex.levels[0].buffer, tex.levels[0].byteOffset, tex.levels[0].byteLength),
          tex.size,
          tex.size,
          { mip: true },
        );
      this.texCache.set(tex, t);
    }
    return t;
  }

  // ---------- a car's geometry, built once ----------
  // each face (a convex polygon) is split into triangles; each vertex carries position, normal, color, texture
  // coordinates, which texture it uses (0 none, 1 livery, 2 carbon, 3 sidewall, 4 tread, 5 rim), which wheel it belongs
  // to, a smoothed normal (so the reflection flows evenly over curves and the facets don't show) and how much it shines
  modelGeometry(model) {
    let g = this.modelCache.get(model);
    if (g) return g;
    const gl = this.gl;
    const data = [];
    const wheels = [];
    const texs = {};
    let helmetStart = -1;
    let neck = { x: 0, y: 0, z: 0 },
      column = { x: 0, y: 0, z: 0, ax: 1, ay: 0, az: 0 };
    const parts = [...model.filter((p) => p.tag !== 'helmet'), ...model.filter((p) => p.tag === 'helmet')];
    for (const part of parts) {
      if (part.tag === 'helmet' && helmetStart < 0) helmetStart = data.length / STRIDE;
      // which wheel it belongs to (1 to 4), 5 if it is the driver's head and 6 if it is the steering wheel; what is
      // mounted on the upright (fixed: steers with the wheel but doesn't spin), 7 to 10; what follows the steering
      // wheel gradually (follow: the forearms), 11 to 12 at each vertex; the paddles and hands (which move when
      // shifting), 13 to 16
      let w = 0;
      if (part.wheel) {
        let k = wheels.indexOf(part.wheel);
        if (k < 0) k = wheels.push(part.wheel) - 1;
        w = k + (part.fixed ? 7 : 1);
      } else if (part.head) {
        w = 5;
        neck = part.head;
      } else if (part.column) {
        w = part.pull !== undefined ? 13 + part.side * 2 + part.pull : 6;
        column = part.column;
      }
      // faces of the piece touching each vertex
      const touching = part.verts.map(() => []);
      for (const face of part.faces) for (const i of face.idx) touching[i].push(face.n);
      for (const face of part.faces) {
        const [r, gg, b] = rgbOf(face.color);
        // smoothed normal at each corner: the average of the neighboring faces that don't bend too much (sharp
        // edges, like those of a box, stay sharp)
        const smooth = face.idx.map((i) => {
          const s = [0, 0, 0];
          for (const m of touching[i]) {
            if (m[0] * face.n[0] + m[1] * face.n[1] + m[2] * face.n[2] < CREASE) continue;
            s[0] += m[0];
            s[1] += m[1];
            s[2] += m[2];
          }
          const l = Math.hypot(...s);
          return s.map((c) => c / l);
        });
        const gloss = face.gloss ?? 0;
        // the model says which texture it is (slot: 1 livery, 2 carbon, 3 sidewall, 4 tread, 5 rim)
        let tid = 0;
        if (face.tex) {
          tid = face.slot || 0;
          texs[tid] = face.tex;
        }
        const size = face.tex ? face.tex.size : 1;
        const vert = (a) => {
          const [x, y, z] = part.verts[face.idx[a]];
          const uv = face.uv ? face.uv[a] : [0, 0];
          const wv = part.follow ? 11 + part.follow[face.idx[a]] : w;
          data.push(
            x,
            y,
            z,
            face.n[0],
            face.n[1],
            face.n[2],
            r,
            gg,
            b,
            uv[0] / size,
            uv[1] / size,
            tid,
            wv,
            ...smooth[a],
            gloss,
          );
        };
        for (let a = 1; a < face.idx.length - 1; a++) {
          vert(0);
          vert(a);
          vert(a + 1);
        }
      }
    }
    const count = data.length / STRIDE;
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    this.buffer(new Float32Array(data));
    const m = this.models;
    this.attrib(m, 'aPos', 3, STRIDE, 0);
    this.attrib(m, 'aNormal', 3, STRIDE, 3);
    this.attrib(m, 'aColor', 3, STRIDE, 6);
    this.attrib(m, 'aUV', 2, STRIDE, 9);
    this.attrib(m, 'aTex', 1, STRIDE, 11);
    this.attrib(m, 'aWheel', 1, STRIDE, 12);
    this.attrib(m, 'aSmooth', 3, STRIDE, 13);
    this.attrib(m, 'aGloss', 1, STRIDE, 16);
    gl.bindVertexArray(null);
    g = { vao, count, helmetStart: helmetStart < 0 ? count : helmetStart, wheels, neck, column, texs };
    this.modelCache.set(model, g);
    return g;
  }

  // camera uniforms, the same in every program that projects
  camera(prog, cam, dirX, dirY, horizon) {
    const gl = this.gl;
    gl.uniform3f(prog.u.uCam, cam.x, cam.y, cam.z);
    gl.uniform2f(prog.u.uDir, dirX, dirY);
    gl.uniform1f(prog.u.uP, this.P);
    gl.uniform1f(prog.u.uHorizon, horizon);
    gl.uniform2f(prog.u.uView, this.w, this.h);
  }

  async render(track, cam, sprites, models = []) {
    const gl = this.gl;
    this.setZoom(cam.zoom || 1);
    const dirX = Math.cos(cam.angle),
      dirY = Math.sin(cam.angle);
    const horizon = this.h / 2 + (cam.pitch || 0);
    const t = this.trackTextures(track);

    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);
    gl.disable(gl.BLEND);

    // 1) sky and terrain (writes each pixel's depth)
    const tp = this.terrain;
    gl.useProgram(tp.p);
    gl.depthFunc(gl.ALWAYS);
    // the rubber is uploaded before binding the others: uploading it uses the active unit and would overwrite the last
    // one
    const rubber = this.rubber && this.rubberTexture(this.rubber);
    this.bind(0, t.field, tp, 'uField');
    this.bind(1, t.station, tp, 'uStation');
    this.bind(2, t.line, tp, 'uLine');
    this.bind(4, this.asphalt, tp, 'uAsphalt');
    this.bind(5, this.grass, tp, 'uGrass');
    this.bind(8, this.gravel, tp, 'uGravel');
    this.bind(6, this.wall, tp, 'uWall');
    this.bind(7, this.macro, tp, 'uMacro');
    this.bind(9, t.sausage, tp, 'uSausage');
    const ks = track.kerbStyle ?? KERB_STYLE;
    gl.uniform4f(tp.u.uKerbStyle, ks.width, ks.stripe, ks.green, ks.line ? 1 : 0);
    gl.uniform2f(tp.u.uMap, track.W, track.H);
    gl.uniform1i(tp.u.uLineN, t.n);
    gl.uniform1f(tp.u.uRunoff, track.runoff);
    const kerb = (track.kerbColors ?? DEFAULT_KERB).slice(0, MAX_KERB_COLORS);
    gl.uniform3fv(
      tp.u.uKerb,
      kerb.flatMap(([r, g, b]) => [r / 255, g / 255, b / 255]),
    );
    gl.uniform1i(tp.u.uKerbN, kerb.length);
    const { line } = track;
    gl.uniform4f(tp.u.uStart, line.x, line.y, line.dx, line.dy);
    gl.uniform1f(tp.u.uStartHalf, line.half);
    gl.uniform1i(tp.u.uFlags, this.rubber ? 2 : 0);
    if (this.rubber) {
      this.bind(3, rubber, tp, 'uRubber');
      gl.uniform2f(tp.u.uRubberSize, this.rubber.length, this.rubber.span);
    }
    gl.uniform3f(tp.u.uCam, cam.x, cam.y, cam.z);
    gl.uniform1f(tp.u.uGround, cam.ground);
    gl.uniform1f(
      tp.u.uZStart,
      Math.max(Z_NEAR, ((cam.z - cam.ground - NEAR_RISE) * this.P) / Math.max(1, this.h - horizon)),
    );
    gl.uniform1f(tp.u.uPlane, this.planeLen);
    gl.uniform1f(tp.u.uP, this.P);
    gl.uniform1f(tp.u.uHorizon, horizon);
    gl.uniform1f(tp.u.uAngle, cam.angle);
    gl.uniform1f(tp.u.uScale, this.scale);
    gl.uniform2f(tp.u.uDir, dirX, dirY);
    gl.uniform2f(tp.u.uView, this.w, this.h);
    gl.bindVertexArray(this.screen);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.depthFunc(gl.LEQUAL);

    // 2) car shadows on the ground
    const shadowModels = models.filter((m) => m.shadow);
    if (shadowModels.length) {
      const sp = this.shadows;
      gl.useProgram(sp.p);
      this.camera(sp, cam, dirX, dirY, horizon);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.depthMask(false);
      gl.enable(gl.POLYGON_OFFSET_FILL);
      gl.polygonOffset(-2, -8);
      gl.bindVertexArray(this.flatVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.dynamic);
      for (const m of shadowModels) {
        const k = 1 / m.meters,
          ca = Math.cos(m.angle),
          sa = Math.sin(m.angle);
        const ox = SHADOW_SHIFT * SUN[0] * k,
          oy = SHADOW_SHIFT * SUN[1] * k;
        const v = [];
        for (const [lx, ly] of SHADOW) {
          const X = m.x + (ca * lx - sa * ly) * k + ox,
            Y = m.y + (sa * lx + ca * ly) * k + oy;
          v.push(X, Y, sampleField(track.height, track.W, X, Y) + 0.03 * k, 0, 0);
        }
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(v), gl.DYNAMIC_DRAW);
        gl.uniform1f(sp.u.uAlpha, 0.38 * (m.alpha ?? 1));
        gl.drawArrays(gl.TRIANGLE_FAN, 0, SHADOW.length);
      }
      gl.disable(gl.POLYGON_OFFSET_FILL);
      gl.disable(gl.BLEND);
      gl.depthMask(true);
    }

    // 3) cars: first the solid ones and at the end the semi-transparent ones (the ghost)
    const mp = this.models;
    gl.useProgram(mp.p);
    this.camera(mp, cam, dirX, dirY, horizon);
    const sorted = [...models.filter((m) => (m.alpha ?? 1) >= 1), ...models.filter((m) => (m.alpha ?? 1) < 1)];
    for (const m of sorted) {
      const alpha = m.alpha ?? 1;
      if (alpha < 1) {
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        gl.depthMask(false);
      }
      this.drawModel(m, alpha);
      if (alpha < 1) {
        gl.disable(gl.BLEND);
        gl.depthMask(true);
      }
    }

    // 4) trees and boards: rectangles facing the camera, grouped by texture
    const sprp = this.sprites;
    gl.useProgram(sprp.p);
    this.camera(sprp, cam, dirX, dirY, horizon);
    const rx = -dirY,
      ry = dirX;
    const groups = new Map();
    for (const s of sprites) {
      const depth = (s.x - cam.x) * dirX + (s.y - cam.y) * dirY;
      if (depth < 0.3 || depth > FOG_END) continue;
      if (!groups.has(s.tex)) groups.set(s.tex, []);
      const v = groups.get(s.tex);
      const hw = s.width / 2,
        z0 = s.z || 0,
        z1 = z0 + s.height;
      const ax = s.x - rx * hw,
        ay = s.y - ry * hw,
        bx = s.x + rx * hw,
        by = s.y + ry * hw;
      v.push(
        ax,
        ay,
        z0,
        0,
        1,
        bx,
        by,
        z0,
        1,
        1,
        bx,
        by,
        z1,
        1,
        0,
        ax,
        ay,
        z0,
        0,
        1,
        bx,
        by,
        z1,
        1,
        0,
        ax,
        ay,
        z1,
        0,
        0,
      );
    }
    gl.bindVertexArray(this.flatVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.dynamic);
    for (const [tex, v] of groups) {
      this.bind(0, this.glTexture(tex), sprp, 'uTex');
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(v), gl.DYNAMIC_DRAW);
      gl.drawArrays(gl.TRIANGLES, 0, v.length / 5);
    }
    gl.bindVertexArray(null);

    // 5) racing line guide, semi-transparent, at the end
    if (this.guide) {
      const gp = this.guides,
        mesh = this.guideMesh(track, this.guide);
      gl.useProgram(gp.p);
      this.camera(gp, cam, dirX, dirY, horizon);
      this.bind(0, t.guide, gp, 'uGuide');
      gl.uniform1i(gp.u.uLineN, t.n);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.depthMask(false);
      gl.bindVertexArray(mesh.vao);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, mesh.count);
      gl.bindVertexArray(null);
      gl.depthMask(true);
      gl.disable(gl.BLEND);
    }
  }

  // a car (m: { model, x, y, z, angle, pitch, roll, ... } as in render), with the car program already in use.
  // basis: [F, R, U] to orient it any way (otherwise it comes from angle and pitch)
  drawModel(m, alpha = 1, basis = null) {
    const gl = this.gl,
      mp = this.models;
    const g = this.modelGeometry(m.model);
    const ca = Math.cos(m.angle || 0),
      sa = Math.sin(m.angle || 0);
    const cp = Math.cos(m.pitch || 0),
      sp = Math.sin(m.pitch || 0);
    const [F, R, U] = basis ?? [
      [ca * cp, sa * cp, sp],
      [-sa, ca, 0],
      [-ca * sp, -sa * sp, cp],
    ];
    gl.uniform3f(mp.u.uPos, m.x, m.y, m.z);
    gl.uniform3f(mp.u.uF, ...F);
    gl.uniform3f(mp.u.uR, ...R);
    gl.uniform3f(mp.u.uU, ...U);
    gl.uniform4f(
      mp.u.uBody,
      Math.cos(m.roll || 0),
      Math.sin(m.roll || 0),
      Math.cos(m.dive || 0),
      Math.sin(m.dive || 0),
    );
    gl.uniform1f(mp.u.uK, 1 / m.meters);
    gl.uniform2f(mp.u.uSpin, Math.cos(m.spin || 0), Math.sin(m.spin || 0));
    const st = m.steer || 0; // front wheel angle (rad)
    gl.uniform2f(mp.u.uSteer, Math.cos(st), Math.sin(st));
    gl.uniform2f(mp.u.uHead, Math.cos(m.head || 0), Math.sin(m.head || 0));
    gl.uniform3f(mp.u.uNeck, g.neck.x, g.neck.y, g.neck.z);
    const [hr, hp] = m.headTilt || [0, 0];
    gl.uniform4f(mp.u.uHeadTilt, Math.cos(hr), Math.sin(hr), Math.cos(hp), Math.sin(hp));
    gl.uniform2f(mp.u.uPaddle, m.paddle?.[0] || 0, m.paddle?.[1] || 0);
    gl.uniform3f(mp.u.uColumn, g.column.x, g.column.y, g.column.z);
    gl.uniform3f(mp.u.uColumnAxis, g.column.ax, g.column.ay, g.column.az);
    gl.uniform2f(mp.u.uTurn, Math.cos(m.wheelTurn || 0), Math.sin(m.wheelTurn || 0));
    const wv = new Float32Array(16);
    g.wheels.forEach((w, i) => wv.set([w.x, w.y, w.z, w.front ? w.pivot : 0], i * 4));
    gl.uniform4fv(mp.u.uWheels, wv);
    gl.uniform1f(mp.u.uAlpha, alpha);
    gl.uniform1f(mp.u.uWear, m.wear ?? 1);
    gl.uniform1f(mp.u.uShine, m.shine ?? 0);
    gl.uniform1f(mp.u.uGlossK, m.gloss ?? 1);
    // first create them all (creating one leaves it bound to the active unit) and then bind them
    const texs = [1, 2, 3, 4, 5].map((k) => g.texs[k] && this.glTexture(g.texs[k]));
    if (g.texs[6]) texs.push(this.screenTexture(m.screen));
    ['uLivery', 'uCarbon', 'uSidewall', 'uTread', 'uRim', 'uScreen'].forEach((name, i) => {
      if (texs[i]) this.bind(i, texs[i], mp, name);
    });
    gl.bindVertexArray(g.vao);
    gl.drawArrays(gl.TRIANGLES, 0, m.hide === 'helmet' ? g.helmetStart : g.count);
  }

  // A single car, as in a showcase (the menu): it fills the whole canvas (w × h pixels), on a transparent background.
  // The camera stays still, looking toward +x at car height; the car turns (yaw) and tilts toward the camera
  // (pitch), so it is seen from above without changing the game's projection (which doesn't pitch). dist: from the
  // camera to the car (m); P: focal length (pixels). Returns how a point of the car is projected, to draw its shadow.
  showcase(model, { yaw = 0, pitch = 0, dist = 14, P, z0 = 0.45 }, w, h) {
    const gl = this.gl,
      mp = this.models;
    if (this.canvas.width !== w || this.canvas.height !== h) Object.assign(this.canvas, { width: w, height: h });
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.useProgram(mp.p);
    gl.uniform3f(mp.u.uCam, 0, 0, 0);
    gl.uniform2f(mp.u.uDir, 1, 0);
    gl.uniform1f(mp.u.uP, P);
    gl.uniform1f(mp.u.uHorizon, h / 2);
    gl.uniform2f(mp.u.uView, w, h);
    // turn around the vertical axis and then tilt the top toward the camera (around y)
    const cy = Math.cos(yaw),
      sy = Math.sin(yaw),
      cp = Math.cos(pitch),
      sp = Math.sin(pitch);
    const tilt = ([x, y, z]) => [x * cp - z * sp, y, x * sp + z * cp];
    const basis = [
      [cy, sy, 0],
      [-sy, cy, 0],
      [0, 0, 1],
    ].map(tilt);
    // the car's point z0 (above its center) ends up at the center of the image
    const c = tilt([0, 0, z0]);
    const pos = [dist - c[0], -c[1], -c[2]];
    this.drawModel({ model, x: pos[0], y: pos[1], z: pos[2], meters: 1 }, 1, basis);
    gl.bindVertexArray(null);
    return ([x, y, z]) => {
      const [F, R, U] = basis;
      const wx = pos[0] + F[0] * x + R[0] * y + U[0] * z,
        wy = pos[1] + F[1] * x + R[1] * y + U[1] * z;
      const wz = pos[2] + F[2] * x + R[2] * y + U[2] * z;
      return [w / 2 + (wy * P) / wx, h / 2 - (wz * P) / wx];
    };
  }

  // racing line ribbon: two vertices per centerline cell, one on each side of the racing line
  guideMesh(track, line) {
    let mesh = this.guideMeshes.get(line);
    if (mesh) return mesh;
    const gl = this.gl,
      f = lineFrame(track),
      L = line.offset.length;
    const data = new Float32Array((L + 1) * 2 * 5);
    let o = 0;
    for (let k = 0; k <= L; k++) {
      const u = k % L,
        p = pointAt(f, u, line.offset[u]);
      const nx = f.nx[u % f.L],
        ny = f.ny[u % f.L];
      for (const side of [-1, 1]) {
        const x = p.x + nx * GUIDE_W * side,
          y = p.y + ny * GUIDE_W * side;
        data.set([x, y, sampleField(track.height, track.W, x, y) + GUIDE_LIFT, k, side], o);
        o += 5;
      }
    }
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    this.buffer(data);
    this.attrib(this.guides, 'aPos', 3, 5, 0);
    this.attrib(this.guides, 'aUV', 2, 5, 3);
    gl.bindVertexArray(null);
    mesh = { vao, count: (L + 1) * 2 };
    this.guideMeshes.set(line, mesh);
    return mesh;
  }
}
