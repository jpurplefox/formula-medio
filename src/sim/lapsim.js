// Lap simulator: the highest speed the car can reach at each point of a fixed racing line, with its limits
// (dynamics.js). In each corner, what the lateral grip can take; going backward, the car has to arrive braking; going
// forward, it only accelerates as much as the engine allows. Braking or accelerating in a corner, the tyres split
// their grip between the two (friction circle).

const STEP = 2; // m between racing line points
const SMOOTH = 12; // m: the curvature comes from the heading change over ±SMOOTH

// A closed racing line from points [x, y, lap fraction] (in m): one point every STEP meters, with its curvature
// (1/m, signed) and its lap fraction
export function pathFromPoints(points) {
  const xs = [],
    ys = [],
    fs = [];
  let next = 0; // where the next point goes, from the start of the segment
  for (let i = 0; i < points.length; i++) {
    const [ax, ay, af] = points[i],
      [bx, by, bf] = points[(i + 1) % points.length];
    const d = Math.hypot(bx - ax, by - ay);
    for (; next < d; next += STEP) {
      const t = next / d;
      xs.push(ax + (bx - ax) * t);
      ys.push(ay + (by - ay) * t);
      fs.push(bf < af ? af : af + (bf - af) * t); // when the lap closes the fraction goes back to zero
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

// The fastest a corner of curvature c (1/m) can be taken: v²·c = lateral grip (which grows with v);
// gripUse: what fraction of the grip is used
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

// The car's limits in a table by speed (every TABLE_STEP m/s, interpolating): computing them is costly (weight
// transfer, solved in several iterations) and the simulator asks for them thousands of times per lap
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

// Speed at each point (m/s) and lap time (s)
export function lapSim(path, limits) {
  const lim = tabulate(limits);
  const { n, ds, k } = path,
    wrap = (i) => (i + n) % n;
  const v = Float64Array.from(k, (c) => cornerSpeed(lim, c));
  // fraction of the grip left for braking or accelerating after turning
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
