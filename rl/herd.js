// Carreras en manada (currículo v8, rl/CURRICULO.md): todos los autos de la carrera son agentes con la misma red,
// que aprende. Así se entrena el comportamiento de grupo que se ve en el juego (21 redes iguales), por ejemplo la
// fila india en la largada, que con rivales de la IA de siempre no aparecía.
//
// Escenarios (cuánto duran sale de la vuelta de la trazada del circuito):
//   solo     agentes repartidos por la pista, lanzados, dos vueltas (repaso de la fase 1)
//   grid     largada desde parado con semáforo (src/lights.js), dos vueltas: la grilla del circuito o una al azar
//            antes de una curva. Con las luces prendidas la red sube y baja las vueltas con sus dos salidas de rpm
//            (car.revBy); al apagarse, si viene acelerando suelta el embrague con las que tenga (car.launch: ahogado o
//            patinando si no están en la ventana) o, si no, cuando acelere
//   start    arranque: como grid (semáforo, la grilla del circuito o una al azar), pero termina cuando el primero
//            llega a START_MARGIN m del comienzo de la frenada de la primera curva: hasta ahí lo correcto es ir a
//            fondo, así que no premia llegar pasado de velocidad (lo que sigue lo estima el crítico, como en un corte
//            por tiempo). Corto: muchas más largadas por paso que en grid (en grid, unas 280 cada 3,5 M de pasos)
//   flying   largada en movimiento: dos filas alternadas a FLYING_GAP m, todos a la misma fracción de la velocidad
//            de la trazada (±3 %), antes de una curva, una vuelta. Para aprender a ir a la par y en grupo apretado
//   rolling  en fila, lanzados, a distancias distintas, dos vueltas
//   chase    de a pares: el de adelante con menos motor, una vuelta. Se mide sólo al de atrás; el de adelante maneja
//            con el premio de siempre (su tiempo): si aflojar para que lo pasen le cuesta, no aprende a aflojar
//
// Una sola medida, en todos los escenarios: el tiempo con castigo (las mismas reglas para premiar y para medir; ver
// Budgets en rl/train.py), contra el de la trazada para su auto arrancando igual (1,05: 5 % más lento):
//   solo, rolling  cada vuelta
//   grid           las dos vueltas, contra la trazada desde parado más una lanzada
//   start          hasta donde llegó cada uno cuando el primero cruzó la línea, contra la trazada desde parado
//   flying         la vuelta, contra la trazada arrancando a su velocidad
//   chase          la vuelta del de atrás
// El castigo, en segundos que se le suman al tiempo:
//   - ZONE_TIME por cada segundo con otro auto en la zona de al lado (el auto con ZONE_MARGIN m más de cada costado,
//     del mismo largo: a la par a menos de ese margen, o encimados). No es más larga que el auto: venir atrás no
//     cuesta (con un castigo por peligro de alcanzar a otro, en el pelotón de la largada convenía levantar y que te
//     pegaran de atrás, v10 y v11). No se distingue culpa: entre iguales, los dos pagan
//   - HIT_TIME por cada toque: un contacto que empieza después de CONTACT_GAP sin tocarse (un roce largo, uno solo)
//   - GRASS_TIME por cada segundo y cada rueda en el pasto
// Lo que se rompe ya cuesta por sí solo: ir con el auto roto es más lento.
//
// Premio de cada agente, × la escala de su escenario (scales; la fija el entrenamiento: el escenario que la fase
// premia con un peso fijo y los demás ajustados solos para que no empeoren, presupuestos):
//   + metros avanzados (también en el pasto: lo cobra su castigo por rueda; si llega a convenir cortar camino, se
//     sube GRASS_TIME)
//   - el castigo, como lo que avanzaría en esos segundos a la velocidad media de la trazada
// Y sin escala: - muro, quedarse quieto, rescate, abandono, ir lento con la pista libre (piso de ritmo)

