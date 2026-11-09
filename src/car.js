// Física del auto, en unidades reales: la velocidad va en m/s y las aceleraciones en m/s².
// La posición va en celdas del mapa; track.meters dice cuántos metros mide una celda.
// Lo que puede hacer el auto (agarre de cada eje, frenada, empuje del motor, resistencia del aire) sale de
// dynamics.js, con los números de cars/*.json, la puesta a punto (alerones y balance) y el aire del circuito.
// Acá está lo que pasa en cada instante: pedales, marchas, traslado de peso, la cola que se abre, golpes, pasto y
// daños (damage.js: lo que se rompe en los choques de collision.js).

import { sampleField, surfaceAt } from './track.js';
import { collideWalls } from './collision.js';
import { carLimits, DEFAULT_TUNE, GRAVITY, SEA_AIR, tyreCurve } from './dynamics.js';
import { deflate, NO_DAMAGE, steerPull, wheelDrag as damageDrag, wheelGrip as damageGrip } from './damage.js';

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
export const SURFACES = {
  road: { grip: 1, drag: 0, maxSpeed: Infinity },
  kerb: { grip: 1, drag: 0, maxSpeed: Infinity },
  grass: { grip: 0.6, drag: 5, maxSpeed: 25 }, // con las cuatro: 20 m/s² de freno y no pasa de ~90 km/h
};
const DRAG_FROM = 15; // m/s
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
const TC_FLOOR = 0.1; // aun con la cola al límite, deja empujar esta parte de la tracción (para no quedarse clavado)
const WHEEL_SIDE = 0.8; // m: distancia de cada rueda al centro, de costado (para el tirón de una rueda en el pasto)
// traslado de peso: al frenar el peso se pasa adelante y al acelerar, atrás; cada eje agarra según la carga que
// tiene y lo que le queda después de frenar o traccionar (círculo de fricción). En una curva sin pedales da lo que
// dice dynamics.js; frenando fuerte la cola queda liviana y se abre, y a fondo en una curva lenta también.
const CG_H = 0.25; // m: altura del centro de gravedad
const MAX_SHIFT = 0.07; // lo más que se pasa de un eje al otro (fracción del peso)
const LOAD_EXP = 0.8; // el doble de carga da 2^0,8 = 1,74 veces el agarre: al pasarse el peso se pierde agarre
const BRAKE_USE = 0.7; // frenando a fondo, qué parte del agarre de las gomas se va en frenar
const BRAKE_BIAS = 0.57; // parte de la frenada que hacen las de adelante (los equipos la corren adelante: así, frenando
// en curva, la cola no se queda sin agarre de costado)
const LONG_GRIP = 1.25; // las gomas agarran más para empujar o frenar que de costado: empujando a fondo en recta
// usan 3/4 de su agarre (la tracción de dynamics.js), y lo que queda alcanza para doblar con cuidado
const TRANSFER_RATE = 10; // 1/s: el peso tarda un instante en pasarse (lo frena la suspensión)
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
    this.grass = 0; // fracción de las ruedas en el pasto
    this.onGrass = false; // dos ruedas o más en el pasto: afuera de la pista
    this.onKerb = false;
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
    this.tcCap = Infinity; // lo más que puede empujar el motor según el control de tracción (m/s², del paso anterior)
    this.tcCut = false; // si en este paso el control de tracción cortó motor
    this.setup = SAME_SETUP;
    this.tune = DEFAULT_TUNE; // puesta a punto (dynamics.js): la del circuito, salvo que tenga una propia (ownTune)
    this.ownTune = null;
    this.ownAir = null;
    this.air = SEA_AIR; // densidad del aire del circuito (kg/m³)
    this.damage = NO_DAMAGE; // lo que tiene roto (damage.js)
    this.damageLevel = 'off'; // si los golpes rompen: 'off', 'reduced' o 'real'
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
    this.wheels = WHEELS.map(([f, r]) => surfaceAt(track, this.x + (ca0 * f - sa0 * r) / M, this.y + (sa0 * f + ca0 * r) / M));
    const surf = this.wheels.map((w) => SURFACES[w]);
    // la goma no pasa de agarrar a patinar de golpe: entra de a poco en lo que pisa
    const blend = Math.min(1, dt * SURFACE_RATE);
    // (una rueda con la suspensión torcida o pinchada, además, agarra menos y una pinchada frena)
    surf.forEach((sf, i) => {
      this.wheelGrip[i] += (sf.grip * damageGrip(this.damage, i) - this.wheelGrip[i]) * blend;
      this.wheelDrag[i] += (sf.drag + damageDrag(this.damage, i) - this.wheelDrag[i]) * blend;
    });
    const wg = this.wheelGrip;
    this.grass = this.wheels.filter((w) => w === 'grass').length / 4;
    this.onGrass = this.grass >= 0.5;
    this.onKerb = this.wheels.includes('kerb');

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
      // el control de tracción corta lo que la cola no puede empujar sin soltarse
      this.tcCut = this.tc > 0 && drive > this.tcCap;
      if (this.tcCut) drive = this.tcCap;
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
    // frenando, cada eje gasta en frenar su parte de la frenada (BRAKE_BIAS) sobre lo que agarra; el empuje del
    // motor va todo a las de atrás
    const braked = braking > 0 ? brk * BRAKE_USE : 0;
    const gripFront = FS * frontLoad, gripRear = (1 - FS) * rearLoad, gripBoth = gripFront + gripRear;
    const brakeF = (braked * BRAKE_BIAS * gripBoth) / gripFront, brakeR = (braked * (1 - BRAKE_BIAS) * gripBoth) / gripRear;
    const front = axleF * tyres * frontSurf * frontLoad * usage(brakeF);
    // lo que pueden empujar las traseras sobre lo que pisan (m/s² de todo el auto)
    const traction = axleR * tyres * rearSurf * (1 - FS) * LONG_GRIP;
    const rearSteady = axleR * tyres * rearSurf; // lo que agarra la cola sin frenar ni empujar
    const rear = rearSteady * rearLoad * usage(brakeR + drive / traction / rearLoad);
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
    const axle = (across, along, most, k) => {
      const f = -most * tyreCurve(across / (PEAK_SLIP * Math.max(Math.abs(along), SLIP_SPEED)), SLIDE);
      const cap = (SETTLE * Math.abs(across)) / (h * k);
      return Math.max(-cap, Math.min(cap, f));
    };
    const kF = 1 + (A * A) / YAW_K2, kR = 1 + (B * B) / YAW_K2;
    let lastR = 0, lastSlipR = 0;
    for (let i = 0; i < SUBSTEPS; i++) {
      // velocidad de costado de cada eje: la del auto más la que le da el giro (adelante suma, atrás resta);
      // la delantera, medida según para dónde apuntan las ruedas
      const sideF = this.slip + A * this.omega, sideR = this.slip - B * this.omega;
      const fF = axle(sideF * cd - this.speed * sd, this.speed * cd + sideF * sd, gripF, kF);
      const fR = axle(sideR, this.speed, gripR, kR);
      lastR = fR;
      lastSlipR = sideR / (PEAK_SLIP * Math.max(Math.abs(this.speed), SLIP_SPEED));
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
    // control de tracción, para el paso siguiente: qué parte del agarre de la cola (sin empujar) se va en doblar, y
    // cuánto le queda para empujar; con la cola pasada del pico (deslizando), casi nada
    if (this.tc > 0) {
      const rearAll = (1 - FS) * rearSteady * rearLoad * usage(brakeR) * REAR_MARGIN;
      const cornering = Math.abs(lastSlipR) > 1 ? 1 : Math.min(1, Math.abs(lastR) / Math.max(rearAll, 1e-6));
      const push = Math.max(TC_FLOOR, Math.sqrt(Math.max(0, this.tc ** 2 - cornering ** 2)));
      this.tcCap = push * traction * rearLoad;
    }
    // desgaste: cuánto se exige el agarre (doblar + empujar o frenar, sobre lo que agarran) y el deslizamiento
    const whole = grip * (frontSurf + rearSurf) / 2;
    if (this.wearRate) {
      const use = (sp * Math.abs(this.omega) + Math.abs(this.aLon)) / whole + Math.abs(this.slip) / 5;
      this.wear = Math.min(1, this.wear + this.wearRate * setup.wear * (WEAR_BASE + WEAR_USE * (1 - WEAR_BASE) * use) * sp * dt);
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
