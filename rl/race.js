// Etapa 2: carreras con varios autos. Algunos autos aprenden (los "agentes", todos con la misma red: compite
// contra sí misma) y los demás son rivales que no aprenden: la IA de siempre (ai.js) con ritmos distintos o una
// red ya entrenada (la de la etapa 1, que no mira a los demás).
//
// Recompensa de cada agente, además de la de la etapa 1 (metros, pasto, muro):
//   - por cada toque con otro auto, según lo fuerte; mucho más si fue él el que le pegó al de adelante
//   ± PASS_REWARD por cada auto que pasa o que lo pasa (en 0: con un premio por pasar y defender aprendió a
//     zigzaguear y a meterse aunque hubiera contacto; pasar ya conviene porque detrás de uno lento avanza menos)
//
// Cada carrera larga de una de estas formas, al azar:
//   grilla     parados en dos filas, en un punto cualquiera de la vuelta (como la largada del juego)
//   lanzada    en fila india, ya andando, con huecos distintos entre autos
//   repartida  los agentes separados por la pista (sigue practicando solo; puede tener rivales cerca)
// Si un agente se queda en el pasto, quieto o va para atrás, termina su episodio y vuelve a la pista ahí mismo;
// la carrera sigue. A los EPISODE_STEPS termina la carrera para todos.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Driver } from '../src/ai.js';
import { Car, DEFAULT_PROFILE, isSolid, slipstream } from '../src/car.js';
import { collideCars } from '../src/collision.js';
import { NeuralDriver, Policy } from '../src/policy.js';
import { racingLine } from '../src/racingline.js';
import { OBS_SIZE, observe, stationAt, trackHeading } from '../src/sensors.js';
import { sampleField } from '../src/track.js';
import { pointOnCenter, rng } from './env.js';
import { loadTrack } from './tracks.js';

const DT = 1 / 60;
const SUBSTEPS = 3;
const EPISODE_STEPS = 2400;
const PROGRESS_REWARD = 0.02;
const GRASS_PENALTY = 0.1;
const WALL_PENALTY = 1;
const CAR_PENALTY = 4; // por un toque a fondo con otro auto, si le pegó él al de adelante
const CAR_PENALTY_HIT = 0.25; // fracción si le pegaron a él (algo de culpa siempre: que no se meta donde no hay lugar)
const PASS_REWARD = 0;
const PASS_GAP = 30; // m: sólo cuentan los cambios de orden entre autos cerca
const GRASS_LIMIT = 6, STUCK_LIMIT = 6, BACKWARDS_LIMIT = 30, END_PENALTY = 2;
const MAX_BOTS = 6;

let profile = DEFAULT_PROFILE;
try {
  profile = JSON.parse(readFileSync(fileURLToPath(new URL('../cars/f1-2023.json', import.meta.url)), 'utf8'));
} catch {
  // sin el perfil medido, el de por defecto
}

const tracks = new Map();
function getTrack(id) {
  if (!tracks.has(id)) {
    const track = loadTrack(id);
    tracks.set(id, { track, line: racingLine(track, profile, { brakeUse: 0.93 }) });
  }
  return tracks.get(id);
}

const opponentPolicies = new Map();
function getPolicy(file) {
  if (!opponentPolicies.has(file)) {
    opponentPolicies.set(file, new Policy(JSON.parse(readFileSync(fileURLToPath(new URL('../' + file, import.meta.url)), 'utf8'))));
  }
  return opponentPolicies.get(file);
}

const wrap = (d, L) => ((d % L) + 1.5 * L) % L - L / 2; // diferencia de posición en la vuelta, entre -L/2 y L/2

export class RaceSim {
  // agents: cuántos autos aprenden; opponent: archivo de la red que maneja algunos rivales (o null)
  constructor({ trackIds, agents = 4, seed = 1, opponent = null }) {
    this.trackIds = trackIds;
    this.agents = agents;
    this.rand = rng(seed);
    this.opponent = opponent ? getPolicy(opponent) : null;
  }

  // Ubica un auto en la posición u de la vuelta (celdas), corrido side metros a la derecha de la línea central
  place(u, side, speed) {
    const { track } = this;
    const h = trackHeading(track, u);
    const { x, y } = pointOnCenter(track, u);
    const s = side / track.meters;
    const car = new Car(x - Math.sin(h) * s, y + Math.cos(h) * s, h, profile);
    car.speed = speed;
    while (car.gear < car.gears && car.rpmAt(speed, car.gear) > profile.upshiftRpm) car.gear++;
    car.rpm = Math.max(4000, car.rpmAt(speed, car.gear));
    car.throttle = speed ? 0.5 : 1;
    if (!speed) car.launch();
    return car;
  }

