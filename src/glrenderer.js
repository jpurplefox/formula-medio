// Render con WebGL 2: lo mismo que renderer.js, pero en la placa de video.
// - Cielo y terreno: un "shader" que corre una vez por píxel. Para cada píxel se arma el rayo de la cámara y se avanza
//   sobre el mapa de alturas hasta chocar con el piso o un muro (paso a paso, y después afinando el punto exacto).
//   El paso se achica cerca de los muros usando la distancia al borde de la pista, así ningún rayo los saltea.
//   El color del piso (asfalto, pasto, pianos, trazada, goma) es el mismo "shader" de renderer.js, escrito en GLSL.
// - Autos, árboles y carteles: triángulos con la misma proyección que el terreno (un horizonte que se corre en vez de
//   inclinar la cámara) y la misma profundidad, así el z-buffer de la placa resuelve qué tapa a qué.
// La resolución de la imagen es la de la pantalla (con un tope); las cuentas de cámara siguen en los mismos
// "píxeles virtuales" de 960 de ancho que usa el resto del juego.

import { KERB_W, kerbAmount, stationAt } from './track.js';
import { RUBBER_DARK } from './rubber.js';
import { asphaltTexture, grassTexture, macroNoise, wallTexture } from './textures.js';
import {
  FOG_END, FOG_START, GRASS_BAND, GRASS_TPC, GUIDE_W, KERB_H, LINE_W, MACRO_TPC, MAX_DIST, MODEL_NEAR, NEAR_RISE, PLANE_LEN,
  BODY_PIVOT_Z, ROAD_TPC, SHADOW, SHADOW_SHIFT, STRIPE, SUN, WALL_H, WALL_STRIPE, WALL_T, Z_NEAR,
} from './renderer.js';
import { sampleField } from './track.js';
import { lineFrame, pointAt } from './ai.js';

const FAR = MAX_DIST + 10; // lo más lejos que se guarda en el z-buffer (en celdas)
const MAX_SCALE = 1.5; // como mucho, 1,5 veces los píxeles virtuales (1440×810): más no se nota y calienta la máquina
const LINE_TEX_W = 1024; // ancho de las texturas con datos por celda de la línea central
const GUIDE_LIFT = 0.1; // cuánto flota la ayuda de trazada sobre la pista (celdas; el lomo de los pianos es KERB_H)
const GUIDE_ALPHA = 0.6; // opacidad de la ayuda de trazada en el centro
const ATTRIBS = ['aPos', 'aUV', 'aNormal', 'aColor', 'aTex', 'aWheel', 'aSmooth', 'aGloss'];
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
vec3 fog(vec3 c, float d) {
  float t = clamp((d - ${glsl(FOG_START)}) / ${glsl(FOG_END - FOG_START)}, 0.0, 1.0);
  return mix(c, FOG, t * t);
}`;

// ---------- cielo y terreno ----------
const TERRAIN_VS = `#version 300 es
in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`;

const TERRAIN_FS = `#version 300 es
precision highp float;
precision highp sampler2D;
uniform sampler2D uField, uStation, uLine, uAsphalt, uGrass, uWall, uMacro, uRubber;
uniform vec2 uMap;
uniform int uLineN;
uniform vec2 uRubberSize; // largo de la vuelta y de la línea central al último carril (celdas)
uniform float uRunoff;
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
const float KERB_W = ${glsl(KERB_W)}, KERB_H = ${glsl(KERB_H)}, LINE_W = ${glsl(LINE_W)}, STRIPE = ${glsl(STRIPE)};
const float RUBBER_DARK = ${glsl(RUBBER_DARK)};
const float ROAD_TPC = ${glsl(ROAD_TPC)}, GRASS_TPC = ${glsl(GRASS_TPC)}, GRASS_BAND = ${glsl(GRASS_BAND)}, MACRO_TPC = ${glsl(MACRO_TPC)};
const vec3 KERB_RED = vec3(200.0, 30.0, 30.0) / 255.0, KERB_WHITE = vec3(235.0) / 255.0, EDGE_WHITE = vec3(225.0) / 255.0;
const vec3 LINE_BLACK = vec3(20.0) / 255.0, LINE_WHITE = vec3(245.0) / 255.0, WALL_TOP = vec3(150.0, 150.0, 155.0) / 255.0;
const vec3 SKY_TOP = vec3(70.0, 130.0, 210.0) / 255.0, MOUNTAIN = vec3(110.0, 135.0, 160.0) / 255.0;

