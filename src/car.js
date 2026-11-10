// Física del auto, en unidades reales: la velocidad va en m/s y las aceleraciones en m/s².
// La posición va en celdas del mapa; track.meters dice cuántos metros mide una celda.
// Lo que puede hacer el auto (agarre de cada eje, frenada, empuje del motor, resistencia del aire) sale de
// dynamics.js, con los números de cars/*.json, la puesta a punto (alerones y balance) y el aire del circuito.
// Acá está lo que pasa en cada instante: pedales, marchas, traslado de peso, la cola que se abre, golpes, pasto y
// daños (damage.js: lo que se rompe en los choques de collision.js).

import { edgeInfo, sampleField, stationAt } from './track.js';
import { RubberMap } from './rubber.js';
import { collideWalls } from './collision.js';
import { brakeBias, carLimits, CG_HEIGHT, DEFAULT_TUNE, GRAVITY, SEA_AIR, TRACK_WIDTH, tyreCurve, weightShift, WHEELBASE } from './dynamics.js';
import { applyHit, deflate, NO_DAMAGE, steerPull, wheelDrag as damageDrag, wheelGrip as damageGrip } from './damage.js';

// Auto por defecto, por si no se carga uno (como cars/f1-2025.json)
export const DEFAULT_PROFILE = {
  maxRpm: 11985,
  upshiftRpm: 10845,
  downshiftRpm: 10522,
  gearKmhPerRpm: [0.00954, 0.01137, 0.01354, 0.01613, 0.01896, 0.02184, 0.02501, 0.02828],
  mass: 810,
  frontShare: 0.445,
  mu: 1.9,
  loadExp: 0.85,
  brakeMu: 1.1,
  tractionMu: 1.15,
  rollRange: 0.3,
  power: 620400,
  engineBrake: 2.6,
  rolling: 0.15,
  aero: { clMin: 4.85, clMax: 7.032, frontWing: 0.4, ldFront: 8, ldRear: 2.278, cdBody: 1.058 },
};

