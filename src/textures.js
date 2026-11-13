// Texturas procedurales para el piso y los muros, generadas al arrancar (sin imágenes externas).
// Cada textura es cuadrada, de lado potencia de 2, y se repite en el mundo. Tiene mipmaps:
// versiones cada vez más chicas (promediadas) que se usan a lo lejos, para que no "titile".

const rgb = (r, g, b) => (0xff000000 | (clamp(b) << 16) | (clamp(g) << 8) | clamp(r)) >>> 0;
const clamp = (v) => Math.max(0, Math.min(255, v | 0));

function rng(seed) {
  let s = seed;
  return () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
}

// Ruido suave (0..1) que se repite cada `size` píxeles: suma de octavas de ruido de valor,
// la primera con `cells` celdas por lado y cada una el doble de fina y la mitad de fuerte
function fbm(size, cells, octaves, seed) {
  const out = new Float32Array(size * size);
  const rand = rng(seed);
  let amp = 1, total = 0, g = cells;
  for (let o = 0; o < octaves; o++) {
    const grid = new Float32Array(g * g);
    for (let i = 0; i < g * g; i++) grid[i] = rand();
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const gx = (x * g) / size, gy = (y * g) / size;
        const x0 = gx | 0, y0 = gy | 0;
        let u = gx - x0, v = gy - y0;
        u = u * u * (3 - 2 * u);
        v = v * v * (3 - 2 * v);
        const x1 = (x0 + 1) % g, y1 = (y0 + 1) % g;
        const a = grid[y0 * g + x0], b = grid[y0 * g + x1], c = grid[y1 * g + x0], d = grid[y1 * g + x1];
        out[y * size + x] += amp * ((a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v);
      }
    }
    total += amp;
    amp *= 0.5;
    g = Math.min(size, g * 2);
  }
  for (let i = 0; i < out.length; i++) out[i] /= total;
  return out;
}

// Arma la cadena de mipmaps: cada nivel promedia de a 2×2 píxeles del anterior
function withMips(size, data) {
  const levels = [data];
  let s = size, cur = data;
  while (s > 1) {
    const h = s >> 1;
    const next = new Uint32Array(h * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < h; x++) {
        const i = 2 * y * s + 2 * x;
        const p = [cur[i], cur[i + 1], cur[i + s], cur[i + s + 1]];
        let r = 0, g = 0, b = 0;
        for (const c of p) { r += c & 255; g += (c >>> 8) & 255; b += (c >>> 16) & 255; }
        next[y * h + x] = rgb(r / 4, g / 4, b / 4);
      }
    }
    levels.push(next);
    cur = next;
    s = h;
  }
  return { size, levels };
}

// Color de la textura en (u, v), en texeles. fp = cuántos texeles cubre un píxel de pantalla:
// cuanto más grande, más chico el mipmap que se usa.
export function sample(tex, u, v, fp) {
  let l = 0;
  while (fp > 1 && l < tex.levels.length - 1) { fp *= 0.5; l++; }
  const s = tex.size >> l;
  const x = (Math.floor(u) >> l) & (s - 1), y = (Math.floor(v) >> l) & (s - 1);
  return tex.levels[l][y * s + x];
}

// Asfalto: gris con manchas grandes suaves, grano fino y piedritas claras y oscuras
export function asphaltTexture(size = 256) {
  const blot = fbm(size, 6, 4, 101);
  const rand = rng(7);
  const data = new Uint32Array(size * size);
  for (let i = 0; i < data.length; i++) {
    let v = 86 + (blot[i] - 0.5) * 30 + (rand() - 0.5) * 14;
    const r = rand();
    if (r < 0.05) v += 30; // piedrita clara
    else if (r < 0.11) v -= 22; // hueco oscuro
    data[i] = rgb(v, v, v + 4);
  }
  return withMips(size, data);
}

// Césped: verde con matas más claras y oscuras y briznas sueltas
export function grassTexture(size = 128) {
  const tufts = fbm(size, 8, 4, 202);
  const rand = rng(11);
  const data = new Uint32Array(size * size);
  for (let i = 0; i < data.length; i++) {
    const t = tufts[i] - 0.5;
    const n = (rand() - 0.5) * 22;
    const blade = rand() < 0.08 ? 18 : 0; // brizna iluminada
    data[i] = rgb(60 + t * 30 + n * 0.6 + blade, 134 + t * 40 + n + blade, 52 + t * 20 + n * 0.5);
  }
  return withMips(size, data);
}

// Tierra (las calvas del césped, ver grassMask): marrón con manchas suaves, grano y piedritas
export function dirtTexture(size = 128) {
  const patch = fbm(size, 8, 4, 606);
  const rand = rng(19);
  const data = new Uint32Array(size * size);
  for (let i = 0; i < data.length; i++) {
    let v = (patch[i] - 0.5) * 34 + (rand() - 0.5) * 20;
    const r = rand();
    if (r < 0.04) v += 28; // piedrita clara
    else if (r < 0.1) v -= 20; // terrón en sombra
    data[i] = rgb(112 + v, 96 + v * 0.9, 72 + v * 0.8);
  }
  return withMips(size, data);
}

