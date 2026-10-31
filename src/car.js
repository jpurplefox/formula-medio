// Física del auto, en unidades reales: la velocidad va en m/s y las aceleraciones en m/s².
// La posición va en celdas del mapa; track.meters dice cuántos metros mide una celda.
// El comportamiento del auto sale de un perfil medido con telemetría real (tools/car_profile.py):
// relación de marchas, RPM, aceleración y desaceleración por velocidad, frenada y agarre lateral.

import { KERB_W, kerbAt, sampleField } from './track.js';
import { collideWalls } from './collision.js';

// Perfil por defecto, por si no se carga uno (valores parecidos a los medidos en Interlagos 2023)
export const DEFAULT_PROFILE = {
  maxRpm: 12000,
  upshiftRpm: 10850,
  downshiftRpm: 10500,
  topSpeed: 90,
  gearKmhPerRpm: [0.0095, 0.0114, 0.0135, 0.0161, 0.019, 0.0218, 0.025, 0.0283],
  accel: [[42, 13.7], [53, 11.8], [64, 6.9], [75, 3.9], [86, 1]],
  coast: [[25, 3.9], [86, 6]],
  brake: { base: 21, perV2: 0.0034 },
  lateralGrip: { base: 25.5, perV2: 0.0018 },
};

const GRASS_MAX = 25; // m/s ≈ 90 km/h
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
const DRAFT_TOP = 4; // m/s más de velocidad punta pegado al de adelante (~14 km/h)
const GRAVITY = 9.8;
const SLIP_GRIP = 0.8; // las gomas frenan el deslizamiento de costado con esta fracción de su agarre
const SPIN_DAMP = 7; // y el giro que dejan los golpes, a este ritmo (rad/s²; en el pasto, la mitad)
const SPIN_GRIP = 0.25; // más esta fracción del agarre: a más velocidad, las gomas enderezan antes el auto
// balance: al frenar el peso se pasa adelante y al acelerar, atrás; cada eje agarra según la carga que tiene
// y lo que le queda después de frenar o traccionar (círculo de fricción). En una curva sin pedales da lo mismo
// que el agarre medido; frenando fuerte la cola queda liviana y se abre, y a fondo en una curva lenta también.
const FRONT_SHARE = 0.45; // parte del peso sobre el eje delantero, con el auto quieto
const CG_H = 0.25; // m: altura del centro de gravedad
const MAX_SHIFT = 0.07; // lo más que se pasa de un eje al otro (fracción del peso)
const LOAD_EXP = 0.8; // el doble de carga da 2^0,8 = 1,74 veces el agarre: al pasarse el peso se pierde agarre
const BRAKE_USE = 0.7; // frenando a fondo, qué parte del agarre de las gomas se va en frenar
const TRACTION = 18; // m/s²: lo que pueden empujar las gomas traseras (sin carga aerodinámica)
const TRANSFER_RATE = 10; // 1/s: el peso tarda un instante en pasarse (lo frena la suspensión)
// el pie no llega a fondo de golpe: con teclado (todo o nada) el acelerador tarda un instante en abrirse, así
// pisar en plena curva no suelta la cola de un saque (con joystick casi no se nota: va siguiendo al gatillo)
const THROTTLE_RISE = 3; // 1/s: de nada a fondo en 1/3 s
const BRAKE_RISE = 10; // 1/s
const PEDAL_DROP = 12; // 1/s: soltar es rápido
const OVERSTEER = 2.5; // cuánto más gira el auto cuando a la cola le falta agarre (1 = lo justo que le falta)
const LOOSE_RATE = 4; // 1/s: qué tan rápido se abre la cola
const LOOSE_SLIP = 0.25; // con la cola suelta, las gomas frenan el deslizamiento de costado mucho menos
const IDLE_RPM = 4000;
const LAUNCH_RPM = 8000; // con el embrague patinando, en 1ª y 2ª el motor no cae de acá
const FULL_POWER_RPM = 9000; // por debajo de esto el motor rinde cada vez menos
// Largada: según las rpm al soltar el embrague, el auto sale con todo, se ahoga o patina
export const LAUNCH_WINDOW = [9500, 10500]; // rpm de la largada perfecta
const LAUNCH_TIME = 1.6; // cuánto dura el efecto de la largada (s)
const REV_RATE = 6500; // cuánto suben las rpm por segundo en punto muerto, a fondo (más lento cerca del corte)
const REV_DROP = 7000; // y cuánto bajan sin acelerar
// desgaste de las gomas: se gastan al andar, más cuanto más se exige su agarre (doblando, frenando, acelerando,
// deslizando); gastadas del todo agarran y frenan WEAR_GRIP menos
const WEAR_GRIP = 0.08;
const WEAR_BASE = 0.3; // parte del desgaste que es sólo por andar, aunque sea derecho y suave
const WEAR_USE = 1.33; // la otra parte se escala para que una vuelta normal promedie 1 (medido con rl/wear.js)

