// Damage: what breaks in a hit, depending on where it strikes and how hard, and what that does to the car.
//
// Parts (each from 0 = intact to 1 = broken), with their side for when they need to be drawn:
//   frontWing   front wing [left, right]: the flaps first, then the whole wing. Its downforce is lost: in a slow
//               corner it is barely noticeable (mechanical grip remains) and in fast ones the car won't turn
//   rearWing    rear wing [left, right]: less rear downforce (oversteers in fast corners) and less drag
//   sidepod     sidepod and floor [left, right]: the floor gives most of the downforce, and the radiator breathes
//               through the sidepod: the engine overheats and delivers less
//   suspension  suspension of each wheel [FL, FR, RL, RR] (on the fronts, with the steering): bent, that wheel
//               grips less and the car pulls to one side; broken, retirement
//   tyre        puncture of each wheel [FL, FR, RL, RR]: 0 intact; once punctured it deflates up to 1 in DEFLATE
//               seconds: almost no grip, it drags and pulls to that side
// With damage on one side only, the car grips differently depending on which way it turns: in a corner the weight
// goes to the outside wheels, so a wing broken on the left is more noticeable turning right.
//
// The damage object is not modified: each hit builds a new one (so car.limits knows when to recompute).

export const DAMAGE_LEVELS = [
  { id: 'off', name: 'No' }, // Crashes do nothing to the car
  { id: 'reduced', name: 'Reducidos' }, // Crashes damage the car and slow it down, but you can always finish the race
  { id: 'real', name: 'Reales' }, // A hard crash can puncture a tyre or break a wheel and take you out of the race
];

export const NO_DAMAGE = Object.freeze({
  frontWing: [0, 0],
  rearWing: [0, 0],
  sidepod: [0, 0],
  suspension: [0, 0, 0, 0],
  tyre: [0, 0, 0, 0],
  retired: null,
});

// Hit zones: rectangles in meters from the car's center (x forward, y to the right), like the 3D model.
// part: the part that gets damaged; side: the side (0 left, 1 right; null: depending on where it hit); wheel: which
// wheel
export const ZONES = [
  { part: 'frontWing', x: [2.25, 2.8], y: [-0.95, 0.95] },
  { part: 'frontWing', x: [1.0, 2.25], y: [-0.25, 0.25] }, // the nose: takes the wing with it
  { part: 'wheel', wheel: 0, x: [1.3, 2.0], y: [-1.0, -0.6] },
  { part: 'wheel', wheel: 1, x: [1.3, 2.0], y: [0.6, 1.0] },
  { part: 'sidepod', x: [-1.3, 1.0], y: [-0.8, 0.8] },
  { part: 'wheel', wheel: 2, x: [-2.05, -1.35], y: [-1.0, -0.6] },
  { part: 'wheel', wheel: 3, x: [-2.05, -1.35], y: [0.6, 1.0] },
  { part: 'rearWing', x: [-2.3, -1.3], y: [-0.45, 0.45] }, // gearbox and engine: the hit goes up to the wing
  { part: 'rearWing', x: [-2.8, -2.3], y: [-0.5, 0.5] },
];

// How much each part breaks in a hit: from `from` (m/s of speed change at the contact point) it starts to get
// damaged and at `full` it breaks at once; hits add up. Tuned with tools/damage_hits.js so that the light contacts
// of a normal race break almost nothing.
export const STRENGTH = {
  frontWing: { from: 5, full: 24 },
  rearWing: { from: 6, full: 26 },
  sidepod: { from: 7, full: 28 },
  suspension: { from: 7, full: 26 },
};
const PUNCTURE_HIT = 5; // m/s: another car's wing against a tyre can cut it from here on...
const PUNCTURE_CHANCE = 0.12; // ...with this probability (more with harder hits)
const WHEEL_PUNCTURE_HIT = 12; // and two wheels hitting hard, too
const DEFLATE = 4; // s until fully deflated
const REDUCED_MAX = 0.6; // with reduced damage, the most a part can break

// Effect on the car
const FRONT_WING_SHARE = 0.6; // of the body's front downforce, the wing's share (with the wing at minimum)
const REAR_WING_SHARE = 0.35; // and of the rear
const REAR_WING_DRAG = 0.25; // of the body's drag, the rear wing's share
const FLOOR_LOSS = 0.4; // floor downforce lost with a destroyed sidepod
const COOLING_LOSS = 0.08; // and power
const BENT_GRIP = 0.3; // a wheel with nearly broken suspension grips this much less
const BENT_PULL = 0.06; // and twists the steering (in steering units)
const FLAT_GRIP = 0.55; // a deflated tyre grips this much less
const FLAT_DRAG = 3; // and drags (m/s², like the grass)

let random = Math.random;
export const setDamageRandom = (fn) => (random = fn);

const clamp01 = (x) => Math.max(0, Math.min(1, x));
const set = (arr, i, v) => arr.map((x, k) => (k === i ? v : x));

// The zone of a point on the car (in meters from its center, in the car's frame): the one that contains it or, if
// none does (a point on the edge of the rectangle that falls in no part), the nearest one
export function zoneAt(lx, ly) {
  let best = null,
    bestD = Infinity;
  for (const z of ZONES) {
    const dx = Math.max(z.x[0] - lx, 0, lx - z.x[1]),
      dy = Math.max(z.y[0] - ly, 0, ly - z.y[1]);
    const d = dx * dx + dy * dy;
    if (d < bestD) [best, bestD] = [z, d];
  }
  return best;
}

