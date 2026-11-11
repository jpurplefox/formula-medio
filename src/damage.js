// Daños: qué se rompe en un golpe, según dónde pega y qué tan fuerte, y qué le hace eso al auto.
//
// Piezas (cada una de 0 = sana a 1 = rota), con su lado para cuando haya que dibujarlas:
//   frontWing   alerón delantero [izquierda, derecha]: los flaps primero, después el alerón entero. Se pierde su
//               apoyo: en curva lenta casi no se nota (el agarre mecánico queda) y en las rápidas no dobla
//   rearWing    alerón trasero [izquierda, derecha]: menos apoyo atrás (sobrevira en las rápidas) y menos resistencia
//   sidepod     pontón y piso [izquierda, derecha]: el piso da la mayor parte del apoyo, y por el pontón respira
//               el radiador: el motor recalienta y rinde menos
//   suspension  suspensión de cada rueda [DI, DD, TI, TD] (en las de adelante, con la dirección): torcida, esa
//               rueda agarra menos y el auto tira para un lado; rota, abandono
//   tyre        pinchazo de cada rueda [DI, DD, TI, TD]: 0 sana; al pincharse se va desinflando hasta 1 en DEFLATE
//               segundos: casi sin agarre, frena y tira para ese lado
// Con daño de un solo lado, el auto agarra distinto según para dónde dobla: en una curva el peso va a las ruedas
// de afuera, así que un alerón roto a la izquierda se nota más doblando a la derecha.
//
// El objeto de daños no se modifica: cada golpe arma uno nuevo (así car.limits sabe cuándo recalcular).

export const DAMAGE_LEVELS = [
  { id: 'off', name: 'No' }, // Los choques no le hacen nada al auto
  { id: 'reduced', name: 'Reducidos' }, // Los choques dañan el auto y lo hacen más lento, pero siempre podés terminar la carrera
  { id: 'real', name: 'Reales' }, // Un choque fuerte puede pinchar una goma o romper una rueda y dejarte afuera de la carrera
];

export const NO_DAMAGE = Object.freeze({
  frontWing: [0, 0],
  rearWing: [0, 0],
  sidepod: [0, 0],
  suspension: [0, 0, 0, 0],
  tyre: [0, 0, 0, 0],
  retired: null,
});

// Zonas de golpe: rectángulos en metros desde el centro del auto (x adelante, y a la derecha), como el modelo 3D.
// part: la pieza que se daña; side: el lado (0 izquierda, 1 derecha; null: según dónde pegó); wheel: qué rueda
export const ZONES = [
  { part: 'frontWing', x: [2.25, 2.8], y: [-0.95, 0.95] },
  { part: 'frontWing', x: [1.0, 2.25], y: [-0.25, 0.25] }, // la trompa: se lleva el alerón
  { part: 'wheel', wheel: 0, x: [1.3, 2.0], y: [-1.0, -0.6] },
  { part: 'wheel', wheel: 1, x: [1.3, 2.0], y: [0.6, 1.0] },
  { part: 'sidepod', x: [-1.3, 1.0], y: [-0.8, 0.8] },
  { part: 'wheel', wheel: 2, x: [-2.05, -1.35], y: [-1.0, -0.6] },
  { part: 'wheel', wheel: 3, x: [-2.05, -1.35], y: [0.6, 1.0] },
  { part: 'rearWing', x: [-2.3, -1.3], y: [-0.45, 0.45] }, // caja y motor: el golpe sube al alerón
  { part: 'rearWing', x: [-2.8, -2.3], y: [-0.5, 0.5] },
];

// Cuánto se rompe cada pieza con un golpe: desde `from` (m/s de cambio de velocidad en el punto de contacto) empieza
// a dañarse y con `full` se rompe de una; los golpes se suman. Ajustado con tools/damage_hits.js para que los roces
// de una carrera normal no rompan casi nada.
export const STRENGTH = {
  frontWing: { from: 5, full: 24 },
  rearWing: { from: 6, full: 26 },
  sidepod: { from: 7, full: 28 },
  suspension: { from: 7, full: 26 },
};
const PUNCTURE_HIT = 5; // m/s: un alerón ajeno contra una goma la puede cortar desde acá...
const PUNCTURE_CHANCE = 0.12; // ...con esta probabilidad (más con golpes más fuertes)
const WHEEL_PUNCTURE_HIT = 12; // y dos ruedas que se golpean fuerte, también
const DEFLATE = 4; // s hasta desinflarse del todo
const REDUCED_MAX = 0.6; // con daños reducidos, lo más que se rompe una pieza

