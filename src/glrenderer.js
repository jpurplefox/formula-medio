// Render con WebGL 2: lo mismo que renderer.js, pero en la placa de video.
// - Cielo y terreno: un "shader" que corre una vez por píxel. Para cada píxel se arma el rayo de la cámara y se avanza
//   sobre el mapa de alturas hasta chocar con el piso o un muro (paso a paso, y después afinando el punto exacto).
//   El paso se achica cerca de los muros usando la distancia al borde de la pista, así ningún rayo los saltea.
//   El color del piso (asfalto, pasto, pianos, trazada, goma) es el mismo "shader" de renderer.js, escrito en GLSL.
// - Autos, árboles y carteles: triángulos con la misma proyección que el terreno (un horizonte que se corre en vez de
//   inclinar la cámara) y la misma profundidad, así el z-buffer de la placa resuelve qué tapa a qué.
// La resolución de la imagen es la de la pantalla (con un tope); las cuentas de cámara siguen en los mismos
// "píxeles virtuales" de 960 de ancho que usa el resto del juego.

import { DEFAULT_KERB, KERB_STYLE, MAX_KERB_COLORS, RIDGE, RIDGE_DEPTH, SAUSAGE_H, SAUSAGE_W, edgeReach, kerbAmount, stationAt } from './track.js';
import { RUBBER_DARK, WEAR_REACH } from './rubber.js';
import { TREE_FLOATS, treeMesh } from './trees.js';
import { puffLook } from './smoke.js';
import { asphaltTexture, cloudNoise, dirtTexture, grassTexture, gravelTexture, macroNoise, wallTexture } from './textures.js';
import {
  DIRT_DEEP, DIRT_TPC, GRASS_MASK_CELLS, GRASS_STRIPE, WEAR_DIRT, FOG_MAX, GL_FOG_START, GRASS_BAND, GRASS_TPC, GRAVEL_TPC, RUNOFF_LIGHT, GUIDE_W, KERB_H, LINE_W, MACRO_TPC, GL_MAX_DIST as MAX_DIST, MODEL_NEAR, NEAR_RISE, PLANE_LEN,
  BODY_PIVOT_Z, CLOUD_BASE, CLOUD_CHURN, CLOUD_COVER, CLOUD_FAR, CLOUD_SIGMA, CLOUD_TILE, CLOUD_TOP, CLOUD_WIND, ROAD_TPC, SHADOW, SHADOW_SHIFT, SUN, WALL_H, WALL_STRIPE, WALL_T, Z_NEAR,
  KERB_RUBBER_MAX, KERB_DIRT_MAX, WEAR_CELL,
} from './renderer.js';
import { sampleField } from './track.js';
import { lineFrame, pointAt } from './ai.js';

const FAR = MAX_DIST + 10; // lo más lejos que se guarda en el z-buffer (en celdas)
const MAX_SCALE = 1.5; // como mucho, 1,5 veces los píxeles virtuales (1440×810): más no se nota y calienta la máquina
const LINE_TEX_W = 1024; // ancho de las texturas con datos por celda de la línea central
const GUIDE_LIFT = 0.1; // cuánto flota la ayuda de trazada sobre la pista (celdas; el lomo de los pianos es KERB_H)
const GUIDE_ALPHA = 0.6; // opacidad de la ayuda de trazada en el centro
const ATTRIBS = ['aPos', 'aUV', 'aNormal', 'aColor', 'aTex', 'aWheel', 'aSmooth', 'aGloss', 'iPos', 'iRot'];
const STRIDE = 17; // floats por vértice de los autos
const CREASE = 0.7; // coseno del ángulo hasta el que las caras vecinas se suavizan para el reflejo (~45°)

const glsl = (n) => (Number.isInteger(n) ? `${n}.0` : String(n));
const rgbOf = (c) => [(c & 255) / 255, ((c >>> 8) & 255) / 255, ((c >>> 16) & 255) / 255];

// proyección compartida: de un punto del mundo (celdas) a coordenadas de recorte. La profundidad es la de siempre
// en las placas (proporcional a 1/distancia), que se interpola exacta dentro de cada triángulo; el terreno escribe
// la misma (depthOf), así todo se tapa bien.
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
// la bruma llega a FOG_MAX (no a todo) donde termina lo que se dibuja: más allá sigue un plano de pasto lejano que
// se pierde del todo recién en el horizonte (ver el terreno), así lo lejano no parece cielo debajo del horizonte
const float FOG_MAX = ${glsl(FOG_MAX)};
vec3 fog(vec3 c, float d) {
  float t = clamp((d - ${glsl(GL_FOG_START)}) / ${glsl(MAX_DIST - GL_FOG_START)}, 0.0, 1.0);
  return mix(c, FOG, pow(t, 1.4) * FOG_MAX);
}`;

// ---------- cielo y terreno ----------
const TERRAIN_VS = `#version 300 es
in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`;

const TERRAIN_FS = `#version 300 es
precision highp float;
precision highp sampler2D;
uniform sampler2D uField, uStation, uLine, uAsphalt, uGrass, uGravel, uWall, uMacro, uRubber;
uniform sampler2D uDirt, uGrassMask; // tierra, y dónde hay tierra (r: 1 = césped, 0 = tierra; g: lo mismo, desenfocado; b: zonas de pasto seco)
uniform highp sampler3D uClouds; // ruido de las nubes (cloudNoise de textures.js): r forma, g detalle
uniform float uTime; // segundos, para que las nubes se muevan con el viento
uniform sampler2D uSkid; // marcas de bloqueos y patinadas (skids.js), sobre todo el mapa
uniform sampler2D uWear; // pasto gastado (rubber.js): carriles desde el borde (izquierda al revés, derecha) × filas
uniform sampler2D uSausage; // cuánta salchicha hay en cada celda (r, 0..1)
uniform vec4 uKerbStyle; // ancho del piano, largo de cada franja, ancho del verde, línea blanca (1) o no (0)
uniform vec2 uMap;
uniform int uLineN;
uniform vec2 uRubberSize; // largo de la vuelta y de la línea central al último carril (celdas)
uniform float uRunoff;
uniform vec3 uKerb[${MAX_KERB_COLORS}]; // colores de las franjas del piano, en orden (0..1)
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
const float DIRT_TPC = ${glsl(DIRT_TPC)}, GRASS_MASK_CELLS = ${glsl(GRASS_MASK_CELLS)}, GRASS_STRIPE = ${glsl(GRASS_STRIPE)};
const float WEAR_REACH = ${glsl(WEAR_REACH)}, WEAR_DIRT = ${glsl(WEAR_DIRT)}, DIRT_DEEP = ${glsl(DIRT_DEEP)};
const vec3 DRY_GRASS = vec3(140.0, 134.0, 72.0) / 255.0;
const vec3 EDGE_WHITE = vec3(225.0) / 255.0;
const vec3 LINE_BLACK = vec3(20.0) / 255.0, LINE_WHITE = vec3(245.0) / 255.0, WALL_TOP = vec3(150.0, 150.0, 155.0) / 255.0;
const vec3 SKY_TOP = vec3(70.0, 130.0, 210.0) / 255.0;
const float SKID_DARK = 0.72; // cuánto oscurece una marca de goma del todo negra
const vec3 FAR_LAND = vec3(68.0, 122.0, 58.0) / 255.0; // el pasto de lejos (el promedio de la textura, a la luz)
const float FAR_HAZE = 1500.0; // en cuántas celdas más allá de lo que se dibuja se pierde casi todo
const vec3 LAND_HAZE = vec3(150.0, 172.0, 178.0) / 255.0; // la tierra en el horizonte: más oscura y verdosa que el cielo

vec4 field(vec2 p) { return texture(uField, p / uMap); }
vec3 shade(vec3 c, float k) { return min(c * k, vec3(1.0)); }
float hash(float i) { return fract(sin(i * 12.9898) * 43758.5453); }
vec4 lineData(int i) { i = (i % uLineN + uLineN) % uLineN; return texelFetch(uLine, ivec2(i % ${LINE_TEX_W}, i / ${LINE_TEX_W}), 0); }

// posición sobre la línea central (como stationAt de track.js): interpolada, salvo donde salta
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

// alto del tope del muro en p (dentro de su franja): el piso del borde que da a la pista más WALL_H, igual en todo
// el espesor. Si siguiera al piso de cada punto, en una ladera el muro se inclinaba con el terreno y se veían lomos
// grises encima. Al borde se llega yendo hacia la pista (donde s crece) lo que falta para s = wallIn
float wallTop(vec2 p, float s, float wallIn) {
  float e = 0.35;
  vec2 g = vec2(field(p + vec2(e, 0.0)).y - field(p - vec2(e, 0.0)).y, field(p + vec2(0.0, e)).y - field(p - vec2(0.0, e)).y);
  return field(p + g / max(length(g), 1e-4) * (wallIn - s)).x + WALL_H;
}

// lo que hay al costado de la pista (como edgeAt de track.js): el piano es un lomo por fuera del borde, con
// serrucho a lo largo; detrás, el verde (plano) y, en algunas curvas, la salchicha, más alta y angosta
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

// bordes de las franjas del costado (de afuera hacia adentro): b = salchicha, verde, piano, línea blanca
vec3 zone(float s, vec4 b, vec3 grass, vec3 sausage, vec3 green, vec3 kerb, vec3 edge, vec3 road) {
  if (s < b.x) return grass;
  if (s < b.y) return sausage;
  if (s < b.z) return green;
  if (s < 0.0) return kerb;
  if (s < b.w) return edge;
  return road;
}

// el césped (como grassColor de renderer.js): franjas del corte suaves que se pierden donde está gastado, pasto
// seco alrededor de las calvas y en zonas grandes, y la tierra de la máscara con el borde deshilachado por el
// grano del pasto, que crece donde pisan los autos (wear, 0..1)
vec3 grassColor(vec2 p, float fw, float light, float wear) {
  float k = float(textureSize(uGrassMask, 0).x) / GRASS_MASK_CELLS, mg = fw / GRASS_MASK_CELLS;
  vec3 m = textureGrad(uGrassMask, p / GRASS_MASK_CELLS, vec2(mg, 0.0), vec2(0.0, mg)).rgb;
  float dryZone = clamp((m.b - 0.5) / 0.2, 0.0, 1.0);
  float worn = min(1.0, (1.0 - m.g) * 4.0 + wear);
  float ph = (p.x + p.y) * (0.7071 / GRASS_BAND);
  float fr = fract(ph), e = min(0.5, fw / GRASS_BAND);
  float band = mod(floor(ph), 2.0);
  if (fr < e) band += (1.0 - 2.0 * band) * ((e - fr) / (2.0 * e));
  else if (fr > 1.0 - e) band += (1.0 - 2.0 * band) * ((fr - 1.0 + e) / (2.0 * e));
  float g = fw * GRASS_TPC / 128.0;
  vec3 tex = textureGrad(uGrass, p * GRASS_TPC / 128.0, vec2(g, 0.0), vec2(0.0, g)).rgb;
  vec3 c = shade(tex, light * (1.0 + (band - 0.5) * GRASS_STRIPE * (1.0 - max(worn, dryZone))));
  float dryness = min(1.0, worn * 0.8 + dryZone * 0.6);
  c = mix(c, shade(DRY_GRASS, light * (0.8 + tex.g * 255.0 / 500.0)), dryness * 0.6);
  float g4 = g * 0.25;
  float grain = (textureGrad(uGrass, p * GRASS_TPC / 512.0, vec2(g4, 0.0), vec2(0.0, g4)).g - 0.525) * 4.0;
  float f = (m.r + m.g) * 0.5 - wear * WEAR_DIRT + grain * 0.5;
  float w = min(0.5, 0.06 + fw * k * 0.3);
  float t = smoothstep(0.0, 1.0, (0.5 + w - f) / (2.0 * w));
  if (t <= 0.0) return c;
  float deep = min(1.0, clamp((0.45 - m.g) * 2.5, 0.0, 1.0) + wear * 0.5);
  float gd = fw * DIRT_TPC / 128.0;
  return mix(c, shade(textureGrad(uDirt, p * DIRT_TPC / 128.0, vec2(gd, 0.0), vec2(0.0, gd)).rgb, light * (1.0 - DIRT_DEEP * deep)), t);
}

