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
const IDLE_RPM = 4000;
const LAUNCH_RPM = 8000; // con el embrague patinando, en 1ª y 2ª el motor no cae de acá
const FULL_POWER_RPM = 9000; // por debajo de esto el motor rinde cada vez menos
// Largada: según las rpm al soltar el embrague, el auto sale con todo, se ahoga o patina
export const LAUNCH_WINDOW = [9500, 10500]; // rpm de la largada perfecta
const LAUNCH_TIME = 1.6; // cuánto dura el efecto de la largada (s)
const REV_RATE = 6500; // cuánto suben las rpm por segundo en punto muerto, a fondo (más lento cerca del corte)
const REV_DROP = 7000; // y cuánto bajan sin acelerar

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
    this.throttle = 0; // 1 si va acelerando (para el sonido)
    this.launchFactor = 1; // en la largada: qué fracción de la aceleración llega al piso
    this.launchTime = 0;
    this.launchRpm = 0;
    this.gear = 1; // 0 = marcha atrás
    this.rpm = IDLE_RPM;
    this.manual = false;
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

  // En la grilla, con el auto detenido (embrague apretado): el acelerador sólo sube las vueltas
  rev(dt, throttle) {
    const max = this.profile.maxRpm;
    if (throttle) this.rpm = Math.min(max, this.rpm + REV_RATE * (1 - 0.6 * (this.rpm / max)) * dt);
    else this.rpm = Math.max(IDLE_RPM, this.rpm - REV_DROP * dt);
    this.throttle = throttle ? 1 : 0;
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
    this.throttle = input.throttle ? 1 : 0;
    if (this.speed >= 0 && this.gear === 0) this.gear = 1;
    if (!this.manual && this.gear > 0) this.autoShift(input.throttle);

    // motor: la tabla medida dice cuánto acelera a fondo a cada velocidad con la marcha justa;
    // con otra marcha rinde menos (pocas vueltas) o nada (corte de RPM)
    let rpm = this.rpmAt(v, this.gear);
    if (this.gear <= 2 && input.throttle) rpm = Math.max(rpm, LAUNCH_RPM);
    rpm = Math.max(rpm, IDLE_RPM);
    const limiter = rpm >= p.maxRpm;
    const power = limiter ? 0 : Math.min(1, Math.max(0.2, (rpm - 3000) / (FULL_POWER_RPM - 3000)));
    // patinando en la largada, el motor queda arriba de vueltas
    if (this.launchTime > 0 && this.launchRpm > LAUNCH_WINDOW[1] && input.throttle) rpm = Math.max(rpm, this.launchRpm * (0.9 + 0.1 * (this.launchTime / LAUNCH_TIME)));
    this.launchTime = Math.max(0, this.launchTime - dt);
    this.rpm += (Math.min(rpm, p.maxRpm) - this.rpm) * Math.min(1, dt * 20);

    // el acelerador siempre empuja hacia adelante: si el auto venía para atrás, primero lo frena
    if (input.throttle) {
      if (this.gear === 0) this.gear = 1;
      const top = this.onGrass ? GRASS_MAX : Infinity;
      // cerca de la velocidad punta medida, la resistencia del aire se come todo el empuje (en el rebufo, más arriba)
      const aero = Math.min(1, Math.max(0, (p.topSpeed + 2 + DRAFT_TOP * this.draft - v) / 4));
      // en la largada, si se ahogó o patina, llega menos aceleración al piso
      const launch = this.launchTime > 0 ? this.launchFactor : 1;
      // el rebufo devuelve la parte de la resistencia del aire que se ahorra
      const draft = power > 0 ? this.draft * DRAFT_DRAG * this.drag(v) : 0;
      if (this.speed < top) this.speed += (lookup(p.accel, v) * power + draft) * aero * launch * dt;
    } else if (input.brake) {
      if (this.speed > 0.5) {
        // frenada: más fuerte a más velocidad, por la carga aerodinámica
        this.speed = Math.max(0, this.speed - (p.brake.base + p.brake.perV2 * v * v) * dt);
      } else {
        this.gear = 0;
        this.speed = Math.max(-REVERSE_MAX, this.speed - REVERSE_ACCEL * dt);
      }
    } else {
      // sin pedales: resistencia del aire y freno motor, medidos (en el rebufo, menos aire)
      const decel = lookup(p.coast, v) - this.draft * DRAFT_DRAG * this.drag(v);
      this.speed -= Math.sign(this.speed) * Math.min(v, decel * dt);
    }

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

    // dirección: el giro está limitado por el agarre lateral (v²/r ≤ agarre), que crece con la
    // velocidad por la carga aerodinámica; aun así, a más velocidad las curvas se abren
    const target = input.steer;
    this.steer += (target - this.steer) * Math.min(1, dt * 10);
    const sp = Math.abs(this.speed);
    let grip = p.lateralGrip.base + p.lateralGrip.perV2 * sp * sp;
    if (this.onGrass) grip *= 0.5;
    const yaw = yawRate(sp, grip);
    const steerYaw = this.steer * yaw * Math.sign(this.speed || 1);
    // con el volante la velocidad dobla junto con el auto; el giro de un golpe, en cambio, hace girar el auto
    // pero la velocidad sigue para donde iba: esa diferencia queda como deslizamiento de costado
    const turn = this.spin * dt, c = Math.cos(turn), s = Math.sin(turn);
    [this.speed, this.slip] = [this.speed * c + this.slip * s, -this.speed * s + this.slip * c];
    this.omega = steerYaw + this.spin;
    this.angle += this.omega * dt;
    // las gomas frenan el deslizamiento y el giro
    const settle = (value, rate) => value - Math.sign(value) * Math.min(Math.abs(value), rate * dt);
    this.slip = settle(this.slip, grip * SLIP_GRIP);
    this.spin = settle(this.spin, (SPIN_DAMP + grip * SPIN_GRIP) * (this.onGrass ? 0.5 : 1));

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