// Variación entre autos: multiplicadores sobre el auto medido (1 = igual). La red los recibe como entradas.
//   power     empuje del motor
//   topSpeed  velocidad punta (menos resistencia del aire)
//   grip      agarre lateral
//   brakes    frenada
//   wear      qué tan rápido se gastan las gomas
export const SETUP_KEYS = ['power', 'topSpeed', 'grip', 'brakes', 'wear'];
export const SAME_SETUP = Object.freeze({ power: 1, topSpeed: 1, grip: 1, brakes: 1, wear: 1 });

// Interpola una tabla [[x, y], ...] ordenada por x; fuera del rango usa el extremo
// giro del auto (rad/s) con el volante a fondo, a velocidad sp (m/s) y con ese agarre lateral (m/s²)
function yawRate(sp, grip) {
  return Math.min(MAX_YAW, grip / Math.max(sp, 1)) * Math.min(1, sp / 4);
}

// Ángulo de las ruedas delanteras para dibujarlas: el que hace doblar al auto lo que de verdad dobla
// (ángulo ≈ distancia entre ejes × giro / velocidad). A baja velocidad doblan mucho; a fondo, apenas.
export function wheelAngle(steer, speed, profile = DEFAULT_PROFILE) {
  const sp = Math.max(4, Math.abs(speed)); // parado o casi, como a paso de hombre: con todo el giro
  const grip = profile.lateralGrip.base + profile.lateralGrip.perV2 * sp * sp;
  const a = Math.atan((WHEELBASE * yawRate(sp, grip)) / sp);
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
    this.onGrass = false;
    this.onKerb = false;
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
    this.wear = 0; // desgaste de las gomas, 0 (nuevas) a 1 (gastadas)
    this.wearRate = 0; // desgaste por metro andando normal (0 = no se gastan); lo fija el juego según la carrera
  }

  get gears() {
    return this.profile.gearKmhPerRpm.length;
  }

  // RPM del motor a una velocidad (m/s) en una marcha
  // resistencia del aire a velocidad v (m/s²): crece con v²; a velocidad punta es casi toda la desaceleración
  // medida sin pedales
  drag(v) {
    const p = this.profile;
    return lookup(p.coast, p.topSpeed) * (v / p.topSpeed) ** 2;
  }

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

  update(dt, input, track) {
    const p = this.profile;
    const edge = sampleField(track.sdf, track.W, this.x, this.y);
    // los pianos están por fuera del límite de pista: pisarlos no es ir al pasto
    this.onKerb = edge < 0 && edge > -KERB_W * kerbAt(track, this.x, this.y);
    this.onGrass = edge < 0 && !this.onKerb;

    const v = Math.abs(this.speed);
    // pedales y volante pueden ir a medias (joystick): 0..1 y -1..1; el teclado manda true/false
    const ease = (now, target, rise) => now + Math.max(-PEDAL_DROP * dt, Math.min(rise * dt, target - now));
    const thr = (this.throttle = ease(this.throttle, pedal(input.throttle), THROTTLE_RISE));
    const brk = (this.brake = ease(this.brake, pedal(input.brake), BRAKE_RISE));
    if (thr && this.gear === 0) this.gear = 1;
    if (this.speed >= 0 && this.gear === 0) this.gear = 1;
    if (!this.manual && this.gear > 0) this.autoShift(thr > 0.5);

    // motor: la tabla medida dice cuánto acelera a fondo a cada velocidad con la marcha justa;
    // con otra marcha rinde menos (pocas vueltas) o nada (corte de RPM)
    let rpm = this.rpmAt(v, this.gear);
    if (this.gear <= 2 && thr) rpm = Math.max(rpm, LAUNCH_RPM);
    rpm = Math.max(rpm, IDLE_RPM);
    const limiter = rpm >= p.maxRpm;
    const power = limiter ? 0 : Math.min(1, Math.max(0.2, (rpm - 3000) / (FULL_POWER_RPM - 3000)));
    // patinando en la largada, el motor queda arriba de vueltas
    if (this.launchTime > 0 && this.launchRpm > LAUNCH_WINDOW[1] && thr) rpm = Math.max(rpm, this.launchRpm * (0.9 + 0.1 * (this.launchTime / LAUNCH_TIME)));
    this.launchTime = Math.max(0, this.launchTime - dt);
    this.rpm += (Math.min(rpm, p.maxRpm) - this.rpm) * Math.min(1, dt * 20);

    // sin pedales frenan la resistencia del aire y el freno motor, medidos (en el rebufo, menos aire)
    const setup = this.setup, tyres = 1 - WEAR_GRIP * this.wear;
    // con más velocidad punta, menos resistencia del aire: v²/topSpeed²
    const losses = lookup(p.coast, v) / setup.topSpeed ** 2 - this.draft * DRAFT_DRAG * this.drag(v);
    let drive = 0, braking = 0; // lo que empujan y frenan las gomas (m/s²), para el balance
    if (this.speed < 0 || (brk && !thr && this.speed <= 0.5)) {
      // marcha atrás: el freno empuja para atrás; el acelerador primero frena
      if (thr) this.speed += lookup(p.accel, v) * thr * dt;
      else if (brk) {
        this.gear = 0;
        this.speed = Math.max(-REVERSE_MAX, this.speed - REVERSE_ACCEL * brk * dt);
      } else this.speed = Math.min(0, this.speed + losses * dt);
    } else {
      // a fondo, la tabla medida (aceleración neta); a medias, una parte del empuje menos las pérdidas.
      // Cerca de la velocidad punta la resistencia del aire se come todo el empuje (en el rebufo, más arriba)
      const aero = Math.min(1, Math.max(0, (p.topSpeed * setup.topSpeed + 2 + DRAFT_TOP * this.draft - v) / 4));
      // en la largada, si se ahogó o patina, llega menos aceleración al piso
      const launch = this.launchTime > 0 ? this.launchFactor : 1;
      // el rebufo devuelve la parte de la resistencia del aire que se ahorra
      const draft = power > 0 ? this.draft * DRAFT_DRAG * this.drag(v) : 0;
      const full = this.speed < (this.onGrass ? GRASS_MAX : Infinity) ? (lookup(p.accel, v) * power * setup.power + draft) * aero * launch : 0;
      drive = thr * (full + losses);
      // frenada medida: más fuerte a más velocidad, por la carga aerodinámica (ya incluye las pérdidas)
      braking = brk * Math.max(0, (p.brake.base + p.brake.perV2 * v * v) * setup.brakes * tyres - losses);
      this.speed = Math.max(0, this.speed + (drive - losses - braking) * dt);
    }
    // el peso se pasa según lo que empujan o frenan las gomas, con un poco de demora
    this.aLon += (drive - braking - this.aLon) * Math.min(1, dt * TRANSFER_RATE);

    const M = track.meters;
    // pendiente en la dirección de marcha (suavizada): la gravedad frena en subida y empuja en bajada
    const fx = Math.cos(this.angle), fy = Math.sin(this.angle);
    const ahead = sampleField(track.height, track.W, this.x + fx * 1.5, this.y + fy * 1.5);
    const behind = sampleField(track.height, track.W, this.x - fx * 1.5, this.y - fy * 1.5);
    this.slope += ((ahead - behind) / 3 - this.slope) * Math.min(1, dt * 8);
    this.speed -= GRAVITY * this.slope * dt;

    // el pasto frena mucho
    if (this.onGrass && Math.abs(this.speed) > GRASS_MAX * 0.6) {
      this.speed -= Math.sign(this.speed) * Math.min(Math.abs(this.speed), 20 * dt);
    }

    const sp = Math.abs(this.speed);
    let grip = p.lateralGrip.base + p.lateralGrip.perV2 * sp * sp;
    // carga sobre las gomas (por kg): el peso más la carga aerodinámica, que crece igual que el agarre
    const load = GRAVITY * (grip / p.lateralGrip.base);
    grip *= setup.grip * tyres;
    if (this.onGrass) grip *= 0.5;
    // balance: qué parte del peso pasa adelante (frenando) o atrás (acelerando), y cuánto agarra cada eje
    // para doblar con esa carga y lo que le queda después de frenar o empujar
    const shift = Math.max(-MAX_SHIFT, Math.min(MAX_SHIFT, (-this.aLon * CG_H) / (WHEELBASE * load)));
    const usage = (x) => Math.sqrt(1 - Math.min(1, x) ** 2);
    const frontLoad = ((FRONT_SHARE + shift) / FRONT_SHARE) ** LOAD_EXP;
    const rearLoad = ((1 - FRONT_SHARE - shift) / (1 - FRONT_SHARE)) ** LOAD_EXP;
    // los frenos reparten la fuerza según la carga de cada eje, así que el eje cargado la aguanta mejor
    // (con LOAD_EXP < 1, apenas); el empuje del motor va todo a las de atrás
    const braked = braking > 0 ? brk * BRAKE_USE : 0;
    const front = grip * frontLoad * usage(braked * frontLoad ** (1 / LOAD_EXP - 1));
    const rear = grip * rearLoad * usage(braked * rearLoad ** (1 / LOAD_EXP - 1) + drive / ((TRACTION * load) / GRAVITY) / rearLoad);
    this.grip = [front / grip, rear / grip]; // para mostrarlo o probarlo: 1 es el agarre de siempre

    // dirección: el giro está limitado por lo que agarran las gomas de adelante (v²/r ≤ agarre), que crece con
    // la velocidad por la carga aerodinámica; aun así, a más velocidad las curvas se abren
    const target = input.steer;
    this.steer += (target - this.steer) * Math.min(1, dt * 10);
    const yaw = yawRate(sp, front);
    const steerYaw = this.steer * yaw * Math.sign(this.speed || 1);
    // si la cola no alcanza a sostener la curva, se abre: el auto gira más de lo que pide el volante
    // (contravolanteando o levantando el pie, la cola vuelve a agarrar)
    const loose = Math.max(0, sp * Math.abs(steerYaw) - rear);
    if (loose > 0) this.spin += ((Math.sign(steerYaw) * loose * OVERSTEER) / Math.max(sp, 1) - this.spin) * Math.min(1, dt * LOOSE_RATE);
    // con el volante la velocidad dobla junto con el auto; el giro de un golpe, en cambio, hace girar el auto
    // pero la velocidad sigue para donde iba: esa diferencia queda como deslizamiento de costado
    const turn = this.spin * dt, c = Math.cos(turn), s = Math.sin(turn);
    [this.speed, this.slip] = [this.speed * c + this.slip * s, -this.speed * s + this.slip * c];
    this.omega = steerYaw + this.spin;
    this.angle += this.omega * dt;
    // las gomas frenan el deslizamiento y el giro; mientras la cola está suelta, el giro no y el deslizamiento
    // apenas: el auto queda cruzado y la trompa apunta más adentro de lo que va
    const settle = (value, rate) => value - Math.sign(value) * Math.min(Math.abs(value), rate * dt);
    // desgaste: cuánto se exige el agarre (doblar + empujar o frenar, sobre lo que agarran) y el deslizamiento
    if (this.wearRate) {
      const use = (sp * Math.abs(this.omega) + Math.abs(this.aLon)) / grip + Math.abs(this.slip) / 5;
      this.wear = Math.min(1, this.wear + this.wearRate * setup.wear * (WEAR_BASE + WEAR_USE * (1 - WEAR_BASE) * use) * sp * dt);
    }
    this.slip = settle(this.slip, grip * SLIP_GRIP * (loose > 0 ? LOOSE_SLIP : 1));
    this.spin = settle(this.spin, (SPIN_DAMP + grip * SPIN_GRIP) * (this.onGrass ? 0.5 : 1) * (loose > 0 ? 0 : 1));

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
