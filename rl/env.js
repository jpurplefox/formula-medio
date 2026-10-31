// Entorno de entrenamiento: un auto en un circuito, con la misma física del juego y sin dibujar nada.
//
// Acción: [volante, pedal], los dos de -1 a 1 (pedal positivo acelera, negativo frena).
// La IA decide 20 veces por segundo; entre decisiones la física avanza 3 pasos de 1/60 s, como en el juego.
//
// Recompensa por cada decisión:
//   + metros avanzados sobre la línea central (para atrás resta): optimizarlo es bajar el tiempo de vuelta.
//     En el pasto no cuentan, así que cortar camino nunca conviene
//   - por cada paso en el pasto
//   - por cada golpe contra el muro, según lo fuerte
// El episodio termina si pasa demasiado tiempo en el pasto, si se queda quieto o si va para atrás,
// y se corta (sin ser culpa del auto) a los EPISODE_STEPS.
//
// Cada episodio el auto es un poco distinto (motor, punta, agarre, frenos, ritmo de desgaste: ± spread) y larga
// con las gomas a medio gastar; la red recibe esos datos (sensors.js), así aprende a manejar cualquier auto.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Car, DEFAULT_PROFILE, SETUP_KEYS } from '../src/car.js';
import { racingLine } from '../src/racingline.js';
import { halfWidthAt } from '../src/track.js';
import { OBS_SIZE, observe, stationAt, trackHeading } from '../src/sensors.js';
import { loadTrack } from './tracks.js';

export const PHYSICS_DT = 1 / 60;
export const SUBSTEPS = 3;
export const EPISODE_STEPS = 2400; // 2 minutos
const PROGRESS_REWARD = 0.02; // por metro
const GRASS_PENALTY = 0.1; // por decisión en el pasto
const WALL_PENALTY = 1; // por un golpe a fondo
const GRASS_LIMIT = 6; // s seguidos en el pasto: se termina el episodio (antes, que aprenda a volver)
const STUCK_LIMIT = 6; // s casi quieto
const STANDING_START = 0.2; // parte de los episodios que larga con el auto quieto, como en la grilla
const ROUGH_START = 0.2; // y parte que larga cruzado o con dos ruedas afuera, para aprender a recuperarse
const BACKWARDS_LIMIT = 30; // m de retroceso acumulado
const END_PENALTY = 2;

let profile = DEFAULT_PROFILE;
try {
  profile = JSON.parse(readFileSync(fileURLToPath(new URL('../cars/f1-2023.json', import.meta.url)), 'utf8'));
} catch {
  // sin el perfil medido, el de por defecto
}

const tracks = new Map(); // id → { track, line } (se arma una vez por proceso)
function getTrack(id) {
  if (!tracks.has(id)) {
    const track = loadTrack(id);
    tracks.set(id, { track, line: racingLine(track, profile) });
  }
  return tracks.get(id);
}

// generador de números al azar con semilla (mulberry32), para poder repetir un entrenamiento
export function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Un auto al azar: cada multiplicador entre 1 - spread y 1 + spread, o entre 1 - spread[0] y 1 + spread[1]
// (el desgaste varía siempre ±30 %)
export function randomSetup(rand, spread) {
  const [down, up] = Array.isArray(spread) ? spread : [spread, spread];
  return Object.fromEntries(SETUP_KEYS.map((k) => [k, k === 'wear' ? 1 + (2 * rand() - 1) * 0.3 : 1 - down + (down + up) * rand()]));
}

// Gomas al azar: carreras de 3 a 20 vueltas (desgaste por metro) y en cualquier momento de la carrera
export function randomTyres(car, rand, track) {
  car.wearRate = 1 / ((3 + 17 * rand()) * track.length * track.meters);
  car.wear = 0.9 * rand();
}

export class RaceEnv {
  // rewards: escala del castigo por pasto y por muro (la fase 1 del tercer intento los hace más caros)
  constructor({ trackIds, seed = 1, spread = 0.02, rewards = {} }) {
    this.rewards = { grass: 1, wall: 1, ...rewards };
    this.trackIds = trackIds;
    this.spread = spread;
    this.rand = rng(seed);
    this.obs = new Float32Array(OBS_SIZE);
  }