// el color del piso (lo mismo que groundColor de renderer.js); mat: qué hay en la escapatoria (RUNOFF de track.js)
vec3 ground(vec2 p, float fw, float s, float k, float q, float st, float side, float lit, float mat) {
  float skid = 1.0 - SKID_DARK * texture(uSkid, p / uMap).r; // las marcas de goma oscurecen el asfalto y los pianos
  float light = lit * (0.88 + 0.24 * texture(uMacro, p * MACRO_TPC / 64.0).r);
  bool isKerb = k > 0.02, isSausage = isKerb && q > 0.02;
  float kb = isKerb ? -uKerbStyle.x * k : 0.0;
  float gb = isKerb ? kb - uKerbStyle.z * k : 0.0;
  float outer = isSausage ? gb - SAUSAGE_W * q : gb;
  float lb = isKerb && uKerbStyle.w < 0.5 ? 0.0 : LINE_W;
  vec4 b = vec4(outer, gb, kb, lb);
  vec3 grass = vec3(0.0);
  if (s < outer + fw) {
    // lo de afuera: pasto, leca o asfalto (más claro que el de la pista: no tiene goma)
    if (mat > 1.5) {
      float ga = fw * ROAD_TPC / 256.0;
      grass = shade(textureGrad(uAsphalt, p * ROAD_TPC / 256.0, vec2(ga, 0.0), vec2(0.0, ga)).rgb, light * RUNOFF_LIGHT * skid);
    } else if (mat > 0.5) {
      float gg = fw * GRAVEL_TPC / 128.0;
      grass = shade(textureGrad(uGravel, p * GRAVEL_TPC / 128.0, vec2(gg, 0.0), vec2(0.0, gg)).rgb, light);
    } else {
      float wear = 0.0;
      if ((uFlags & 2) != 0 && st >= 0.0 && s < 0.0 && s > -WEAR_REACH)
        wear = texture(uWear, vec2(0.5 + sign(side) * -s / (2.0 * WEAR_REACH), st / uRubberSize.x)).r;
      grass = grassColor(p, fw, light, wear);
    }
    if (s < outer - fw) return grass;
  }
  float ga = fw * ROAD_TPC / 256.0;
  vec3 asphalt = textureGrad(uAsphalt, p * ROAD_TPC / 256.0, vec2(ga, 0.0), vec2(0.0, ga)).rgb;
  vec3 road = asphalt;
  float dark = 0.0;
  if ((uFlags & 2) != 0 && st >= 0.0) {
    // la goma del mapa (rubber.js): a lo largo según st, a lo ancho según de qué lado y cuánto
    float v = (side / uRubberSize.y + 1.0) * 0.5;
    if (v > 0.0 && v < 1.0) dark = RUBBER_DARK * texture(uRubber, vec2(v, st / uRubberSize.x)).r;
  }
  road = shade(road, light * (1.0 - dark) * skid);
  vec2 a2 = p - uStart.xy;
  float al = dot(a2, uStart.zw);
  if (al > -0.7 && al < 0.7) {
    float l = -a2.x * uStart.w + a2.y * uStart.z;
    if (abs(l) < uStartHalf) road = shade(mod(floor((al + 0.7) * 2.0) + floor((l + 200.0) * 2.0), 2.0) > 0.5 ? LINE_WHITE : LINE_BLACK, lit);
  }
  if (s > lb + fw) return road;
  vec3 kerbC = EDGE_WHITE, greenC = KERB_GREEN, sausageC = SAUSAGE_YELLOW;
  if (isKerb) {
    // franjas de los colores del circuito, en orden; en el borde entre franjas se mezcla con la vecina
    float stripe = uKerbStyle.y;
    float ph = st / stripe, fr = fract(ph);
    int i = int(floor(ph));
    float e = min(0.5, fw / stripe);
    float ow = fr < e ? (e - fr) / (2.0 * e) : fr > 1.0 - e ? (fr - 1.0 + e) / (2.0 * e) : 0.0;
    int n = max(uKerbN, 1);
    int ci = ((i % n) + n) % n, oi = (((fr < e ? i - 1 : i + 1) % n) + n) % n;
    kerbC = mix(uKerb[ci], uKerb[oi], ow);
    // desgaste: manchas de goma del lado de la pista y de tierra del lado del pasto (de lejos, el promedio)
    float t = clamp((s - kb) / -kb, 0.0, 1.0);
    float fade = clamp(1.0 - fw / WEAR_CELL, 0.0, 1.0);
    float cell = floor(st / WEAR_CELL) + (side > 0.0 ? 7919.0 : 0.0);
    float n1 = 0.5 + (hash(cell) - 0.5) * fade, n2 = 0.5 + (hash(cell + 101.0) - 0.5) * fade;
    kerbC = mix(kerbC, KERB_RUBBER, KERB_RUBBER_MAX * smoothstep(0.35, 1.0, t) * n1);
    kerbC = mix(kerbC, DIRT, KERB_DIRT_MAX * (1.0 - smoothstep(0.0, 0.4, t)) * n2 * n2);
    // serrucho: la cara empinada de cada escalón queda en sombra (de lejos no se distingue)
    float r = fract(st / RIDGE);
    float ridge = 1.0 + ((r < 0.8 ? 1.05 : 0.75) - 1.0) * clamp(1.0 - 2.0 * fw / RIDGE, 0.0, 1.0);
    kerbC = shade(kerbC, light * (1.0 - dark) * ridge * skid);
    // el verde: pintura sobre el asfalto (se ve el grano); la salchicha, amarilla
    greenC = shade(mix(asphalt, KERB_GREEN, 0.75), light);
    if (isSausage) sausageC = shade(SAUSAGE_YELLOW, lit);
  }
  vec3 edgeC = shade(EDGE_WHITE, lit);
  // antialiasing: cerca de un cambio de zona, mezclamos los dos colores
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

// ---------- nubes: raymarching por una capa de cúmulos ----------
// Todo en celdas (como el resto): la capa va de CLOUD_BASE a CLOUD_TOP sobre el piso del mapa; el ruido se repite
// cada CLOUD_TILE celdas; CLOUD_COVER es cuánto del cielo tapan; el viento las corre (celdas por segundo)
const float CLOUD_BASE = ${glsl(CLOUD_BASE)}, CLOUD_TOP = ${glsl(CLOUD_TOP)}, CLOUD_TILE = ${glsl(CLOUD_TILE)};
const float CLOUD_COVER = ${glsl(CLOUD_COVER)}, CLOUD_SIGMA = ${glsl(CLOUD_SIGMA)}, CLOUD_FAR = ${glsl(CLOUD_FAR)};
const vec2 CLOUD_WIND = vec2(${glsl(CLOUD_WIND[0])}, ${glsl(CLOUD_WIND[1])});
const float CLOUD_CHURN = ${glsl(CLOUD_CHURN)};
const vec3 SUN_DIR = normalize(vec3(${glsl(-SUN[0])}, ${glsl(-SUN[1])}, ${glsl(SUN[2])})); // hacia el sol (como en los autos)
const vec3 SUN_LIGHT = vec3(1.0, 0.97, 0.9) * 1.05, CLOUD_AMBIENT = vec3(0.7, 0.76, 0.86);
const int CLOUD_STEPS = 72;

// cuánta nube hay en q (0..1): la forma del ruido, con la base plana y el tope redondeado, recortada según
// cuánto cielo tapan (que cambia de a zonas grandes) y con los bordes comidos por el detalle
float cloudDensity(vec3 q, float detail) {
  float h = (q.z - CLOUD_BASE) / (CLOUD_TOP - CLOUD_BASE);
  if (h <= 0.0 || h >= 1.0) return 0.0;
  vec2 w = q.xy + CLOUD_WIND * uTime;
  // el ruido también avanza en altura con el tiempo: la forma de cada nube va cambiando mientras viaja
  vec3 uvw = vec3(w, q.z * 1.2) / CLOUD_TILE + vec3(0.0, 0.0, uTime * CLOUD_CHURN);
  float shape = texture(uClouds, uvw).r;
  float cover = CLOUD_COVER * (0.55 + 0.9 * texture(uClouds, vec3(w / (CLOUD_TILE * 7.0), 0.37 + uTime * CLOUD_CHURN * 0.3)).r);
  float profile = smoothstep(0.0, 0.08, h) * smoothstep(1.0, 0.35, h) * (1.0 - 0.25 * h);
  float d = (shape * profile - (1.0 - cover)) / cover;
  if (d <= 0.0) return 0.0;
  if (detail > 0.0) d -= (1.0 - texture(uClouds, uvw * 4.0 + vec3(0.0, 0.0, uTime * CLOUD_CHURN * 3.0)).g) * 0.3 * detail * (1.0 - d);
  return clamp(d, 0.0, 1.0);
}

// mezcla de dos Henyey-Greenstein (borde plateado mirando hacia el sol, algo hacia atrás) sobre un piso parejo:
// 1 = como si la nube repartiera la luz igual para todos lados
float cloudPhase(float c) {
  float g1 = 0.65, g2 = -0.2;
  float a = (1.0 - g1 * g1) / pow(1.0 + g1 * g1 - 2.0 * g1 * c, 1.5);
  float b = (1.0 - g2 * g2) / pow(1.0 + g2 * g2 - 2.0 * g2 * c, 1.5);
  return 0.55 + 0.45 * mix(b, a, 0.5);
}

// el rayo de un píxel del cielo: rd (horizontal, por unidad de d), sube rise celdas por unidad de d. Devuelve la luz
// que suman las nubes (rgb) y cuánto del cielo de atrás se sigue viendo (a)
vec4 clouds(vec2 rd, float rise) {
  float d0 = max(0.0, (CLOUD_BASE - uCam.z) / rise), d1 = (CLOUD_TOP - uCam.z) / rise;
  float far = CLOUD_FAR / length(rd);
  if (d0 >= far) return vec4(0.0, 0.0, 0.0, 1.0);
  d1 = min(d1, far);
  vec3 dir = vec3(rd, rise);
  float len = length(dir);
  vec3 view = dir / len;
  float phase = cloudPhase(dot(view, SUN_DIR));
  // pasos cortos cerca (unas 12 celdas de recorrido) que se alargan con la distancia; cada píxel arranca un poco
  // corrido (ruido de gradiente entrelazado), así no se ven escalones entre pasos
  float jitter = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
  float travel = 0.0, ds = 12.0;
  float t = d0 + ds * jitter / len;
  float T = 1.0;
  vec3 col = vec3(0.0);
  for (int i = 0; i < CLOUD_STEPS; i++) {
    if (t > d1) break;
    vec3 q = vec3(uCam.xy + rd * t, uCam.z + rise * t);
    // el detalle, sólo de cerca (a lo lejos es más chico que un píxel y sólo hace ruido)
    float den = cloudDensity(q, clamp(1.5 - t * length(rd) / 3000.0, 0.0, 1.0));
    if (den > 0.003) {
      // luz del sol que llega: cuánta nube hay hacia el sol (dos muestras); la que rebota adentro (lo segundo)
      // hace que lo sombreado no quede negro
      float l1 = cloudDensity(q + SUN_DIR * 25.0, 0.0), l2 = cloudDensity(q + SUN_DIR * 80.0, 0.0);
      float od = CLOUD_SIGMA * (l1 * 25.0 + l2 * 55.0) * 0.6;
      float sunT = max(exp(-od), 0.35 * exp(-od * 0.25));
      float h = clamp((q.z - CLOUD_BASE) / (CLOUD_TOP - CLOUD_BASE), 0.0, 1.0);
      vec3 S = SUN_LIGHT * sunT * phase + CLOUD_AMBIENT * (0.55 + 0.45 * h);
      float Ts = exp(-den * CLOUD_SIGMA * ds);
      col += T * S * (1.0 - Ts);
      T *= Ts;
      if (T < 0.02) break;
    }
    travel += ds;
    ds = max(12.0, travel * 0.06);
    t += ds / len;
  }
  // a lo lejos se pierden en la bruma del horizonte
  float fade = exp(-d0 * length(rd) / (CLOUD_FAR * 0.3));
  return vec4(col * fade, mix(1.0, T, fade));
}

// ---------- montañas del fondo ----------
// Tres capas alrededor del horizonte, de la más lejana a la más cercana: una cordillera alta y azulada, sierras, y
// lomas con borde de bosque. La silueta de cada una es ruido leído sobre un círculo (de uMacro), así da la vuelta
// completa sin costura; e = tangente de cuánto sube la vista (alto en píxeles / uP).
const vec3 MOUNT_FAR = vec3(128.0, 146.0, 176.0) / 255.0, MOUNT_MID = vec3(92.0, 116.0, 132.0) / 255.0;
const vec3 MOUNT_NEAR = vec3(70.0, 98.0, 74.0) / 255.0;

float ridgeNoise(float a, float rad, vec2 at) {
  float v = texture(uMacro, at + vec2(cos(a), sin(a)) * rad).r;
  return clamp((v - 0.2) / 0.6, 0.0, 1.0);
}

// alto de la capa k (tangente) en el ángulo a
float mountainH(int k, float a) {
  if (k == 0) {
    float n = ridgeNoise(a, 0.55, vec2(0.21, 0.63)), r = ridgeNoise(a, 2.2, vec2(0.7, 0.1));
    return 0.025 + 0.085 * pow(n, 1.5) + 0.018 * (1.0 - abs(2.0 * r - 1.0)) * n; // picos, más filosos en lo alto
  }
  if (k == 1) {
    float n = ridgeNoise(a, 0.9, vec2(0.55, 0.37)), r = ridgeNoise(a, 3.5, vec2(0.12, 0.88));
    return 0.012 + 0.05 * n + 0.008 * r;
  }
  float n = ridgeNoise(a, 1.4, vec2(0.83, 0.52)), r = ridgeNoise(a, 12.0, vec2(0.36, 0.24));
  return 0.004 + 0.024 * n * n + 0.003 * r; // lomas, con el borde de los árboles
}

vec3 mountains(vec3 c, float a, float e) {
  if (e > 0.15) return c;
  float sunAz = atan(SUN_DIR.y, SUN_DIR.x);
  for (int k = 0; k < 3; k++) {
    float h = mountainH(k, a);
    if (e >= h) continue;
    // caras, quebradas y manchas de vegetación: ruido en ángulo y altura (estirado a lo alto, como las laderas),
    // la cresta un poco más clara, y del lado del sol, un poco más de luz
    float fk = float(k);
    float n2 = texture(uMacro, vec2(a * (2.0 + fk * 2.0) + fk * 0.37, e * (25.0 + fk * 30.0) + fk * 0.61)).r;
    float crest = smoothstep(0.75, 1.0, e / h);
    float lit = (0.82 + 0.3 * n2) * (1.0 + 0.12 * crest) * (1.0 + 0.08 * cos(sunAz - a));
    vec3 col = k == 0 ? MOUNT_FAR : k == 1 ? MOUNT_MID : MOUNT_NEAR;
    float haze = k == 0 ? 0.3 : k == 1 ? 0.16 : 0.06;
    float base = 1.0 - e / h; // 0 en la cresta, 1 en el horizonte
    col = shade(col, lit * (1.05 - 0.15 * base));
    c = mix(col, FOG, haze + (1.0 - haze) * 0.2 * base * base);
  }
  return c;
}

void main() {
  // píxel virtual (y desde arriba, como en el resto del juego)
  vec2 px = gl_FragCoord.xy / uScale;
  float x = px.x, y = uView.y - px.y;
  float cx = 2.0 * x / uView.x - 1.0;
  vec2 rd = uDir + vec2(-uDir.y, uDir.x) * uPlane * cx;
  float rdl = length(rd);
  float drop = (y - uHorizon) / uP; // cuánto baja el rayo por cada celda de distancia
  float invCP = 1.0 / (max(0.3, uCam.z - uGround) * uP);
  float wallIn = -uRunoff, wallOut = wallIn - WALL_T;

  float d = uZStart, prev = d, prevS = 0.0, lastH = uGround;
  bool hit = false;
  bool starved = false; // se quedó sin pasos antes de llegar lejos
  for (int i = 0; i < 700; i++) {
    starved = i == 699;
    vec4 f = field(uCam.xy + rd * d);
    lastH = f.x;
    float top = f.y < wallIn && f.y > wallOut ? wallTop(uCam.xy + rd * d, f.y, wallIn) : f.x + edgeBump(f, uCam.xy + rd * d);
    if (uCam.z - drop * d <= top) { hit = true; break; }
    // paso: unos píxeles de pantalla, y que no se saltee el muro. Afuera de la franja del muro: hasta la franja,
    // según lo rápido que el rayo se le acerca (cuánto cambió s en el paso anterior, con margen, y nunca menos de la
    // mitad de lo más rápido posible: s es la distancia al tramo más cercano y cambia de golpe al pasar de un tramo
    // a otro); uno que corre paralelo al muro casi no se le acerca y puede dar pasos más largos. Encima de la
    // franja (más alto que el muro, si no ya chocó): hasta que el rayo baje a la altura del tope, como mucho media
    // celda (más allá puede haber otro muro). Si no, los rayos casi horizontales que cruzan muros de costado se
    // quedaban sin pasos y se veía el cielo debajo del horizonte
    float band = f.y > wallIn ? f.y - wallIn : (f.y < wallOut ? wallOut - f.y : 0.0);
    float rate = i == 0 ? rdl : clamp(abs(f.y - prevS) / max(d - prev, 1e-4) * 1.5, rdl * 0.5, rdl);
    float wallStep = band > 0.0 ? band / rate : min(0.5, (uCam.z - drop * d - top) / max(drop, 1e-5) * 0.8);
    float step = min(clamp(d * d * invCP * 2.0, 0.015, 0.2 + 0.025 * d), max(0.03, wallStep));
    prevS = f.y;
    prev = d;
    d += step;
    if (d > MAX_DIST) break;
  }

  if (!hit) {
    // cielo con nubes y montañas lejanas; debajo del horizonte, más allá de lo que se dibuja, un plano de pasto a la
    // altura del último piso que vio el rayo, que se va perdiendo en la bruma hasta el horizonte
    vec3 c = FOG;
    if (y >= uHorizon) {
      // (o donde se quedó sin pasos: casi siempre rayos rasantes, cerca del horizonte, que ya iban lejos)
      float far = max(starved ? d : MAX_DIST, (uCam.z - lastH) / max(drop, 1e-5));
      vec3 land = FAR_LAND * (0.9 + 0.2 * texture(uMacro, (uCam.xy + rd * far) * MACRO_TPC / 64.0).r);
      // hasta lo que se dibuja, la bruma de siempre; más allá, la de la tierra lejana (más oscura que el cielo)
      c = mix(fog(land, far), LAND_HAZE, 1.0 - exp(-max(0.0, far - MAX_DIST) / FAR_HAZE));
    } else {
      float a = uAngle + atan(cx * uPlane);
      float dy = uHorizon - y, t = y / max(1.0, uHorizon);
      c = mix(SKY_TOP, FOG, t * t);
      vec4 cl = clouds(rd, dy / uP);
      c = mountains(c * cl.a + cl.rgb, a, dy / uP);
    }
    outColor = vec4(c, 1.0);
    gl_FragDepth = 1.0;
    return;
  }
  // afinamos dónde choca el rayo
  float a = prev, b = d;
  for (int k = 0; k < 7; k++) {
    float m = (a + b) * 0.5;
    vec4 f = field(uCam.xy + rd * m);
    float top = f.y < wallIn && f.y > wallOut ? wallTop(uCam.xy + rd * m, f.y, wallIn) : f.x + edgeBump(f, uCam.xy + rd * m);
    if (uCam.z - drop * m <= top) b = m; else a = m;
  }
  d = b;
  vec2 p = uCam.xy + rd * d;
  vec4 f = field(p);
  float s = f.y, zr = uCam.z - drop * d;
  bool wall = s < wallIn && s > wallOut;
  vec3 c;
  if (wall) {
    float top = wallTop(p, s, wallIn);
    if (top - zr > 0.01) {
      // cara del guardrail, con su textura: a lo largo según la posición sobre la línea central, a lo alto desde arriba
      float st = max(0.0, stationAt(p));
      c = texture(uWall, vec2(st / (2.0 * WALL_STRIPE), (top - zr) / WALL_H)).rgb;
    } else c = WALL_TOP;
  } else {
    // luz por pendiente: las laderas que miran al sol se aclaran
    float gx = (field(p + vec2(1.0, 0.0)).x - field(p - vec2(1.0, 0.0)).x) * 0.5;
    float gy = (field(p + vec2(0.0, 1.0)).x - field(p - vec2(0.0, 1.0)).x) * 0.5;
    float lit = clamp(1.0 - (gx * -0.6 + gy * -0.8) * 4.0, 0.65, 1.3);
    float st = stationAt(p), side = f.z, k = f.w, q = 0.0;
    if (k > 0.0 && s < 0.0) {
      // los lomos del piano y de la salchicha: la cara que mira a la pista, más iluminada
      float kb = -uKerbStyle.x * k, gb = kb - uKerbStyle.z * k;
      q = texture(uSausage, p / uMap).r;
      float sb = gb - SAUSAGE_W * q;
      if (s > kb) lit *= 1.0 - 0.22 * cos(3.14159265 * (s - kb) / -kb);
      else if (q > 0.02 && s < gb && s > sb) lit *= 1.0 - 0.3 * cos(3.14159265 * (s - sb) / (gb - sb));
    }
    float fw = max(0.03, d * uPlane / uView.x);
    // escapatoria de este lado en este tramo (hasta el muro; más allá, pasto): en la 4.ª componente de la línea
    // central, izquierda + 4 · derecha
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

// ---------- autos ----------
const MODEL_VS = `#version 300 es
in vec3 aPos, aNormal, aColor, aSmooth;
in vec2 aUV;
in float aTex, aWheel, aGloss;
uniform vec4 uWheels[4];
uniform vec2 uSpin, uSteer, uHead; // coseno y seno
uniform vec3 uNeck; // pivote de la cabeza
uniform vec4 uHeadTilt; // la cabeza se inclina: coseno y seno hacia el costado (como uBody) y hacia adelante
uniform vec2 uPaddle; // cuánto tira el piloto de cada leva, izquierda y derecha (m, hacia él)
uniform vec3 uColumn, uColumnAxis; // el volante gira alrededor de su columna
uniform vec2 uTurn; // coseno y seno de cuánto gira el volante
uniform vec3 uPos, uF, uR, uU;
uniform vec4 uBody; // carrocería: coseno y seno del rolido (+: el costado derecho sube) y del cabeceo (+: la trompa baja)
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
// giro alrededor del eje de la columna (Rodrigues)
vec3 turnBy(vec3 n, vec2 t) { return n * t.x + cross(uColumnAxis, n) * t.y + uColumnAxis * dot(uColumnAxis, n) * (1.0 - t.x); }
vec3 turn(vec3 n) { return turnBy(n, uTurn); }
// la carrocería rola sobre el eje largo y cabecea sobre el eje de costado, a la altura del centro de rolido
vec3 lean(vec3 n) {
  n = vec3(n.x, n.y * uBody.x - n.z * uBody.y, n.y * uBody.y + n.z * uBody.x);
  return vec3(n.x * uBody.z + n.z * uBody.w, n.y, n.z * uBody.z - n.x * uBody.w);
}
const vec3 BODY_PIVOT = vec3(0.0, 0.0, ${glsl(BODY_PIVOT_Z)});
void main() {
  vec3 p = aPos, n = aNormal, sm = aSmooth;
  // el vidrio de los espejos es convexo: la normal se abre hacia los bordes (aUV va de -1 a 1 sobre el vidrio),
  // así el reflejo cambia de un lado al otro y abarca más
  if (aGloss > 1.5 && aGloss < 2.5) sm = normalize(sm + vec3(0.0, aUV.x, aUV.y) * 0.45);
  if (aWheel > 12.5) {
    // las levas y las manos: giran con el volante y, al cambiar, se acercan al piloto sobre la columna (que no cambia
    // al girar); izquierda de 13 a 14, derecha de 15 a 16, según cuánto acompaña cada pieza el tirón
    float c = aWheel - 13.0, side = c > 1.5 ? 1.0 : 0.0;
    p = uColumn + turn(p - uColumn) + uColumnAxis * mix(uPaddle.x, uPaddle.y, side) * (c - 2.0 * side);
    n = turn(n);
    sm = turn(sm);
  } else if (aWheel > 10.5) {
    // los antebrazos del piloto: siguen al volante de a poco, de la muñeca (aWheel 12: entera) al codo (11: nada)
    float a = atan(uTurn.y, uTurn.x) * (aWheel - 11.0);
    vec2 t = vec2(cos(a), sin(a));
    p = uColumn + turnBy(p - uColumn, t);
    n = turnBy(n, t);
    sm = turnBy(sm, t);
  } else if (aWheel > 6.5) {
    // montado en la mangueta (el tambor del freno): no gira con la rueda, pero dobla con la dirección
    vec4 wh = uWheels[int(aWheel + 0.5) - 7];
    if (wh.w != 0.0) {
      vec3 kp = wh.xyz + vec3(0.0, wh.w, 0.0);
      p = kp + steer(p - kp);
      n = steer(n);
      sm = steer(sm);
    }
  } else if (aWheel > 5.5) {
    // el volante gira sobre su columna
    p = uColumn + turn(p - uColumn);
    n = turn(n);
    sm = turn(sm);
  } else if (aWheel > 4.5) {
    // la cabeza del piloto gira alrededor del cuello y se inclina con las fuerzas de las curvas y las frenadas
    p = uNeck + tilt(look(p - uNeck));
    n = tilt(look(n));
    sm = tilt(look(sm));
  } else if (aWheel > 0.5) {
    // la rueda gira sobre su eje y, si es delantera, dobla con la dirección
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
  // todo menos las ruedas (que quedan apoyadas en el piso) se mueve con la suspensión
  if (aWheel < 0.5 || (aWheel > 4.5 && aWheel < 6.5) || aWheel > 10.5) {
    p = BODY_PIVOT + lean(p - BODY_PIVOT);
    n = lean(n);
    sm = lean(sm);
  }
  vec3 world = uPos + (uF * p.x + uR * p.y + uU * p.z) * uK;
  vNormal = uF * sm.x + uR * sm.y + uU * sm.z;
  // se ilumina con la normal suavizada, así lo redondeado (halo, gomas, carrocería) no se ve en facetas;
  // las aristas marcadas siguen marcadas (CREASE)
  vec3 face = uF * n.x + uR * n.y + uU * n.z;
  vec3 nw = vNormal;
  vView = world - uCam;
  vGloss = aGloss;
  float sun = -nw.x * ${glsl(SUN[0])} - nw.y * ${glsl(SUN[1])} + nw.z * ${glsl(SUN[2])};
  vLight = 0.5 + 0.6 * max(0.0, sun) + 0.12 * nw.z;
  vBack = dot(face, world - uCam) >= 0.0 ? 1.0 : 0.0; // cara que mira para el otro lado
  vColor = aColor;
  vUV = aUV;
  vTex = int(aTex + 0.5);
  gl_Position = project(world, vDepth);
}`;

const MODEL_FS = `#version 300 es
precision highp float;
uniform sampler2D uLivery, uCarbon, uSidewall, uTread, uRim, uScreen;
uniform float uAlpha, uWear, uShine; // gomas: cuánto se gastaron y cuánto brillo de nuevas les queda (0..1)
uniform float uGlossK; // cuánto del brillo de la pintura y el carbono (el auto propio visto desde la cabina, menos)
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
const vec3 NEW_TREAD = vec3(0.15, 0.15, 0.17); // banda de una goma nueva: lisa, sin marcas

// Lo que se refleja en la dirección r: un entorno inventado pero parecido al del circuito. Abajo asfalto que se
// aclara hacia el horizonte; en el horizonte una franja de árboles de alto irregular; arriba el cielo con el mismo
// degradé que el de fondo. Al doblar, la franja de árboles corre sobre los costados del auto.
vec3 env(vec3 r) {
  if (r.z < 0.0) return mix(ASPHALT, FOG * 0.8, pow(1.0 + r.z, 8.0));
  float az = atan(r.y, r.x);
  float trees = 0.06 + 0.035 * (0.5 * sin(az * 7.0) + 0.3 * sin(az * 19.0 + 1.3) + 0.2 * sin(az * 43.0 + 0.7));
  if (r.z < trees) return TREES * (0.8 + 2.0 * r.z);
  return mix(FOG, SKY_TOP, pow(r.z, 0.5));
}
// Lo que refleja la visera del casco: el mismo entorno pero borroso, un degradé de oscuro abajo a cielo arriba.
// Como la visera se curva hacia los dos lados, un horizonte nítido se vería como un anillo alrededor.
const vec3 VISOR_LOW = vec3(0.05, 0.06, 0.08);
vec3 visorEnv(vec3 r) {
  return mix(VISOR_LOW, mix(FOG, SKY_TOP, 0.6), smoothstep(-0.5, 0.6, r.z));
}

void main() {
  if (vBack > 0.5) discard;
  vec3 c = vTex == 1 ? texture(uLivery, vUV).rgb : vTex == 2 ? texture(uCarbon, vUV).rgb
    : vTex == 3 ? texture(uSidewall, vUV).rgb : vTex == 4 ? mix(NEW_TREAD, texture(uTread, vUV).rgb, uWear) : vTex == 5 ? texture(uRim, vUV).rgb : vColor;
  c = min(c * vLight, vec3(1.0));
  // la pantalla del volante tiene luz propia
  if (vTex == 6) c = texture(uScreen, vUV).rgb;
  // la banda de las gomas nuevas brilla hasta que se gasta un poco
  float gloss = vTex == 4 ? 0.5 * uShine : vGloss;
  if (gloss <= 1.0) gloss *= uGlossK; // los espejos y la visera, igual
  if (gloss > 0.0) {
    // barniz: refleja poco de frente y mucho de costado (Fresnel), y un brillo chico y fuerte donde rebota el sol
    vec3 v = normalize(vView), n = normalize(vNormal);
    float facing = clamp(-dot(n, v), 0.0, 1.0);
    vec3 r = reflect(v, n);
    // espejo (gloss 2) y visera (gloss 3): reflejan casi todo, también de frente
    float k = gloss > 1.5 ? 0.85 : gloss * min(0.75, 0.12 + 0.88 * pow(1.0 - facing, 5.0));
    float sun = pow(max(dot(r, SUN_DIR), 0.0), 150.0) * 1.4 * min(gloss, 1.0);
    c = mix(c, gloss > 2.5 ? visorEnv(r) : env(r), k) + vec3(1.0, 0.97, 0.9) * sun;
  }
  outColor = vec4(fog(min(c, vec3(1.0)), vDepth), uAlpha);
}`;

// ---------- sprites (árboles, carteles) y sombras ----------
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

// ---------- ayuda de trazada ----------
// Una cinta que flota un poco sobre la pista, a lo largo de la trazada ideal. Cada vértice toma su color (verde,
// amarillo o rojo según haga falta frenar) de la textura de la guía, que se actualiza en cada cuadro;
// el color se interpola entre celdas y los bordes se desvanecen, así no se ve pixelada.
const GUIDE_VS = `#version 300 es
in vec3 aPos;
in vec2 aUV; // x: posición sobre la línea central (celda); y: de -1 a 1, de un borde al otro
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

// ---------- árboles (trees.js): mallas instanciadas ----------
// por árbol: iPos = dónde (celdas) y escala (celdas por metro); iRot = coseno y seno del giro, tono (-1..1) y
// fundido entre niveles de detalle (ver drawTrees). aGloss: cuánto se mueve con el viento ese vértice (0 en el
// tronco, 1 en la punta)
const TREE_VS = `#version 300 es
in vec3 aPos, aNormal, aColor;
in float aGloss, aTex;
in vec4 iPos, iRot;
uniform float uTime;
${PROJECT}
out vec3 vColor, vNormal, vObj, vAround;
out float vDepth, vWood;
flat out float vFade;
void main() {
  vec3 p = aPos;
  vFade = iRot.w;
  vObj = aPos;
  vWood = aTex;
  // el viento: la copa se mece, más arriba y con ráfagas que no van parejas entre árboles
  float phase = fract(sin(dot(iPos.xy, vec2(12.9898, 78.233))) * 43758.5453) * 20.0;
  float t = uTime * 1.6 + phase;
  float gust = 0.6 + 0.4 * sin(uTime * 0.37 + phase * 0.5);
  p.xy += vec2(sin(t), cos(t * 0.83) * 0.6) * 0.16 * gust * aGloss;
  p.xy += vec2(sin(t * 3.1 + p.z), cos(t * 2.7 + p.x)) * 0.04 * aGloss;
  vec2 cs = iRot.xy;
  vec3 r = vec3(p.x * cs.x - p.y * cs.y, p.x * cs.y + p.y * cs.x, p.z);
  vNormal = vec3(aNormal.x * cs.x - aNormal.y * cs.y, aNormal.x * cs.y + aNormal.y * cs.x, aNormal.z);
  // alrededor del tronco (tangente horizontal), ya girado como el árbol: para el relieve de la corteza
  vec2 ar = normalize(vec2(-aPos.y, aPos.x) + 1e-5);
  vAround = vec3(ar.x * cs.x - ar.y * cs.y, ar.x * cs.y + ar.y * cs.x, 0.0);
  // tono propio de cada árbol: algunos más secos, otros más oscuros
  vColor = aColor * (1.0 + 0.12 * iRot.z) + vec3(0.03, 0.02, -0.01) * max(0.0, iRot.z);
  gl_Position = project(iPos.xyz + r * iPos.w, vDepth);
}`;
const TREE_FS = `#version 300 es
precision highp float;
in vec3 vColor, vNormal, vObj, vAround;
in float vDepth, vWood;
flat in float vFade;
out vec4 outColor;
${FOG}
const vec3 SUN_DIR = normalize(vec3(${glsl(-SUN[0])}, ${glsl(-SUN[1])}, ${glsl(SUN[2])}));
float hash3(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
float vnoise3(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash3(i), hash3(i + vec3(1, 0, 0)), f.x), mix(hash3(i + vec3(0, 1, 0)), hash3(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(hash3(i + vec3(0, 0, 1)), hash3(i + vec3(1, 0, 1)), f.x), mix(hash3(i + vec3(0, 1, 1)), hash3(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
// corteza: surcos verticales que se cortan en placas, leídos sobre el cilindro del tronco (ruido 3D con el ángulo
// como coseno y seno: da toda la vuelta sin costura). 1 = placa, 0 = grieta
float bark(float a, float z) {
  vec3 q = vec3(cos(a) * 4.5, sin(a) * 4.5, z * 1.4);
  float n = vnoise3(q) * 0.6 + vnoise3(q * vec3(2.1, 2.1, 2.6) + 7.0) * 0.4;
  return smoothstep(0.38, 0.47, n);
}
void main() {
  // fundido entre niveles de detalle: cada píxel es de uno o del otro, según un tramado (vFade < 2: el que entra,
  // se ve donde el tramado es menor que vFade; vFade >= 2: el que sale, donde es mayor o igual que vFade - 2)
  float dither = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
  if (vFade < 2.0 ? dither >= vFade : dither < vFade - 2.0) discard;
  vec3 n = normalize(vNormal);
  vec3 base = vColor;
  if (vWood > 0.5) {
    // de cerca, la corteza con relieve (la grieta, más oscura y hundida); de lejos se va a un tono parejo
    float a = atan(vObj.y, vObj.x), e = 0.03;
    float b = bark(a, vObj.z);
    float near = 1.0 - clamp((vDepth - 25.0) / 60.0, 0.0, 1.0);
    float slope = (bark(a + e, vObj.z) - bark(a - e, vObj.z)) / (2.0 * e);
    n = normalize(n - vAround * clamp(slope * 0.06, -1.2, 1.2) * near);
    float grain = vnoise3(vec3(cos(a) * 14.0, sin(a) * 14.0, vObj.z * 9.0));
    base *= mix(0.82, mix(0.38, 1.15, b) * (0.8 + 0.4 * grain), near);
  } else if (vDepth < 70.0) {
    // hojas, de cerca: manojos más claros y más oscuros, y un relieve fino que corta los brillos parejos
    float near = 1.0 - clamp((vDepth - 30.0) / 40.0, 0.0, 1.0);
    vec3 q = vObj * 3.2;
    float l0 = vnoise3(q), e = 0.25;
    vec3 g = vec3(vnoise3(q + vec3(e, 0, 0)), vnoise3(q + vec3(0, e, 0)), vnoise3(q + vec3(0, 0, e))) - l0;
    n = normalize(n - g * 2.2 * near);
    float bunch = vnoise3(vObj * 1.3 + 3.0);
    base *= mix(1.0, (0.78 + 0.4 * l0) * (0.85 + 0.3 * bunch), near);
  }
  // luz envolvente (las hojas dejan pasar algo de luz) y cielo desde arriba
  float sun = max(0.0, (dot(n, SUN_DIR) + 0.35) / 1.35);
  float sky = 0.7 + 0.3 * n.z;
  vec3 c = base * (vec3(1.0, 0.97, 0.9) * sun * 1.05 + vec3(0.55, 0.62, 0.75) * sky * 0.65);
  outColor = vec4(fog(c, vDepth), 1.0);
}`;
// humo de las ruedas (smoke.js): carteles de frente a la cámara con una bocanada suave; aColor = (opacidad, tono)
const SMOKE_VS = `#version 300 es
in vec3 aPos;
in vec2 aUV;
in vec3 aColor;
${PROJECT}
out vec2 vUV;
out float vDepth, vAlpha, vShade;
void main() { vUV = aUV; vAlpha = aColor.x; vShade = aColor.y; gl_Position = project(aPos, vDepth); }`;
const SMOKE_FS = `#version 300 es
precision highp float;
uniform sampler2D uTex;
in vec2 vUV;
in float vDepth, vAlpha, vShade;
out vec4 outColor;
${FOG}
void main() {
  vec4 t = texture(uTex, vUV);
  // más claro arriba (le da el sol), un poco más gris abajo
  vec3 c = vec3(0.9, 0.9, 0.93) * vShade * (0.88 + 0.2 * (1.0 - vUV.y)) * t.r;
  outColor = vec4(fog(c, vDepth), t.a * vAlpha);
}`;

// sombra de un árbol en el piso: un óvalo suave (la textura uTex), estirado lejos del sol
const SOFT_SHADOW_FS = `#version 300 es
precision highp float;
uniform sampler2D uTex;
uniform float uAlpha;
in vec2 vUV;
in float vDepth;
out vec4 outColor;
void main() {
  float a = texture(uTex, vUV).a * uAlpha * (1.0 - clamp((vDepth - 60.0) / 200.0, 0.0, 1.0));
  outColor = vec4(0.0, 0.0, 0.0, a);
}`;

// la sombra de un árbol: un óvalo suave, más oscuro cerca del pie (u: a lo ancho, v: del pie hacia lejos del sol)
// una bocanada de humo: redonda, de borde suave y con grumos (r: luz, a: cuánto tapa)
function puffImage(n = 64) {
  const data = new Uint8Array(n * n * 4);
  const h = (x, y) => { const v = Math.sin(x * 127.1 + y * 311.7) * 43758.5453; return v - Math.floor(v); };
  const noise = (x, y) => {
    const x0 = Math.floor(x), y0 = Math.floor(y), u = x - x0, v = y - y0, s = (t) => t * t * (3 - 2 * t);
    const a = h(x0, y0), b = h(x0 + 1, y0), c = h(x0, y0 + 1), d = h(x0 + 1, y0 + 1);
    return (a + (b - a) * s(u)) * (1 - s(v)) + (c + (d - c) * s(u)) * s(v);
  };
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const u = (x + 0.5) / n - 0.5, v = (y + 0.5) / n - 0.5, r = Math.hypot(u, v) * 2;
    const lump = noise(x / 9, y / 9) * 0.6 + noise(x / 4.5 + 7, y / 4.5) * 0.4;
    const a = Math.max(0, Math.min(1, (1 - r) * 1.6)) * (0.55 + 0.45 * lump);
    const i = (y * n + x) * 4;
    data[i] = Math.round(255 * (0.85 + 0.15 * lump));
    data[i + 3] = Math.round(255 * a * a);
  }
  return data;
}

function treeShadowImage(n = 64) {
  const data = new Uint8Array(n * n * 4);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const u = (x + 0.5) / n - 0.5, v = (y + 0.5) / n;
    const r = Math.hypot(u / 0.42, (v - 0.55) / 0.43);
    const a = Math.max(0, Math.min(1, (1 - r) / 0.45)) * (0.75 + 0.25 * (1 - v));
    data[(y * n + x) * 4 + 3] = Math.round(255 * a * a * (3 - 2 * a));
  }
  return data;
}

// árboles: qué especie, giro, tono y fase del viento le toca a cada uno (siempre lo mismo para el mismo lugar)
const TREE_KINDS = [{ kind: 'pine', seed: 1 }, { kind: 'broadleaf', seed: 1 }, { kind: 'broadleaf', seed: 2 }]; // dos variantes de copa
const TREE_LODS = [{ cell: 0.2, upTo: 40 }, { cell: 0.32, upTo: 80 }, { cell: 0.5, upTo: 150 }, { cell: 0.65, upTo: Infinity }]; // celdas de distancia
const TREE_SIZE = 1.6; // escala de las mallas respecto del "scale" de cada árbol del circuito: pinos de 13 a 24 m, copas de 9 a 16 m
function treeLooks(trees) {
  return trees.map((t) => {
    const h = (k) => { const v = Math.sin(t.x * 12.9898 + t.y * 78.233 + k * 37.719) * 43758.5453; return v - Math.floor(v); };
    const a = h(1) * Math.PI * 2;
    const k = h(2);
    return { kind: k < 0.5 ? 0 : k < 0.75 ? 1 : 2, cos: Math.cos(a), sin: Math.sin(a), tint: h(3) * 2 - 1 };
  });
}
const TREE_BLEND = 0.25; // fracción de cada distancia de cambio de detalle en la que se funden los dos niveles

export class GLRenderer {
  // devuelve null si el navegador no tiene WebGL 2 (o algo falla): ahí se usa el renderer de siempre.
  // modelsOnly: sólo para mostrar autos sueltos (showcase), sin circuito y con el fondo transparente
  static create(canvas, w, h, { modelsOnly = false } = {}) {
    try {
      const gl = canvas.getContext('webgl2', { antialias: true, alpha: modelsOnly, depth: true });
      return gl ? new GLRenderer(canvas, gl, w, h, modelsOnly) : null;
    } catch (err) {
      console.warn('WebGL no disponible:', err);
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
    // píxeles virtuales (los del resto del juego) y la resolución real de la imagen
    this.w = w;
    this.h = h;
    this.scale = Math.min(MAX_SCALE, Math.max(1, Math.ceil((window.devicePixelRatio || 1) * (canvas.clientWidth || w) / w)));
    canvas.width = w * this.scale;
    canvas.height = h * this.scale;
    this.setZoom(1);
    this.guide = null;
    this.rubber = null;

    this.terrain = this.program(TERRAIN_VS, TERRAIN_FS);
    this.models = this.program(MODEL_VS, MODEL_FS);
    this.sprites = this.program(FLAT_VS, SPRITE_FS);
    this.shadows = this.program(FLAT_VS, SHADOW_FS);
    this.treeProg = this.program(TREE_VS, TREE_FS);
    this.softShadows = this.program(FLAT_VS, SOFT_SHADOW_FS);
    this.smokeProg = this.program(SMOKE_VS, SMOKE_FS);
    this.puffTex = this.texture(puffImage(), 64, 64, { clamp: true, mip: true });
    this.smoke = null; // humo de las ruedas (Smoke de smoke.js), lo pone el juego
    this.skids = null; // marcas de goma (SkidMarks de skids.js), las pone el juego
    this.noSkids = this.texture(new Uint8Array([0]), 1, 1, { format: 'R8' });
    this.smokeVao = gl.createVertexArray();
    this.smokeBuf = gl.createBuffer();
    gl.bindVertexArray(this.smokeVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.smokeBuf);
    this.attrib(this.smokeProg, 'aPos', 3, 7, 0);
    this.attrib(this.smokeProg, 'aUV', 2, 7, 3);
    this.attrib(this.smokeProg, 'aColor', 2, 7, 5);
    gl.bindVertexArray(null);
    this.treeShadowTex = this.texture(treeShadowImage(), 64, 64, { clamp: true });
    this.trees = null; // las mallas se arman en el primer cuadro con árboles (treeModels)
    this.treeShadowMeshes = new WeakMap();
    this.guides = this.program(GUIDE_VS, GUIDE_FS);
    this.guideMeshes = new WeakMap();
    this.aniso = gl.getExtension('EXT_texture_filter_anisotropic');

    // un triángulo que cubre toda la pantalla, para el terreno
    this.screen = gl.createVertexArray();
    gl.bindVertexArray(this.screen);
    this.buffer(new Float32Array([-1, -1, 3, -1, -1, 3]));
    this.attrib(this.terrain, 'aPos', 2, 2, 0);

    // geometría que cambia en cada cuadro (sprites, sombras)
    this.dynamic = gl.createBuffer();
    this.flatVao = gl.createVertexArray();
    gl.bindVertexArray(this.flatVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.dynamic);
    this.attrib(this.sprites, 'aPos', 3, 5, 0);
    this.attrib(this.sprites, 'aUV', 2, 5, 3);
    gl.bindVertexArray(null);

    const repeatTex = (t) => this.texture(new Uint8Array(t.levels[0].buffer, t.levels[0].byteOffset, t.levels[0].byteLength), t.size, t.size, { mip: true });
    this.asphalt = repeatTex(asphaltTexture());
    this.grass = repeatTex(grassTexture());
    this.gravel = repeatTex(gravelTexture());
    this.dirt = repeatTex(dirtTexture());
    this.clouds = this.texture3D(cloudNoise());
    this.grassMask = this.texture(new Uint8Array([255, 255, 0, 255]), 1, 1); // todo césped hasta que llegue la imagen
    this.wall = repeatTex(wallTexture());
    const macro = macroNoise();
    this.macro = this.texture(Uint8Array.from(macro.data, (v) => Math.round(((v - 0.88) / 0.24) * 255)), macro.size, macro.size, { format: 'R8' });

    this.trackData = new WeakMap();
  }

  // césped/tierra (loadGrassMask de textures.js)
  setGrassMask(mask) {
    if (!mask) return;
    this.gl.deleteTexture(this.grassMask);
    const rgba = new Uint8Array(mask.size * mask.size * 4).fill(255);
    for (let i = 0; i < mask.data.length; i++) {
      rgba[4 * i] = mask.data[i];
      rgba[4 * i + 1] = mask.soft[i];
      rgba[4 * i + 2] = mask.dry[i];
    }
    this.grassMask = this.texture(rgba, mask.size, mask.size, { mip: true });
  }

  setZoom(zoom) {
    this.planeLen = PLANE_LEN / zoom;
    this.P = this.w / 2 / this.planeLen;
  }

  // ---------- utilidades de WebGL ----------
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
    // los atributos siempre en el mismo lugar, así varios programas pueden usar la misma geometría
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
    const gl = this.gl, b = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, b);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    return b;
  }

  attrib(prog, name, size, stride, offset) {
    const gl = this.gl, loc = ATTRIBS.indexOf(name);
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride * 4, offset * 4);
  }

  // formatos: RGBA8 (por defecto), R8, RGBA16F (con filtro), R32F y RGBA32F (sin filtro, se leen con texelFetch)
  texture(data, w, h, { format = 'RGBA8', mip = false, nearest = false, clamp = false } = {}) {
    const gl = this.gl, t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    const f = {
      RGBA8: [gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE], R8: [gl.R8, gl.RED, gl.UNSIGNED_BYTE],
      RGBA16F: [gl.RGBA16F, gl.RGBA, gl.FLOAT], R32F: [gl.R32F, gl.RED, gl.FLOAT], RGBA32F: [gl.RGBA32F, gl.RGBA, gl.FLOAT],
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

  // las mallas de los árboles (trees.js): cada especie en cada nivel de detalle, con su lugar para los datos de
  // cada árbol (que cambian en cada cuadro: sólo los que se ven, en el nivel que les toca por la distancia). Se
  // arman en un worker (tardan casi un segundo); mientras tanto los árboles se dibujan como antes, de cartón.
  // Devuelve las mallas, o null si todavía no están
  treeModels() {
    if (this.trees) return this.trees;
    if (this.treeParts) return null;
    const parts = this.treeParts = TREE_KINDS.map(() => TREE_LODS.map(() => null));
    let left = TREE_KINDS.length * TREE_LODS.length;
    const add = (k, l, data, index) => {
      parts[k][l] = this.treeMeshGL(data, index);
      if (--left === 0) this.trees = parts;
    };
    const kinds = TREE_KINDS, cells = TREE_LODS.map((d) => d.cell);
    try {
      const worker = new Worker(new URL('./treeworker.js', import.meta.url), { type: 'module' });
      worker.onmessage = ({ data: m }) => {
        add(m.k, m.l, m.data, m.index);
        if (!left) worker.terminate();
      };
      worker.onerror = () => { worker.terminate(); this.buildTreesHere(add, kinds, cells); };
      worker.postMessage({ kinds, cells });
    } catch {
      this.buildTreesHere(add, kinds, cells);
    }
    return null;
  }

  // sin worker: de a una malla por cuadro, para no trabar
  buildTreesHere(add, kinds, cells) {
    const jobs = [];
    kinds.forEach(({ kind, seed }, k) => cells.forEach((cell, l) => jobs.push([k, l, kind, seed, cell])));
    const next = () => {
      const job = jobs.shift();
      if (!job) return;
      const [k, l, kind, seed, cell] = job, m = treeMesh(kind, cell, seed);
      add(k, l, m.data, m.index);
      setTimeout(next, 0);
    };
    next();
  }

  treeMeshGL(data, index) {
    const gl = this.gl, F = 4;
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    this.buffer(data);
    const B = TREE_FLOATS * F, at = (name, size, off) => {
      const loc = ATTRIBS.indexOf(name);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, B, off * F);
    };
    at('aPos', 3, 0);
    at('aNormal', 3, 3);
    at('aColor', 3, 6);
    at('aGloss', 1, 9);
    at('aTex', 1, 10);
    const ib = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, index, gl.STATIC_DRAW);
    const inst = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, inst);
    for (const [name, off] of [['iPos', 0], ['iRot', 4]]) {
      const loc = ATTRIBS.indexOf(name);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 4, gl.FLOAT, false, 8 * F, off * F);
      gl.vertexAttribDivisor(loc, 1);
    }
    gl.bindVertexArray(null);
    return { vao, inst, count: index.length, type: index instanceof Uint32Array ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT };
  }

  // los árboles que se ven, cada uno en su nivel de detalle
  drawTrees(track, cam, dirX, dirY, horizon) {
    const gl = this.gl, tp = this.treeProg, models = this.treeModels(), M = track.meters;
    if (!models) return false;
    if (!this.treeLooks || this.treeLooks.trees !== track.trees) this.treeLooks = { trees: track.trees, looks: treeLooks(track.trees) };
    const looks = this.treeLooks.looks;
    const lists = TREE_KINDS.map(() => TREE_LODS.map(() => []));
    const rx = -dirY, ry = dirX, wide = this.planeLen * 1.15;
    track.trees.forEach((t, i) => {
      const dx = t.x - cam.x, dy = t.y - cam.y;
      const depth = dx * dirX + dy * dirY, side = dx * rx + dy * ry, k = (TREE_SIZE * t.scale) / M;
      if (depth < -4 * k || depth > MAX_DIST || Math.abs(side) > Math.max(0, depth) * wide + 4 * k) return;
      const l = looks[i], lod = TREE_LODS.findIndex((d) => depth < d.upTo), list = lists[l.kind];
      // cerca del cambio de nivel se dibujan los dos, cada uno en parte de los píxeles (se van pasando de a poco)
      const upTo = TREE_LODS[lod].upTo, band = upTo * TREE_BLEND;
      if (depth > upTo - band && lod + 1 < TREE_LODS.length) {
        const f = (depth - (upTo - band)) / band;
        list[lod].push(t.x, t.y, t.z, k, l.cos, l.sin, l.tint, 2 + f);
        list[lod + 1].push(t.x, t.y, t.z, k, l.cos, l.sin, l.tint, f);
      } else list[lod].push(t.x, t.y, t.z, k, l.cos, l.sin, l.tint, 1);
    });
    gl.useProgram(tp.p);
    this.camera(tp, cam, dirX, dirY, horizon);
    gl.uniform1f(tp.u.uTime, this.time ?? (performance.now() / 1000) % 100000);
    models.forEach((levels, kind) => levels.forEach((m, lod) => {
      const v = lists[kind][lod];
      if (!v.length) return;
      gl.bindVertexArray(m.vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, m.inst);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(v), gl.DYNAMIC_DRAW);
      gl.drawElementsInstanced(gl.TRIANGLES, m.count, m.type, 0, v.length / 8);
    }));
    gl.bindVertexArray(null);
    return true;
  }

  drawSmoke(cam, dirX, dirY, horizon) {
    const gl = this.gl, sp = this.smokeProg, rx = -dirY, ry = dirX;
    const list = [];
    for (const p of this.smoke.puffs) {
      const depth = (p.x - cam.x) * dirX + (p.y - cam.y) * dirY;
      if (depth > 0.2 && depth < MAX_DIST) list.push([depth, p]);
    }
    if (!list.length) return;
    list.sort((a, b) => b[0] - a[0]);
    const v = new Float32Array(list.length * 6 * 7);
    let o = 0;
    for (const [, p] of list) {
      const { alpha, size } = puffLook(p), h = size / 2;
      const c = Math.cos(p.spin), s = Math.sin(p.spin); // cada una girada distinto, así los grumos no se repiten
      const uv = (a, b) => [0.5 + (a * c - b * s) * 0.5, 0.5 + (a * s + b * c) * 0.5];
      const corner = (a, b) => {
        const [u, w] = uv(a, b);
        v.set([p.x + rx * h * a, p.y + ry * h * a, p.z + h * (1 - b), u, w, alpha, p.shade], o);
        o += 7;
      };
      corner(-1, 1); corner(1, 1); corner(1, -1); corner(-1, 1); corner(1, -1); corner(-1, -1);
    }
    gl.useProgram(sp.p);
    this.camera(sp, cam, dirX, dirY, horizon);
    this.bind(0, this.puffTex, sp, 'uTex');
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
    gl.bindVertexArray(this.smokeVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.smokeBuf);
    gl.bufferData(gl.ARRAY_BUFFER, v, gl.DYNAMIC_DRAW);
    gl.drawArrays(gl.TRIANGLES, 0, list.length * 6);
    gl.bindVertexArray(null);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
  }

  // las sombras de los árboles: un óvalo suave por árbol, estirado lejos del sol, apoyado en el piso (en tramos,
  // para seguir las lomas). Se arma una vez por circuito
  treeShadows(track) {
    if (this.treeShadowMeshes.has(track)) return this.treeShadowMeshes.get(track);
    const gl = this.gl, M = track.meters, v = [];
    const sl = Math.hypot(SUN[0], SUN[1]), sx = SUN[0] / sl, sy = SUN[1] / sl, px = -sy, py = sx;
    const reach = sl / SUN[2]; // cuánto se estira la sombra por cada metro de alto
    const z = (x, y) => sampleField(track.height, track.W, x, y) + 0.04;
    const N = 4;
    for (const t of track.trees) {
      const k = (TREE_SIZE * t.scale) / M, w = 2.3 * k, back = 1.2 * k, len = 8.5 * k * reach + 2 * k;
      for (let i = 0; i < N; i++) {
        const a0 = -back + ((len + back) * i) / N, a1 = -back + ((len + back) * (i + 1)) / N;
        const v0 = i / N, v1 = (i + 1) / N;
        const P = (a, b) => { const X = t.x + sx * a + px * b, Y = t.y + sy * a + py * b; return [X, Y, z(X, Y)]; };
        const A = P(a0, -w), B = P(a0, w), C = P(a1, w), D = P(a1, -w);
        v.push(...A, 0, v0, ...B, 1, v0, ...C, 1, v1, ...A, 0, v0, ...C, 1, v1, ...D, 0, v1);
      }
    }
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    this.buffer(new Float32Array(v));
    this.attrib(this.softShadows, 'aPos', 3, 5, 0);
    this.attrib(this.softShadows, 'aUV', 2, 5, 3);
    gl.bindVertexArray(null);
    const mesh = { vao, count: v.length / 5 };
    this.treeShadowMeshes.set(track, mesh);
    return mesh;
  }

  // las marcas de goma en una textura del tamaño de su imagen; después se sube sólo lo que cambió
  skidTexture(sk) {
    const gl = this.gl;
    if (this.skidMap !== sk) {
      if (this.skidTex) gl.deleteTexture(this.skidTex);
      this.skidTex = this.texture(sk.data, sk.w, sk.h, { format: 'R8', clamp: true });
      this.skidMap = sk;
      sk.dirty = null;
    } else if (sk.dirty) {
      const { x0, y0, x1, y1 } = sk.dirty;
      gl.bindTexture(gl.TEXTURE_2D, this.skidTex);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.pixelStorei(gl.UNPACK_ROW_LENGTH, sk.w);
      gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, x0);
      gl.pixelStorei(gl.UNPACK_SKIP_ROWS, y0);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, x0, y0, x1 - x0 + 1, y1 - y0 + 1, gl.RED, gl.UNSIGNED_BYTE, sk.data);
      gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
      gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0);
      gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);
      sk.dirty = null;
    }
    return this.skidTex;
  }

  // textura 3D de dos canales (r, g) que se repite, con mipmaps (para las nubes)
  texture3D({ size, data }) {
    const gl = this.gl, t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_3D, t);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RG8, size, size, size, 0, gl.RG, gl.UNSIGNED_BYTE, data);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    for (const w of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T, gl.TEXTURE_WRAP_R]) gl.texParameteri(gl.TEXTURE_3D, w, gl.REPEAT);
    gl.generateMipmap(gl.TEXTURE_3D);
    return t;
  }

  // la goma (rubber.js) en una textura de carriles (ancho) × filas (alto), como están los bytes: se vuelve a subir
  // cuando el mapa cambia
  rubberTexture(map) {
    const gl = this.gl;
    if (this.rubberMap !== map) {
      if (this.rubberTex) gl.deleteTexture(this.rubberTex);
      this.rubberTex = this.texture(map.bytes, map.lanes, map.rows, { format: 'R8' });
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      if (this.wearTex) gl.deleteTexture(this.wearTex);
      this.wearTex = this.texture(map.wearBytes, map.wearLanes, map.rows, { format: 'R8' });
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      this.rubberMap = map;
      this.rubberVersion = map.version;
      this.wearVersion = map.wearVersion;
      map.wearDirty = null;
    } else {
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      if (this.rubberVersion !== map.version) {
        gl.bindTexture(gl.TEXTURE_2D, this.rubberTex);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, map.lanes, map.rows, gl.RED, gl.UNSIGNED_BYTE, map.bytes);
        this.rubberVersion = map.version;
      }
      // el pasto gastado cambia en el momento: se suben sólo las filas que cambiaron
      if (this.wearVersion !== map.wearVersion && map.wearDirty) {
        const { lo, hi } = map.wearDirty, n = map.wearLanes;
        gl.bindTexture(gl.TEXTURE_2D, this.wearTex);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, lo, n, hi - lo + 1, gl.RED, gl.UNSIGNED_BYTE, map.wearBytes.subarray(lo * n, (hi + 1) * n));
        this.wearVersion = map.wearVersion;
        map.wearDirty = null;
      }
    }
    return this.rubberTex;
  }

  bind(unit, tex, prog, name) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(prog.u[name], unit);
  }

  // ---------- datos del circuito, en texturas ----------
  trackTextures(track) {
    let t = this.trackData.get(track);
    if (!t) {
      const { W, H, height, sdf, lat, station, kerbLeft, kerbRight, sausageLeft, sausageRight, runoffLeft, runoffRight } = track;
      const reach = edgeReach(track.kerbStyle ?? KERB_STYLE);
      // por celda: altura, distancia al borde, distancia de costado a la línea central y cuánto piano hay (0..1);
      // aparte, cuánta salchicha
      const f = new Float32Array(W * H * 4), sq = new Float32Array(W * H * 4);
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
      const n = kerbLeft.length, rows = Math.ceil(n / LINE_TEX_W);
      t = {
        field: this.texture(f, W, H, { format: 'RGBA16F', clamp: true }),
        sausage: this.texture(sq, W, H, { format: 'RGBA16F', clamp: true }),
        station: this.texture(Float32Array.from(station), W, H, { format: 'R32F', nearest: true, clamp: true }),
        n, rows, kerbLeft, kerbRight, runoffLeft, runoffRight, offset: undefined, line: null,
        guide: this.texture(new Uint8Array(LINE_TEX_W * rows * 4), LINE_TEX_W, rows, { nearest: true, clamp: true }),
      };
      this.trackData.set(track, t);
    }
    // por celda de la línea central: pianos a cada lado, por dónde pasa la trazada (para la guía) y las escapatorias
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
      const gl = this.gl, c = this.guide.color;
      const rows = Math.ceil(Math.min(c.length, t.n) / LINE_TEX_W);
      const bytes = new Uint8Array(LINE_TEX_W * rows * 4);
      bytes.set(new Uint8Array(c.buffer, c.byteOffset, Math.min(c.length, t.n) * 4));
      gl.bindTexture(gl.TEXTURE_2D, t.guide);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, LINE_TEX_W, rows, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
    }
    return t;
  }

  // texturas de los autos y de los sprites (se suben una vez)
  // la pantalla del volante: el canvas que dibuja el juego en cada cuadro (sin canvas, apagada)
  screenTexture(canvas) {
    const gl = this.gl;
    if (!this.screenTex) {
      this.screenTex = this.texture(new Uint8Array([5, 7, 10, 255]), 1, 1, { clamp: true });
      this.screenOff = this.screenTex;
    }
    if (!canvas) return this.screenOff;
    if (this.screenOff === this.screenTex) this.screenTex = this.texture(canvas, canvas.width, canvas.height, { clamp: true });
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
      else t = this.texture(new Uint8Array(tex.levels[0].buffer, tex.levels[0].byteOffset, tex.levels[0].byteLength), tex.size, tex.size, { mip: true });
      this.texCache.set(tex, t);
    }
    return t;
  }

  // ---------- geometría de un auto, armada una vez ----------
  // cada cara (un polígono convexo) se parte en triángulos; cada vértice lleva posición, normal, color, coordenadas
  // de textura, qué textura usa (0 ninguna, 1 decoración, 2 carbono, 3 flanco, 4 banda, 5 llanta), a qué rueda pertenece, una normal
  // suavizada (para que el reflejo corra parejo sobre las curvas y no se vean las facetas) y cuánto brilla
  modelGeometry(model) {
    let g = this.modelCache.get(model);
    if (g) return g;
    const gl = this.gl;
    const data = [];
    const wheels = [];
    const texs = {};
    let helmetStart = -1;
    let neck = { x: 0, y: 0, z: 0 }, column = { x: 0, y: 0, z: 0, ax: 1, ay: 0, az: 0 };
    const parts = [...model.filter((p) => p.tag !== 'helmet'), ...model.filter((p) => p.tag === 'helmet')];
    for (const part of parts) {
      if (part.tag === 'helmet' && helmetStart < 0) helmetStart = data.length / STRIDE;
      // a qué rueda pertenece (1 a 4), 5 si es la cabeza del piloto y 6 si es el volante; lo que va montado en la
      // mangueta (fixed: dobla con la rueda pero no gira), 7 a 10; lo que sigue al volante de a poco (follow: los
      // antebrazos), de 11 a 12 en cada vértice; las levas y las manos (que se mueven al cambiar), de 13 a 16
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
      // caras de la pieza que tocan cada vértice
      const touching = part.verts.map(() => []);
      for (const face of part.faces) for (const i of face.idx) touching[i].push(face.n);
      for (const face of part.faces) {
        const [r, gg, b] = rgbOf(face.color);
        // normal suavizada en cada esquina: el promedio de las caras vecinas que no doblan demasiado (las aristas
        // marcadas, como las de una caja, quedan marcadas)
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
        // qué textura es lo dice el modelo (slot: 1 decoración, 2 carbono, 3 flanco, 4 banda, 5 llanta)
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
          data.push(x, y, z, face.n[0], face.n[1], face.n[2], r, gg, b, uv[0] / size, uv[1] / size, tid, wv, ...smooth[a], gloss);
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

  // uniforms de la cámara, iguales en todos los programas que proyectan
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
    const dirX = Math.cos(cam.angle), dirY = Math.sin(cam.angle);
    const horizon = this.h / 2 + (cam.pitch || 0);
    const t = this.trackTextures(track);

    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);
    gl.disable(gl.BLEND);

    // 1) cielo y terreno (escribe la profundidad de cada píxel)
    const tp = this.terrain;
    gl.useProgram(tp.p);
    gl.depthFunc(gl.ALWAYS);
    // la goma se sube antes de enganchar las demás: subirla usa la unidad activa y pisaría la última
    const rubber = this.rubber && this.rubberTexture(this.rubber);
    const skidTex = this.skids ? this.skidTexture(this.skids) : this.noSkids; // (las marcas también)
    this.bind(0, t.field, tp, 'uField');
    this.bind(1, t.station, tp, 'uStation');
    this.bind(2, t.line, tp, 'uLine');
    this.bind(4, this.asphalt, tp, 'uAsphalt');
    this.bind(5, this.grass, tp, 'uGrass');
    this.bind(8, this.gravel, tp, 'uGravel');
    this.bind(6, this.wall, tp, 'uWall');
    this.bind(7, this.macro, tp, 'uMacro');
    this.bind(9, t.sausage, tp, 'uSausage');
    this.bind(10, this.dirt, tp, 'uDirt');
    this.bind(11, this.grassMask, tp, 'uGrassMask');
    this.bind(14, skidTex, tp, 'uSkid');
    gl.activeTexture(gl.TEXTURE13);
    gl.bindTexture(gl.TEXTURE_3D, this.clouds);
    gl.uniform1i(tp.u.uClouds, 13);
    gl.uniform1f(tp.u.uTime, this.time ?? (performance.now() / 1000) % 100000);
    const ks = track.kerbStyle ?? KERB_STYLE;
    gl.uniform4f(tp.u.uKerbStyle, ks.width, ks.stripe, ks.green, ks.line ? 1 : 0);
    gl.uniform2f(tp.u.uMap, track.W, track.H);
    gl.uniform1i(tp.u.uLineN, t.n);
    gl.uniform1f(tp.u.uRunoff, track.runoff);
    const kerb = (track.kerbColors ?? DEFAULT_KERB).slice(0, MAX_KERB_COLORS);
    gl.uniform3fv(tp.u.uKerb, kerb.flatMap(([r, g, b]) => [r / 255, g / 255, b / 255]));
    gl.uniform1i(tp.u.uKerbN, kerb.length);
    const { line } = track;
    gl.uniform4f(tp.u.uStart, line.x, line.y, line.dx, line.dy);
    gl.uniform1f(tp.u.uStartHalf, line.half);
    gl.uniform1i(tp.u.uFlags, this.rubber ? 2 : 0);
    if (this.rubber) {
      this.bind(3, rubber, tp, 'uRubber');
      this.bind(12, this.wearTex, tp, 'uWear');
      gl.uniform2f(tp.u.uRubberSize, this.rubber.length, this.rubber.span);
    }
    gl.uniform3f(tp.u.uCam, cam.x, cam.y, cam.z);
    gl.uniform1f(tp.u.uGround, cam.ground);
    gl.uniform1f(tp.u.uZStart, Math.max(Z_NEAR, ((cam.z - cam.ground - NEAR_RISE) * this.P) / Math.max(1, this.h - horizon)));
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

    // 2) sombras de los autos sobre el piso
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
        const k = 1 / m.meters, ca = Math.cos(m.angle), sa = Math.sin(m.angle);
        const ox = SHADOW_SHIFT * SUN[0] * k, oy = SHADOW_SHIFT * SUN[1] * k;
        const v = [];
        for (const [lx, ly] of SHADOW) {
          const X = m.x + (ca * lx - sa * ly) * k + ox, Y = m.y + (sa * lx + ca * ly) * k + oy;
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

    // 2b) sombras de los árboles
    if (track.trees?.length) {
      const sp = this.softShadows, mesh = this.treeShadows(track);
      gl.useProgram(sp.p);
      this.camera(sp, cam, dirX, dirY, horizon);
      this.bind(0, this.treeShadowTex, sp, 'uTex');
      gl.uniform1f(sp.u.uAlpha, 0.42);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.depthMask(false);
      gl.enable(gl.POLYGON_OFFSET_FILL);
      gl.polygonOffset(-2, -8);
      gl.bindVertexArray(mesh.vao);
      gl.drawArrays(gl.TRIANGLES, 0, mesh.count);
      gl.bindVertexArray(null);
      gl.disable(gl.POLYGON_OFFSET_FILL);
      gl.disable(gl.BLEND);
      gl.depthMask(true);
    }

    // 3) autos: primero los sólidos y al final los semitransparentes (el fantasma)
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

    // 3b) árboles, en 3D (si las mallas ya están; si no, van como sprites)
    const trees3d = !!track.trees?.length && this.drawTrees(track, cam, dirX, dirY, horizon);

    // 4) carteles (y los árboles viejos, si alguno viene como sprite): rectángulos de frente a la cámara, agrupados
    // por textura
    const sprp = this.sprites;
    gl.useProgram(sprp.p);
    this.camera(sprp, cam, dirX, dirY, horizon);
    const rx = -dirY, ry = dirX;
    const groups = new Map();
    for (const s of sprites) {
      if (s.tree && trees3d) continue; // los árboles van en 3D (drawTrees)
      const depth = (s.x - cam.x) * dirX + (s.y - cam.y) * dirY;
      if (depth < 0.3 || depth > MAX_DIST) continue; // con la bruma al FOG_MAX, todavía se ven un poco
      if (!groups.has(s.tex)) groups.set(s.tex, []);
      const v = groups.get(s.tex);
      const hw = s.width / 2, z0 = s.z || 0, z1 = z0 + s.height;
      const ax = s.x - rx * hw, ay = s.y - ry * hw, bx = s.x + rx * hw, by = s.y + ry * hw;
      v.push(ax, ay, z0, 0, 1, bx, by, z0, 1, 1, bx, by, z1, 1, 0, ax, ay, z0, 0, 1, bx, by, z1, 1, 0, ax, ay, z1, 0, 0);
    }
    gl.bindVertexArray(this.flatVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.dynamic);
    for (const [tex, v] of groups) {
      this.bind(0, this.glTexture(tex), sprp, 'uTex');
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(v), gl.DYNAMIC_DRAW);
      gl.drawArrays(gl.TRIANGLES, 0, v.length / 5);
    }
    gl.bindVertexArray(null);

    // 4b) humo de las ruedas: semitransparente, de lo más lejos a lo más cerca, sin tapar lo que viene atrás
    if (this.smoke?.puffs.length) this.drawSmoke(cam, dirX, dirY, horizon);

    // 5) ayuda de trazada, semitransparente, al final
    if (this.guide) {
      const gp = this.guides, mesh = this.guideMesh(track, this.guide);
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

  // un auto (m: { model, x, y, z, angle, pitch, roll, ... } como en render), con el programa de los autos ya en uso.
  // basis: [F, R, U] para orientarlo de cualquier forma (si no, sale de angle y pitch)
  drawModel(m, alpha = 1, basis = null) {
    const gl = this.gl, mp = this.models;
    const g = this.modelGeometry(m.model);
    const ca = Math.cos(m.angle || 0), sa = Math.sin(m.angle || 0);
    const cp = Math.cos(m.pitch || 0), sp = Math.sin(m.pitch || 0);
    const [F, R, U] = basis ?? [[ca * cp, sa * cp, sp], [-sa, ca, 0], [-ca * sp, -sa * sp, cp]];
    gl.uniform3f(mp.u.uPos, m.x, m.y, m.z);
    gl.uniform3f(mp.u.uF, ...F);
    gl.uniform3f(mp.u.uR, ...R);
    gl.uniform3f(mp.u.uU, ...U);
    gl.uniform4f(mp.u.uBody, Math.cos(m.roll || 0), Math.sin(m.roll || 0), Math.cos(m.dive || 0), Math.sin(m.dive || 0));
    gl.uniform1f(mp.u.uK, 1 / m.meters);
    gl.uniform2f(mp.u.uSpin, Math.cos(m.spin || 0), Math.sin(m.spin || 0));
    const st = m.steer || 0; // ángulo de las ruedas delanteras (rad)
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
    // primero se crean todas (crear una la deja atada a la unidad activa) y después se atan
    const texs = [1, 2, 3, 4, 5].map((k) => g.texs[k] && this.glTexture(g.texs[k]));
    if (g.texs[6]) texs.push(this.screenTexture(m.screen));
    ['uLivery', 'uCarbon', 'uSidewall', 'uTread', 'uRim', 'uScreen'].forEach((name, i) => {
      if (texs[i]) this.bind(i, texs[i], mp, name);
    });
    gl.bindVertexArray(g.vao);
    gl.drawArrays(gl.TRIANGLES, 0, m.hide === 'helmet' ? g.helmetStart : g.count);
  }

  // Un auto solo, como en una vitrina (el menú): ocupa todo el canvas (de w × h píxeles), sobre fondo transparente.
  // La cámara queda quieta, mirando hacia +x a la altura del auto; el auto gira (yaw) y se inclina hacia la cámara
  // (pitch), así se lo ve desde arriba sin cambiar la proyección del juego (que no cabecea). dist: de la cámara al
  // auto (m); P: distancia focal (píxeles). Devuelve cómo se proyecta un punto del auto, para dibujar su sombra.
  showcase(model, { yaw = 0, pitch = 0, dist = 14, P, z0 = 0.45 }, w, h) {
    const gl = this.gl, mp = this.models;
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
    // girar alrededor del eje vertical y después inclinar la parte de arriba hacia la cámara (alrededor de y)
    const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
    const tilt = ([x, y, z]) => [x * cp - z * sp, y, x * sp + z * cp];
    const basis = [[cy, sy, 0], [-sy, cy, 0], [0, 0, 1]].map(tilt);
    // el punto z0 del auto (sobre su centro) queda en el centro de la imagen
    const c = tilt([0, 0, z0]);
    const pos = [dist - c[0], -c[1], -c[2]];
    this.drawModel({ model, x: pos[0], y: pos[1], z: pos[2], meters: 1 }, 1, basis);
    gl.bindVertexArray(null);
    return ([x, y, z]) => {
      const [F, R, U] = basis;
      const wx = pos[0] + F[0] * x + R[0] * y + U[0] * z, wy = pos[1] + F[1] * x + R[1] * y + U[1] * z;
      const wz = pos[2] + F[2] * x + R[2] * y + U[2] * z;
      return [w / 2 + (wy * P) / wx, h / 2 - (wz * P) / wx];
    };
  }

  // cinta de la ayuda de trazada: dos vértices por celda de la línea central, uno a cada lado de la trazada
  guideMesh(track, line) {
    let mesh = this.guideMeshes.get(line);
    if (mesh) return mesh;
    const gl = this.gl, f = lineFrame(track), L = line.offset.length;
    const data = new Float32Array((L + 1) * 2 * 5);
    let o = 0;
    for (let k = 0; k <= L; k++) {
      const u = k % L, p = pointAt(f, u, line.offset[u]);
      const nx = f.nx[u % f.L], ny = f.ny[u % f.L];
      for (const side of [-1, 1]) {
        const x = p.x + nx * GUIDE_W * side, y = p.y + ny * GUIDE_W * side;
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
