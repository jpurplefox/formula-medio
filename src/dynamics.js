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
//   balance      balance mecánico (barras estabilizadoras, resortes), de -5 (más agarre atrás) a 5 (más adelante):
//                decide el balance en las curvas lentas, donde la carga aerodinámica casi no pesa.
// Con poco agarre adelante el auto no dobla lo que pide el volante (subviraje); con poco atrás, la cola se abre
// (sobreviraje); lo más rápido es lo parejo.

import { damagedAero, NO_DAMAGE, OUTER_SHARE, powerLoss } from './damage.js';

export const GRAVITY = 9.8;
export const SEA_AIR = 1.225; // kg/m³: densidad del aire a nivel del mar (15 °C)
const AIR_SCALE = 8500; // m: cada tanto más alto el aire es e veces menos denso
const TURBO = 0.2; // el turbo compensa casi todo el aire que falta: con 20 % menos de aire, 4 % menos de potencia

export const DEFAULT_TUNE = Object.freeze({ front: 5, rear: 5, balance: 0 });
export const WING_MIN = 1, WING_MAX = 10, BALANCE_MAX = 5;

// densidad del aire (kg/m³) a una altura sobre el nivel del mar (m)
export const airDensity = (altitude = 0) => SEA_AIR * Math.exp(-altitude / AIR_SCALE);

const wing = (x) => (Math.max(WING_MIN, Math.min(WING_MAX, x)) - WING_MIN) / (WING_MAX - WING_MIN); // 0..1

// Los límites del auto con esa puesta a punto, ese aire, esa variación (setup: multiplicadores de car.js) y esos
// daños (damage.js). Velocidades en m/s y aceleraciones en m/s² (por kilo de auto, salvo axles: por kilo sobre ese
// eje).
export function carLimits(car, tune = DEFAULT_TUNE, air = SEA_AIR, setup = {}, damage = NO_DAMAGE) {
  const { mass, frontShare, mu, loadExp, brakeMu, tractionMu, power, engineBrake, rolling, aero } = car;
  const wf = wing(tune.front), wr = wing(tune.rear);
  // coeficientes por área (m²): carga y resistencia = ½·ρ·C·v². Con los dos alerones al mínimo el auto tiene clMin
  // de carga (la del piso y la carrocería) y con los dos al máximo, clMax; frontWing es la parte de esa diferencia
  // que pone el alerón delantero. La carrocería reparte su carga de modo que con los alerones parejos el auto quede
  // neutro (la carga se reparte entre los ejes como el peso). Cada alerón cobra en resistencia su carga sobre su
  // eficiencia (ld): el delantero es mucho más eficiente que el trasero.
  const span = aero.clMax - aero.clMin, wingF = span * aero.frontWing, wingR = span - wingF;
  const bodyF = (frontShare * (aero.clMin + span / 2) - wingF / 2) / aero.clMin;
  // con daños, cada eje lleva carga distinta de cada lado: [izquierda, derecha] (la mitad del eje cada uno)
  const hurt = damagedAero(damage, {
    bodyF: aero.clMin * bodyF, bodyR: aero.clMin * (1 - bodyF), wingF: wingF * wf, wingR: wingR * wr,
    cd: aero.cdBody, cdWingF: (wingF * wf) / aero.ldFront, cdWingR: (wingR * wr) / aero.ldRear,
  });
  const clF = hurt.front[0] + hurt.front[1], clR = hurt.rear[0] + hurt.rear[1];
  const cd = hurt.cd / (setup.topSpeed ?? 1) ** 2;
  // balance mecánico: pasa agarre de un eje al otro sin cambiar el total
  const b = (Math.max(-BALANCE_MAX, Math.min(BALANCE_MAX, tune.balance ?? 0)) / BALANCE_MAX) * car.balanceRange;
  const mechF = 1 + b, mechR = 1 - (b * frontShare) / (1 - frontShare);
  const grip = mu * (setup.grip ?? 1);
  const q = (v) => 0.5 * air * v * v; // presión dinámica
  const W = mass * GRAVITY;
  const P = power * (1 - TURBO * (1 - air / SEA_AIR)) * (setup.power ?? 1) * powerLoss(damage);
  // carga de cada rueda respecto de la del auto quieto, por eje y lado
  const sideLoad = (cl, share, v) => 1 + (cl * q(v)) / ((W * share) / 2);

  const lim = {
    frontShare,
    air,
    rolling, // m/s²: rodadura
    // carga sobre cada eje respecto de la del auto quieto (1 = sólo el peso)
    loads(v) {
      return [1 + (clF * q(v)) / (W * frontShare), 1 + (clR * q(v)) / (W * (1 - frontShare))];
    },
    // carga total en g (el peso más el apoyo aerodinámico)
    load(v) {
      return 1 + ((clF + clR) * q(v)) / W;
    },
    // agarre lateral de cada eje, por kilo que apoya en ese eje (m/s²), sin traslado de peso. turn: para dónde
    // dobla (1 derecha, -1 izquierda, 0 derecho): en curva la rueda de afuera lleva más carga, así que pesa más lo
    // que tenga de su lado (con el auto sano da lo mismo)
    axles(v, turn = 0) {
      const out = turn > 0 ? 0 : 1, w = turn ? OUTER_SHARE : 0.5;
      const axle = (cl, share) => w * sideLoad(cl[out], share, v) ** loadExp + (1 - w) * sideLoad(cl[1 - out], share, v) ** loadExp;
      return [grip * mechF * GRAVITY * axle(hurt.front, frontShare), grip * mechR * GRAVITY * axle(hurt.rear, 1 - frontShare)];
    },
    // lo más que puede doblar el auto en régimen (los dos ejes tienen que aguantar su parte)
    lateral(v) {
      const [f, r] = lim.axles(v);
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
    // frenada de las gomas (m/s², sin el aire): todo el agarre del auto, en sentido longitudinal
    brake(v) {
      const [f, r] = lim.axles(v);
      return brakeMu * (setup.brakes ?? 1) * (f * frontShare + r * (1 - frontShare));
    },
    // lo que pueden empujar las ruedas de atrás (m/s² de todo el auto)
    traction(v) {
      return tractionMu * lim.axles(v)[1] * (1 - frontShare);
    },
    // empuje del motor a fondo en la marcha justa (m/s²), hasta lo que da la tracción
    thrust(v) {
      return Math.min(P / (mass * Math.max(v, 1)), lim.traction(v));
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
  return lim;
}