  reset() {
    const id = this.trackIds[Math.floor(this.rand() * this.trackIds.length)];
    const { track, line } = getTrack(id);
    this.id = id;
    this.track = track;
    // largada en un punto cualquiera de la vuelta, sobre la trazada y a una parte de su velocidad
    const L = track.length;
    const u = this.rand() * L;
    const rough = this.rand() < ROUGH_START;
    const side = (this.rand() - 0.5) * halfWidthAt(track, u) * (rough ? 2.6 : 1);
    const h = trackHeading(track, u);
    const { x, y } = pointOnCenter(track, u);
    const car = new Car(x - Math.sin(h) * side, y + Math.cos(h) * side, h + (this.rand() - 0.5) * (rough ? 1.6 : 0.2), profile);
    const standing = this.rand() < STANDING_START;
    car.speed = standing ? 0 : this.rand() * (rough ? 0.4 : 0.8) * line.speed[Math.floor(u) % line.speed.length];
    if (standing) car.launch();
    while (car.gear < car.gears && car.rpmAt(car.speed, car.gear) > profile.upshiftRpm) car.gear++;
    car.rpm = Math.max(4000, car.rpmAt(car.speed, car.gear));
    car.throttle = 0.5;
    car.setup = randomSetup(this.rand, this.spread);
    randomTyres(car, this.rand, track);
    this.car = car;
    this.u = stationAt(track, car.x, car.y);
    this.steps = 0;
    this.grass = 0;
    this.stuck = 0;
    this.back = 0;
    this.lapStart = null; // tiempo en que cruzó la línea de largada (para medir vueltas completas)
    this.time = 0;
    this.ret = 0;
    this.dist = 0;
    return observe(track, car, this.u, [], this.obs);
  }

  // Devuelve { obs, reward, done, truncated, info }
  step(steer, pedal) {
    const { track, car } = this;
    const input = { steer: clamp(steer), throttle: Math.max(0, clamp(pedal)), brake: Math.max(0, -clamp(pedal)) };
    let reward = 0, lap = null;
    const L = track.length;
    for (let k = 0; k < SUBSTEPS; k++) {
      const bump = car.bump;
      car.update(PHYSICS_DT, input, track);
      if (car.bump > bump + 0.05) reward -= WALL_PENALTY * this.rewards.wall * (car.bump - bump);
      this.time += PHYSICS_DT;
      // avance sobre la línea central (en metros); al cruzar la línea de largada el station vuelve a 0
      const u = stationAt(track, car.x, car.y);
      if (u >= 0) {
        let du = u - this.u;
        if (du < -L / 2) {
          du += L;
          if (this.lapStart !== null) lap = this.time - this.lapStart;
          this.lapStart = this.time;
        } else if (du > L / 2) {
          du -= L;
          this.lapStart = null; // cruzó la línea para atrás: esa vuelta no cuenta
        }
        this.u = u;
        const m = du * track.meters;
        if (!car.onGrass || m < 0) reward += PROGRESS_REWARD * m;
        this.dist += m;
        this.back = m < 0 ? this.back - m : Math.max(0, this.back - m);
      }
    }
    const dt = PHYSICS_DT * SUBSTEPS;
    if (car.onGrass) {
      reward -= GRASS_PENALTY * this.rewards.grass;
      this.grass += dt;
    } else this.grass = 0;
    this.stuck = Math.abs(car.speed) < 1 ? this.stuck + dt : 0;
    this.steps++;

    const done = this.grass > GRASS_LIMIT || this.stuck > STUCK_LIMIT || this.back > BACKWARDS_LIMIT;
    if (done) reward -= END_PENALTY;
    const truncated = !done && this.steps >= EPISODE_STEPS;
    this.ret += reward;
    const info = { lap, track: this.id };
    if (done || truncated) {
      info.episode = { r: this.ret, l: this.steps, dist: this.dist, track: this.id,
        end: this.grass > GRASS_LIMIT ? 'grass' : this.stuck > STUCK_LIMIT ? 'stuck' : this.back > BACKWARDS_LIMIT ? 'back' : 'time' };
    }
    return { obs: observe(track, car, this.u, [], this.obs), reward, done, truncated, info };
  }
}

const clamp = (v) => Math.max(-1, Math.min(1, Number.isFinite(v) ? v : 0));

// punto de la línea central en la posición u de la vuelta (celdas)
export function pointOnCenter(track, u) {
  const { n, x, y, st } = track.path;
  const L = st[n];
  u = ((u % L) + L) % L;
  let lo = 0, hi = n;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (st[mid] <= u) lo = mid;
    else hi = mid;
  }
  const b = (lo + 1) % n, t = (u - st[lo]) / Math.max(1e-9, st[lo + 1] - st[lo]);
  return { x: x[lo] + (x[b] - x[lo]) * t, y: y[lo] + (y[b] - y[lo]) * t };
}