// Efecto en el auto
const FRONT_WING_SHARE = 0.6; // del apoyo delantero de la carrocería, lo que es del alerón (con el alerón al mínimo)
const REAR_WING_SHARE = 0.35; // y del trasero
const REAR_WING_DRAG = 0.25; // de la resistencia de la carrocería, lo que es del alerón trasero
const FLOOR_LOSS = 0.4; // apoyo del piso que se pierde con un pontón destrozado
const COOLING_LOSS = 0.08; // y potencia
const BENT_GRIP = 0.3; // una rueda con la suspensión casi rota agarra esto menos
const BENT_PULL = 0.06; // y tuerce la dirección (en unidades de volante)
const FLAT_GRIP = 0.55; // una goma desinflada agarra esto menos
const FLAT_DRAG = 3; // y frena (m/s², como el pasto)

let random = Math.random;
export const setDamageRandom = (fn) => (random = fn);

const clamp01 = (x) => Math.max(0, Math.min(1, x));
const set = (arr, i, v) => arr.map((x, k) => (k === i ? v : x));

// La zona de un punto del auto (en metros desde su centro, en el marco del auto): la que lo contiene o, si
// ninguna (un punto del borde del rectángulo que no cae en ninguna pieza), la más cercana
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

// Un golpe de intensidad hit (m/s) en el punto (lx, ly) del auto. other: la zona del otro auto que pegó (null: muro).
// level: 'reduced' o 'real'. Devuelve el daño nuevo (o el mismo si no se rompió nada).
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
    // pinchazo: cortada por un alerón ajeno o en un golpe fuerte rueda contra rueda
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
      // la trompa y el centro del alerón trasero reparten el golpe entre los dos lados
      const both = (z.part === 'frontWing' && z.x[0] < 2) || z.part === 'rearWing' || Math.abs(ly) < 0.3;
      // con daños reducidos nada se rompe del todo
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

// Daños al azar, para entrenar con autos ya rotos: una o dos piezas, con un poco o del todo (con daños reducidos,
// como mucho REDUCED_MAX y sin pinchazos); nunca un abandono
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

// Las gomas pinchadas se van desinflando
export function deflate(damage, dt) {
  if (!damage.tyre.some((t) => t > 0 && t < 1)) return damage;
  return { ...damage, tyre: damage.tyre.map((t) => (t > 0 ? Math.min(1, t + dt / DEFLATE) : 0)) };
}

export const damaged = (d) =>
  d !== NO_DAMAGE &&
  (d.retired || [d.frontWing, d.rearWing, d.sidepod, d.suspension, d.tyre].some((p) => p.some((x) => x > 0)));

// Para dynamics.js: cuánto apoyo y resistencia se pierde. Coeficientes del auto sano → del auto dañado.
//   body: carga de la carrocería adelante y atrás (sin los alerones regulables); wingF, wingR: lo que agregan los
//   alerones; cd: resistencia. Devuelve, para cada lado (0 izquierda, 1 derecha), la carga de cada eje.
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

// Para car.js, rueda por rueda: cuánto agarra (1 sana) y cuánto frena de más (m/s²)
export function wheelGrip(damage, i) {
  return (1 - BENT_GRIP * damage.suspension[i] ** 2) * (1 - FLAT_GRIP * damage.tyre[i]);
}
export const wheelDrag = (damage, i) => FLAT_DRAG * damage.tyre[i];

// Para dónde tira la dirección con la suspensión torcida (volante: + derecha): una rueda delantera torcida se va
// hacia afuera, y el auto hacia ese lado
export const steerPull = (damage) => BENT_PULL * (damage.suspension[1] ** 2 - damage.suspension[0] ** 2);