import { gridSlots } from '../src/ai.js';
import { isSolid, slipstream } from '../src/car.js';
import { collideCars } from '../src/collision.js';
import { ACTIONS, stationAt } from '../src/sensors.js';
import { halfWidthAt, sampleField } from '../src/track.js';
import { NO_DAMAGE } from '../src/damage.js';
import { randomSetup, randomTune, randomTyres, TUNE_SPREAD } from './env.js';
import { getTrack, mod, RaceSim, recordPace, wrap } from './race.js';
import { LIGHT_FIRST, lightsAt, lightsDuration, randomHold } from '../src/lights.js';

const DT = 1 / 60, SUBSTEPS = 3, DECISIONS = 20; // decisiones por segundo
const PROGRESS_REWARD = 0.02, WALL_PENALTY = 1;
const GRASS_LIMIT = 6, STUCK_LIMIT = 6, BACKWARDS_LIMIT = 30, RESCUE_PENALTY = 4, STALL_PENALTY = 1, RETIRE_PENALTY = 10;
const PACE_FLOOR = 0.75, PACE_PENALTY = 1, FREE_ROAD = 40;
const FLYING_GAP = 6, FLYING_SPEED = [0.6, 0.8]; // largada en movimiento: m entre autos y fracción de la trazada
const PASS_HOLD = 2.5; // s que el de atrás tiene que seguir adelante, sin tocarse, para contar la pasada
const CONTACT_GAP = 0.5; // s sin tocarse para que el siguiente contacto sea otro toque
// castigo, en segundos: por cada segundo con otro auto en la zona de al lado, por cada toque y por cada segundo y
// rueda en el pasto
const ZONE_TIME = 0.2, HIT_TIME = 0.6, GRASS_TIME = 0.8;
// la zona: el auto (5,6 × 2 m, src/collision.js) con ZONE_MARGIN m más de cada costado, del mismo largo
const CAR_L = 5.6, CAR_W = 2, ZONE_MARGIN = 0.5;
// desventaja de motor del de adelante en las persecuciones, al principio y al final de la fase
const CHASE_HANDICAP = [0.2, 0.08];
// vueltas de cada escenario y margen de tiempo (la vuelta de la trazada × SLACK, más unos segundos)
// (start: lo que suele durar, en vueltas, para repartir los pasos de la mezcla y cortar si nadie llega)
export const HERD_SCENARIOS = { solo: 2, grid: 2, rolling: 2, chase: 1, flying: 1, start: 0.25 };
const START_MARGIN = 10; // m antes del comienzo de la frenada donde termina el arranque
const SLACK = 1.25, EXTRA = 25; // con una grilla de 16 los últimos tardan en completar las dos vueltas
const DAMAGE_LEVELS = ['off', 'reduced', 'real'];

// Comienzo de la frenada de cada curva (celdas): desde el vértice (corners, rl/race.js), hacia atrás mientras la
// trazada viene más rápida
const brakeCache = new WeakMap();
function brakePoints(track, line, corners) {
  if (brakeCache.has(track)) return brakeCache.get(track);
  const v = line.speed, n = v.length, at = (i) => v[((i % n) + n) % n];
  const out = corners.map((c) => {
    let i = c;
    while (i > c - n / 2 && at(i - 1) > at(i)) i--;
    return ((i % n) + n) % n;
  });
  brakeCache.set(track, out);
  return out;
}

export class HerdSim extends RaceSim {
  constructor({ trackIds, agents = 16, seed = 1, mix = { grid: 1 }, spread = 0.02, rewards = {}, progress = 0,
    damage = 'off', tuneSpread = TUNE_SPREAD }) {
    super({ trackIds, agents, seed, mix: {}, spread, rewards, progress, damage, tuneSpread });
    this.rewards = { paceFloor: 1, ...rewards };
    this.scales = Object.fromEntries(Object.keys(HERD_SCENARIOS).map((k) => [k, 1]));
    // el peso es la parte de los pasos: cada escenario se elige según su peso dividido sus vueltas
    this.mix = Object.entries(mix).filter(([, w]) => w > 0).map(([k, w]) => [k, w / HERD_SCENARIOS[k]]);
    this.mixTotal = this.mix.reduce((a, [, w]) => a + w, 0);
  }

