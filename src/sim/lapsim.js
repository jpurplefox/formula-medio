// Simulador de vuelta: la velocidad más alta a la que el auto puede ir en cada punto de una trazada fija, con sus
// límites (dynamics.js). En cada curva, lo que aguanta el agarre lateral; hacia atrás, hay que llegar frenando; hacia
// adelante, sólo se acelera lo que da el motor. Frenando o acelerando en curva, las gomas reparten su agarre entre
// las dos cosas (círculo de fricción).

const STEP = 2; // m entre puntos de la trazada
const SMOOTH = 12; // m: la curvatura sale del giro en ±SMOOTH

// Una trazada cerrada a partir de puntos [x, y, fracción de vuelta] (en m): un punto cada STEP metros, con su
// curvatura (1/m, con signo) y su fracción de vuelta
export function pathFromPoints(points) {
  const xs = [],
    ys = [],
    fs = [];
  let next = 0; // dónde va el próximo punto, desde el principio del tramo
  for (let i = 0; i < points.length; i++) {
    const [ax, ay, af] = points[i],
      [bx, by, bf] = points[(i + 1) % points.length];
    const d = Math.hypot(bx - ax, by - ay);
    for (; next < d; next += STEP) {
      const t = next / d;
      xs.push(ax + (bx - ax) * t);
      ys.push(ay + (by - ay) * t);
      fs.push(bf < af ? af : af + (bf - af) * t); // al cerrar la vuelta la fracción vuelve a cero
    }
    next -= d;
  }
  const n = xs.length,
    wrap = (i) => (i + n) % n,
    K = Math.round(SMOOTH / STEP);
  const heading = (i) => Math.atan2(ys[wrap(i + 1)] - ys[i], xs[wrap(i + 1)] - xs[i]);
  const k = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let dh = heading(wrap(i + K)) - heading(wrap(i - K));
    dh = Math.atan2(Math.sin(dh), Math.cos(dh));
    k[i] = dh / (2 * K * STEP);
  }
  return { n, ds: STEP, k, f: Float64Array.from(fs) };
}

// Lo más rápido que se puede tomar una curva de curvatura c (1/m): v²·c = agarre lateral (que crece con v);
// gripUse: qué parte del agarre se usa
export function cornerSpeed(lim, c, gripUse = 1) {
  c = Math.abs(c) / gripUse;
  if (c * lim.topSpeed ** 2 <= lim.lateral(lim.topSpeed)) return lim.topSpeed;
  let lo = 0,
    hi = lim.topSpeed;
  for (let it = 0; it < 30; it++) {
    const m = (lo + hi) / 2;
    if (m * m * c < lim.lateral(m)) lo = m;
    else hi = m;
  }
  return lo;
}

// Los límites del auto en una tabla por velocidad (cada TABLE_STEP m/s, interpolando): calcularlos cuesta (traslado
// de peso, que se resuelve en varias vueltas) y el simulador los pide miles de veces por vuelta
const TABLE_STEP = 1;
function tabulate(lim) {
  const n = Math.ceil(lim.topSpeed / TABLE_STEP) + 2;
  const table = (f) => {
    const y = Float64Array.from({ length: n }, (_, i) => f(i * TABLE_STEP));
    return (v) => {
      const x = Math.min(n - 1.001, Math.max(0, v / TABLE_STEP)),
        i = Math.floor(x);
      return y[i] + (y[i + 1] - y[i]) * (x - i);
    };
  };
  return {
    topSpeed: lim.topSpeed,
    lateral: table((v) => lim.lateral(v)),
    brake: table((v) => lim.brake(v)),
    drag: table((v) => lim.drag(v)),
    thrust: table((v) => lim.thrust(v)),
    traction: table((v) => lim.traction(v)),
  };
}

// Velocidad en cada punto (m/s) y tiempo de vuelta (s)
export function lapSim(path, limits) {
  const lim = tabulate(limits);
  const { n, ds, k } = path,
    wrap = (i) => (i + n) % n;
  const v = Float64Array.from(k, (c) => cornerSpeed(lim, c));
  // parte del agarre que queda para frenar o acelerar después de doblar
  const left = (s, c) => Math.sqrt(Math.max(0, 1 - ((s * s * c) / lim.lateral(s)) ** 2));
  for (let pass = 0; pass < 2; pass++) {
    for (let j = 2 * n - 1; j >= 0; j--) {
      const i = wrap(j),
        next = v[wrap(i + 1)];
      const decel = lim.brake(next) * left(next, Math.abs(k[i])) + lim.drag(next);
      v[i] = Math.min(v[i], Math.sqrt(next * next + 2 * decel * ds));
    }
    for (let j = 0; j < 2 * n; j++) {
      const i = wrap(j),
        prev = v[wrap(i - 1)];
      const push = Math.min(lim.thrust(prev), lim.traction(prev) * left(prev, Math.abs(k[i])));
      const a = Math.max(0, push - lim.drag(prev));
      v[i] = Math.min(v[i], Math.sqrt(prev * prev + 2 * a * ds));
    }
  }
  let time = 0;
  for (let i = 0; i < n; i++) time += (2 * ds) / (v[i] + v[wrap(i + 1)]);
  return { v, time };
}