// A hit of intensity hit (m/s) at point (lx, ly) of the car. other: the zone of the other car that hit (null: a
// wall). level: 'reduced' or 'real'. Returns the new damage (or the same one if nothing broke).
export function applyHit(damage, lx, ly, hit, other, level) {
  if (level === 'off' || damage.retired) return damage;
  const z = zoneAt(lx, ly),
    side = ly < 0 ? 0 : 1;
  const k = level === 'reduced' ? 0.5 : 1;
  const amount = (part) => k * clamp01((hit - STRENGTH[part].from) / (STRENGTH[part].full - STRENGTH[part].from));
  let d = damage;
  if (z.part === 'wheel') {
    const w = z.wheel,
      s = amount('suspension');
    if (s > 0) {
      const now = Math.min(level === 'reduced' ? REDUCED_MAX : 1, d.suspension[w] + s);
      d = { ...d, suspension: set(d.suspension, w, now) };
      if (now >= 1) d = { ...d, retired: w < 2 ? 'Dirección rota' : 'Suspensión rota' };
    }
    // puncture: cut by another car's wing or in a hard wheel-to-wheel hit
    if (level === 'real' && !d.tyre[w]) {
      const cut =
        other?.part === 'frontWing' &&
        hit > PUNCTURE_HIT &&
        random() < PUNCTURE_CHANCE * Math.min(2, hit / PUNCTURE_HIT);
      const bang = other?.part === 'wheel' && hit > WHEEL_PUNCTURE_HIT && random() < 0.5;
      if (cut || bang) d = { ...d, tyre: set(d.tyre, w, 1e-3) };
    }
  } else {
    const a = amount(z.part);
    if (a > 0) {
      // the nose and the center of the rear wing split the hit between both sides
      const both = (z.part === 'frontWing' && z.x[0] < 2) || z.part === 'rearWing' || Math.abs(ly) < 0.3;
      // with reduced damage nothing breaks completely
      const cur = d[z.part],
        max = level === 'reduced' ? REDUCED_MAX : 1;
      d = {
        ...d,
        [z.part]: both ? cur.map((x) => Math.min(max, x + a)) : set(cur, side, Math.min(max, cur[side] + a)),
      };
    }
  }
  return d;
}

// Random damage, to train with already broken cars: one or two parts, slightly or completely (with reduced damage,
// at most REDUCED_MAX and no punctures); never a retirement
export function randomDamage(rand, level) {
  let d = NO_DAMAGE;
  const max = level === 'reduced' ? REDUCED_MAX : 1;
  for (let n = rand() < 0.3 ? 2 : 1; n > 0; n--) {
    const amount = Math.min(max, 0.2 + 0.8 * rand());
    const part = ['frontWing', 'rearWing', 'sidepod', 'suspension', 'tyre'][
      Math.floor(rand() * (level === 'reduced' ? 4 : 5))
    ];
    const i = Math.floor(rand() * d[part].length);
    const value = part === 'tyre' ? 1 : part === 'suspension' ? Math.min(0.7, amount) : amount;
    d = { ...d, [part]: set(d[part], i, value) };
  }
  return d;
}

// Punctured tyres gradually deflate
export function deflate(damage, dt) {
  if (!damage.tyre.some((t) => t > 0 && t < 1)) return damage;
  return { ...damage, tyre: damage.tyre.map((t) => (t > 0 ? Math.min(1, t + dt / DEFLATE) : 0)) };
}

export const damaged = (d) =>
  d !== NO_DAMAGE &&
  (d.retired || [d.frontWing, d.rearWing, d.sidepod, d.suspension, d.tyre].some((p) => p.some((x) => x > 0)));

// For dynamics.js: how much downforce and drag is lost. Coefficients of the intact car → of the damaged car.
//   body: body downforce front and rear (without the adjustable wings); wingF, wingR: what the wings add; cd: drag.
//   Returns, for each side (0 left, 1 right), the downforce on each axle.
export function damagedAero(damage, { bodyF, bodyR, wingF, wingR, cd, cdWingF, cdWingR }) {
  const fw = damage.frontWing,
    rw = damage.rearWing,
    sp = damage.sidepod;
  const front = [0, 1].map(
    (s) =>
      (bodyF * (1 - FRONT_WING_SHARE) * (1 - FLOOR_LOSS * sp[s]) + (bodyF * FRONT_WING_SHARE + wingF) * (1 - fw[s])) /
      2,
  );
  const rear = [0, 1].map(
    (s) =>
      (bodyR * (1 - REAR_WING_SHARE) * (1 - FLOOR_LOSS * sp[s]) + (bodyR * REAR_WING_SHARE + wingR) * (1 - rw[s])) / 2,
  );
  const lostCd = (cdWingF * (fw[0] + fw[1])) / 2 + ((cd * REAR_WING_DRAG + cdWingR) * (rw[0] + rw[1])) / 2;
  return { front, rear, cd: cd + cdWingF + cdWingR - lostCd };
}

export const powerLoss = (damage) => 1 - (COOLING_LOSS * (damage.sidepod[0] + damage.sidepod[1])) / 2;

// For car.js, wheel by wheel: how much it grips (1 intact) and how much extra it drags (m/s²)
export function wheelGrip(damage, i) {
  return (1 - BENT_GRIP * damage.suspension[i] ** 2) * (1 - FLAT_GRIP * damage.tyre[i]);
}
export const wheelDrag = (damage, i) => FLAT_DRAG * damage.tyre[i];

// Which way the steering pulls with bent suspension (steering: + right): a bent front wheel goes outward, and the
// car goes toward that side
export const steerPull = (damage) => BENT_PULL * (damage.suspension[1] ** 2 - damage.suspension[0] ** 2);