  reset() {
    const r = this.rand;
    const id = this.trackIds[Math.floor(r() * this.trackIds.length)];
    const { track, line, clock, corners } = getTrack(id);
    const scenario = this.pickScenario();
    const damage = this.damage === 'mix' ? DAMAGE_LEVELS[Math.floor(r() * 3)] : this.damage;
    const lap = clock[clock.length - 1];
    const length = Math.ceil((HERD_SCENARIOS[scenario] * lap * SLACK + EXTRA) * DECISIONS);
    // en la grilla, el semáforo: el tiempo cuenta desde que se apaga (antes, negativo). Se arranca en algún momento
    // del primer segundo, antes de la primera luz
    const lights = scenario === 'grid' || scenario === 'start';
    const lightsTotal = lights ? lightsDuration(randomHold(r)) : 0;
    const time = lights ? r() * LIGHT_FIRST - lightsTotal : 0;
    Object.assign(this, { id, track, line, clock, corners, scenario, damage, steps: 0, time, lightsTotal,
      length: length + Math.ceil(-time * DECISIONS) });
    const L = track.length, M = track.meters, half = track.halfWidth * M, A = this.agents;
    const corner = () => (corners.length ? corners[Math.floor(r() * corners.length)] : r() * L);
    const spots = []; // { u, side (m), v (m/s), partner?, handicap? }

    if (scenario === 'solo') {
      const front = r() * L;
      for (let k = 0; k < A; k++) {
        const u = front + (k * L) / A;
        spots.push({ u, side: (r() - 0.5) * half, v: (0.6 + 0.3 * r()) * this.lineSpeed(u) });
      }
    } else if (scenario === 'grid') {
      // la mitad de las veces la grilla del circuito (como en el juego); si no, 250-500 m antes de una curva
      const first = gridSlots(track, 1)[0];
      const line0 = r() < 0.5 ? stationAt(track, first.x, first.y) : corner() - (250 + 250 * r()) / M;
      for (let k = 0; k < A; k++) spots.push({ u: line0 - (k * 8) / M, side: (k % 2 ? -1 : 1) * Math.min(3, half * 0.5), v: 0 });
    } else if (scenario === 'start') {
      // la mitad de las veces la grilla del circuito y su primera frenada; si no, 300-700 m antes de una frenada
      const brakes = brakePoints(track, line, corners);
      const first = gridSlots(track, 1)[0];
      let line0, brake;
      if (r() < 0.5 || !brakes.length) {
        line0 = stationAt(track, first.x, first.y);
        brake = brakes.reduce((a, b) => (mod(b - line0, L) * M > 100 && mod(b - line0, L) < mod(a - line0, L) ? b : a), line0 + L / 2);
      } else {
        brake = brakes[Math.floor(r() * brakes.length)];
        line0 = brake - (300 + 400 * r()) / M;
      }
      this.finish = brake - START_MARGIN / M;
      for (let k = 0; k < A; k++) spots.push({ u: line0 - (k * 8) / M, side: (k % 2 ? -1 : 1) * Math.min(3, half * 0.5), v: 0 });
    } else if (scenario === 'flying') {
      // 150-400 m antes de una curva, en dos filas como la grilla pero más juntos, todos a la misma fracción de la
      // velocidad de la trazada donde está el primero (±3 % cada uno)
      const line0 = corner() - (150 + 250 * r()) / M;
      const v = (FLYING_SPEED[0] + (FLYING_SPEED[1] - FLYING_SPEED[0]) * r()) * this.lineSpeed(line0);
      for (let k = 0; k < A; k++) {
        spots.push({ u: line0 - (k * FLYING_GAP) / M, side: (k % 2 ? -1 : 1) * Math.min(3, half * 0.5), v: v * (0.97 + 0.06 * r()) });
      }
    } else if (scenario === 'rolling') {
      let u = r() * L;
      for (let k = 0; k < A; k++) {
        spots.push({ u, side: (r() - 0.5) * half, v: (0.6 + 0.3 * r()) * this.lineSpeed(u) });
        u -= (8 + r() * 35) / M;
      }
    } else {
      // de a pares repartidos por la pista: en recta saliendo de una curva o antes de una curva
      const [h0, h1] = CHASE_HANDICAP;
      const pairs = Math.floor(A / 2);
      const front = r() * L;
      for (let p = 0; p < pairs; p++) {
        const straight = r() < 0.5;
        const base = front + (p * L) / pairs;
        // la curva más cercana a su lugar de la pista
        const c = corners.reduce((a, x) => (Math.abs(wrap(x - base, L)) < Math.abs(wrap(a - base, L)) ? x : a), corners[0] ?? base);
        const u0 = straight ? c + (20 + 40 * r()) / M : c - (150 + 150 * r()) / M;
        const v = (straight ? 0.9 : 0.8 + 0.15 * r()) * this.lineSpeed(u0);
        const handicap = (h0 + (h1 - h0) * Math.min(1, this.progress)) * (0.75 + 0.5 * r());
        const gap = (straight ? 10 + 20 * r() : 12 + 25 * r()) / M;
        spots.push({ u: u0, side: (r() - 0.5) * half * 0.5, v: v * (1 - handicap / 2), partner: spots.length + 1, handicap });
        spots.push({ u: u0 - gap, side: (r() - 0.5) * half * 0.6, v: v * (1 + 0.05 * r()), partner: spots.length - 1 });
      }
      while (spots.length < A) spots.push({ u: front + L / 2 + (spots.length * 50) / M, side: 0, v: 0.8 * this.lineSpeed(front) });
    }

    this.cars = spots.map((s) => {
      const car = this.place(s.u, s.side, s.v);
      car.setup = randomSetup(r, this.spread);
      if (s.handicap) car.setup = { ...car.setup, power: car.setup.power * (1 - s.handicap) };
      randomTune(car, r, track, this.tuneSpread);
      randomTyres(car, r, track);
      car.damageLevel = damage;
      // offset: dónde arrancó respecto del primero (m), para saber quién va adelante
      const e = { kind: 'agent', car, u: stationAt(track, car.x, car.y), dist: 0, offset: wrap(s.u - spots[0].u, L) * M,
        lastHit: -1e9, lastTouch: -1e9, lastGrass: -1e9 };
      this.newEpisode(e);
      e.front = !!s.handicap; // el de adelante en una persecución
      e.standing = !s.v;
      // la primera vuelta es de largada (no lanzada): se mide contra la trazada arrancando igual
      e.startLap = scenario === 'grid' || scenario === 'flying' || scenario === 'start';
      if (e.startLap) {
        e.startClock = this.launchClock(car, e.u, car.speed);
        e.startIdeal = e.startClock[e.startClock.length - 1];
      }
      // arranque: cuánto tiene que recorrer hasta la línea (antes de la frenada)
      if (scenario === 'start') e.finishDist = mod(this.finish - e.u, L) * M;
      if (lights) {
        // quieto en la grilla en ralentí, sin el embrague suelto (place lo suelta): se suelta al apagarse las luces
        Object.assign(car, { launchTime: 0, throttle: 0 });
        e.marks = [0];
      }
      return e;
    });
    this.cars.forEach((e, k) => (e.partner = spots[k].partner === undefined ? null : this.cars[spots[k].partner]));
    this.agentsList = this.cars;
    this.setLights();
    return this.cars.map((e) => this.observe(e));
  }

