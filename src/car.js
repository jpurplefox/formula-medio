// Física del auto, en unidades reales: la velocidad va en m/s y las aceleraciones en m/s².
// La posición va en celdas del mapa; track.meters dice cuántos metros mide una celda.
// Lo que puede hacer el auto (agarre de cada eje, frenada, empuje del motor, resistencia del aire) sale de
// dynamics.js, con los números de cars/*.json, la puesta a punto (alerones y balance) y el aire del circuito.
// Acá está lo que pasa en cada instante: pedales, marchas, traslado de peso, la cola que se abre, golpes, pasto y
// daños (damage.js: lo que se rompe en los choques de collision.js).

import { edgeInfo, sampleField, stationAt } from './track.js';
import { RubberMap } from './rubber.js';
import { collideWalls } from './collision.js';
import { carLimits, DEFAULT_TUNE, GRAVITY, SEA_AIR } from './dynamics.js';
import { applyHit, deflate, NO_DAMAGE, steerPull, wheelDrag as damageDrag, wheelGrip as damageGrip } from './damage.js';

// Auto por defecto, por si no se carga uno (como cars/f1-2025.json)
export const DEFAULT_PROFILE = {
  maxRpm: 11985,
  upshiftRpm: 10845,
  downshiftRpm: 10522,
  gearKmhPerRpm: [0.00954, 0.01137, 0.01354, 0.01613, 0.01896, 0.02184, 0.02501, 0.02828],
  mass: 810,
  frontShare: 0.445,
  mu: 2.2,
  loadExp: 0.85,
  brakeMu: 0.95,
  tractionMu: 0.95,
  balanceRange: 0.06,
  power: 621600,
  engineBrake: 2.6,
  rolling: 0.15,
  aero: { clMin: 3.511, clMax: 5.091, frontWing: 0.4, ldFront: 8, ldRear: 1.896, cdBody: 1.092 },
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
const PULL = 0.006; // giro (rad/s) por cada m/s² que una rueda frena más que la del otro lado
const SURFACE_RATE = 5; // 1/s: al cambiar de superficie, el agarre y el freno de la rueda cambian en ~0,2 s
// dónde apoya cada rueda, en m desde el centro del auto (adelante, a la derecha), como en carmodel.js:
// delantera izquierda, delantera derecha, trasera izquierda, trasera derecha
export const WHEELS = [[1.65, -0.8], [1.65, 0.8], [-1.7, -0.79], [-1.7, 0.79]];
const REVERSE_MAX = 8;
const REVERSE_ACCEL = 5;
const MAX_YAW = 1.6; // rad/s: giro máximo a baja velocidad
const WHEELBASE = 3.35; // m, entre los ejes (como en carmodel.js)
const MAX_WHEEL_ANGLE = 0.35; // rad: lo más que doblan las ruedas delanteras, a paso de hombre
const MIN_WHEEL_ANGLE = 0.05; // rad: aun a fondo se ve que doblan un poco
// rebufo: detrás de otro auto el aire llega frenado y hay menos resistencia
const DRAFT_DIST = 45; // m: hasta dónde se siente
const DRAFT_WIDTH = 1.6; // m de costado: el ancho de la estela
const DRAFT_DRAG = 0.3; // fracción de la resistencia del aire que se ahorra pegado al de adelante
const SLIP_GRIP = 0.8; // las gomas frenan el deslizamiento de costado con esta fracción de su agarre
const SLIP_LEFT = 0.15; // aunque estén doblando al límite, con al menos esta parte
const SPIN_DAMP = 7; // y el giro que dejan los golpes, a este ritmo (rad/s²; en el pasto, la mitad)
const SPIN_GRIP = 0.25; // más esta fracción del agarre: a más velocidad, las gomas enderezan antes el auto
// traslado de peso: al frenar el peso se pasa adelante y al acelerar, atrás; cada eje agarra según la carga que
// tiene y lo que le queda después de frenar o traccionar (círculo de fricción). En una curva sin pedales da lo que
// dice dynamics.js; frenando fuerte la cola queda liviana y se abre, y a fondo en una curva lenta también.
const CG_H = 0.25; // m: altura del centro de gravedad
const MAX_SHIFT = 0.07; // lo más que se pasa de un eje al otro (fracción del peso)
const LOAD_EXP = 0.8; // el doble de carga da 2^0,8 = 1,74 veces el agarre: al pasarse el peso se pierde agarre
const BRAKE_USE = 0.7; // frenando a fondo, qué parte del agarre de las gomas se va en frenar
const LONG_GRIP = 1.25; // las gomas agarran más para empujar o frenar que de costado: empujando a fondo en recta
// usan 3/4 de su agarre (la tracción de dynamics.js), y lo que queda alcanza para doblar con cuidado
const TRANSFER_RATE = 10; // 1/s: el peso tarda un instante en pasarse (lo frena la suspensión)
// el pie no llega a fondo de golpe: con teclado (todo o nada) el acelerador tarda un instante en abrirse, así
// pisar en plena curva no suelta la cola de un saque (con joystick casi no se nota: va siguiendo al gatillo)
const THROTTLE_RISE = 3; // 1/s: de nada a fondo en 1/3 s
const BRAKE_RISE = 10; // 1/s
const PEDAL_DROP = 12; // 1/s: soltar es rápido
const OVERSTEER = 2.5; // cuánto más gira el auto cuando a la cola le falta agarre (1 = lo justo que le falta)
const LOOSE_RATE = 4; // 1/s: qué tan rápido se abre la cola
const LOOSE_SLIP = 0.25; // con la cola suelta, las gomas frenan el deslizamiento de costado mucho menos
const REAR_HOLD = 1.05; // hasta cuánto más de lo que agarra la cola puede doblar el auto (cruzándose)
const SCRUB = 0.5; // y las de atrás, arrastrándose de costado, frenan el auto: esta parte de lo que les falta
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
// desgaste de las gomas: se gastan al andar, más cuanto más se exige su agarre (doblando, frenando, acelerando,
// deslizando); gastadas del todo agarran y frenan WEAR_GRIP menos
const WEAR_GRIP = 0.08;
const WEAR_BASE = 0.3; // parte del desgaste que es sólo por andar, aunque sea derecho y suave
const WEAR_USE = 1.33; // la otra parte se escala para que una vuelta normal promedie 1 (medido con rl/wear.js)

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

// Ángulo de las ruedas delanteras para dibujarlas: el que hace doblar al auto lo que de verdad dobla
// (ángulo ≈ distancia entre ejes × giro / velocidad). A baja velocidad doblan mucho; a fondo, apenas.
export function wheelAngle(steer, speed, limits) {
  const sp = Math.max(4, Math.abs(speed)); // parado o casi, como a paso de hombre: con todo el giro
  const a = Math.atan((WHEELBASE * yawRate(sp, limits.lateral(sp))) / sp);
  return steer * Math.max(MIN_WHEEL_ANGLE, Math.min(MAX_WHEEL_ANGLE, a));
}

// Rebufo de car (0..1) por los autos que tiene adelante: más cuanto más cerca y más alineado con la estela.
// meters: metros por celda del circuito.
export function slipstream(car, cars, meters) {
  const fx = Math.cos(car.angle), fy = Math.sin(car.angle);
  let best = 0;
  for (const o of cars) {
    if (o === car || Math.cos(o.angle - car.angle) < 0.9) continue; // la estela va para donde va el otro
    const dx = (o.x - car.x) * meters, dy = (o.y - car.y) * meters;
    const ahead = dx * fx + dy * fy, side = Math.abs(-dx * fy + dy * fx);
    if (ahead < 3 || ahead > DRAFT_DIST || side > DRAFT_WIDTH) continue;
    best = Math.max(best, (1 - ahead / DRAFT_DIST) * (1 - side / DRAFT_WIDTH));
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
    this.draft = 0; // rebufo, 0..1 (lo calcula el juego con slipstream antes de cada update)
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
    this.slip = 0; // velocidad de costado, hacia la derecha (m/s): la dejan los golpes y se va con el agarre
    this.spin = 0; // giro que dejan los golpes (rad/s), aparte del que da el volante
    this.omega = 0; // giro total en este momento (rad/s)
    this.throttle = 0; // cuánto va acelerando, 0..1 (para el sonido)
    this.brake = 0; // cuánto va frenando, 0..1
    this.aLon = 0; // aceleración de las gomas hacia adelante (m/s², suavizada): de acá sale el traslado de peso
    this.launchFactor = 1; // en la largada: qué fracción de la aceleración llega al piso
    this.launchTime = 0;
    this.launchRpm = 0;
    this.gear = 1; // 0 = marcha atrás
    this.rpm = IDLE_RPM;
    this.manual = false;
    this.setup = SAME_SETUP;
    this.tune = DEFAULT_TUNE; // puesta a punto (dynamics.js): la del circuito, salvo que tenga una propia (ownTune)
    this.ownTune = null;
    this.ownAir = null;
    this.air = SEA_AIR; // densidad del aire del circuito (kg/m³)
    this.damage = NO_DAMAGE; // lo que tiene roto (damage.js)
    this.damageLevel = 'off'; // si los golpes rompen: 'off', 'reduced' o 'real'
    this.rubber = null; // la goma sobre la pista (RubberMap de rubber.js), si la hay: cambia el agarre de cada rueda
    this.wear = 0; // desgaste de las gomas, 0 (nuevas) a 1 (gastadas)
    this.wearRate = 0; // desgaste por metro andando normal (0 = no se gastan); lo fija el juego según la carrera
  }

  get gears() {
    return this.profile.gearKmhPerRpm.length;
  }

  // Lo que puede hacer el auto (dynamics.js) con su puesta a punto, su variación, el aire y sus daños: se
  // recalcula cuando cambia alguno (se reemplazan, no se modifican)
  get limits() {
    const c = this._limits;
    if (c && c.profile === this.profile && c.setup === this.setup && c.tune === this.tune && c.air === this.air && c.damage === this.damage) return c.lim;
    const lim = carLimits(this.profile, this.tune, this.air, this.setup, this.damage);
    this._limits = { profile: this.profile, setup: this.setup, tune: this.tune, air: this.air, damage: this.damage, lim };
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
    this.surfaceWear = surf.reduce((a, sf) => a + (sf.wear ?? 1), 0) / 4;
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
      this.spin += -Math.sign(WHEELS[i][1]) * Math.min(SAUSAGE_KICK_MAX, v0 * SAUSAGE_KICK);
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

    // sin pedales frenan el aire, la rodadura y el freno motor (en el rebufo, menos aire)
    const lim = this.limits, setup = this.setup, tyres = 1 - WEAR_GRIP * this.wear;
    const losses = lim.coast(v) - this.draft * DRAFT_DRAG * lim.drag(v);
    let drive = 0, braking = 0; // lo que empujan y frenan las gomas (m/s²), para el balance
    if (this.speed < 0 || (brk && !thr && this.speed <= 0.5)) {
      // marcha atrás: el freno empuja para atrás; el acelerador primero frena
      if (thr) this.speed += lim.accel(v) * thr * dt;
      else if (brk) {
        this.gear = 0;
        this.speed = Math.max(-REVERSE_MAX, this.speed - REVERSE_ACCEL * brk * dt);
      } else this.speed = Math.min(0, this.speed + losses * dt);
    } else {
      // a fondo, todo el empuje del motor (hasta lo que da la tracción); a medias, una parte. Cerca de la
      // velocidad punta el aire se come todo el empuje (en el rebufo, menos aire: más punta)
      // en la largada, si se ahogó o patina, llega menos aceleración al piso
      const launch = this.launchTime > 0 ? this.launchFactor : 1;
      const full = this.speed < Math.max(surf[2].maxSpeed, surf[3].maxSpeed) ? lim.thrust(v) * power * launch : 0;
      // acelerando, el motor no frena: el pie levanta el freno motor (con el pie a fondo, todo)
      drive = thr * (full + lim.coast(v) - lim.drag(v) - lim.rolling);
      // frenada: lo que agarran las gomas (más a más velocidad, por la carga aerodinámica) más el aire
      braking = brk * Math.max(0, lim.brake(v) * tyres + lim.drag(v) + lim.rolling - losses);
      this.speed = Math.max(0, this.speed + (drive - losses - braking) * dt);
    }
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
    // agarre lateral de cada eje con el auto en régimen (dynamics.js: carga aerodinámica, alerones, balance; con
    // daño de un lado, depende de para dónde dobla)
    const side = Math.abs(this.omega) > 0.05 ? Math.sign(this.omega * Math.sign(this.speed || 1)) : 0;
    const [axleF, axleR] = lim.axles(sp, side);
    const grip = Math.min(axleF, axleR) * tyres; // el del auto entero: lo que aguanta el eje que menos agarra
    // carga sobre las gomas (por kg): el peso más la carga aerodinámica
    const load = GRAVITY * lim.load(sp);
    // cada eje agarra según lo que pisan sus dos ruedas
    const frontSurf = (wg[0] + wg[1]) / 2, rearSurf = (wg[2] + wg[3]) / 2;
    // balance: qué parte del peso pasa adelante (frenando) o atrás (acelerando), y cuánto agarra cada eje
    // para doblar con esa carga y lo que le queda después de frenar o empujar
    const FS = lim.frontShare;
    const shift = Math.max(-MAX_SHIFT, Math.min(MAX_SHIFT, (-this.aLon * CG_H) / (WHEELBASE * load)));
    const usage = (x) => Math.sqrt(1 - Math.min(1, x) ** 2);
    const frontLoad = ((FS + shift) / FS) ** LOAD_EXP;
    const rearLoad = ((1 - FS - shift) / (1 - FS)) ** LOAD_EXP;
    // los frenos reparten la fuerza según la carga de cada eje, así que el eje cargado la aguanta mejor
    // (con LOAD_EXP < 1, apenas); el empuje del motor va todo a las de atrás
    const braked = braking > 0 ? brk * BRAKE_USE : 0;
    const front = axleF * tyres * frontSurf * frontLoad * usage(braked * frontLoad ** (1 / LOAD_EXP - 1));
    // lo que pueden empujar las traseras sobre lo que pisan (m/s² de todo el auto)
    const traction = axleR * tyres * rearSurf * (1 - FS) * LONG_GRIP;
    const rearSteady = axleR * tyres * rearSurf; // lo que agarra la cola sin frenar ni empujar
    const rear = rearSteady * rearLoad * usage(braked * rearLoad ** (1 / LOAD_EXP - 1) + drive / traction / rearLoad);
    this.grip = [front / grip, rear / grip]; // para mostrarlo o probarlo: 1 es lo que agarra en régimen

    // dirección: el giro está limitado por lo que agarran las gomas de adelante (v²/r ≤ agarre), que crece con
    // la velocidad por la carga aerodinámica; aun así, a más velocidad las curvas se abren
    // con una suspensión de adelante torcida, la dirección tira para ese lado
    const target = Math.max(-1, Math.min(1, (+input.steer || 0) + steerPull(this.damage)));
    this.steer += (target - this.steer) * Math.min(1, dt * 10);
    // y también por las de atrás: la curva la tienen que sostener los dos ejes. La cola puede pasarse apenas
    // (REAR_HOLD), pero no doblar como si agarrara de más (un alerón trasero roto o una puesta muy sobrevirante
    // hacen más lentas las curvas). Lo que la cola gasta frenando o empujando no achica la curva: la abre (abajo)
    const dir = Math.sign(this.speed || 1);
    const steerYaw = this.steer * yawRate(sp, Math.min(front, rearSteady * REAR_HOLD)) * dir;
    // si la cola no alcanza a sostener la curva que pide el volante, se abre: el auto gira sobre sí mismo más de
    // lo que dobla (contravolanteando o levantando el pie, la cola vuelve a agarrar)
    const loose = Math.max(0, sp * Math.abs(this.steer * yawRate(sp, front)) - rear);
    this.speed -= Math.sign(this.speed) * Math.min(Math.abs(this.speed), SCRUB * loose * dt);
    if (loose > 0) this.spin += ((Math.sign(steerYaw) * loose * OVERSTEER) / Math.max(sp, 1) - this.spin) * Math.min(1, dt * LOOSE_RATE);
    // con el volante la velocidad dobla junto con el auto; el giro de un golpe, en cambio, hace girar el auto
    // pero la velocidad sigue para donde iba: esa diferencia queda como deslizamiento de costado
    const turn = this.spin * dt, c = Math.cos(turn), s = Math.sin(turn);
    [this.speed, this.slip] = [this.speed * c + this.slip * s, -this.speed * s + this.slip * c];
    this.omega = steerYaw + this.spin + pull * PULL * Math.sign(this.speed);
    this.angle += this.omega * dt;
    // las gomas frenan el deslizamiento y el giro; mientras la cola está suelta, el giro no y el deslizamiento
    // apenas: el auto queda cruzado y la trompa apunta más adentro de lo que va
    const settle = (value, rate) => value - Math.sign(value) * Math.min(Math.abs(value), rate * dt);
    // el agarre de todo el auto, para el deslizamiento, el giro de los golpes y el desgaste
    const allSurf = (frontSurf + rearSurf) / 2, whole = grip * allSurf;
    // desgaste: cuánto se exige el agarre (doblar + empujar o frenar, sobre lo que agarran) y el deslizamiento
    if (this.wearRate) {
      const use = (sp * Math.abs(this.omega) + Math.abs(this.aLon)) / whole + Math.abs(this.slip) / 5;
      this.wear = Math.min(1, this.wear + this.wearRate * setup.wear * (this.surfaceWear ?? 1) * (WEAR_BASE + WEAR_USE * (1 - WEAR_BASE) * use) * sp * dt);
    }
    // el deslizamiento lo frena lo que le sobra a las gomas después de doblar (círculo de fricción): doblando al
    // límite, el auto se sigue abriendo (siempre un poco, así un deslizamiento termina)
    const left = Math.max(SLIP_LEFT * whole, whole - sp * Math.abs(steerYaw));
    this.slip = settle(this.slip, left * SLIP_GRIP * (loose > 0 ? LOOSE_SLIP : 1));
    this.spin = settle(this.spin, (SPIN_DAMP + whole * SPIN_GRIP) * allSurf * (loose > 0 ? 0 : 1));

    // movimiento (hacia adelante y de costado) y choques contra los muros
    const ca = Math.cos(this.angle), sa = Math.sin(this.angle);
    this.x += ((ca * this.speed - sa * this.slip) * dt) / M;
    this.y += ((sa * this.speed + ca * this.slip) * dt) / M;
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