  reset() {
    const r = this.rand;
    const id = this.trackIds[Math.floor(r() * this.trackIds.length)];
    const { track, line } = getTrack(id);
    Object.assign(this, { id, track, line, steps: 0, time: 0 });
    const L = track.length, M = track.meters;
    const bots = Math.floor(r() * (MAX_BOTS + 1));
    const total = this.agents + bots;
    // orden en la largada: agentes y rivales mezclados
    const kinds = [...Array(this.agents).fill('agent'), ...Array(bots).fill('bot')];
    for (let i = kinds.length - 1; i > 0; i--) {
      const j = Math.floor(r() * (i + 1));
      [kinds[i], kinds[j]] = [kinds[j], kinds[i]];
    }
    const mode = r() < 0.4 ? 'grid' : r() < 0.75 ? 'rolling' : 'spread';
    const front = r() * L;
    const half = track.halfWidth * M;
    const spots = [];
    if (mode === 'grid') {
      for (let k = 0; k < total; k++) spots.push([front - (k * 8) / M, (k % 2 ? -1 : 1) * Math.min(3, half * 0.5), 0]);
    } else if (mode === 'rolling') {
      let u = front;
      for (let k = 0; k < total; k++) {
        const v = (0.5 + 0.4 * r()) * line.speed[Math.floor(((u % L) + L) % L) % line.speed.length];
        spots.push([u, (r() - 0.5) * half, v]);
        u -= (8 + r() * 35) / M;
      }
    } else {
      for (let k = 0; k < total; k++) {
        const u = kinds[k] === 'agent' ? front + (kinds.slice(0, k).filter((x) => x === 'agent').length * L) / this.agents : front + r() * L;
        spots.push([u, (r() - 0.5) * half, r() * 0.8 * line.speed[Math.floor(((u % L) + L) % L) % line.speed.length]]);
      }
    }
    this.cars = kinds.map((kind, k) => {
      const [u, side, v] = spots[k];
      const car = this.place(((u % L) + L) % L, side, v);
      const e = { kind, car, u: stationAt(track, car.x, car.y), start: wrap(u - front, L) * M, dist: 0 };
      if (kind === 'bot') {
        e.driver = this.opponent && r() < 0.4 ? new NeuralDriver(this.opponent, { opponents: false }) : new Driver(0.9 + 0.18 * r(), k + 1);
      } else this.newEpisode(e);
      return e;
    });
    this.agentsList = this.cars.filter((e) => e.kind === 'agent');
    this.ahead = new Map(); // "i,j" → si i iba adelante de j (para contar pasadas)
    return this.agentsList.map((e) => this.observe(e));
  }

  newEpisode(e) {
    Object.assign(e, { grass: 0, stuck: 0, back: 0, ret: 0, steps: 0, lapStart: null, epDist: 0, passes: 0, hits: 0 });
  }

  observe(e) {
    return observe(this.track, e.car, e.u, this.cars.map((o) => o.car), new Float32Array(OBS_SIZE));
  }

  raceDist(e) {
    return e.start + e.dist;
  }