  // cómo ve cada auto el semáforo (sólo en la grilla; sin, apagado)
  setLights() {
    if (!this.lightsTotal) return;
    const lights = lightsAt(this.time + this.lightsTotal, this.lightsTotal);
    for (const e of this.cars) e.car.lights = lights;
  }

  // Con el semáforo prendido: quietos; las dos salidas de rpm suben y bajan las vueltas (el pedal no: con la red
  // saturada a fondo nunca probaba otra cosa que el corte). Al apagarse, el que viene acelerando suelta el embrague con
  // las que tenga; el que no, cuando acelere (waiting)
  countdown(actions) {
    const { cars } = this;
    cars.forEach((e, k) => {
      const a = ACTIONS * k, pedal = clamp(actions[a + 1]);
      e.input = { steer: 0, throttle: Math.max(0, pedal), brake: Math.max(0, -pedal) };
      e.car.throttle = e.input.throttle;
      for (let s = 0; s < SUBSTEPS; s++) e.car.revBy(DT, clamp(actions[a + 2]), clamp(actions[a + 3]));
    });
    this.time += DT * SUBSTEPS;
    if (this.time >= 0) {
      this.time = 0;
      for (const e of cars) {
        if (e.input.throttle > 0) e.car.launch();
        else e.waiting = true;
      }
    }
    this.setLights();
    this.steps++;
    return cars.map((e) => ({ obs: this.observe(e), reward: 0, done: false, truncated: false, info: { lap: null, track: this.id } }));
  }