// Superficies (surfaceAt de track.js dice cuál hay debajo de cada rueda):
//   grip      fracción del agarre de esa rueda
//   drag      cuánto frena esa rueda (m/s², pasando DRAG_FROM); si frena más de un lado, el auto tira para ese lado
//   maxSpeed  con las dos traseras ahí, el motor ya no empuja más allá de esta velocidad (m/s)
//   rough     cuánto traquetea (el volante y la cámara)
//   out       fuera de la pista (todo lo que está más allá del borde y del piano)
//   slide     (opcional) cuánto agarre más pierde la rueda con el auto de costado (con SLIDE_FULL m/s de deslizamiento)
//   wear      (opcional) cuántas veces más se gastan las gomas ahí
export const SURFACES = {
  road: { grip: 1, drag: 0, maxSpeed: Infinity, rough: 0, out: false },
  // el piano: pintura lisa con escalones, agarra un poco menos que el asfalto, y de costado bastante menos (el
  // traqueteo del piano va aparte: car.onKerb)
  kerb: { grip: 0.9, drag: 0.5, maxSpeed: Infinity, rough: 0, out: false, slide: 0.3 },
  // la franja verde detrás del piano: ya es fuera de la pista; abrasiva, agarra menos y come las gomas
  green: { grip: 0.8, drag: 2, maxSpeed: Infinity, rough: 0.3, out: true, slide: 0.2, wear: 4 },
  // la salchicha: el auto salta (y puede romper el piso, ver SAUSAGE_HIT), casi no agarra y frena mucho
  sausage: { grip: 0.4, drag: 10, maxSpeed: Infinity, rough: 1.2, out: true, slide: 0.3 },
  grass: { grip: 0.6, drag: 5, maxSpeed: 25, rough: 1, out: true }, // con las cuatro: 20 m/s² de freno y no pasa de ~90 km/h
  // leca: casi no deja doblar y frena mucho más que el pasto (con las cuatro, 32 m/s²); el motor apenas la saca
  gravel: { grip: 0.4, drag: 8, maxSpeed: 12, rough: 1.4, out: true },
  // escapatoria asfaltada: como la pista, un poco más sucia
  asphalt: { grip: 0.92, drag: 0, maxSpeed: Infinity, rough: 0, out: true },
};
const SLIDE_FULL = 4; // m/s de deslizamiento de costado con el que una superficie pierde todo su `slide`
// subirse a una salchicha: un golpe en el piso de esta intensidad (m/s, como los choques de damage.js) por cada m/s
// de velocidad: desde ~28 m/s (100 km/h) empieza a romper, a 160 km/h se lleva un 20 % del piso y a 250 km/h, la
// mitad. Y el auto pega un salto y un tirón para el otro lado
const SAUSAGE_HIT = 0.25;
const SAUSAGE_KICK = 0.012; // rad/s de giro por cada m/s de velocidad, hacia el lado contrario de la salchicha
const SAUSAGE_KICK_MAX = 0.5; // rad/s
const DRAG_FROM = 15; // m/s
const SURFACE_RATE = 5; // 1/s: al cambiar de superficie, el agarre y el freno de la rueda cambian en ~0,2 s
// dónde apoya cada rueda, en m desde el centro del auto (adelante, a la derecha), como en carmodel.js:
// delantera izquierda, delantera derecha, trasera izquierda, trasera derecha
export const WHEELS = [[1.65, -0.8], [1.65, 0.8], [-1.7, -0.79], [-1.7, 0.79]];
const REVERSE_MAX = 8;
const REVERSE_ACCEL = 5;
const MAX_YAW = 1.6; // rad/s: giro máximo a baja velocidad
const MAX_WHEEL_ANGLE = 0.35; // rad: lo más que doblan las ruedas delanteras, a paso de hombre
const MIN_WHEEL_ANGLE = 0.05; // rad: aun a fondo se ve que doblan un poco
// La estela: detrás de otro auto el aire llega frenado y revuelto. Hay menos resistencia (rebufo: más punta en la
// recta) pero también menos carga aerodinámica (aire sucio), sobre todo adelante: en las curvas rápidas el que sigue
// de cerca subvira, y frenando se le bloquean antes las ruedas.
const DRAFT_DIST = 120; // m: hasta dónde se siente (cae con el cuadrado: a 20 m queda el 70 %; a 45 m, el 40 %)
const DRAFT_WIDTH = 2.5; // m de costado: el ancho de la estela
const DRAFT_DRAG = 0.35; // fracción de la resistencia del aire que se ahorra pegado al de adelante
// y la carga de cada eje que se pierde pegado al de adelante; cae mucho más rápido con la distancia que el rebufo
// (con la estela a la DIRTY_FADE): a 10 m se pierde ~30 % de la carga (33 % adelante, 26 % atrás), a 20 m ~15 % y a
// 40 m ~3 %. Es lo que se publicó de los F1 de 2023 en adelante (más de 30 % siguiendo de cerca; el objetivo del
// reglamento de 2022 era 18 % a 10 m y 4 % a 20 m, y los autos anteriores perdían 45 % y 35 %)
const DIRTY_FRONT = 0.6, DIRTY_REAR = 0.48, DIRTY_FADE = 3.5;
// La carga aerodinámica también cambia con cómo va el auto: frenando la trompa baja y el piso carga más adelante y
// menos atrás (PITCH_AERO por cada g de frenada; acelerando, al revés), y de costado el aire no entra derecho al
// piso ni a los alerones (pasados YAW_AERO_FREE rad de deriva del auto, YAW_AERO por rad, hasta YAW_AERO_MAX)
const PITCH_AERO = 0.008, PITCH_MAX = 0.05;
const YAW_AERO = 1, YAW_AERO_FREE = 0.1, YAW_AERO_MAX = 0.5;
// nafta: cada kilo pesa (dynamics.js); el motor a fondo gasta los 100 kg/h del reglamento
export const FUEL_FLOW = 100 / 3600; // kg/s
export const FUEL_PER_KM = 0.37; // kg: lo que se carga por cada km de carrera
// Gomas de costado (modelo de bicicleta: cada eje como una sola rueda). El auto tiene velocidad hacia adelante
// (speed), de costado (slip) y de giro (omega); cada eje empuja de costado según su deriva (tyreCurve de
// dynamics.js), hasta lo que agarra (dynamics.js más el traslado de peso, lo que pisa y lo que gasta en frenar o
// empujar). Lo que empuja cada eje hace girar el auto según a qué distancia del centro de gravedad está.
const PEAK_SLIP = 0.08; // rad (~4,6°): deriva con la que la goma da todo su agarre
const SLIDE = 0.75; // arrastrándose de costado, la goma agarra esta parte de lo que agarra en el pico
const SLIP_SPEED = 5; // m/s: por debajo de esto la deriva se mide como si fuera a esta velocidad (parado no hay ángulo)
const YAW_K2 = 1.25; // m²: momento de inercia de giro por kilo (~1000 kg·m² en 810 kg)
const SUBSTEPS = 4; // pasos de las gomas por cada paso del juego (la goma responde más rápido que 1/60 s)
const SETTLE = 0.5; // en un paso, una goma no empuja más que esta parte de lo que frenaría del todo su deslizamiento
// la cola agarra de costado esta parte más de lo que dice dynamics.js: así un auto parejo, al pasarse del límite,
// se abre de trompa (subvira) en vez de soltar la cola, como los autos de verdad con su puesta de fábrica. Con una
// puesta muy cargada adelante (balance o alerón delantero) la cola igual se suelta: es lo que tiene que pasar
const REAR_MARGIN = 1.15;
// con el volante a fondo, además del ángulo que hace doblar al auto, las ruedas suman esta parte de PEAK_SLIP: lo
// que la trompa tiene que derivar más que la cola (que, con REAR_MARGIN, agarra más con menos deriva)
const LOCK_SLIP = 0.45;
// Control de tracción (ayuda, sobre todo para el teclado, que acelera todo o nada): el motor no empuja más de lo que
// las de atrás pueden empujar sin dejar de sostener la curva. tc es qué parte del círculo de fricción de la cola
// puede usarse entre doblar y empujar (0 = sin control); si la cola ya está deslizando, corta casi todo
export const TRACTION_CONTROL = { off: 0, low: 0.97, high: 0.85 };
// las ayudas con las que corren siempre los rivales del juego (y con las que se entrena la red): ABS y control de
// tracción bajo
export const RIVAL_AIDS = Object.freeze({ abs: true, tc: TRACTION_CONTROL.low });
// ABS (ayuda, sobre todo para el teclado, que frena todo o nada): si se pide frenar más de lo que aguantan las gomas,
// suelta freno hasta ABS_USE de ese límite: las ruedas no se bloquean y queda algo de agarre para doblar
const ABS_USE = 0.95;
const TC_FLOOR = 0.1; // aun con la cola al límite, deja empujar esta parte de la tracción (para no quedarse clavado)
const WHEEL_SIDE = 0.8; // m: distancia de cada rueda al centro, de costado (para el tirón de una rueda en el pasto)
// traslado de peso: al frenar el peso se pasa adelante y al acelerar, atrás; cada eje agarra según la carga que
// tiene y lo que le queda después de frenar o traccionar (círculo de fricción). En una curva sin pedales da lo que
// dice dynamics.js; frenando fuerte la cola queda liviana y se abre, y a fondo en una curva lenta también.
// (la altura del centro de gravedad, el reparto de la frenada y cuánto agarra la goma a lo largo están en
// dynamics.js)
const TRANSFER_RATE = 20; // 1/s: el peso tarda un instante en pasarse (lo frena la suspensión)
// Bloqueos y patinamiento: si a un eje se le pide frenar o empujar más de lo que agarra en ese momento, sus ruedas
// se bloquean (o patinan): arrastrándose frenan o empujan sólo LONG_SLIDE de lo que agarraban, casi no sostienen de
// costado (SLIDING_SIDE: con las de adelante bloqueadas el auto sigue derecho; con las de atrás, la cola se va) y
// se calientan y se gastan mucho (un plano). Vuelven a agarrar cuando lo pedido baja de LONG_RELEASE del agarre
const LONG_SLIDE = 0.75, SLIDING_SIDE = 0.15, LONG_RELEASE = 0.9;
// Temperatura de las gomas (°C, una por rueda). Se calientan con lo que deslizan (doblando, frenando, empujando, y
// mucho bloqueadas o patinando) y con rodar cargadas; el aire y el asfalto las enfrían, más a más velocidad. Agarran
// todo entre TEMP_LOW y TEMP_HIGH; más frías (la largada: salen de las mantas a TYRE_START) o más calientes
// (deslizando de más), menos. Las recalentadas además se gastan más rápido.
export const TYRE_START = 80, TEMP_LOW = 85, TEMP_HIGH = 105;
const TRACK_TEMP = 35;
const COLD_LOSS = 0.14, COLD_SPAN = 50; // a COLD_SPAN grados por debajo de TEMP_LOW agarra COLD_LOSS menos
const HOT_LOSS = 0.2, HOT_SPAN = 40;
const HEAT = 0.17; // °C por cada m²/s³ de deslizamiento de un eje (fuerza por kilo de auto × velocidad de deslizamiento)
const HEAT_SPEED = 30; // m/s: más rápido, la goma pasa menos tiempo en el piso y se queda con menos de ese calor
const ROLL_HEAT = 0.015; // °C por metro rodado con la carga del auto quieto
const COOL = 0.004, COOL_SPEED = 0.0009; // 1/s y 1/m: enfriamiento hacia TRACK_TEMP
const LONG_SLIP = 0.02; // frenando o empujando sin bloquear, la goma desliza esta parte de la velocidad
const SPIN_SPEED = 6; // m/s que patina de más una rueda que perdió tracción
const HOT_WEAR = 2; // una goma HOT_SPAN grados pasada se gasta esto más
const LOCK_WEAR = 25; // y una bloqueada, estas veces más (el plano)
export const tempGrip = (t) => 1 - (t < TEMP_LOW ? COLD_LOSS * Math.min(1, (TEMP_LOW - t) / COLD_SPAN) ** 1.5 : t > TEMP_HIGH ? HOT_LOSS * Math.min(1, (t - TEMP_HIGH) / HOT_SPAN) ** 1.5 : 0);
// el pie no llega a fondo de golpe: con teclado (todo o nada) el acelerador tarda un instante en abrirse, así
// pisar en plena curva no suelta la cola de un saque (con joystick casi no se nota: va siguiendo al gatillo)
const THROTTLE_RISE = 3; // 1/s: de nada a fondo en 1/3 s
const BRAKE_RISE = 10; // 1/s
const PEDAL_DROP = 12; // 1/s: soltar es rápido
const PARKED = 2; // s parado después de abandonar hasta que lo sacan de la pista
const IDLE_RPM = 4000;
const LAUNCH_RPM = 8000; // con el embrague patinando, en 1ª y 2ª el motor no cae de acá
const FULL_POWER_RPM = 9000; // por debajo de esto el motor rinde cada vez menos
// Largada: según las rpm al soltar el embrague, el auto sale con todo, se ahoga o patina
export const LAUNCH_WINDOW = [9500, 10500]; // rpm de la largada perfecta
const LAUNCH_TIME = 1.6; // cuánto dura el efecto de la largada (s)
const REV_RATE = 6500; // cuánto suben las rpm por segundo en punto muerto, a fondo (más lento cerca del corte)
const REV_DROP = 7000; // y cuánto bajan sin acelerar
const REV_BASE = 8000, REV_SPAN = 4000, REV_FOLLOW = 40000; // la red en la grilla (revBy): vueltas sin pedir nada y cuánto suma o resta cada salida a fondo
// desgaste de las gomas (uno por rueda): se gastan al andar, más cuanto más se exige su agarre (doblando, frenando,
// acelerando, deslizando) y más las que más trabajan (las de afuera, las que patinan); gastadas del todo agarran y
// frenan WEAR_GRIP menos, y al final (pasado WEAR_CLIFF_FROM) se caen de golpe otro WEAR_CLIFF
const WEAR_GRIP = 0.08, WEAR_CLIFF = 0.06, WEAR_CLIFF_FROM = 0.85;
export const wearGrip = (w) => 1 - WEAR_GRIP * w - WEAR_CLIFF * Math.max(0, (w - WEAR_CLIFF_FROM) / (1 - WEAR_CLIFF_FROM)) ** 2;
const WEAR_BASE = 0.3; // parte del desgaste que es sólo por andar, aunque sea derecho y suave
const WEAR_USE = 1.9; // la otra parte se escala para que una vuelta normal promedie 1 (medido con rl/wear.js)

