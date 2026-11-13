// Procedural textures for the ground and the walls, generated at startup (no external images).
// Each texture is square, with a power-of-2 side, and tiles across the world. It has mipmaps:
// progressively smaller (averaged) versions used in the distance, so it doesn't "flicker".

const rgb = (r, g, b) => (0xff000000 | (clamp(b) << 16) | (clamp(g) << 8) | clamp(r)) >>> 0;
const clamp = (v) => Math.max(0, Math.min(255, v | 0));

function rng(seed) {
  let s = seed;
  return () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
}

// Smooth noise (0..1) that tiles every `size` pixels: a sum of octaves of value noise,
// the first with `cells` cells per side and each next one twice as fine and half as strong
function fbm(size, cells, octaves, seed) {
  const out = new Float32Array(size * size);
  const rand = rng(seed);
  let amp = 1,
    total = 0,
    g = cells;
  for (let o = 0; o < octaves; o++) {
    const grid = new Float32Array(g * g);
    for (let i = 0; i < g * g; i++) grid[i] = rand();
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const gx = (x * g) / size,
          gy = (y * g) / size;
        const x0 = gx | 0,
          y0 = gy | 0;
        let u = gx - x0,
          v = gy - y0;
        u = u * u * (3 - 2 * u);
        v = v * v * (3 - 2 * v);
        const x1 = (x0 + 1) % g,
          y1 = (y0 + 1) % g;
        const a = grid[y0 * g + x0],
          b = grid[y0 * g + x1],
          c = grid[y1 * g + x0],
          d = grid[y1 * g + x1];
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

// Builds the mipmap chain: each level averages 2×2 pixels of the previous one
function withMips(size, data) {
  const levels = [data];
  let s = size,
    cur = data;
  while (s > 1) {
    const h = s >> 1;
    const next = new Uint32Array(h * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < h; x++) {
        const i = 2 * y * s + 2 * x;
        const p = [cur[i], cur[i + 1], cur[i + s], cur[i + s + 1]];
        let r = 0,
          g = 0,
          b = 0;
        for (const c of p) {
          r += c & 255;
          g += (c >>> 8) & 255;
          b += (c >>> 16) & 255;
        }
        next[y * h + x] = rgb(r / 4, g / 4, b / 4);
      }
    }
    levels.push(next);
    cur = next;
    s = h;
  }
  return { size, levels };
}

// Texture color at (u, v), in texels. fp = how many texels one screen pixel covers:
// the larger it is, the smaller the mipmap used.
export function sample(tex, u, v, fp) {
  let l = 0;
  while (fp > 1 && l < tex.levels.length - 1) {
    fp *= 0.5;
    l++;
  }
  const s = tex.size >> l;
  const x = (Math.floor(u) >> l) & (s - 1),
    y = (Math.floor(v) >> l) & (s - 1);
  return tex.levels[l][y * s + x];
}

// Asphalt: grey with large soft patches, fine grain and light and dark pebbles
export function asphaltTexture(size = 256) {
  const blot = fbm(size, 6, 4, 101);
  const rand = rng(7);
  const data = new Uint32Array(size * size);
  for (let i = 0; i < data.length; i++) {
    let v = 86 + (blot[i] - 0.5) * 30 + (rand() - 0.5) * 14;
    const r = rand();
    if (r < 0.05)
      v += 30; // light pebble
    else if (r < 0.11) v -= 22; // dark hole
    data[i] = rgb(v, v, v + 4);
  }
  return withMips(size, data);
}

// Grass: green with lighter and darker clumps and loose blades
export function grassTexture(size = 128) {
  const tufts = fbm(size, 8, 4, 202);
  const rand = rng(11);
  const data = new Uint32Array(size * size);
  for (let i = 0; i < data.length; i++) {
    const t = tufts[i] - 0.5;
    const n = (rand() - 0.5) * 22;
    const blade = rand() < 0.08 ? 18 : 0; // sunlit blade
    data[i] = rgb(60 + t * 30 + n * 0.6 + blade, 134 + t * 40 + n + blade, 52 + t * 20 + n * 0.5);
  }
  return withMips(size, data);
}

// Gravel: sand-colored pebbles, with soft patches (where it was raked) and light and dark grains
export function gravelTexture(size = 128) {
  const patch = fbm(size, 8, 4, 505);
  const rand = rng(17);
  const data = new Uint32Array(size * size);
  for (let i = 0; i < data.length; i++) {
    let v = (patch[i] - 0.5) * 26 + (rand() - 0.5) * 34;
    const r = rand();
    if (r < 0.12)
      v += 26; // pebble in the sun
    else if (r < 0.24) v -= 30; // shadow between stones
    data[i] = rgb(178 + v, 158 + v * 0.95, 122 + v * 0.85);
  }
  return withMips(size, data);
}

// Large-scale brightness variation (0.88..1.12), so the texture tiling doesn't show
export function macroNoise(size = 64) {
  const n = fbm(size, 4, 3, 303);
  for (let i = 0; i < n.length; i++) n[i] = 0.88 + n[i] * 0.24;
  return { size, data: n };
}

// Barrier face: a painted band on top (half red, half white, so they alternate along the wall),
// a dark line, and concrete below with joints between panels and dirtier near the ground
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
        const edge = y < 2 ? -40 : 0; // darker top edge
        c = red
          ? rgb(205 + n + edge, 35 + n * 0.4 + edge, 35 + n * 0.4 + edge)
          : rgb(238 + n + edge, 238 + n + edge, 236 + n + edge);
      } else if (y < band + 2) {
        c = rgb(40, 40, 44);
      } else {
        const dirt = ((y - band) / (size - band)) * 35; // dirtier at the bottom
        const v = 120 + n - dirt;
        c = rgb(v, v, v + 4);
      }
      // joint between panels (every half texture), in the concrete
      if (y >= band && (x === 0 || x === size / 2)) c = rgb(60, 60, 64);
      data[i] = c;
    }
  }
  return withMips(size, data);
}

// Texture from a square canvas (power-of-2 side) drawn with the browser's 2D API
export function canvasTexture(canvas) {
  const size = canvas.width;
  const px = canvas.getContext('2d').getImageData(0, 0, size, size).data;
  // the RGBA bytes read as 32-bit integers end up in the same order rgb() uses
  const data = new Uint32Array(px.buffer.slice(0));
  for (let i = 0; i < data.length; i++) data[i] |= 0xff000000;
  return withMips(size, data);
}

// Carbon fiber: diagonal weave (2×2 twill) of threads slightly lighter and darker
export function carbonTexture(size = 64) {
  const data = new Uint32Array(size * size);
  const cell = size / 8;
  const rand = rng(17);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const cx = (x / cell) | 0,
        cy = (y / cell) | 0;
      const warp = ((cx + cy) >> 1) & 1; // cells are grouped in pairs and shifted diagonally
      const fx = (x % cell) / cell,
        fy = (y % cell) / cell;
      const along = warp ? fx : fy; // brightness along the thread
      const v = 30 + (warp ? 8 : 0) + Math.sin(along * Math.PI) * 6 + (rand() - 0.5) * 3;
      data[y * size + x] = rgb(v, v, v + 4);
    }
  }
  return withMips(size, data);
}