  // actions: [volante, pedal] de cada agente, en orden. Devuelve un resultado por agente, como RaceEnv.step
  step(actions) {
    const { track, line, cars } = this;
    const L = track.length, M = track.meters;
    const all = cars.map((e) => e.car);
    const rewards = new Float32Array(this.agentsList.length);
    const laps = this.agentsList.map(() => null);
    this.agentsList.forEach((e, k) => {
      const steer = clamp(actions[2 * k]), pedal = clamp(actions[2 * k + 1]);
      e.input = { steer, throttle: Math.max(0, pedal), brake: Math.max(0, -pedal) };
    });
    const states = cars.map((e) => ({ car: e.car, st: e.u, lat: sampleField(track.lat, track.W, e.car.x, e.car.y) }));
    for (let s = 0; s < SUBSTEPS; s++) {
      for (const c of all) c.draft = slipstream(c, all, M);
      cars.forEach((e, i) => {
        const input = e.kind === 'agent' ? e.input : e.driver.drive(DT, track, line, states[i], states.filter((_, j) => j !== i));
        const bump = e.car.bump;
        e.car.update(DT, input, track);
        e.wallHit = e.car.bump > bump + 0.05 ? e.car.bump - bump : 0;
      });
      const before = all.map((c) => c.bump);
      collideCars(all, track, isSolid);
      this.time += DT;
      cars.forEach((e, i) => {
        const k = this.agentsList.indexOf(e);
        const carHit = e.car.bump > before[i] + 0.05 ? e.car.bump - before[i] : 0;
        if (k >= 0) {
          rewards[k] -= WALL_PENALTY * e.wallHit;
          if (carHit) {
            rewards[k] -= CAR_PENALTY * carHit * (this.hitAhead(e) ? 1 : CAR_PENALTY_HIT);
            e.hits++;
          }
        }
        // avance sobre la línea central
        const u = stationAt(track, e.car.x, e.car.y);
        if (u < 0) return;
        let du = u - e.u;
        if (du < -L / 2) {
          du += L;
          if (k >= 0) {
            if (e.lapStart !== null) laps[k] = this.time - e.lapStart;
            e.lapStart = this.time;
          }
        } else if (du > L / 2) {
          du -= L;
          e.lapStart = null;
        }
        e.u = u;
        const m = du * M;
        e.dist += m;
        states[i].st = u;
        states[i].lat = sampleField(track.lat, track.W, e.car.x, e.car.y);
        if (k >= 0) {
          if (!e.car.onGrass || m < 0) rewards[k] += PROGRESS_REWARD * m;
          e.epDist += m;
          e.back = m < 0 ? e.back - m : Math.max(0, e.back - m);
        }
      });
    }
    // pasadas: cambios de orden entre autos cercanos
    this.agentsList.forEach((e, k) => {
      for (const o of cars) {
        if (o === e) continue;
        const gap = this.raceDist(e) - this.raceDist(o);
        const key = `${cars.indexOf(e)},${cars.indexOf(o)}`;
        const was = this.ahead.get(key);
        const now = gap > 0;
        if (PASS_REWARD && Math.abs(gap) < PASS_GAP && was !== undefined && was !== now) {
          rewards[k] += now ? PASS_REWARD : -PASS_REWARD;
          if (now) e.passes++;
        }
        this.ahead.set(key, now);
      }
    });

    this.steps++;
    const truncated = this.steps >= EPISODE_STEPS;
    const dt = DT * SUBSTEPS;
    const results = this.agentsList.map((e, k) => {
      const car = e.car;
      if (car.onGrass) {
        rewards[k] -= GRASS_PENALTY;
        e.grass += dt;
      } else e.grass = 0;
      e.stuck = Math.abs(car.speed) < 1 ? e.stuck + dt : 0;
      e.steps++;
      const done = e.grass > GRASS_LIMIT || e.stuck > STUCK_LIMIT || e.back > BACKWARDS_LIMIT;
      if (done) rewards[k] -= END_PENALTY;
      e.ret += rewards[k];
      const info = { lap: laps[k], track: this.id };
      if (done || truncated) {
        info.episode = { r: e.ret, l: e.steps, dist: e.epDist, track: this.id, passes: e.passes, hits: e.hits,
          end: e.grass > GRASS_LIMIT ? 'grass' : e.stuck > STUCK_LIMIT ? 'stuck' : e.back > BACKWARDS_LIMIT ? 'back' : 'time' };
      }
      return { obs: null, reward: rewards[k], done: done && !truncated, truncated, info, e };
    });
    // los que terminaron vuelven a la pista donde estaban, a un costado y despacio (next: su nueva observación)
    for (const r of results) {
      r.obs = this.observe(r.e);
      if (r.done) {
        const e = r.e;
        const side = (this.rand() < 0.5 ? -1 : 1) * track.halfWidth * M * 0.6;
        e.car = this.place(e.u, side, 10);
        this.newEpisode(e);
        r.next = this.observe(e);
      }
    }
    return results;
  }

  // ¿había un auto justo adelante suyo (le pegó él)?
  hitAhead(e) {
    const { car } = e, M = this.track.meters;
    const ca = Math.cos(car.angle), sa = Math.sin(car.angle);
    return this.cars.some((o) => {
      if (o === e) return false;
      const dx = (o.car.x - car.x) * M, dy = (o.car.y - car.y) * M;
      const fwd = dx * ca + dy * sa, side = -dx * sa + dy * ca;
      return fwd > 0 && fwd < 7 && Math.abs(side) < 2.5;
    });
  }
}

const clamp = (v) => Math.max(-1, Math.min(1, Number.isFinite(v) ? v : 0));