// Variación entre autos: multiplicadores sobre el auto (1 = igual). La red los recibe como entradas.
//   power     empuje del motor
//   topSpeed  velocidad punta (menos resistencia del aire)
//   grip      agarre lateral
//   brakes    frenada
//   wear      qué tan rápido se gastan las gomas
export const SETUP_KEYS = ['power', 'topSpeed', 'grip', 'brakes', 'wear'];
export const SAME_SETUP = Object.freeze({ power: 1, topSpeed: 1, grip: 1, brakes: 1, wear: 1 });

// giro del auto (rad/s) con el volante a fondo, a velocidad sp (m/s) y con ese agarre lateral (m/s²)
function yawRate(sp, grip) {
  return Math.min(MAX_YAW, grip / Math.max(sp, 1)) * Math.min(1, sp / 4);
}

// Ángulo de las ruedas delanteras con el volante a fondo (rad): el que hace doblar al auto lo que puede doblar
// (ángulo ≈ distancia entre ejes × giro / velocidad, más lo que deriva la trompa de más). A baja velocidad doblan
// mucho; a fondo, apenas. Es la ayuda para manejar con teclado: el volante va de 0 a lo justo, no de 0 a todo lo que
// gira la dirección. grip: el agarre lateral (m/s²) con que se calcula; por defecto, el del auto sano en asfalto.
export function steerLock(speed, limits, grip) {
  const sp = Math.max(4, Math.abs(speed)); // parado o casi, como a paso de hombre: con todo el giro
  const a = Math.atan((WHEELBASE * yawRate(sp, grip ?? limits.lateral(sp))) / sp) + LOCK_SLIP * PEAK_SLIP;
  return Math.min(MAX_WHEEL_ANGLE, a);
}

// Para la puesta a punto, en régimen a velocidad v (m/s), con los límites de dynamics.js:
// cuánto dobla el auto (m/s²): lo que aguanta el eje que menos agarra, con el margen de la cola
export function cornerGrip(limits, v) {
  const [f, r] = limits.axles(v);
  return Math.min(f, r * REAR_MARGIN);
}
// y cuánto más puede sostener la cola que la trompa (0,15 con un auto parejo): con poco margen, frenando en curva o al
// soltar el freno la cola se va (el peso pasa adelante); con menos de 0, sobrevira aun en régimen
export function rearMargin(limits, v) {
  const [f, r] = limits.axles(v);
  return (r * REAR_MARGIN) / f - 1;
}

// Volante con teclado (todo o nada): al apretar, el volante salta enseguida a KEY_STEER_START (responde sin demora) y
// de ahí sigue subiendo de a poco, más despacio cuanto más rápido va (a 300 km/h, ~0,4 s hasta el fondo). Así un toque
// corrige sin tirar el auto para adentro, como pasaba yendo de 0 a fondo de golpe; al soltar vuelve rápido al centro.
// now: cómo está ahora (-1..1); want: lo que piden las teclas (-1, 0 o 1).
const KEY_STEER_START = 0.35;
const KEY_STEER_RISE = 8; // 1/s: parado, de KEY_STEER_START a fondo en 0,08 s
const KEY_STEER_SPEED = 25; // m/s: a esta velocidad sube a la mitad de ritmo (a 300 km/h, a menos de un cuarto)
const KEY_STEER_RETURN = 10; // 1/s
export function keyboardSteer(now, want, speed, dt) {
  if (want && want * now < KEY_STEER_START) now = want * KEY_STEER_START; // recién apretada (o cambió de lado)
  const away = want !== now && (now === 0 || Math.sign(want - now) === Math.sign(now)); // más volante
  const rate = away ? KEY_STEER_RISE / (1 + Math.abs(speed) / KEY_STEER_SPEED) : KEY_STEER_RETURN;
  return now + Math.max(-rate * dt, Math.min(rate * dt, want - now));
}