  step(actions) {
    if (this.time < 0) return this.countdown(actions);
    const { track, line, cars } = this;
    const L = track.length, M = track.meters, lapM = L * M;
    const all = cars.map((e) => e.car);
    const n = cars.length;
    const rewards = new Float32Array(n), penalty = new Float32Array(n);
    const scale = this.scales[this.scenario] ?? 1;
    const laps = cars.map(() => null);
    cars.forEach((e, k) => {
      const steer = clamp(actions[ACTIONS * k]), pedal = clamp(actions[ACTIONS * k + 1]);
      e.input = { steer, throttle: Math.max(0, pedal), brake: Math.max(0, -pedal) };
    });
    for (let s = 0; s < SUBSTEPS; s++) {
      for (const c of all) c.draft = slipstream(c, all, M);
      for (const e of cars) {
        if (e.waiting) {
          // se apagaron las luces y no venía acelerando: larga cuando acelera
          if (e.input.throttle > 0) {
            e.car.launch();
            e.waiting = false;
          } else {
            e.car.rev(DT, 0);
            e.wallHit = 0;
            continue;
          }
        }
        const bump = e.car.bump;
        e.car.update(DT, e.input, track);
        e.wallHit = e.car.bump > bump + 0.05 ? e.car.bump - bump : 0;
      }
      const before = all.map((c) => c.bump);
      collideCars(all, track, isSolid);
      this.time += DT;
      cars.forEach((e, k) => {
        const carHit = e.car.bump > before[k] + 0.05 ? e.car.bump - before[k] : 0;
        rewards[k] -= WALL_PENALTY * e.wallHit;
        if (carHit) {
          const fresh = this.time - e.lastTouch > CONTACT_GAP;
          e.lastTouch = e.lastHit = this.time;
          if (fresh) {
            e.hits++;
            penalty[k] += HIT_TIME;
          }
        }
        if (e.car.onGrass) e.lastGrass = this.time;
        const u = stationAt(track, e.car.x, e.car.y);
        if (u < 0) return;
        let du = u - e.u;
        if (du < -L / 2) du += L;
        else if (du > L / 2) du -= L;
        e.u = u;
        const m = du * M;
        e.dist += m;
        rewards[k] += PROGRESS_REWARD * (m < 0 ? 1 : this.rewards.progress ?? 1) * m * scale;
        // pasto: por cada rueda (car.grass: la fracción de las ruedas que lo pisan)
        const grassPen = GRASS_TIME * 4 * (e.car.grass ?? (e.car.onGrass ? 1 : 0)) * DT;
        penalty[k] += grassPen;
        e.grassPen += grassPen;
        e.epDist += m;
        e.back = m < 0 ? e.back - m : Math.max(0, e.back - m);
        // vueltas contadas desde donde arrancó el episodio (y el castigo que llevaba en cada una)
        while (e.dist - e.lapFrom >= e.marks.length * lapM) {
          e.marks.push(this.time);
          e.penMarks.push(e.penalty + penalty[k]);
          const t = e.marks.at(-1) - e.marks.at(-2);
          laps[k] = t;
          // la primera de una largada no es lanzada
          if (!(e.startLap && e.marks.length === 2)) {
            const ratio = t / this.idealLap(e);
            e.paceLaps.push(ratio);
            recordPace(this.id, ratio);
          }
        }
      });
    }
    const dt = DT * SUBSTEPS;
    // la zona de al lado: un auto encimado a lo largo y a menos de ZONE_MARGIN de costado (en el marco de cada uno)
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const [ahead, side] = this.rel(cars[i], cars[j]);
        if (Math.abs(ahead) < CAR_L && Math.abs(side) < CAR_W + ZONE_MARGIN) {
          for (const k of [i, j]) {
            cars[k].zone += dt;
            penalty[k] += ZONE_TIME * dt;
          }
        }
      }
    }
    cars.forEach((e, k) => {
      if (penalty[k]) {
        e.penalty += penalty[k];
        // el castigo como tiempo: lo que avanzaría en esos segundos a la velocidad media de la trazada
        rewards[k] -= PROGRESS_REWARD * ((track.length * M) / this.idealLap(e)) * penalty[k] * scale;
      }
      if (this.rewards.paceFloor) rewards[k] -= this.slow(e, dt) * this.rewards.paceFloor;
      if (e.partner) this.chasePass(e); // sólo se cuentan, sin premio
    });

    // arranque: termina cuando el primero llega a la línea, antes de la frenada
    if (this.scenario === 'start' && cars.some((e) => e.dist >= e.finishDist)) this.length = this.steps + 1;
    this.steps++;
    const truncated = this.steps >= this.length;
    const results = cars.map((e, k) => {
      const car = e.car;
      if (car.onGrass) {
        e.grass += dt;
        e.grassTime += dt;
      } else e.grass = 0;
      if (Math.abs(car.speed) < 1) {
        rewards[k] -= STALL_PENALTY * dt;
        e.stuck += dt;
      } else e.stuck = 0;
      e.steps++;
      const retired = !!car.damage.retired;
      if (retired) rewards[k] -= RETIRE_PENALTY;
      const rescue = !retired && (e.grass > GRASS_LIMIT || e.stuck > STUCK_LIMIT || e.back > BACKWARDS_LIMIT);
      if (rescue) {
        rewards[k] -= RESCUE_PENALTY;
        e.rescues++;
      }
      e.ret += rewards[k];
      const info = { lap: laps[k], track: this.id };
      if (truncated || retired) info.episode = this.episodeInfo(e, retired);
      return { obs: null, reward: rewards[k], done: retired, truncated: truncated && !retired, info, e, rescue, retired };
    });
    // rescatados: vuelven a la pista donde estaban, a un costado y despacio; los que abandonaron, arreglados y con un
    // episodio nuevo (sin medir más su largada)
    for (const r of results) {
      const e = r.e;
      if (r.retired) r.obs = this.observe(e);
      if (r.rescue || r.retired) {
        const old = e.car;
        const side = (this.rand() < 0.5 ? -1 : 1) * halfWidthAt(track, e.u) * M * 0.6;
        e.car = this.place(e.u, side, 10);
        Object.assign(e.car, { setup: old.setup, wear: old.wear, wearRate: old.wearRate, ownTune: old.ownTune, ownAir: old.ownAir,
          damageLevel: old.damageLevel, damage: r.retired ? NO_DAMAGE : old.damage });
        e.car.placeOn(track);
        Object.assign(e, { grass: 0, stuck: 0, back: 0, waiting: false });
        if (r.retired) {
          this.newEpisode(e);
          e.standing = e.startLap = false;
        }
      }
      if (r.retired) r.next = this.observe(e);
      else r.obs = this.observe(e);
      delete r.rescue;
      delete r.retired;
    }
    return results;
  }

  newEpisode(e) {
    super.newEpisode(e);
    // marks: cuándo completó cada vuelta, contando desde lapFrom (donde arrancó el episodio)
    Object.assign(e, { penalty: 0, penMarks: [0], zone: 0, grassPen: 0, paceLaps: [], grassTime: 0, marks: [this.time], lapFrom: e.dist, passDone: false, passFrom: null, passBonus: 0 });
  }

  // Pasada en la persecución: el de atrás pasa al de adelante y sigue adelante PASS_HOLD s sin que se toquen. Sólo se
  // cuenta (una vez por par), para ver: lo que se mide es el tiempo del de atrás
  chasePass(e) {
    const p = e.partner;
    if (e.front || e.passDone) return;
    const ahead = e.offset + e.dist > p.offset + p.dist; // e: el de atrás, que arrancó sin desventaja
    if (!ahead) {
      e.passFrom = null;
      return;
    }
    e.passFrom ??= this.time;
    if (Math.max(e.lastTouch, p.lastTouch) >= e.passFrom) {
      e.passFrom = this.time; // se tocaron: cuenta desde ahora
      return;
    }
    if (this.time - e.passFrom < PASS_HOLD) return;
    e.passDone = p.passDone = true;
    e.passes++;
    p.passed++;
  }

  // Lo que se informa al terminar el episodio: la medida (time: el tiempo con castigo contra el de la trazada, null si
  // no hubo con qué medirla) y, para ver, el tiempo sin castigo y el castigo por partes
  episodeInfo(e, retired) {
    const lapTimes = e.marks.slice(1).map((t, i) => t - e.marks[i]);
    const withPen = lapTimes.map((t, i) => t + e.penMarks[i + 1] - e.penMarks[i]);
    const mean = (xs) => (xs.length ? xs.reduce((a, x) => a + x, 0) / xs.length : null);
    const ideal = this.idealLap(e);
    let time = null;
    if (this.scenario === 'grid') {
      if (withPen.length >= 2) time = (withPen[0] + withPen[1]) / (e.startIdeal + ideal);
    } else if (this.scenario === 'start') {
      // hasta donde llegó, contra la trazada desde parado hasta ahí (si casi no avanzó, no hay con qué medir)
      const at = Math.min(e.startClock.length - 1, Math.floor(e.dist / this.track.meters));
      if (e.dist > 50 && !e.rescues) time = (this.time + e.penalty) / e.startClock[at];
    } else if (this.scenario === 'flying') {
      if (withPen.length >= 1) time = withPen[0] / e.startIdeal;
    } else if (this.scenario === 'chase') {
      if (!e.front && withPen.length >= 1) time = withPen[0] / ideal;
    } else if (withPen.length) time = mean(withPen) / ideal;
    // para ver: la vuelta 1 de una largada contra la trazada arrancando igual y, en la grilla, la 2 (sin castigo)
    const launch = e.startLap && lapTimes.length >= 1 ? lapTimes[0] / e.startIdeal : null;
    const lap2 = e.standing && lapTimes.length >= 2 ? lapTimes[1] / ideal : null;
    return { r: e.ret, l: e.steps, dist: e.epDist, track: this.id, scenario: this.scenario, damage: this.damage, retired,
      hits: e.hits, penalty: e.penalty, zone: e.zone, grassPen: e.grassPen, laps: e.epDist / (this.track.length * this.track.meters), passes: e.passes, front: e.front, rescues: e.rescues, danger: e.danger, grass: e.grassTime, pace: mean(e.paceLaps), paceLaps: e.paceLaps.length,
      time, launch, lap2 };
  }
}

const clamp = (v) => Math.max(-1, Math.min(1, Number.isFinite(v) ? v : 0));
