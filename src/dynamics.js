// Lo que puede hacer el auto según la puesta a punto y el aire del circuito: cuánto agarra cada eje, cuánto frena,
// cuánto empuja el motor y cuánto frena el aire, a cada velocidad. Es un modelo físico chico (el de un simulador de
// vuelta): la carga y la resistencia aerodinámicas crecen con la densidad del aire y con v², la goma agarra según la
// carga que tiene encima (cada vez un poco menos por kilo) y el motor da una potencia, así que empuja menos cuanto
// más rápido va. Los números del auto (cars/*.json) se ajustaron con vueltas reales (tools/calibrate.js).
//
// Puesta a punto (tune), como la elige el equipo para cada circuito:
//   front, rear  alerón delantero y trasero, de 1 (casi plano, Monza) a 10 (todo el apoyo, Mónaco). El trasero da
//                más apoyo pero también mucha más resistencia; el delantero, apoyo adelante casi sin resistencia.
//                Lo que pesa cada uno decide el balance en las curvas rápidas.
//   brake        reparto de frenada, de -5 (más atrás) a 5 (más adelante); 0 es lo de fábrica (ver brakeBias)
//   balance      balance mecánico (barras estabilizadoras, resortes), de -5 (más agarre atrás) a 5 (más adelante):
//                decide el balance en las curvas lentas, donde la carga aerodinámica casi no pesa. Es el reparto
//                del rolido: en una curva el peso pasa a las ruedas de afuera, y el eje más duro se lleva más de ese
//                traslado; como la goma agarra cada vez menos por kilo, el eje que más traslada es el que menos
//                agarra. Balance adelante = barra delantera blanda (traslada atrás).
// Con poco agarre adelante el auto no dobla lo que pide el volante (subviraje); con poco atrás, la cola se abre
// (sobreviraje); lo más rápido es lo parejo.

import { damagedAero, NO_DAMAGE, powerLoss } from './damage.js';

export const GRAVITY = 9.8;
export const SEA_AIR = 1.225; // kg/m³: densidad del aire a nivel del mar (15 °C)
const AIR_SCALE = 8500; // m: cada tanto más alto el aire es e veces menos denso
const TURBO = 0.2; // el turbo compensa casi todo el aire que falta: con 20 % menos de aire, 4 % menos de potencia

export const CG_HEIGHT = 0.25; // m: altura del centro de gravedad
export const TRACK_WIDTH = 1.6; // m: trocha (de rueda a rueda del mismo eje)
export const WHEELBASE = 3.35; // m, entre los ejes (como en carmodel.js)
// Traslado de peso al frenar o acelerar: fracción de la carga total que pasa de un eje al otro con una aceleración
// a (m/s², + hacia adelante) y esa carga (m/s²: el peso más el apoyo, por kilo). Positivo: hacia adelante (frenando)
const MAX_SHIFT = 0.3;
export const weightShift = (a, load) => Math.max(-MAX_SHIFT, Math.min(MAX_SHIFT, (-a * CG_HEIGHT) / (WHEELBASE * load)));
// los frenos reparten la frenada entre los ejes como la carga que tiene cada uno en ese momento, corrido esto hacia
// adelante: así las que se bloquean primero son las delanteras (el auto sigue derecho) y no las traseras (trompo)
// (fwd: BRAKE_BIAS_FWD más lo que diga la puesta a punto, de a BRAKE_BIAS_STEP por punto: más adelante el auto frena
// más estable pero bloquea antes las delanteras y frena menos; más atrás frena más y rota al entrar, hasta que
// bloquean las de atrás)
export const BRAKE_BIAS_FWD = 0.08, BRAKE_BIAS_STEP = 0.012, BRAKE_TUNE_MAX = 5;
export const brakeBias = (capF, capR, fwd = BRAKE_BIAS_FWD) => Math.min(0.85, Math.max(0.15, capF / (capF + capR) + fwd));
// lo que se considera frenar y acelerar "a fondo" para la trazada: esta parte de lo más que aguantan las gomas
const BRAKE_NOMINAL = 0.93;
const TRACTION_NOMINAL = 0.92;
const CLEAN_AIR = Object.freeze([1, 1]); // carga aerodinámica de cada eje respecto de la del aire limpio
export const DEFAULT_TUNE = Object.freeze({ front: 5, rear: 5, balance: 0, brake: 0 });
export const WING_MIN = 1, WING_MAX = 10, BALANCE_MAX = 5;