// El ángulo de las ruedas delanteras para dibujarlas (aun a fondo se ve que doblan un poco)
export function wheelAngle(steer, speed, limits) {
  return steer * Math.max(MIN_WHEEL_ANGLE, steerLock(speed, limits));
}

// La estela de los autos que car tiene adelante (0..1): más cuanto más cerca y más alineado.
// meters: metros por celda del circuito.
export function slipstream(car, cars, meters) {
  const fx = Math.cos(car.angle), fy = Math.sin(car.angle);
  let best = 0;
  for (const o of cars) {
    if (o === car || o.gone || Math.cos(o.angle - car.angle) < 0.9) continue; // la estela va para donde va el otro
    const dx = (o.x - car.x) * meters, dy = (o.y - car.y) * meters;
    const ahead = dx * fx + dy * fy, side = Math.abs(-dx * fy + dy * fx);
    if (ahead < 3 || ahead > DRAFT_DIST || side > DRAFT_WIDTH) continue;
    best = Math.max(best, (1 - ahead / DRAFT_DIST) ** 2 * (1 - side / DRAFT_WIDTH));
  }
  return best;
}

// un pedal: true/false del teclado o 0..1 de un joystick
function pedal(x) {
  return Math.max(0, Math.min(1, +x || 0));
}

// Los límites de un auto con la puesta a punto y el aire de un circuito (para la trazada, antes de largar)
export const limitsOn = (profile, track) => carLimits(profile, track.tune ?? DEFAULT_TUNE, track.air ?? SEA_AIR);

// Interpola una tabla [[x, y], ...] ordenada por x; fuera del rango usa el extremo
export function lookup(rows, x) {
  if (x <= rows[0][0]) return rows[0][1];
  for (let i = 1; i < rows.length; i++) {
    if (x <= rows[i][0]) {
      const [x0, y0] = rows[i - 1], [x1, y1] = rows[i];
      return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
    }
  }
  return rows[rows.length - 1][1];
}

export class Car {
  constructor(x, y, angle, profile = DEFAULT_PROFILE) {
    this.x = x;
    this.y = y;
    this.angle = angle;
    this.profile = profile;
    this.speed = 0;
    this.steer = 0; // -1..1 suavizado, para animar el auto
    this.draft = 0; // la estela del de adelante, 0..1 (la calcula el juego con slipstream antes de cada update)
    this.fuel = 0; // kg de nafta encima
    this.fuelFlow = FUEL_FLOW; // kg/s que gasta a fondo (0: no gasta)
    this.tyreTemp = [TYRE_START, TYRE_START, TYRE_START, TYRE_START]; // °C, por rueda (ver WHEELS)
    this.tyreWear = [0, 0, 0, 0]; // desgaste de cada goma, 0 (nueva) a 1 (gastada)
    this.locked = [false, false]; // ruedas bloqueadas, adelante y atrás
    this.wheelspin = false; // las de atrás patinando
    this.cornering = 0; // parte del agarre de costado de la cola que se usó en el paso anterior (para el control de tracción)
    this.traction = 0; // lo más que pueden empujar las de atrás en este momento (m/s²)
    this.wheels = ['road', 'road', 'road', 'road']; // qué pisa cada rueda (ver WHEELS)
    this.wheelGrip = [1, 1, 1, 1]; // agarre y freno de cada rueda según lo que pisa, cambiando de a poco
    this.wheelDrag = [0, 0, 0, 0];
    // fracción de las ruedas fuera de la pista (pasto, leca o escapatoria de asfalto; el nombre es de cuando
    // afuera había sólo pasto: lo usan el entrenamiento y la red)
    this.grass = 0;
    this.onGrass = false; // dos ruedas o más fuera de la pista
    this.rough = 0; // cuánto traquetea lo que pisan las ruedas (0 en la pista; 1 con las cuatro en el pasto)
    this.onKerb = false;
    this.onSausage = false; // alguna rueda arriba de una salchicha
    this.wheelLift = [0, 0, 0, 0]; // cuánto está levantada cada rueda por el piano o la salchicha (celdas)
    this.lift = 0; // y el auto: cuánto sube (celdas), cuánto rola (rad, +: el costado derecho sube) y cabecea
    this.liftRoll = 0; // (rad, +: la trompa baja), para dibujarlo
    this.liftDive = 0;
    this.jolt = 0; // sacudón de la salchicha (0..1, se va solo), para la cámara y el sonido
    this.bump = 0;
    this.slope = 0;
    this.slip = 0; // velocidad de costado, hacia la derecha (m/s)
    this.omega = 0; // velocidad de giro (rad/s; positiva, para la derecha)
    this.delta = 0; // ángulo de las ruedas delanteras (rad)
    this.throttle = 0; // cuánto va acelerando, 0..1 (para el sonido)
    this.brake = 0; // cuánto va frenando, 0..1
    this.aLon = 0; // aceleración de las gomas hacia adelante (m/s², suavizada): de acá sale el traslado de peso
    this.launchFactor = 1; // en la largada: qué fracción de la aceleración llega al piso
    this.launchTime = 0;
    this.launchRpm = 0;
    this.gear = 1; // 0 = marcha atrás
    this.rpm = IDLE_RPM;
    this.manual = false;
    this.tc = 0; // control de tracción (TRACTION_CONTROL): 0 = sin control
    this.tcCut = false; // si en este paso el control de tracción cortó motor
    this.abs = false; // ABS: los frenos sueltan antes de que una rueda se bloquee
    this.absCut = false; // si en este paso el ABS soltó freno
    this.brakeCap = 0; // lo más que pueden frenar las gomas en este momento (m/s²)
    this.pedalLimit = 1; // el pedal de freno (0..1) con el que se llega a ese límite
    this.setup = SAME_SETUP;
    this.tune = DEFAULT_TUNE; // puesta a punto (dynamics.js): la del circuito, salvo que tenga una propia (ownTune)
    this.ownTune = null;
    this.ownAir = null;
    this.air = SEA_AIR; // densidad del aire del circuito (kg/m³)
    this.damage = NO_DAMAGE; // lo que tiene roto (damage.js)
    this.damageLevel = 'off'; // si los golpes rompen: 'off', 'reduced' o 'real'
    this.rubber = null; // la goma sobre la pista (RubberMap de rubber.js), si la hay: cambia el agarre de cada rueda
    this.wearRate = 0; // desgaste por metro andando normal (0 = no se gastan); lo fija el juego según la carrera
  }

  // desgaste de las gomas, 0 (nuevas) a 1 (gastadas): el promedio de las cuatro (al fijarlo, las cuatro iguales)
  get wear() {
    const w = this.tyreWear;
    return (w[0] + w[1] + w[2] + w[3]) / 4;
  }
  set wear(x) {
    this.tyreWear = [x, x, x, x];
  }

  get gears() {
    return this.profile.gearKmhPerRpm.length;
  }