// Dónde hay césped y dónde tierra: una imagen en blanco y negro (blanco = césped, negro = tierra) que se repite
// sobre todo el pasto (GRASS_MASK_CELLS celdas por lado, en renderer.js). Se genera con tools/grass_mask.py y se
// puede retocar a mano. Devuelve { size, data, soft, dry } con un byte por píxel (255 = césped; soft, desenfocada:
// para lo lejos, el pasto seco alrededor y lo hondo de cada calva; dry, ruido suave: zonas grandes de pasto más
// seco), o null si no se pudo cargar.
export const GRASS_MASK_URL = new URL('../textures/grass-mask.png', import.meta.url).href;
export async function loadGrassMask(url = GRASS_MASK_URL) {
  try {
    const img = await createImageBitmap(await (await fetch(url)).blob());
    const size = img.width;
    const c = new OffscreenCanvas(size, size);
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0, size, size);
    const px = g.getImageData(0, 0, size, size).data;
    const data = new Uint8Array(size * size);
    for (let i = 0; i < data.length; i++) data[i] = px[i * 4];
    const n = fbm(size, 4, 3, 707);
    let lo = Infinity, hi = -Infinity;
    for (const v of n) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
    const dry = Uint8Array.from(n, (v) => Math.round(((v - lo) / (hi - lo)) * 255)); // estirado a 0..255
    return { size, data, soft: blurWrap(data, size, Math.max(1, size >> 6)), dry };
  } catch {
    return null;
  }
}

// Desenfoque de caja (dos pasadas por eje), repetido en los bordes
function blurWrap(src, size, r) {
  let a = Float32Array.from(src), b = new Float32Array(src.length);
  const m = size - 1, n = 2 * r + 1;
  for (let pass = 0; pass < 4; pass++) {
    const horiz = pass % 2 === 0;
    for (let y = 0; y < size; y++) {
      let acc = 0;
      for (let k = -r; k <= r; k++) acc += horiz ? a[y * size + (k & m)] : a[(k & m) * size + y];
      for (let x = 0; x < size; x++) {
        if (horiz) b[y * size + x] = acc / n;
        else b[x * size + y] = acc / n;
        const add = (x + r + 1) & m, sub = (x - r) & m;
        acc += horiz ? a[y * size + add] - a[y * size + sub] : a[add * size + y] - a[sub * size + y];
      }
    }
    [a, b] = [b, a];
  }
  return Uint8Array.from(a, (v) => Math.round(v));
}

// Leca: piedritas color arena, con manchas suaves (donde la rastrillaron) y granos claros y oscuros
export function gravelTexture(size = 128) {
  const patch = fbm(size, 8, 4, 505);
  const rand = rng(17);
  const data = new Uint32Array(size * size);
  for (let i = 0; i < data.length; i++) {
    let v = (patch[i] - 0.5) * 26 + (rand() - 0.5) * 34;
    const r = rand();
    if (r < 0.12) v += 26; // piedrita al sol
    else if (r < 0.24) v -= 30; // sombra entre piedras
    data[i] = rgb(178 + v, 158 + v * 0.95, 122 + v * 0.85);
  }
  return withMips(size, data);
}

// Variación de brillo a gran escala (0.88..1.12), para que la repetición de las texturas no se note
export function macroNoise(size = 64) {
  const n = fbm(size, 4, 3, 303);
  for (let i = 0; i < n.length; i++) n[i] = 0.88 + n[i] * 0.24;
  return { size, data: n };
}

// Cara del guardrail: una franja pintada arriba (mitad roja, mitad blanca, así se alternan a lo largo del muro),
// una línea oscura, y abajo hormigón con juntas entre paneles y más sucio cerca del piso
export function wallTexture(size = 64) {
  const grain = fbm(size, 8, 3, 404);
  const rand = rng(13);
  const data = new Uint32Array(size * size);
  const band = Math.round(size * 0.55);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const n = (grain[i] - 0.5) * 18 + (rand() - 0.5) * 8;
      let c;
      if (y < band) {
        const red = x < size / 2;
        const edge = y < 2 ? -40 : 0; // borde superior más oscuro
        c = red ? rgb(205 + n + edge, 35 + n * 0.4 + edge, 35 + n * 0.4 + edge) : rgb(238 + n + edge, 238 + n + edge, 236 + n + edge);
      } else if (y < band + 2) {
        c = rgb(40, 40, 44);
      } else {
        const dirt = ((y - band) / (size - band)) * 35; // más sucio abajo
        const v = 120 + n - dirt;
        c = rgb(v, v, v + 4);
      }
      // junta entre paneles (cada media textura), en el hormigón
      if (y >= band && (x === 0 || x === size / 2)) c = rgb(60, 60, 64);
      data[i] = c;
    }
  }
  return withMips(size, data);
}

