// Árboles en 3D: cada especie se describe como una función de distancia con signo (SDF: negativa adentro), y al
// arrancar se convierte en una malla de triángulos con "surface nets" (un vértice por cubito de la grilla que corta
// la superficie, y un cuadrado por cada arista de la grilla que la cruza). Así las formas son orgánicas y fáciles de
// describir (conos, esferas que se funden, ruido), pero se dibujan como cualquier modelo, sin raymarching.
//
// Las mallas están en metros, con el pie del tronco en el origen y z hacia arriba. Cada vértice lleva posición,
// normal, color (con la oclusión ya aplicada: más oscuro adentro de la copa), cuánto se mueve con el viento (0 en
// el tronco, 1 en la punta) y si es madera (1: el shader le dibuja la corteza).

export const TREE_FLOATS = 11; // floats por vértice: posición, normal, color, viento, madera

// ---------- ruido ----------
function hash3(x, y, z) {
  let h = (x * 374761393 + y * 668265263 + z * 1274126177) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

// ruido de valor 3D suave (0..1)
function noise3(x, y, z) {
  const x0 = Math.floor(x),
    y0 = Math.floor(y),
    z0 = Math.floor(z);
  const s = (t) => t * t * (3 - 2 * t);
  const u = s(x - x0),
    v = s(y - y0),
    w = s(z - z0);
  const l = (a, b, t) => a + (b - a) * t;
  const h = (i, j, k) => hash3(x0 + i, y0 + j, z0 + k);
  return l(
    l(l(h(0, 0, 0), h(1, 0, 0), u), l(h(0, 1, 0), h(1, 1, 0), u), v),
    l(l(h(0, 0, 1), h(1, 0, 1), u), l(h(0, 1, 1), h(1, 1, 1), u), v),
    w,
  );
}

const fbm3 = (x, y, z) =>
  noise3(x, y, z) * 0.6 + noise3(x * 2.1, y * 2.1, z * 2.1) * 0.3 + noise3(x * 4.3, y * 4.3, z * 4.3) * 0.1;

// unión suave: funde dos formas en el borde (k: cuánto)
function smin(a, b, k) {
  if (a === Infinity) return b;
  const h = Math.max(0, Math.min(1, 0.5 + (0.5 * (b - a)) / k));
  return b + (a - b) * h - k * h * (1 - h);
}

// tronco: cilindro que se afina, de z0 a z1; nunca más fino que minR (con la grilla gruesa de los árboles lejanos
// un tronco fino caía entre las muestras y desaparecía, y aparecía de golpe al acercarse)
// Abajo se ensancha (el arranque de las raíces) y la silueta tiene algo de ruido, así no es un cilindro perfecto
function trunk(x, y, z, r0, r1, z1, minR = 0) {
  const t = Math.max(0, Math.min(1, z / z1));
  const flare = r0 * 0.6 * Math.exp(-Math.max(0, z) * 2.5);
  const bumps = (noise3(x * 4, y * 4, z * 1.3) - 0.5) * r0 * 0.25;
  const side = Math.hypot(x, y) - Math.max(minR, r0 + (r1 - r0) * t + flare + bumps);
  return Math.max(side, -z - 1, z - z1); // sigue un metro bajo tierra: en ninguna grilla queda flotando
}

// ---------- especies ----------
// Cada una devuelve { d, wood }: la distancia y si ahí manda el tronco (para el color)

// pino: tronco fino y pisos de ramas en cono, más anchos abajo, con las puntas un poco caídas y ruido en el borde
function pine(x, y, z, seed, cell = 0) {
  const H = 10;
  const wood = trunk(x, y, z, 0.24, 0.08, H * 0.92, cell * 0.6);
  let leaf = Infinity;
  const tiers = 6;
  for (let i = 0; i < tiers; i++) {
    const t = i / (tiers - 1);
    const zb = 1.6 + t * 6.6,
      h = 3.2 - t * 1.4,
      r = 2.5 - t * 1.85;
    const q = Math.hypot(x, y),
      dz = z - zb;
    // borde caído: el piso baja un poco hacia afuera
    const droop = 0.35 * (q / r) * (q / r);
    const side = (q * h + (dz + droop) * r - r * h) / Math.hypot(h, r);
    const cone = Math.max(side, -(dz + droop) - 0.15);
    leaf = smin(leaf, cone, 0.35);
  }
  // ramas que asoman: ruido fuerte en ángulo (alrededor del tronco) y en altura
  const a = Math.atan2(y, x);
  const n = fbm3(Math.cos(a) * 1.6 + seed, Math.sin(a) * 1.6, z * 1.1);
  const fine = noise3(x * 3.1 + seed, y * 3.1, z * 3.1);
  leaf += (n - 0.5) * 0.7 + (fine - 0.5) * 0.18;
  return { d: Math.min(wood, leaf), wood: wood < leaf };
}

// rama: cilindro de a hacia b que se afina de r0 a r1 (distancia aproximada, alcanza para el SDF)
function limb(x, y, z, a, b, r0, r1) {
  const ex = b[0] - a[0],
    ey = b[1] - a[1],
    ez = b[2] - a[2];
  const t = Math.max(
    0,
    Math.min(1, ((x - a[0]) * ex + (y - a[1]) * ey + (z - a[2]) * ez) / (ex * ex + ey * ey + ez * ez)),
  );
  return Math.hypot(x - a[0] - ex * t, y - a[1] - ey * t, z - a[2] - ez * t) - (r0 + (r1 - r0) * t);
}

// la copa de cada variante: grupos de follaje repartidos sobre una copa ancha (más arriba que abajo), y una rama
// del tronco hacia cada uno. Se arma una vez por semilla
const CROWNS = new Map();
function crown(seed) {
  if (CROWNS.has(seed)) return CROWNS.get(seed);
  let s = (seed * 2654435761) >>> 0;
  const rand = (a, b) => {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    return a + ((s >>> 8) / 16777216) * (b - a);
  };
  const C = [0, 0, 4.8],
    R = [4.3, 4.3, 2.4];
  const clumps = [[0, 0, 5.4, 1.7]];
  const N = 13;
  for (let k = 0; k < N; k++) {
    const az = ((k + rand(-0.35, 0.35)) / N) * Math.PI * 2,
      el = rand(-0.45, 0.8),
      f = rand(0.6, 0.95);
    const p = [
      C[0] + Math.cos(az) * Math.cos(el) * R[0] * f,
      C[1] + Math.sin(az) * Math.cos(el) * R[1] * f,
      C[2] + Math.sin(el) * R[2] * f,
    ];
    clumps.push([...p, rand(0.95, 1.45) * (1 - 0.2 * Math.max(0, el))]);
  }
  const limbs = clumps.slice(1).map(([cx, cy, cz]) => {
    const from = [0, 0, rand(2.0, 3.2)];
    return [from, [cx * 0.85, cy * 0.85, from[2] + (cz - from[2]) * 0.85]];
  });
  const c = { clumps, limbs };
  CROWNS.set(seed, c);
  return c;
}

// árbol de copa: tronco, ramas que salen hacia cada grupo de follaje (se asoman entre los grupos) y los grupos,
// apenas fundidos entre sí y con ruido grumoso, así la copa no es una bola pareja
function broadleaf(x, y, z, seed, cell = 0) {
  const { clumps, limbs } = crown(seed);
  let wood = trunk(x, y, z, 0.42, 0.24, 3.4, cell * 0.6);
  for (const [a, b] of limbs)
    wood = smin(wood, limb(x, y, z, a, b, Math.max(cell * 0.45, 0.17), Math.max(cell * 0.45, 0.06)), 0.15);
  let leaf = Infinity;
  for (const [cx, cy, cz, r] of clumps) leaf = smin(leaf, Math.hypot(x - cx, y - cy, z - cz) - r, 0.45);
  if (leaf < 1.2) {
    const lumps = noise3(x * 2.2 + seed * 7, y * 2.2, z * 2.2),
      fine = noise3(x * 4.6 + seed * 3, y * 4.6, z * 4.6);
    leaf += (lumps - 0.5) * 0.5 + (fine - 0.5) * 0.16;
  }
  leaf = Math.max(leaf, 2.5 - z); // la base de la copa, más pareja
  return { d: Math.min(wood, leaf), wood: wood < leaf };
}

export const SPECIES = {
  pine: {
    sdf: pine,
    size: [3.2, 3.2, 10.6],
    height: 10,
    bark: [0.33, 0.22, 0.13],
    leaf: [0.13, 0.33, 0.16],
    tip: [0.24, 0.46, 0.22],
  },
  broadleaf: {
    sdf: broadleaf,
    size: [6.2, 6.2, 8.6],
    height: 8,
    bark: [0.36, 0.27, 0.19],
    leaf: [0.19, 0.38, 0.14],
    tip: [0.4, 0.56, 0.2],
  },
};

// ---------- de SDF a malla ----------
// cell: lado de cada cubito (m): más chico, más detalle y más triángulos
export function treeMesh(kind, cell, seed = 0) {
  const sp = SPECIES[kind];
  const [hx, hy, hz] = sp.size;
  const nx = Math.ceil((2 * hx) / cell) + 1,
    ny = Math.ceil((2 * hy) / cell) + 1,
    nz = Math.ceil((hz + Math.max(0.5, 2 * cell)) / cell) + 1;
  const ox = -hx,
    oy = -hy,
    oz = -Math.max(0.5, 2 * cell); // un poco por debajo del piso (el pie del tronco queda enterrado)
  const at = (i, j, k) => (k * ny + j) * nx + i;
  const val = new Float32Array(nx * ny * nz);
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        val[at(i, j, k)] = sp.sdf(ox + i * cell, oy + j * cell, oz + k * cell, seed, cell).d;
      }
  const sdf = (x, y, z) => sp.sdf(x, y, z, seed, cell);

  // un vértice por cubito que corta la superficie: el promedio de dónde la cruzan sus aristas
  const vid = new Int32Array((nx - 1) * (ny - 1) * (nz - 1)).fill(-1);
  const cid = (i, j, k) => (k * (ny - 1) + j) * (nx - 1) + i;
  const pos = [];
  const EDGES = [
    [0, 1],
    [2, 3],
    [4, 5],
    [6, 7],
    [0, 2],
    [1, 3],
    [4, 6],
    [5, 7],
    [0, 4],
    [1, 5],
    [2, 6],
    [3, 7],
  ];
  const corner = (c) => [c & 1, (c >> 1) & 1, (c >> 2) & 1];
  for (let k = 0; k < nz - 1; k++)
    for (let j = 0; j < ny - 1; j++)
      for (let i = 0; i < nx - 1; i++) {
        const v = [];
        let inside = 0;
        for (let c = 0; c < 8; c++) {
          const [a, b, e] = corner(c);
          v.push(val[at(i + a, j + b, k + e)]);
          if (v[c] < 0) inside++;
        }
        if (inside === 0 || inside === 8) continue;
        let sx = 0,
          sy = 0,
          sz = 0,
          n = 0;
        for (const [c0, c1] of EDGES) {
          if (v[c0] < 0 === v[c1] < 0) continue;
          const t = v[c0] / (v[c0] - v[c1]);
          const p0 = corner(c0),
            p1 = corner(c1);
          sx += p0[0] + (p1[0] - p0[0]) * t;
          sy += p0[1] + (p1[1] - p0[1]) * t;
          sz += p0[2] + (p1[2] - p0[2]) * t;
          n++;
        }
        vid[cid(i, j, k)] = pos.length / 3;
        pos.push(ox + (i + sx / n) * cell, oy + (j + sy / n) * cell, oz + (k + sz / n) * cell);
      }

  // un cuadrado por cada arista de la grilla que cruza la superficie, uniendo los 4 cubitos que la comparten
  const idx = [];
  const quad = (a, b, c, d, flip) => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    if (flip) idx.push(a, c, b, a, d, c);
    else idx.push(a, b, c, a, c, d);
  };
  for (let k = 1; k < nz - 1; k++)
    for (let j = 1; j < ny - 1; j++)
      for (let i = 0; i < nx - 1; i++) {
        const s0 = val[at(i, j, k)] < 0,
          s1 = val[at(i + 1, j, k)] < 0;
        if (s0 === s1) continue;
        quad(vid[cid(i, j - 1, k - 1)], vid[cid(i, j, k - 1)], vid[cid(i, j, k)], vid[cid(i, j - 1, k)], s1);
      }
  for (let k = 1; k < nz - 1; k++)
    for (let j = 0; j < ny - 1; j++)
      for (let i = 1; i < nx - 1; i++) {
        const s0 = val[at(i, j, k)] < 0,
          s1 = val[at(i, j + 1, k)] < 0;
        if (s0 === s1) continue;
        quad(vid[cid(i - 1, j, k - 1)], vid[cid(i - 1, j, k)], vid[cid(i, j, k)], vid[cid(i, j, k - 1)], s1);
      }
  for (let k = 0; k < nz - 1; k++)
    for (let j = 1; j < ny - 1; j++)
      for (let i = 1; i < nx - 1; i++) {
        const s0 = val[at(i, j, k)] < 0,
          s1 = val[at(i, j, k + 1)] < 0;
        if (s0 === s1) continue;
        quad(vid[cid(i - 1, j - 1, k)], vid[cid(i, j - 1, k)], vid[cid(i, j, k)], vid[cid(i - 1, j, k)], s1);
      }

  // normales (el gradiente del SDF), color y viento por vértice
  const nv = pos.length / 3,
    data = new Float32Array(nv * TREE_FLOATS);
  const e = cell * 0.5,
    H = sp.height;
  for (let v = 0; v < nv; v++) {
    const x = pos[3 * v],
      y = pos[3 * v + 1],
      z = pos[3 * v + 2];
    let gx = sdf(x + e, y, z).d - sdf(x - e, y, z).d,
      gy = sdf(x, y + e, z).d - sdf(x, y - e, z).d,
      gz = sdf(x, y, z + e).d - sdf(x, y, z - e).d;
    const gl = Math.hypot(gx, gy, gz) || 1;
    gx /= gl;
    gy /= gl;
    gz /= gl;
    const { wood } = sdf(x, y, z);
    // oclusión: cuánto espacio libre hay saliendo de la superficie (adentro de la copa, poco: más oscuro)
    const open = Math.max(0, Math.min(1, sdf(x + gx * 0.7, y + gy * 0.7, z + gz * 0.7).d / 0.7));
    const ao = 0.45 + 0.55 * open;
    let c;
    if (wood) c = sp.bark;
    else {
      // las puntas (afuera y arriba) más claras y amarillentas, con manchas
      const out = Math.min(1, Math.hypot(x, y) / (H * 0.25)) * 0.6 + (z / H) * 0.4;
      const spot = noise3(x * 1.7 + 11, y * 1.7, z * 1.7);
      const t = Math.max(0, Math.min(1, out * 0.8 + (spot - 0.5) * 0.6));
      c = sp.leaf.map((l, i) => l + (sp.tip[i] - l) * t);
    }
    const o = v * TREE_FLOATS;
    data.set(
      [x, y, z, gx, gy, gz, c[0] * ao, c[1] * ao, c[2] * ao, wood ? 0 : Math.min(1, (z / H) ** 2), wood ? 1 : 0],
      o,
    );
  }
  const index = nv > 65535 ? new Uint32Array(idx) : new Uint16Array(idx);
  return { data, index, vertices: nv, triangles: idx.length / 3 };
}