  // Lo que puede hacer el auto (dynamics.js) con su puesta a punto, su variación, el aire y sus daños: se
  // recalcula cuando cambia alguno (se reemplazan, no se modifican)
  get limits() {
    const c = this._limits, fuel = Math.round(this.fuel); // la nafta, de a kilo
    if (c && c.profile === this.profile && c.setup === this.setup && c.tune === this.tune && c.air === this.air && c.damage === this.damage && c.fuel === fuel) return c.lim;
    const lim = carLimits(this.profile, this.tune, this.air, this.setup, this.damage, fuel);
    this._limits = { profile: this.profile, setup: this.setup, tune: this.tune, air: this.air, damage: this.damage, fuel, lim };
    return lim;
  }

  // RPM del motor a una velocidad (m/s) en una marcha
  rpmAt(v, gear) {
    return (Math.abs(v) * 3.6) / this.profile.gearKmhPerRpm[Math.max(1, gear) - 1];
  }

  // Cambio manual: +1 sube, -1 baja. No deja bajar si el motor se pasaría de vueltas.
  // Devuelve false si el cambio no se hizo por eso.
  shift(dir) {
    if (!this.manual) return true;
    const next = Math.max(1, Math.min(this.gears, this.gear + dir));
    if (dir < 0 && this.rpmAt(this.speed, next) > this.profile.maxRpm) return false;
    this.gear = next;
    return true;
  }

  // Caja automática: sube cerca del corte y baja para mantener el motor en su mejor rango,
  // como se ve en la telemetría (después de bajar, el motor queda en ~downshiftRpm)
  autoShift(throttle) {
    const p = this.profile;
    const up = throttle ? p.maxRpm * 0.97 : p.upshiftRpm;
    if (this.gear < this.gears && this.rpmAt(this.speed, this.gear) > up) this.gear++;
    else if (this.gear > 1 && this.rpmAt(this.speed, this.gear - 1) < p.downshiftRpm) this.gear--;
  }

  // En la grilla, con el auto detenido (embrague apretado): el acelerador sólo sube las vueltas,
  // hasta un punto que depende de cuánto se lo pisa (0..1; true es a fondo)
  // En la grilla con el semáforo en rojo, como lo hace la red: up suma y down resta vueltas (cada uno de -1 a 1, en
  // línea recta: recortados en 0, con el ruido de explorar el promedio al entrenar no era lo que pedía sin ruido, y
  // aprendió a pedir de más) a las de REV_BASE, y el motor va hacia esas. Con las dos en cero, REV_BASE: así explora
  // alrededor de unas vueltas intermedias (con subir y bajar a ritmo, el ruido de un paso se compensaba con el del
  // siguiente y quedaba siempre en ralentí)
  revBy(dt, up, down) {
    const max = this.profile.maxRpm, clip = (x) => Math.max(-1, Math.min(1, +x || 0));
    const target = Math.max(IDLE_RPM, Math.min(max, REV_BASE + (REV_SPAN / 2) * (clip(up) - clip(down))));
    // en vacío y sin carga sigue casi al instante (si tardaba, el ruido de cada paso se promediaba y todas las largadas
    // salían iguales: no había de qué aprender)
    const step = REV_FOLLOW * dt;
    this.rpm = this.rpm < target ? Math.min(target, this.rpm + step) : Math.max(target, this.rpm - step);
  }

  rev(dt, throttle) {
    const max = this.profile.maxRpm, thr = pedal(throttle);
    const target = IDLE_RPM + (max - IDLE_RPM) * thr;
    if (this.rpm < target) this.rpm = Math.min(target, this.rpm + REV_RATE * (1 - 0.6 * (this.rpm / max)) * dt);
    else this.rpm = Math.max(target, this.rpm - REV_DROP * dt);
    this.throttle = thr;
  }

  // Suelta el embrague: según las rpm, cuánto de la aceleración llega al piso durante el primer segundo y medio.
  // Devuelve cómo salió: 'perfect', 'bog' (se ahogó) o 'spin' (patinó).
  launch() {
    const rpm = this.rpm, [lo, hi] = LAUNCH_WINDOW, max = this.profile.maxRpm;
    let factor = 1, kind = 'perfect';
    if (rpm < lo) {
      factor = 0.55 + 0.45 * Math.max(0, (rpm - IDLE_RPM) / (lo - IDLE_RPM));
      kind = rpm < lo - 700 ? 'bog' : 'perfect';
    } else if (rpm > hi) {
      factor = 1 - 0.35 * Math.min(1, (rpm - hi) / (max - hi));
      kind = rpm > hi + 400 ? 'spin' : 'perfect';
    }
    this.launchFactor = factor;
    this.launchTime = LAUNCH_TIME;
    this.launchRpm = rpm;
    return kind;
  }

  // El aire y la puesta a punto del circuito (track.js), o los propios si los tiene (ownAir: para entrenar la red
  // con otras alturas)
  placeOn(track) {
    this.air = this.ownAir ?? track.air ?? SEA_AIR;
    this.tune = this.ownTune ?? track.tune ?? DEFAULT_TUNE;
    return this;
  }