// densidad del aire (kg/m³) a una altura sobre el nivel del mar (m)
export const airDensity = (altitude = 0) => SEA_AIR * Math.exp(-altitude / AIR_SCALE);

// La goma de costado: qué parte de su agarre da según cuánto desliza. x es la deriva (el ángulo entre para dónde
// apunta la goma y para dónde va) sobre la deriva del pico. Hasta el pico la fuerza crece (casi recta al principio);
// pasado el pico, cae de a poco hasta slide (la goma arrastrándose de costado agarra menos que en el pico). Por eso
// pedir más volante del que se puede no dobla más: abre la curva (subviraje) o suelta la cola (sobreviraje).
export function tyreCurve(x, slide = 0.75) {
  const a = Math.abs(x), peak = (2 * a) / (1 + a * a);
  return Math.sign(x) * (a <= 1 ? peak : slide + (1 - slide) * peak);
}

const wing = (x) => (Math.max(WING_MIN, Math.min(WING_MAX, x)) - WING_MIN) / (WING_MAX - WING_MIN); // 0..1

// Los límites del auto con esa puesta a punto, ese aire, esa variación (setup: multiplicadores de car.js), esos
// daños (damage.js) y esa nafta encima (kg). Velocidades en m/s y aceleraciones en m/s² (por kilo de auto, salvo
// axles y straight: por kilo sobre ese eje).
// Las funciones que dependen de la carga aerodinámica aceptan k = [adelante, atrás]: la carga de cada eje respecto
// de la del aire limpio (car.js la baja detrás de otro auto, de costado o según cabecea).
export function carLimits(car, tune = DEFAULT_TUNE, air = SEA_AIR, setup = {}, damage = NO_DAMAGE, fuel = 0) {
  const { frontShare, mu, loadExp, brakeMu, tractionMu, power, engineBrake, rolling, aero } = car;
  const mass = car.mass + fuel;
  const wf = wing(tune.front), wr = wing(tune.rear);
  // coeficientes por área (m²): carga y resistencia = ½·ρ·C·v². Con los dos alerones al mínimo el auto tiene clMin
  // de carga (la del piso y la carrocería) y con los dos al máximo, clMax; frontWing es la parte de esa diferencia
  // que pone el alerón delantero. La carrocería reparte su carga de modo que con los alerones parejos el auto quede
  // neutro (la carga se reparte entre los ejes como el peso). Cada alerón cobra en resistencia su carga sobre su
  // eficiencia (ld): el delantero es mucho más eficiente que el trasero.
  const span = aero.clMax - aero.clMin, wingF = span * aero.frontWing, wingR = span - wingF;
  const bodyF = (frontShare * (aero.clMin + span / 2) - wingF / 2) / aero.clMin;
  const cdWingR = (wingR * wr) / aero.ldRear;
  // con daños, cada eje lleva carga distinta de cada lado: [izquierda, derecha] (la mitad del eje cada uno)
  const hurt = damagedAero(damage, {
    bodyF: aero.clMin * bodyF, bodyR: aero.clMin * (1 - bodyF), wingF: wingF * wf, wingR: wingR * wr,
    cd: aero.cdBody, cdWingF: (wingF * wf) / aero.ldFront, cdWingR,
  });
  const cd = hurt.cd / (setup.topSpeed ?? 1) ** 2;
  // balance mecánico: qué parte del traslado de peso de costado se lleva el eje delantero (parejo: como el peso)
  const b = (Math.max(-BALANCE_MAX, Math.min(BALANCE_MAX, tune.balance ?? 0)) / BALANCE_MAX) * (car.rollRange ?? 0.3);
  const rollF = frontShare - b;
  const grip = mu * (setup.grip ?? 1) * GRAVITY;
  const q = (v) => 0.5 * air * v * v; // presión dinámica
  const W = mass * GRAVITY;
  const P = power * (1 - TURBO * (1 - air / SEA_AIR)) * (setup.power ?? 1) * powerLoss(damage);
  // carga de cada rueda respecto de la del auto quieto, por eje y lado
  const sideLoad = (cl, share, v) => 1 + (cl * q(v)) / ((W * share) / 2);
  // agarre de un eje (respecto de mu·g): cada rueda agarra según su carga; `out` es el lado de afuera de la curva y
  // shift, la carga que pasa de la rueda de adentro a la de afuera (respecto de la de una rueda con el auto quieto;
  // la de adentro no baja de cero: se levanta)
  const axle = (cl, k, share, v, out, shift) => {
    const lo = sideLoad(cl[out] * k, share, v), li = sideLoad(cl[1 - out] * k, share, v), d = Math.min(shift, li);
    return ((lo + d) ** loadExp + (li - d) ** loadExp) / 2;
  };
  // los dos ejes doblando al límite hacia un lado: el traslado de costado depende de cuánto dobla, y cuánto dobla,
  // del agarre que queda (se resuelve en tres vueltas)
  const turning = (v, out, k) => {
    let f = 0, r = 0, ay = 0;
    for (let i = 0; i < 3; i++) {
      const t = (2 * ay * CG_HEIGHT) / (GRAVITY * TRACK_WIDTH);
      f = grip * axle(hurt.front, k[0], frontShare, v, out, (t * rollF) / frontShare);
      r = grip * axle(hurt.rear, k[1], 1 - frontShare, v, out, (t * (1 - rollF)) / (1 - frontShare));
      ay = Math.min(f, r);
    }
    return [f, r];
  };
  const longBrake = brakeMu * (setup.brakes ?? 1);
  const brakeFwd = BRAKE_BIAS_FWD + BRAKE_BIAS_STEP * Math.max(-BRAKE_TUNE_MAX, Math.min(BRAKE_TUNE_MAX, tune.brake ?? 0));
  const even = damage === NO_DAMAGE; // sano: da lo mismo para qué lado dobla
  const clF = hurt.front[0] + hurt.front[1], clR = hurt.rear[0] + hurt.rear[1];

  const lim = {
    frontShare,
    air,
    mass, // kg, con la nafta
    loadExp,
    // cuánto más agarran las gomas para frenar y para empujar que de costado
    longBrake,
    brakeFwd, // cuánto más adelante que la carga va el reparto de frenada
    longDrive: tractionMu,
    rolling, // m/s²: rodadura
    // carga sobre cada eje respecto de la del auto quieto (1 = sólo el peso)
    loads(v, k = CLEAN_AIR) {
      return [1 + (clF * k[0] * q(v)) / (W * frontShare), 1 + (clR * k[1] * q(v)) / (W * (1 - frontShare))];
    },
    // carga total en g (el peso más el apoyo aerodinámico)
    load(v, k = CLEAN_AIR) {
      return 1 + ((clF * k[0] + clR * k[1]) * q(v)) / W;
    },
    // agarre lateral de cada eje doblando al límite, por kilo que apoya en ese eje (m/s²). turn: para dónde dobla
    // (1 derecha, -1 izquierda, 0: cualquiera; con daño de un lado, el peor de los dos)
    axles(v, turn = 0, k = CLEAN_AIR) {
      if (turn || even) return turning(v, turn > 0 ? 0 : 1, k);
      const a = turning(v, 0, k), c = turning(v, 1, k);
      return [Math.min(a[0], c[0]), Math.min(a[1], c[1])];
    },
    // lo mismo en recta (sin traslado de costado): lo que tienen las gomas para frenar o empujar
    straight(v, k = CLEAN_AIR) {
      return [grip * axle(hurt.front, k[0], frontShare, v, 0, 0), grip * axle(hurt.rear, k[1], 1 - frontShare, v, 0, 0)];
    },
    // lo más que puede doblar el auto en régimen (los dos ejes tienen que aguantar su parte)
    lateral(v, k = CLEAN_AIR) {
      const [f, r] = lim.axles(v, 0, k);
      return Math.min(f, r);
    },
    // resistencia del aire (m/s²)
    drag(v) {
      return (cd * q(v)) / mass;
    },
    // sin pedales: aire, rodadura y freno motor (con la recuperación de energía)
    coast(v) {
      return lim.drag(v) + rolling + (v > 5 ? engineBrake : 0);
    },
    // lo más que frenan las gomas en recta (m/s², sin el aire): al frenar el peso pasa adelante, y el límite lo pone
    // el eje que primero se bloquea con el reparto de frenada (brakeBias)
    brakePeak(v, k = CLEAN_AIR) {
      const [f, r] = lim.straight(v, k), load = GRAVITY * lim.load(v, k), FS = frontShare;
      let a = longBrake * (f * FS + r * (1 - FS));
      for (let i = 0; i < 4; i++) {
        const s = weightShift(-a, load);
        const cF = longBrake * f * FS * ((FS + s) / FS) ** loadExp, cR = longBrake * r * (1 - FS) * ((1 - FS - s) / (1 - FS)) ** loadExp;
        const bias = brakeBias(cF, cR, brakeFwd);
        a = Math.min(cF / bias, cR / (1 - bias));
      }
      return a;
    },
    // frenada al límite, con un poco de margen (m/s², sin el aire): la que usa la trazada
    brake(v, k = CLEAN_AIR) {
      return BRAKE_NOMINAL * lim.brakePeak(v, k);
    },
    // lo más que pueden empujar las ruedas de atrás (m/s² de todo el auto): al acelerar el peso pasa atrás
    tractionPeak(v, k = CLEAN_AIR) {
      const r = lim.straight(v, k)[1], load = GRAVITY * lim.load(v, k), FS = frontShare;
      let a = tractionMu * r * (1 - FS);
      for (let i = 0; i < 4; i++) a = tractionMu * r * (1 - FS) * ((1 - FS - weightShift(a, load)) / (1 - FS)) ** loadExp;
      return a;
    },
    // lo que empujan acelerando con cuidado (lo que usa la trazada)
    traction(v, k = CLEAN_AIR) {
      return TRACTION_NOMINAL * lim.tractionPeak(v, k);
    },
    // lo que empuja el motor a fondo en la marcha justa (m/s²), sin mirar si las gomas lo aguantan
    engine(v) {
      return P / (mass * Math.max(v, 1));
    },
    // empuje a fondo (m/s²), hasta lo que da la tracción
    thrust(v) {
      return Math.min(lim.engine(v), lim.traction(v));
    },
    // aceleración neta a fondo (m/s²)
    accel(v) {
      return lim.thrust(v) - lim.drag(v) - rolling;
    },
  };
  // velocidad punta: donde el motor ya no le gana al aire
  let lo = 30, hi = 140;
  for (let i = 0; i < 40; i++) {
    const v = (lo + hi) / 2;
    if (lim.accel(v) > 0) lo = v;
    else hi = v;
  }
  lim.topSpeed = lo;
  // lo que frenan los frenos con el pedal a fondo (m/s²): lo que aguantan las gomas a la velocidad punta, con toda la
  // carga aerodinámica. Más despacio hay menos carga y eso mismo las bloquea: hay que ir soltando el pedal
  lim.brakeMax = lim.brakePeak(lo);
  return lim;
}