// Textura a partir de un canvas cuadrado (lado potencia de 2) dibujado con la API 2D del navegador
export function canvasTexture(canvas) {
  const size = canvas.width;
  const px = canvas.getContext('2d').getImageData(0, 0, size, size).data;
  // los bytes RGBA leídos como enteros de 32 bits quedan en el mismo orden que usa rgb()
  const data = new Uint32Array(px.buffer.slice(0));
  for (let i = 0; i < data.length; i++) data[i] |= 0xff000000;
  return withMips(size, data);
}

// Fibra de carbono: tejido en diagonal (sarga 2×2) de hilos apenas más claros y más oscuros
export function carbonTexture(size = 64) {
  const data = new Uint32Array(size * size);
  const cell = size / 8;
  const rand = rng(17);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const cx = (x / cell) | 0, cy = (y / cell) | 0;
      const warp = ((cx + cy) >> 1) & 1; // las celdas se agrupan de a dos y se corren en diagonal
      const fx = (x % cell) / cell, fy = (y % cell) / cell;
      const along = warp ? fx : fy; // brillo a lo largo del hilo
      const v = 30 + (warp ? 8 : 0) + Math.sin(along * Math.PI) * 6 + (rand() - 0.5) * 3;
      data[y * size + x] = rgb(v, v, v + 4);
    }
  }
  return withMips(size, data);
}

// Ruido 3D para las nubes (ver el cielo en glrenderer.js): un cubo de size³ que se repite en los tres ejes, con dos
// canales. r: la forma, ruido suave mezclado con Worley invertido (bolitas redondas que se juntan, como cúmulos);
// g: el detalle, Worley más fino, para comer los bordes. Devuelve los bytes intercalados (r, g) por vóxel.
export function cloudNoise(size = 64) {
  const n = size * size * size, out = new Uint8Array(n * 2);
  const shape = new Float32Array(n), detail = new Float32Array(n);
  // Worley: distancia al punto más cercano de una grilla de g³ celdas (un punto al azar por celda), repetida
  const worley = (g, seed, into, weight) => {
    const rand = rng(seed), pts = new Float32Array(g * g * g * 3);
    for (let i = 0; i < pts.length; i++) pts[i] = rand();
    const k = g / size, m = g - 1;
    for (let z = 0; z < size; z++) {
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const fx = x * k, fy = y * k, fz = z * k;
          const cx = Math.floor(fx), cy = Math.floor(fy), cz = Math.floor(fz);
          let best = 9;
          for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
            const i = ((((cz + dz) & m) * g + ((cy + dy) & m)) * g + ((cx + dx) & m)) * 3;
            const px = cx + dx + pts[i] - fx, py = cy + dy + pts[i + 1] - fy, pz = cz + dz + pts[i + 2] - fz;
            best = Math.min(best, px * px + py * py + pz * pz);
          }
          into[(z * size + y) * size + x] += weight * (1 - Math.min(1, Math.sqrt(best)));
        }
      }
    }
  };
  // ruido de valor 3D suave, repetido, con g³ celdas
  const value = (g, seed, into, weight) => {
    const rand = rng(seed), grid = new Float32Array(g * g * g), m = g - 1, k = g / size;
    for (let i = 0; i < grid.length; i++) grid[i] = rand();
    const at = (x, y, z) => grid[((z & m) * g + (y & m)) * g + (x & m)];
    const s = (t) => t * t * (3 - 2 * t);
    for (let z = 0; z < size; z++) {
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const fx = x * k, fy = y * k, fz = z * k, x0 = Math.floor(fx), y0 = Math.floor(fy), z0 = Math.floor(fz);
          const u = s(fx - x0), v = s(fy - y0), w = s(fz - z0);
          const l = (a, b, t) => a + (b - a) * t;
          const c = l(l(l(at(x0, y0, z0), at(x0 + 1, y0, z0), u), l(at(x0, y0 + 1, z0), at(x0 + 1, y0 + 1, z0), u), v),
            l(l(at(x0, y0, z0 + 1), at(x0 + 1, y0, z0 + 1), u), l(at(x0, y0 + 1, z0 + 1), at(x0 + 1, y0 + 1, z0 + 1), u), v), w);
          into[(z * size + y) * size + x] += weight * c;
        }
      }
    }
  };
  value(4, 801, shape, 0.35);
  value(8, 802, shape, 0.15);
  worley(4, 803, shape, 0.32);
  worley(8, 804, shape, 0.18);
  worley(8, 805, detail, 0.55);
  worley(16, 806, detail, 0.3);
  worley(32, 807, detail, 0.15);
  // estirados a 0..255
  for (const [ch, a] of [[0, shape], [1, detail]]) {
    let lo = Infinity, hi = -Infinity;
    for (const v of a) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
    for (let i = 0; i < n; i++) out[i * 2 + ch] = Math.round(((a[i] - lo) / (hi - lo)) * 255);
  }
  return { size, data: out };
}