  update(dt, input, track) {
    const p = this.profile, M = track.meters;
    this.placeOn(track);
    this.damage = deflate(this.damage, dt);
    // abandonó: suelta todo y frena de a poco hasta quedar parado; a los PARKED segundos parado lo sacan (gone)
    if (this.damage.retired) {
      input = { throttle: 0, brake: 0.3, steer: this.steer * 0.5 };
      this.parked = Math.abs(this.speed) < 0.5 ? (this.parked ?? 0) + dt : 0;
      this.gone = this.parked > PARKED;
    }
    // qué pisa cada rueda, en su lugar (los pianos están por fuera del límite de pista: pisarlos no es ir al pasto)
    const ca0 = Math.cos(this.angle), sa0 = Math.sin(this.angle);
    const at = WHEELS.map(([f, r]) => [this.x + (ca0 * f - sa0 * r) / M, this.y + (sa0 * f + ca0 * r) / M]);
    const under = at.map(([x, y]) => edgeInfo(track, x, y));
    this.wheels = under.map((u) => u.surface);
    const surf = this.wheels.map((w) => SURFACES[w]);
    // la goma no pasa de agarrar a patinar de golpe: entra de a poco en lo que pisa
    const blend = Math.min(1, dt * SURFACE_RATE);
    // de costado, en el piano y el verde se agarra todavía menos
    const sliding = Math.min(1, Math.abs(this.slip) / SLIDE_FULL);
    // sobre el asfalto, la goma que dejaron los autos (rubber.js) agarra más; fuera de la trazada, algo menos
    const rubber = (i) => {
      if (!this.rubber || this.wheels[i] !== 'road') return 1;
      const st = stationAt(track, at[i][0], at[i][1]);
      return st < 0 ? 1 : RubberMap.gripAt(this.rubber, st, sampleField(track.lat, track.W, at[i][0], at[i][1]));
    };
    // (una rueda con la suspensión torcida o pinchada, además, agarra menos y una pinchada frena)
    surf.forEach((sf, i) => {
      const g = sf.grip * (1 - (sf.slide ?? 0) * sliding) * rubber(i);
      this.wheelGrip[i] += (g * damageGrip(this.damage, i) - this.wheelGrip[i]) * blend;
      this.wheelDrag[i] += (sf.drag + damageDrag(this.damage, i) - this.wheelDrag[i]) * blend;
    });
    const wg = this.wheelGrip;
    this.grass = surf.filter((sf) => sf.out).length / 4;
    this.rough = surf.reduce((a, sf) => a + sf.rough, 0) / 4;
    this.onGrass = this.grass >= 0.5;
    this.onKerb = this.wheels.includes('kerb');
    // cuánto levantan al auto el piano y la salchicha debajo de cada rueda
    const L = (this.wheelLift = under.map((u) => u.lift));
    this.lift = (L[0] + L[1] + L[2] + L[3]) / 4;
    this.liftRoll = Math.atan((((L[1] + L[3]) - (L[0] + L[2])) / 2) * M / (WHEELS[1][1] - WHEELS[0][1]));
    this.liftDive = Math.atan((((L[2] + L[3]) - (L[0] + L[1])) / 2) * M / (WHEELS[0][0] - WHEELS[2][0]));
    // subirse a una salchicha: salto, tirón para el otro lado y, rápido, un golpe en el piso
    const onSausage = this.wheels.includes('sausage');
    const v0 = Math.abs(this.speed);
    // (una vez por salto: mientras dura el sacudón, rebotar sobre la misma salchicha no vuelve a romper)
    if (onSausage && !this.onSausage && v0 > 5 && this.jolt < 0.2) {
      this.jolt = Math.min(1, v0 / 40);
      const i = this.wheels.indexOf('sausage');
      this.omega += -Math.sign(WHEELS[i][1]) * Math.min(SAUSAGE_KICK_MAX, v0 * SAUSAGE_KICK);
      this.damage = applyHit(this.damage, 0, 0, v0 * SAUSAGE_HIT, null, this.damageLevel);
    }
    this.onSausage = onSausage;
    this.jolt = Math.max(0, this.jolt - dt * 2.5);

    const v = Math.abs(this.speed);
    // pedales y volante pueden ir a medias (joystick): 0..1 y -1..1; el teclado manda true/false
    const ease = (now, target, rise) => now + Math.max(-PEDAL_DROP * dt, Math.min(rise * dt, target - now));
    const thr = (this.throttle = ease(this.throttle, pedal(input.throttle), THROTTLE_RISE));
    const brk = (this.brake = ease(this.brake, pedal(input.brake), BRAKE_RISE));
    if (thr && this.gear === 0) this.gear = 1;
    if (this.speed >= 0 && this.gear === 0) this.gear = 1;
    if (!this.manual && this.gear > 0) this.autoShift(thr > 0.5);

    // motor: dynamics.js dice cuánto empuja a fondo con la marcha justa; con otra marcha rinde menos (pocas
    // vueltas) o nada (corte de RPM)
    let rpm = this.rpmAt(v, this.gear);
    if (this.gear <= 2 && thr) rpm = Math.max(rpm, LAUNCH_RPM);
    rpm = Math.max(rpm, IDLE_RPM);
    const limiter = rpm >= p.maxRpm;
    const power = limiter ? 0 : Math.min(1, Math.max(0.2, (rpm - 3000) / (FULL_POWER_RPM - 3000)));
    // patinando en la largada, el motor queda arriba de vueltas
    if (this.launchTime > 0 && this.launchRpm > LAUNCH_WINDOW[1] && thr) rpm = Math.max(rpm, this.launchRpm * (0.9 + 0.1 * (this.launchTime / LAUNCH_TIME)));
    this.launchTime = Math.max(0, this.launchTime - dt);
    this.rpm += (Math.min(rpm, p.maxRpm) - this.rpm) * Math.min(1, dt * 20);

    const lim = this.limits, setup = this.setup, FS = lim.frontShare;
    // el aire: en la estela de otro hay menos resistencia y menos carga; de costado, menos carga; frenando, la carga
    // se corre adelante
    const beta = v > 10 ? Math.abs(Math.atan2(this.slip, v)) : 0;
    const askew = 1 - Math.min(YAW_AERO_MAX, YAW_AERO * Math.max(0, beta - YAW_AERO_FREE));
    const pitch = Math.max(-PITCH_MAX, Math.min(PITCH_MAX, (-this.aLon / GRAVITY) * PITCH_AERO));
    const lateral = Math.abs(this.omega) * v;
    const dirty = this.draft ** DIRTY_FADE;
    const k = [(1 - DIRTY_FRONT * dirty) * askew * (1 + pitch), (1 - DIRTY_REAR * dirty) * askew * (1 - pitch)];
    const airDrag = lim.drag(v) * (1 - this.draft * DRAFT_DRAG);
    // sin pedales frenan el aire, la rodadura y el freno motor
    const losses = lim.coast(v) - lim.drag(v) + airDrag;

    // Las gomas. Agarre de cada eje (dynamics.js: carga aerodinámica, alerones, balance; con daño de un lado,
    // depende de para dónde dobla): doblando al límite y en recta (para frenar y empujar)
    const side = Math.abs(this.omega) > 0.05 ? Math.sign(this.omega * Math.sign(this.speed || 1)) : 0;
    const [axleF, axleR] = lim.axles(v, side, k);
    const [longF, longR] = lim.straight(v, k);
    const grip = lim.lateral(v); // el del auto entero con aire limpio: lo que aguanta el eje que menos agarra
    // carga sobre las gomas (por kg): el peso más la carga aerodinámica
    const load = GRAVITY * lim.load(v, k);
    // en una curva la rueda de afuera lleva más carga (outer: su parte de la del eje): pesa más lo que pisa, su
    // temperatura y su desgaste, y es la que más se calienta y se gasta. o: el lado de afuera (0 izquierda)
    const o = side > 0 ? 0 : 1;
    const outer = side ? 0.5 + 0.5 * Math.min(1, (2 * lateral * CG_HEIGHT) / (TRACK_WIDTH * load)) : 0.5;
    const tyre = (i) => tempGrip(this.tyreTemp[i]) * wearGrip(this.tyreWear[i]);
    const pair = (f, i) => outer * f(i + o) + (1 - outer) * f(i + 1 - o);
    const tyreF = pair(tyre, 0), tyreR = pair(tyre, 2);
    const frontSurf = pair((i) => wg[i], 0), rearSurf = pair((i) => wg[i], 2);
    // traslado de peso: qué parte pasa adelante (frenando) o atrás (acelerando), y cuánto agarra cada eje con esa
    // carga (cada kilo de más agarra un poco menos)
    const shift = weightShift(this.aLon, load);
    const frontLoad = ((FS + shift) / FS) ** lim.loadExp;
    const rearLoad = ((1 - FS - shift) / (1 - FS)) ** lim.loadExp;
    // lo más que puede frenar cada eje y empujar el trasero en este momento (m/s² de todo el auto)
    const loadF = longF * FS * frontLoad, loadR = longR * (1 - FS) * rearLoad;
    const capF = lim.longBrake * loadF * frontSurf * tyreF, capR = lim.longBrake * loadR * rearSurf * tyreR;
    const traction = (this.traction = lim.longDrive * loadR * rearSurf * tyreR);

    let drive = 0, braking = 0; // lo que empujan y frenan las gomas (m/s²), para el balance
    let useF = 0, useR = 0; // parte del agarre de cada eje que se va en frenar o empujar
    let lockF = false, lockR = false, spin = false;
    let forceF = 0, forceR = 0; // lo que frenan las de adelante y lo que frenan o empujan las de atrás (m/s²)
    if (this.speed < 0 || (brk && !thr && this.speed <= 0.5)) {
      // marcha atrás: el freno empuja para atrás; el acelerador primero frena
      if (thr) this.speed += lim.accel(v) * thr * dt;
      else if (brk) {
        this.gear = 0;
        this.speed = Math.max(-REVERSE_MAX, this.speed - REVERSE_ACCEL * brk * dt);
      } else this.speed = Math.min(0, this.speed + losses * dt);
    } else {
      // a fondo, todo lo que empuja el motor (cerca de la velocidad punta el aire se lo come todo); a medias, una
      // parte. El motor puede más que las gomas hasta bien entrada la 4ª: sin control de tracción hay que dosificar
      const full = this.speed < Math.max(surf[2].maxSpeed, surf[3].maxSpeed) ? lim.engine(v) * power : 0;
      // acelerando, el motor no frena: el pie levanta el freno motor (con el pie a fondo, todo)
      drive = thr * (full + lim.coast(v) - lim.drag(v) - lim.rolling);
      // en la largada, si se ahogó o patina, llega menos aceleración al piso
      if (this.launchTime > 0) drive = Math.min(drive, this.launchFactor * lim.traction(v, k));
      // el control de tracción corta lo que la cola no puede empujar sin soltarse: de su agarre, lo que no usó para
      // doblar en el paso anterior
      const tcCap = Math.max(TC_FLOOR, Math.sqrt(Math.max(0, this.tc ** 2 - this.cornering ** 2))) * traction;
      this.tcCut = this.tc > 0 && drive > tcCap;
      if (this.tcCut) drive = tcCap;
      // frenada: el pedal manda la fuerza de los frenos, de nada a lim.brakeMax (lo que aguantan las gomas a la
      // velocidad punta), repartida entre los ejes. Lo que aguantan las gomas en cada momento (brakeCap) depende de la
      // carga (menos a menos velocidad, en el aire sucio de otro o mientras el peso no pasó adelante), de lo que pisan
      // y de cómo están: pedir más que eso las bloquea. pedalLimit: el pedal que llega justo a ese límite
      const bias = brakeBias(loadF, loadR, lim.brakeFwd);
      const extra = lim.drag(v) + lim.rolling - losses;
      this.brakeCap = Math.min(capF / bias, capR / (1 - bias));
      this.pedalLimit = Math.min(1, Math.max(0, this.brakeCap / Math.max(lim.brakeMax + extra, 1e-6)));
      braking = brk * Math.max(0, lim.brakeMax + extra);
      // ABS: suelta freno (de los dos ejes) para que ninguno pase de ABS_USE de su agarre
      this.absCut = this.abs && braking > ABS_USE * this.brakeCap;
      if (this.absCut) braking = ABS_USE * this.brakeCap;
      let brakeF = braking * bias;
      let rear = drive - (braking - brakeF); // lo que hacen las de atrás: empujar (+) o frenar (-)
      const over = (use, was) => use > 1 || (was && use > LONG_RELEASE);
      useF = brakeF / Math.max(capF, 1e-6);
      lockF = brakeF > 0 && over(useF, this.locked[0]);
      if (lockF) brakeF = LONG_SLIDE * capF;
      if (rear < 0) {
        useR = -rear / Math.max(capR, 1e-6);
        lockR = over(useR, this.locked[1]);
        if (lockR) rear = -LONG_SLIDE * capR;
      } else {
        useR = rear / Math.max(traction, 1e-6);
        spin = rear > 0 && over(useR, this.wheelspin);
        if (spin) rear = LONG_SLIDE * traction;
      }
      forceF = brakeF;
      forceR = Math.abs(rear);
      braking = brakeF + Math.max(0, -rear);
      drive = Math.max(0, rear);
      this.speed = Math.max(0, this.speed + (drive - losses - braking) * dt);
    }
    if (!braking) this.absCut = false;
    this.locked = [lockF, lockR];
    this.wheelspin = spin;
    if (this.fuel > 0) this.fuel = Math.max(0, this.fuel - this.fuelFlow * thr * dt);
    // el peso se pasa según lo que empujan o frenan las gomas, con un poco de demora
    this.aLon += (drive - braking - this.aLon) * Math.min(1, dt * TRANSFER_RATE);

    // pendiente en la dirección de marcha (suavizada): la gravedad frena en subida y empuja en bajada
    const fx = Math.cos(this.angle), fy = Math.sin(this.angle);
    const ahead = sampleField(track.height, track.W, this.x + fx * 1.5, this.y + fy * 1.5);
    const behind = sampleField(track.height, track.W, this.x - fx * 1.5, this.y - fy * 1.5);
    this.slope += ((ahead - behind) / 3 - this.slope) * Math.min(1, dt * 8);
    this.speed -= GRAVITY * this.slope * dt;

    // cada rueda frena según lo que pisa (el pasto, mucho); si de un lado frena más, el auto tira para ese lado
    let drag = 0, pull = 0;
    if (Math.abs(this.speed) > DRAG_FROM) {
      this.wheelDrag.forEach((d, i) => { drag += d; pull += Math.sign(WHEELS[i][1]) * d; });
      this.speed -= Math.sign(this.speed) * Math.min(Math.abs(this.speed), drag * dt);
    }

    const sp = Math.abs(this.speed);
    // lo que agarra de costado cada eje (m/s² por kilo sobre el eje): con su carga, lo que pisa, cómo están sus gomas
    // y lo que le queda después de frenar o empujar (círculo de fricción); bloqueado o patinando, casi nada
    const left = (use, sliding) => (sliding ? SLIDING_SIDE : Math.sqrt(1 - Math.min(1, use) ** 2));
    const front = axleF * tyreF * frontSurf * frontLoad * left(useF, lockF);
    const rearSteady = axleR * tyreR * rearSurf * rearLoad; // lo que agarra la cola sin frenar ni empujar
    const rear = rearSteady * left(useR, lockR || spin);
    this.grip = [front / grip, rear / grip]; // para mostrarlo o probarlo: 1 es lo que agarra en régimen

    // volante: con una suspensión de adelante torcida, la dirección tira para ese lado
    const target = Math.max(-1, Math.min(1, (+input.steer || 0) + steerPull(this.damage)));
    this.steer += (target - this.steer) * Math.min(1, dt * 10);
    // ángulo de las ruedas: con el volante a fondo, lo justo para doblar lo que agarra en este momento el eje que
    // menos agarra (steerLock)
    const delta = (this.delta = this.steer * steerLock(sp, lim, Math.min(front, rear * REAR_MARGIN)));
    const cd = Math.cos(delta), sd = Math.sin(delta);
    // lo que puede empujar de costado cada eje (m/s² de todo el auto) y a qué distancia está del centro de gravedad
    const gripF = FS * front, gripR = (1 - FS) * rear * REAR_MARGIN;
    const A = WHEELBASE * (1 - FS), B = WHEELBASE * FS;
    // una rueda que frena más que la del otro lado (en el pasto) hace girar el auto para ese lado
    const pullYaw = WHEEL_SIDE * pull * Math.sign(this.speed);
    // fuerza de costado de un eje (m/s² de todo el auto): según su deriva (velocidad de costado sobre la de
    // marcha de la goma), pero sin pasarse de lo que frenaría del todo ese deslizamiento en un paso (k: cuánto
    // cambia la velocidad de costado del eje por cada m/s² que empuja ahí, contando el giro que provoca)
    const h = dt / SUBSTEPS;
    const axle = (across, along, most, kk) => {
      const f = -most * tyreCurve(across / (PEAK_SLIP * Math.max(Math.abs(along), SLIP_SPEED)), SLIDE);
      const cap = (SETTLE * Math.abs(across)) / (h * kk);
      return Math.max(-cap, Math.min(cap, f));
    };
    const kF = 1 + (A * A) / YAW_K2, kR = 1 + (B * B) / YAW_K2;
    let lastR = 0, lastSlipR = 0, heatF = 0, heatR = 0;
    for (let i = 0; i < SUBSTEPS; i++) {
      // velocidad de costado de cada eje: la del auto más la que le da el giro (adelante suma, atrás resta);
      // la delantera, medida según para dónde apuntan las ruedas
      const sideF = this.slip + A * this.omega, sideR = this.slip - B * this.omega;
      const acrossF = sideF * cd - this.speed * sd;
      const fF = axle(acrossF, this.speed * cd + sideF * sd, gripF, kF);
      const fR = axle(sideR, this.speed, gripR, kR);
      lastR = fR;
      lastSlipR = sideR / (PEAK_SLIP * Math.max(Math.abs(this.speed), SLIP_SPEED));
      // lo que se calientan: la fuerza de costado por la velocidad a la que la goma desliza de costado
      heatF += Math.abs(fF * acrossF);
      heatR += Math.abs(fR * sideR);
      // lo que empujan las gomas, en el marco del auto (las delanteras dobladas también frenan un poco), y el giro
      // del auto: la velocidad gira al revés en su marco (lo que era de costado pasa a ser de marcha y al revés)
      const ax = -fF * sd, ay = fF * cd + fR, vx = this.speed;
      this.speed += (ax + this.slip * this.omega) * h;
      this.slip += (ay - vx * this.omega) * h;
      this.omega += ((A * fF * cd - B * fR + pullYaw) / YAW_K2) * h;
      this.angle += this.omega * h;
      const ca = Math.cos(this.angle), sa = Math.sin(this.angle);
      this.x += ((ca * this.speed - sa * this.slip) * h) / M;
      this.y += ((sa * this.speed + ca * this.slip) * h) / M;
    }
    // para el control de tracción del paso siguiente: qué parte del agarre de la cola (sin empujar) se fue en doblar;
    // con la cola pasada del pico (deslizando), toda
    this.cornering = Math.abs(lastSlipR) > 1 ? 1 : Math.min(1, Math.abs(lastR) / Math.max((1 - FS) * rearSteady * REAR_MARGIN, 1e-6));

    // temperatura: cada eje se calienta con lo que desliza de costado (más la rueda de afuera) y a lo largo (frenando
    // o empujando: poco si agarra, mucho bloqueado o patinando), y cada rueda con lo que rueda cargada
    const slideF = lockF ? v : LONG_SLIP * v, slideR = lockR ? v : LONG_SLIP * v + (spin ? SPIN_SPEED : 0);
    const axleLoad = lim.loads(v, k), cool = COOL + COOL_SPEED * sp;
    const share = (i) => (i % 2 === o ? outer : 1 - outer);
    const keep = HEAT_SPEED / (HEAT_SPEED + sp);
    const work = [0, 1, 2, 3].map((i) => keep * (i < 2 ? (heatF / SUBSTEPS) * share(i) + (forceF * slideF) / 2 : (heatR / SUBSTEPS) * share(i) + (forceR * slideR) / 2));
    const temp = this.tyreTemp;
    for (let i = 0; i < 4; i++) {
      temp[i] += (HEAT * work[i] + ROLL_HEAT * sp * axleLoad[i >> 1] * 2 * share(i) - cool * (temp[i] - TRACK_TEMP)) * dt;
    }
    // desgaste: cuánto se exige el agarre (doblar + empujar o frenar, sobre lo que agarran) y el deslizamiento; de
    // las cuatro, se gasta más la que más trabaja, la que pisa algo abrasivo, la recalentada y la bloqueada
    if (this.wearRate) {
      const whole = (grip * (frontSurf + rearSurf)) / 2;
      const use = (sp * Math.abs(this.omega) + Math.abs(this.aLon)) / whole + Math.abs(this.slip) / 5;
      const base = this.wearRate * setup.wear * (WEAR_BASE + WEAR_USE * (1 - WEAR_BASE) * use) * sp * dt;
      const mean = (work[0] + work[1] + work[2] + work[3]) / 4, wear = this.tyreWear;
      for (let i = 0; i < 4; i++) {
        const hot = 1 + HOT_WEAR * Math.max(0, (temp[i] - TEMP_HIGH) / HOT_SPAN);
        const flat = this.locked[i >> 1] ? this.wearRate * LOCK_WEAR * sp * dt : 0;
        wear[i] = Math.min(1, wear[i] + base * (surf[i].wear ?? 1) * (mean > 1e-6 ? 0.5 + (0.5 * work[i]) / mean : 1) * hot + flat);
      }
    }

    // choques contra los muros
    this.bump = Math.max(0, this.bump - dt * 3);
    collideWalls(this, track);
  }
}

// ¿Un círculo de radio r (en celdas) centrado en (x, y) toca el muro?
// El muro empieza a `runoff` celdas del borde de la pista; como sdf es continuo, el muro es liso.
export function isSolid(track, x, y, r = 0) {
  if (x < 2 || y < 2 || x >= track.W - 2 || y >= track.H - 2) return true;
  return sampleField(track.sdf, track.W, x, y) < -track.runoff + r;
}