vec4 field(vec2 p) { return texture(uField, p / uMap); }
// el piano es un lomo por fuera del borde: sube desde el pasto, hace cumbre y baja hacia la pista
float kerbBump(vec4 f) {
  float kw = KERB_W * f.w;
  return f.w > 0.02 && f.y < 0.0 && f.y > -kw ? KERB_H * f.w * sin(3.14159265 * (f.y + kw) / kw) : 0.0;
}
vec3 shade(vec3 c, float k) { return min(c * k, vec3(1.0)); }
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

vec3 zone(float s, float outer, vec3 grass, vec3 kerb, vec3 road, vec3 edge) {
  if (s < outer) return grass;
  if (s < 0.0) return kerb;
  if (s < LINE_W) return edge;
  return road;
}

// el color del piso (lo mismo que groundColor de renderer.js)
vec3 ground(vec2 p, float fw, float s, float k, float st, float side, float lit) {
  float light = lit * (0.88 + 0.24 * texture(uMacro, p * MACRO_TPC / 64.0).r);
  bool isKerb = k > 0.02;
  float outer = isKerb ? -KERB_W * k : 0.0;
  vec3 grass = vec3(0.0);
  if (s < outer + fw) {
    float ph = (p.x + p.y) * (0.7071 / GRASS_BAND);
    float fr = fract(ph), e = min(0.5, fw / GRASS_BAND);
    float band = mod(floor(ph), 2.0);
    if (fr < e) band += (1.0 - 2.0 * band) * ((e - fr) / (2.0 * e));
    else if (fr > 1.0 - e) band += (1.0 - 2.0 * band) * ((fr - 1.0 + e) / (2.0 * e));
    float g = fw * GRASS_TPC / 128.0;
    grass = shade(textureGrad(uGrass, p * GRASS_TPC / 128.0, vec2(g, 0.0), vec2(0.0, g)).rgb, light * (0.9 + band * 0.2));
    if (s < outer - fw) return grass;
  }
  float ga = fw * ROAD_TPC / 256.0;
  vec3 road = textureGrad(uAsphalt, p * ROAD_TPC / 256.0, vec2(ga, 0.0), vec2(0.0, ga)).rgb;
  float dark = 0.0;
  if ((uFlags & 2) != 0 && st >= 0.0) {
    // la goma del mapa (rubber.js): a lo largo según st, a lo ancho según de qué lado y cuánto
    float v = (side / uRubberSize.y + 1.0) * 0.5;
    if (v > 0.0 && v < 1.0) dark = RUBBER_DARK * texture(uRubber, vec2(st / uRubberSize.x, v)).r;
  }
  road = shade(road, light * (1.0 - dark));
  vec2 a2 = p - uStart.xy;
  float al = dot(a2, uStart.zw);
  if (al > -0.7 && al < 0.7) {
    float l = -a2.x * uStart.w + a2.y * uStart.z;
    if (abs(l) < uStartHalf) road = shade(mod(floor((al + 0.7) * 2.0) + floor((l + 200.0) * 2.0), 2.0) > 0.5 ? LINE_WHITE : LINE_BLACK, lit);
  }
  if (s > LINE_W + fw) return road;
  vec3 kerbC = EDGE_WHITE;
  if (isKerb) {
    float ph = st / STRIPE, fr = fract(ph);
    bool red = mod(floor(ph), 2.0) > 0.5;
    vec3 cur = red ? KERB_RED : KERB_WHITE, other = red ? KERB_WHITE : KERB_RED;
    float e = min(0.5, fw / STRIPE);
    float ow = fr < e ? (e - fr) / (2.0 * e) : fr > 1.0 - e ? (fr - 1.0 + e) / (2.0 * e) : 0.0;
    kerbC = mix(cur, other, ow);
  }
  kerbC = shade(kerbC, lit);
  vec3 edgeC = shade(EDGE_WHITE, lit);
  float edge = outer;
  if (isKerb && abs(s) < abs(s - edge)) edge = 0.0;
  if (abs(s - LINE_W) < abs(s - edge)) edge = LINE_W;
  float zs = s - edge;
  if (zs > -fw && zs < fw) return mix(zone(edge - fw, outer, grass, kerbC, road, edgeC), zone(edge + fw, outer, grass, kerbC, road, edgeC), (zs + fw) / (2.0 * fw));
  return zone(s, outer, grass, kerbC, road, edgeC);
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

  float d = uZStart, prev = d;
  bool hit = false;
  for (int i = 0; i < 400; i++) {
    vec4 f = field(uCam.xy + rd * d);
    float top = f.x + (f.y < wallIn && f.y > wallOut ? WALL_H : kerbBump(f));
    if (uCam.z - drop * d <= top) { hit = true; break; }
    // paso: unos píxeles de pantalla, y nunca más que la distancia a la franja del muro
    float band = f.y > wallIn ? f.y - wallIn : (f.y < wallOut ? wallOut - f.y : 0.0);
    float step = min(clamp(d * d * invCP * 2.0, 0.015, 0.2 + 0.025 * d), max(0.03, band / rdl));
    prev = d;
    d += step;
    if (d > MAX_DIST) break;
  }

  if (!hit) {
    // cielo con montañas lejanas, o niebla debajo del horizonte
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
  // afinamos dónde choca el rayo
  float a = prev, b = d;
  for (int k = 0; k < 7; k++) {
    float m = (a + b) * 0.5;
    vec4 f = field(uCam.xy + rd * m);
    float top = f.x + (f.y < wallIn && f.y > wallOut ? WALL_H : kerbBump(f));
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
      // cara del guardrail, con su textura: a lo largo según la posición sobre la línea central, a lo alto desde arriba
      float st = max(0.0, stationAt(p));
      c = texture(uWall, vec2(st / (2.0 * WALL_STRIPE), (top - zr) / WALL_H)).rgb;
    } else c = WALL_TOP;
  } else {
    // luz por pendiente: las laderas que miran al sol se aclaran
    float gx = (field(p + vec2(1.0, 0.0)).x - field(p - vec2(1.0, 0.0)).x) * 0.5;
    float gy = (field(p + vec2(0.0, 1.0)).x - field(p - vec2(0.0, 1.0)).x) * 0.5;
    float lit = clamp(1.0 - (gx * -0.6 + gy * -0.8) * 4.0, 0.65, 1.3);
    float st = stationAt(p), side = f.z, k = f.w;
    float kw = KERB_W * k;
    if (k > 0.0 && s < 0.0 && s > -kw) lit *= 1.0 - 0.22 * cos(3.14159265 * (s + kw) / kw);
    float fw = max(0.03, d * uPlane / uView.x);
    c = ground(p, fw, s, k, st, side, lit);
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
// giro alrededor del eje de la columna (Rodrigues)
vec3 turn(vec3 n) { return n * uTurn.x + cross(uColumnAxis, n) * uTurn.y + uColumnAxis * dot(uColumnAxis, n) * (1.0 - uTurn.x); }
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
  if (aWheel > 5.5) {
    // el volante gira sobre su columna
    p = uColumn + turn(p - uColumn);
    n = turn(n);
    sm = turn(sm);
  } else if (aWheel > 4.5) {
    // la cabeza del piloto gira alrededor del cuello
    p = uNeck + look(p - uNeck);
    n = look(n);
    sm = look(sm);
  } else if (aWheel > 0.5) {
    // la rueda gira sobre su eje y, si es delantera, dobla con la dirección
    vec4 wh = uWheels[int(aWheel + 0.5) - 1];
    p = wh.xyz + spin(p - wh.xyz);
    n = spin(n);
    sm = spin(sm);
    if (wh.w > 0.5) {
      p = wh.xyz + steer(p - wh.xyz);
      n = steer(n);
      sm = steer(sm);
    }
  }
  // todo menos las ruedas (que quedan apoyadas en el piso) se mueve con la suspensión
  if (aWheel < 0.5 || aWheel > 4.5) {
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

export class GLRenderer {
  // devuelve null si el navegador no tiene WebGL 2 (o algo falla): ahí se usa el renderer de siempre
  static create(canvas, w, h) {
    try {
      const gl = canvas.getContext('webgl2', { antialias: true, alpha: false, depth: true });
      return gl ? new GLRenderer(canvas, gl, w, h) : null;
    } catch (err) {
      console.warn('WebGL no disponible:', err);
      return null;
    }
  }

  constructor(canvas, gl, w, h) {
    this.gl = gl;
    this.canvas = canvas;
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
    this.wall = repeatTex(wallTexture());
    const macro = macroNoise();
    this.macro = this.texture(Uint8Array.from(macro.data, (v) => Math.round(((v - 0.88) / 0.24) * 255)), macro.size, macro.size, { format: 'R8' });

    this.trackData = new WeakMap();
    this.texCache = new WeakMap();
    this.modelCache = new WeakMap();
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

  // la goma (rubber.js) en una textura de filas × carriles: se vuelve a subir cuando el mapa cambia
  rubberTexture(map) {
    const gl = this.gl;
    if (this.rubberMap !== map) {
      if (this.rubberTex) gl.deleteTexture(this.rubberTex);
      this.rubberTex = this.texture(map.bytes, map.rows, map.lanes, { format: 'R8' });
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this.rubberMap = map;
      this.rubberVersion = map.version;
    } else if (this.rubberVersion !== map.version) {
      gl.bindTexture(gl.TEXTURE_2D, this.rubberTex);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, map.rows, map.lanes, gl.RED, gl.UNSIGNED_BYTE, map.bytes);
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

  // ---------- datos del circuito, en texturas ----------
  trackTextures(track) {
    let t = this.trackData.get(track);
    if (!t) {
      const { W, H, height, sdf, lat, station, kerbLeft, kerbRight } = track;
      // por celda: altura, distancia al borde, distancia de costado a la línea central y cuánto piano hay (0..1)
      const f = new Float32Array(W * H * 4);
      for (let i = 0; i < W * H; i++) {
        f[i * 4] = height[i];
        f[i * 4 + 1] = sdf[i];
        f[i * 4 + 2] = lat[i];
        if (sdf[i] > -KERB_W - 1 && sdf[i] < 1) {
          const st = stationAt(track, (i % W) + 0.5, Math.floor(i / W) + 0.5);
          if (st >= 0) f[i * 4 + 3] = kerbAmount(lat[i] > 0 ? kerbRight : kerbLeft, st);
        }
      }
      const n = kerbLeft.length, rows = Math.ceil(n / LINE_TEX_W);
      t = {
        field: this.texture(f, W, H, { format: 'RGBA16F', clamp: true }),
        station: this.texture(Float32Array.from(station), W, H, { format: 'R32F', nearest: true, clamp: true }),
        n, rows, kerbLeft, kerbRight, offset: undefined, line: null,
        guide: this.texture(new Uint8Array(LINE_TEX_W * rows * 4), LINE_TEX_W, rows, { nearest: true, clamp: true }),
      };
      this.trackData.set(track, t);
    }
    // por celda de la línea central: pianos a cada lado y por dónde pasa la trazada (para la guía)
    const offset = (this.guide && this.guide.offset) || null;
    if (t.offset !== offset) {
      const d = new Float32Array(LINE_TEX_W * t.rows * 4);
      for (let i = 0; i < t.n; i++) {
        d[i * 4] = t.kerbLeft[i];
        d[i * 4 + 1] = t.kerbRight[i];
        d[i * 4 + 2] = offset ? offset[Math.min(i, offset.length - 1)] : 0;
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
      // a qué rueda pertenece (1 a 4), 5 si es la cabeza del piloto y 6 si es el volante
      let w = 0;
      if (part.wheel) {
        let k = wheels.indexOf(part.wheel);
        if (k < 0) k = wheels.push(part.wheel) - 1;
        w = k + 1;
      } else if (part.head) {
        w = 5;
        neck = part.head;
      } else if (part.column) {
        w = 6;
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
          data.push(x, y, z, face.n[0], face.n[1], face.n[2], r, gg, b, uv[0] / size, uv[1] / size, tid, w, ...smooth[a], gloss);
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
    this.bind(0, t.field, tp, 'uField');
    this.bind(1, t.station, tp, 'uStation');
    this.bind(2, t.line, tp, 'uLine');
    this.bind(4, this.asphalt, tp, 'uAsphalt');
    this.bind(5, this.grass, tp, 'uGrass');
    this.bind(6, this.wall, tp, 'uWall');
    this.bind(7, this.macro, tp, 'uMacro');
    gl.uniform2f(tp.u.uMap, track.W, track.H);
    gl.uniform1i(tp.u.uLineN, t.n);
    gl.uniform1f(tp.u.uRunoff, track.runoff);
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

    // 3) autos: primero los sólidos y al final los semitransparentes (el fantasma)
    const mp = this.models;
    gl.useProgram(mp.p);
    this.camera(mp, cam, dirX, dirY, horizon);
    const sorted = [...models.filter((m) => (m.alpha ?? 1) >= 1), ...models.filter((m) => (m.alpha ?? 1) < 1)];
    for (const m of sorted) {
      const g = this.modelGeometry(m.model);
      const alpha = m.alpha ?? 1;
      if (alpha < 1) {
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        gl.depthMask(false);
      }
      const ca = Math.cos(m.angle), sa = Math.sin(m.angle);
      const cp = Math.cos(m.pitch || 0), sp = Math.sin(m.pitch || 0);
      gl.uniform3f(mp.u.uPos, m.x, m.y, m.z);
      gl.uniform3f(mp.u.uF, ca * cp, sa * cp, sp);
      gl.uniform3f(mp.u.uR, -sa, ca, 0);
      gl.uniform3f(mp.u.uU, -ca * sp, -sa * sp, cp);
      gl.uniform4f(mp.u.uBody, Math.cos(m.roll || 0), Math.sin(m.roll || 0), Math.cos(m.dive || 0), Math.sin(m.dive || 0));
      gl.uniform1f(mp.u.uK, 1 / m.meters);
      gl.uniform2f(mp.u.uSpin, Math.cos(m.spin || 0), Math.sin(m.spin || 0));
      const st = m.steer || 0; // ángulo de las ruedas delanteras (rad)
      gl.uniform2f(mp.u.uSteer, Math.cos(st), Math.sin(st));
      gl.uniform2f(mp.u.uHead, Math.cos(m.head || 0), Math.sin(m.head || 0));
      gl.uniform3f(mp.u.uNeck, g.neck.x, g.neck.y, g.neck.z);
      gl.uniform3f(mp.u.uColumn, g.column.x, g.column.y, g.column.z);
      gl.uniform3f(mp.u.uColumnAxis, g.column.ax, g.column.ay, g.column.az);
      gl.uniform2f(mp.u.uTurn, Math.cos(m.wheelTurn || 0), Math.sin(m.wheelTurn || 0));
      const wv = new Float32Array(16);
      g.wheels.forEach((w, i) => wv.set([w.x, w.y, w.z, w.front ? 1 : 0], i * 4));
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
      if (alpha < 1) {
        gl.disable(gl.BLEND);
        gl.depthMask(true);
      }
    }

    // 4) árboles y carteles: rectángulos de frente a la cámara, agrupados por textura
    const sprp = this.sprites;
    gl.useProgram(sprp.p);
    this.camera(sprp, cam, dirX, dirY, horizon);
    const rx = -dirY, ry = dirX;
    const groups = new Map();
    for (const s of sprites) {
      const depth = (s.x - cam.x) * dirX + (s.y - cam.y) * dirY;
      if (depth < 0.3 || depth > FOG_END) continue;
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
