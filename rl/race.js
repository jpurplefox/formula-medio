// Fases 2 a 4: carreras con varios autos. Algunos autos aprenden (los "agentes", todos con la misma red: compite
// contra sí misma) y los demás son rivales que no aprenden: la IA de siempre (ai.js) con ritmos distintos o redes
// ya entrenadas (versiones anteriores).
//
// Cada carrera es un escenario (rl/CURRICULO.md), elegido al azar según la mezcla de la fase:
//   solo     agentes repartidos por la pista, sin rivales (repaso de la fase 1)
//   pack     grupos de 2 o 3 autos que llegan juntos a una curva: frenar sin llevarse a nadie puesto
//   start    largada con muchos autos, poco antes de una curva: pasarla sin chocar
//   chase    un rival más lento adelante (y a veces otro agente atrás), en recta o antes de una curva: pasarlo
//   race     carrera completa: largada o en fila, con rivales de todo tipo (consolidar)
// Los escenarios cortos duran pocos segundos: muchos más intentos por hora en las situaciones que importan.
//
// Recompensa de cada agente (la misma en todos los escenarios, así lo aprendido en uno vale en los demás):
//   + metros avanzados (en el pasto no cuentan); - pasto, muro, quedarse quieto, tener que ser rescatado
//   - toque con otro auto, según lo fuerte; mucho más si lo provocó él (le pegó al de adelante o apretó al de al lado)
//   - peligro: si al ritmo que se acerca alcanzaría al de adelante (o al de al lado) en menos de TTC segundos
//     (castiga el peligro, no la cercanía: ir pegado a la misma velocidad, a rebufo, está bien)
//   + pasada limpia: pasa a un auto cercano y sigue adelante PASS_HOLD segundos, sin tocar a nadie ni pisar el
//     pasto en ese rato, y con no más de 2 autos alrededor (en un pelotón la prioridad es no chocar)
//   - ser pasado limpio (bastante menos: defender sí, pero nunca a costa de un toque)
//   - zigzag defendiendo: en recta y con alguien pegado atrás, cambiar de dirección más de una vez
//   - ir lento con la pista libre (piso de ritmo, si la fase lo usa)
//   - largada lenta: perder en la primera vuelta desde parado más de lo que se permite (launch, si la fase lo usa)
//
// Cada fase puede escalar partes del premio (rewards: progress, pass, paceFloor, paceAlways, paceCrowd, crowd) y el castigo
// por toque provocado se multiplica por contactScale, que el entrenamiento ajusta solo según un presupuesto de
// toques (rl/train.py). progress (de 0 a 1, cuánto lleva la fase) achica la desventaja del rival en persecución.
// boost hace a los rivales más rápidos (ver el constructor).
//
// Cada auto es un poco distinto (motor, punta, agarre, frenos, desgaste: ± spread) y las gomas pueden estar
// gastadas; la red lo recibe como entradas. Con autos distintos, pasar y defender aparecen solos.
//
// Si un agente se queda en el pasto, quieto o va para atrás, vuelve a la pista ahí mismo con un castigo; la carrera
// sigue. Al terminar el tiempo del escenario termina la carrera para todos.
//
// Daños (damage): 'off', 'reduced', 'real' o 'mix' (cada escenario con uno de los tres al azar), para todos los autos
// de la carrera. Con damagedStarts, esa parte de los agentes arranca con algo roto (damage.js: randomDamage), así
// aprende a manejar un auto roto. Si un agente abandona, termina su episodio con un castigo (y no suma más: el
// resto de la carrera lo perdió) y vuelve a la pista con el auto arreglado; los rivales que abandonan, cuando
// quedan parados, salen de la pista.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Driver } from '../src/ai.js';
import { Car, DEFAULT_PROFILE, isSolid, limitsOn, RIVAL_AIDS, SAME_SETUP, slipstream } from '../src/car.js';
import { collideCars } from '../src/collision.js';
import { NeuralDriver, Policy } from '../src/policy.js';
import { racingLine } from '../src/racingline.js';
import { ACTIONS, OBS_SIZE, observe, stationAt, trackHeading } from '../src/sensors.js';
import { halfWidthAt, sampleField } from '../src/track.js';
import { pointOnCenter, randomSetup, randomTune, randomTyres, rng, TUNE_SPREAD } from './env.js';
import { NO_DAMAGE, randomDamage } from '../src/damage.js';
import { loadTrack } from './tracks.js';

const DT = 1 / 60;
const SUBSTEPS = 3;
const PROGRESS_REWARD = 0.02;
const GRASS_PENALTY = 0.1;
const WALL_PENALTY = 1;
const CAR_PENALTY = 6; // por un toque a fondo con otro auto, si le pegó él al de adelante
const CAR_PENALTY_HIT = 0.25; // fracción si le pegaron a él (algo de culpa siempre: que no se meta donde no hay lugar)
const TTC = 1; // s: tiempo hasta alcanzar al de adelante por debajo del cual hay peligro
const TTC_SIDE = 1; // s: lo mismo con el de al lado (con menos, esquiva hacia el costado y lo apreta)
// por decisión, con el choque inminente (proporcional a cuánto falta). Como mucho 0,6 por segundo: menos que lo que
// da avanzar a ritmo de curva, así levantar el pie con alguien cerca nunca conviene más que seguir corriendo
const DANGER_PENALTY = 0.03;
const ALONGSIDE = 5.5; // m adelante o atrás: hasta acá un auto está "al lado"
const CAR_WIDTH = 2; // m entre centros por debajo de los cuales dos autos de costado se tocan
const SQUEEZE_SPEED = 0.5; // m/s de costado hacia el otro: desde acá, en un toque de costado la culpa es suya
const PASS_REWARD = 1; // por pasada limpia
const PASSED_PENALTY = 0.3; // por ser pasado limpio
const PASS_GAP = 30; // m: sólo cuentan los cambios de orden entre autos cerca
const PASS_HOLD = 2.5; // s que tiene que seguir adelante para que la pasada cuente
const PASS_CLEAN = 2; // s antes de la pasada sin toques ni pasto
const CROWD_RANGE = 50,
  CROWD_MAX = 2; // con más de 2 autos a menos de 50 m, pasar no suma
const WEAVE_PENALTY = 0.5; // por cada cambio de dirección de más defendiendo en recta
const WEAVE_MOVE = 1.5; // m de costado: desde acá cuenta como movimiento
// Trabado, en el pasto o para atrás demasiado tiempo: se lo vuelve a poner en la pista (como el rescate del juego)
// con un castigo, pero el episodio sigue. Si terminara, quedarse quieto sería una salida barata de un
// amontonamiento: la red se ahorra los toques y el peligro que venían, y aprende a frenar en vez de salir de ahí
const GRASS_LIMIT = 6,
  STUCK_LIMIT = 6,
  BACKWARDS_LIMIT = 30,
  RESCUE_PENALTY = 4;
const STALL_PENALTY = 1; // por segundo casi quieto
const RETIRE_PENALTY = 10; // por abandonar
const DAMAGE_LEVELS = ['off', 'reduced', 'real'];
// Piso de ritmo: con la pista libre adelante, ir por debajo de PACE_FLOOR de la velocidad de la trazada se castiga
// (hasta PACE_PENALTY por segundo, proporcional a lo que le falta). Así frenar nunca es "seguro" sin motivo; con
// alguien adelante no aplica, porque seguir a uno más lento está bien
const PACE_FLOOR = 0.75,
  PACE_PENALTY = 1,
  FREE_ROAD = 40;
// Con paceAlways el piso cuenta también con alguien adelante (quedarse detrás de uno lento cuesta: hay que pasarlo),
// salvo en un amontonamiento: más de CROWD_CLOSE autos a menos de CROWD_NEAR m (largadas, pelotones). Ahí, con
// crowd, un toque provocado cuesta crowd veces más y el peligro se mira con TTC_CROWD veces más anticipación
const CROWD_NEAR = 30,
  CROWD_CLOSE = 3,
  TTC_CROWD = 1.5;
// Con paceCrowd (una fracción, como PACE_FLOOR) el piso también cuenta amontonado, pero más bajo: en una largada
// meterse en fila levantando el pie cuesta tiempo, así que si hay lugar conviene seguir a la par
// Largada (launch): desde parado, lo que la primera vuelta va perdiendo contra su ritmo de vuelta lanzada. Se
// permiten LAUNCH_START s de la salida desde parado más LAUNCH_LAP s repartidos en la vuelta: lo que perdía la fase 2
// de v6 (la primera vuelta de 7,5 a 10 s más lenta que la mejor), antes de aprender a no chocar haciendo fila. Pasado
// eso, cada segundo de más cuesta LAUNCH_PENALTY, y más cuanto más lleva perdido (×2 a LAUNCH_SCALE s de más): perder
// un poco es aceptable, mucho no. Para no castigar lo que ya cuesta ir más lento, el ritmo de vuelta lanzada es el
// de las vueltas recientes de los agentes en ese circuito (LAUNCH_PACE: el cuartil más rápido de las últimas)
const LAUNCH_START = 5,
  LAUNCH_LAP = 10,
  LAUNCH_PENALTY = 2,
  LAUNCH_SCALE = 3;
const LAUNCH_PACE = { laps: 60, min: 8, quantile: 0.25, initial: 1.08 };
// Persecución: desventaja del rival de adelante (menos agarre y motor) al principio y al final de la fase
const CHASE_HANDICAP = [0.2, 0.08];

// escenarios: duración (decisiones, a 20 por segundo)
export const SCENARIOS = { solo: 2400, pack: 300, start: 500, chase: 600, race: 2400 };

// vueltas lanzadas recientes de los agentes por circuito, como fracción de la vuelta de la trazada para su auto
const paces = new Map();
export function recordPace(id, ratio) {
  if (!paces.has(id)) paces.set(id, []);
  const xs = paces.get(id);
  xs.push(ratio);
  if (xs.length > LAUNCH_PACE.laps) xs.shift();
}
function paceOf(id) {
  const xs = paces.get(id);
  if (!xs || xs.length < LAUNCH_PACE.min) return LAUNCH_PACE.initial;
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.floor(LAUNCH_PACE.quantile * (sorted.length - 1))];
}

let profile = DEFAULT_PROFILE;
try {
  profile = JSON.parse(readFileSync(fileURLToPath(new URL('../cars/f1-2025.json', import.meta.url)), 'utf8'));
} catch {
  // sin el perfil medido, el de por defecto
}

// circuito, trazada ideal y dónde están las curvas (el punto más lento de cada una, en celdas)
const tracks = new Map();
export function getTrack(id) {
  if (!tracks.has(id)) {
    const track = loadTrack(id);
    const line = racingLine(track, limitsOn(profile, track), { brakeUse: 0.93 });
    // segundos hasta cada celda yendo a la velocidad de la trazada (para medir lo que se pierde en la largada)
    const clock = new Float64Array(line.speed.length + 1);
    line.speed.forEach((v, i) => (clock[i + 1] = clock[i] + track.meters / Math.max(1, v)));
    tracks.set(id, { track, line, clock, corners: corners(track, line) });
  }
  return tracks.get(id);
}

function corners(track, line) {
  const v = line.speed,
    n = v.length,
    M = track.meters;
  const near = Math.round(100 / M),
    far = Math.round(300 / M);
  const at = (i) => v[((i % n) + n) % n];
  const out = [];
  for (let i = 0; i < n; i++) {
    let min = true,
      top = 0;
    for (let d = -far; d <= far && min; d++) {
      if (Math.abs(d) <= near && at(i + d) < v[i]) min = false;
      top = Math.max(top, at(i + d));
    }
    if (min && v[i] < 0.85 * top && !out.some((u) => Math.abs(u - i) < near)) out.push(i);
  }
  return out;
}

const policies = new Map();
function getPolicy(file) {
  if (!policies.has(file)) {
    policies.set(
      file,
      new Policy(JSON.parse(readFileSync(fileURLToPath(new URL('../' + file, import.meta.url)), 'utf8'))),
    );
  }
  return policies.get(file);
}

export const wrap = (d, L) => (((d % L) + 1.5 * L) % L) - L / 2; // diferencia de posición en la vuelta, entre -L/2 y L/2
export const mod = (u, L) => ((u % L) + L) % L;

export class RaceSim {
  // agents: cuántos autos aprenden; opponents: redes que manejan algunos rivales; mix: peso de cada escenario
  // (en pasos de entrenamiento, no en carreras); spread: variación de los autos (raceSpread en carrera completa)
  constructor({
    trackIds,
    agents = 4,
    seed = 1,
    opponents = [],
    mix = { race: 1 },
    spread = 0.02,
    raceSpread = spread,
    rewards = {},
    contactScale = 1,
    progress = 0,
    boost = 0,
    damage = 'off',
    damagedStarts = 0,
    tuneSpread = TUNE_SPREAD,
  }) {
    this.tuneSpread = tuneSpread;
    this.damage = damage;
    this.damagedStarts = damagedStarts;
    // boost: los rivales con esa fracción más de agarre y potencia, y la IA de siempre a más ritmo (de 1 a 1,1):
    // para seguir mejorando el ritmo detrás de autos más rápidos que uno mismo
    this.boost = boost;
    this.rewards = { progress: 1, pass: 1, paceFloor: 0, paceAlways: 0, paceCrowd: 0, crowd: 1, launch: 0, ...rewards };
    this.contactScale = contactScale;
    this.progress = progress;
    this.trackIds = trackIds;
    this.agents = agents;
    this.rand = rng(seed);
    this.opponents = opponents.map(getPolicy);
    this.spread = spread;
    this.raceSpread = raceSpread;
    // cada escenario se elige según su peso dividido su duración: así el peso es la parte de los pasos
    this.mix = Object.entries(mix)
      .filter(([, w]) => w > 0)
      .map(([k, w]) => [k, w / SCENARIOS[k]]);
    this.mixTotal = this.mix.reduce((a, [, w]) => a + w, 0);
  }

  pickScenario() {
    let x = this.rand() * this.mixTotal;
    for (const [k, w] of this.mix) if ((x -= w) <= 0) return k;
    return this.mix[this.mix.length - 1][0];
  }

  // Ubica un auto en la posición u de la vuelta (celdas), corrido side metros a la derecha de la línea central
  place(u, side, speed) {
    const { track } = this;
    u = mod(u, track.length);
    const h = trackHeading(track, u);
    const { x, y } = pointOnCenter(track, u);
    const s = side / track.meters;
    const car = Object.assign(new Car(x - Math.sin(h) * s, y + Math.cos(h) * s, h, profile), RIVAL_AIDS); // con las ayudas del juego
    car.speed = speed;
    while (car.gear < car.gears && car.rpmAt(speed, car.gear) > profile.upshiftRpm) car.gear++;
    car.rpm = Math.max(4000, car.rpmAt(speed, car.gear));
    car.throttle = speed ? 0.5 : 1;
    if (!speed) car.launch();
    return car;
  }

  lineSpeed(u) {
    const v = this.line.speed;
    return v[Math.floor(mod(u, this.track.length)) % v.length];
  }

  // rival de la IA de siempre (pace: fracción de la trazada ideal) o, a veces, una red ya entrenada
  bot(k, pace = this.boost ? 1 + 0.1 * this.rand() : 0.9 + 0.18 * this.rand(), neural = 0) {
    if (this.opponents.length && this.rand() < neural)
      return new NeuralDriver(this.opponents[Math.floor(this.rand() * this.opponents.length)]);
    return new Driver(pace, k + 1);
  }

  reset() {
    const r = this.rand;
    const id = this.trackIds[Math.floor(r() * this.trackIds.length)];
    const { track, line, clock, corners } = getTrack(id);
    const scenario = this.pickScenario();
    const damage = this.damage === 'mix' ? DAMAGE_LEVELS[Math.floor(r() * 3)] : this.damage;
    Object.assign(this, {
      id,
      track,
      line,
      clock,
      corners,
      scenario,
      damage,
      steps: 0,
      time: 0,
      length: SCENARIOS[scenario],
    });
    const L = track.length,
      M = track.meters,
      half = track.halfWidth * M;
    const corner = () => (corners.length ? corners[Math.floor(r() * corners.length)] : r() * L);
    const spread = scenario === 'race' ? this.raceSpread : this.spread;
    const spots = []; // { kind, u, side (m), v (m/s), driver? }
    const agent = (u, side, v) => spots.push({ kind: 'agent', u, side, v });
    const bot = (u, side, v, driver) => spots.push({ kind: 'bot', u, side, v, driver });
    const A = this.agents;

    if (scenario === 'solo') {
      const front = r() * L;
      for (let k = 0; k < A; k++) {
        const u = front + (k * L) / A;
        agent(u, (r() - 0.5) * half, r() * 0.8 * this.lineSpeed(u));
      }
    } else if (scenario === 'pack') {
      // de a dos agentes (y a veces un rival) por curva, a 150-350 m de la frenada, a la par o uno atrás del otro
      const used = [];
      for (let k = 0; k < A; k += 2) {
        let c = corner();
        for (let t = 0; t < 5 && used.some((x) => Math.abs(wrap(x - c, L)) * M < 400); t++) c = corner();
        used.push(c);
        const u0 = c - (150 + 200 * r()) / M;
        const v = (0.85 + 0.15 * r()) * this.lineSpeed(u0);
        const group = Math.min(2, A - k) + (r() < 0.5 ? 1 : 0);
        const abreast = r() < 0.5; // los dos primeros a la par; si no, uno atrás del otro
        let back = 0;
        for (let j = 0; j < group; j++) {
          const side = abreast && j < 2 ? (j % 2 ? -1 : 1) * Math.min(2.2, half * 0.4) : (r() - 0.5) * half * 0.6;
          if (j > 0 && !(abreast && j === 1)) back += 6 + 9 * r();
          const u = u0 - back / M;
          const speed = v * (0.97 + 0.06 * r());
          if (j < Math.min(2, A - k)) agent(u, side, speed);
          else bot(u, side, speed, this.bot(spots.length));
        }
      }
    } else if (scenario === 'start') {
      // grilla de 12 a 20 autos, 250-500 m antes de una curva; los agentes en lugares al azar
      const total = A + 8 + Math.floor(r() * 9);
      const kinds = [...Array(A).fill('agent'), ...Array(total - A).fill('bot')];
      for (let i = kinds.length - 1; i > 0; i--) {
        const j = Math.floor(r() * (i + 1));
        [kinds[i], kinds[j]] = [kinds[j], kinds[i]];
      }
      const front = corner() - (250 + 250 * r()) / M;
      kinds.forEach((kind, k) => {
        const u = front - (k * 8) / M,
          side = (k % 2 ? -1 : 1) * Math.min(3, half * 0.5);
        if (kind === 'agent') agent(u, side, 0);
        else bot(u, side, 0, this.bot(k, undefined, 0.4));
      });
    } else if (scenario === 'chase') {
      // un rival lento adelante; atrás uno o dos agentes. En recta (saliendo de una curva) o antes de una curva
      const used = [];
      for (let k = 0; k < A;) {
        const two = A - k >= 2 && r() < 0.5;
        const straight = r() < 0.5;
        let c = corner();
        for (let t = 0; t < 5 && used.some((x) => Math.abs(wrap(x - c, L)) * M < 400); t++) c = corner();
        used.push(c);
        const u0 = straight ? c + (20 + 40 * r()) / M : c - (150 + 150 * r()) / M;
        const v = (straight ? 0.9 : 0.8 + 0.15 * r()) * this.lineSpeed(u0);
        // más lento: menos agarre, motor, frenos y punta, una desventaja que se achica a lo largo de la fase (primero
        // pasadas fáciles, con lugar de sobra; al final, más ajustadas). Maneja a su ritmo con ese auto
        const [h0, h1] = CHASE_HANDICAP;
        const h = (h0 + (h1 - h0) * Math.min(1, this.progress)) * (0.75 + 0.5 * r());
        const setup = { ...SAME_SETUP, grip: 1 - h, power: 1 - h, brakes: 1 - h / 2, topSpeed: 1 - h / 3 };
        const slow = this.bot(spots.length, 0.93 + 0.04 * r());
        bot(u0, (r() - 0.5) * half * 0.5, v * (1 - h / 2), slow);
        spots[spots.length - 1].setup = setup;
        let gap = (straight ? 10 + 20 * r() : 12 + 25 * r()) / M;
        for (let j = 0; j < (two ? 2 : 1); j++) {
          agent(u0 - gap, (r() - 0.5) * half * 0.6, v * (1 + 0.05 * r()));
          gap += (10 + 15 * r()) / M;
        }
        k += two ? 2 : 1;
      }
    } else {
      // carrera completa: grilla o en fila, con 0 a 14 rivales de todo tipo
      const total = A + Math.floor(r() * 15);
      const kinds = [...Array(A).fill('agent'), ...Array(total - A).fill('bot')];
      for (let i = kinds.length - 1; i > 0; i--) {
        const j = Math.floor(r() * (i + 1));
        [kinds[i], kinds[j]] = [kinds[j], kinds[i]];
      }
      const grid = r() < 0.5;
      let u = r() * L;
      kinds.forEach((kind, k) => {
        const side = grid ? (k % 2 ? -1 : 1) * Math.min(3, half * 0.5) : (r() - 0.5) * half;
        const v = grid ? 0 : (0.5 + 0.4 * r()) * this.lineSpeed(u);
        if (kind === 'agent') agent(u, side, v);
        else bot(u, side, v, this.bot(k, undefined, 0.4));
        u -= (grid ? 8 : 8 + r() * 35) / M;
      });
    }

    const front = Math.max(...spots.map((s) => s.u));
    this.cars = spots.map((s) => {
      const car = this.place(s.u, s.side, s.v);
      car.setup = s.setup ?? randomSetup(r, spread);
      // los rivales más rápidos (salvo los que ya traen su auto, como el de adelante en las persecuciones)
      if (s.kind === 'bot' && !s.setup && this.boost) {
        car.setup = {
          ...car.setup,
          grip: car.setup.grip * (1 + this.boost),
          power: car.setup.power * (1 + this.boost),
        };
      }
      // la puesta a punto y el aire varían sólo para los que aprenden: los demás manejan para la del circuito
      if (s.kind === 'agent') randomTune(car, r, track, this.tuneSpread);
      else car.placeOn(track);
      randomTyres(car, r, track);
      car.damageLevel = damage;
      if (s.kind === 'agent' && damage !== 'off' && r() < this.damagedStarts) car.damage = randomDamage(r, damage);
      const e = {
        kind: s.kind,
        car,
        u: stationAt(track, car.x, car.y),
        start: wrap(s.u - front, L) * M,
        dist: 0,
        lastHit: -1e9,
        lastGrass: -1e9,
      };
      if (s.kind === 'bot') {
        e.driver = s.driver;
        // la IA de siempre no sabe de su auto: con menos agarre, menos ritmo (la velocidad en curva va con su raíz)
        if (e.driver.pace) e.driver.pace *= Math.sqrt(Math.min(1, car.setup.grip));
      } else {
        this.newEpisode(e);
        // largando parado: se mide cuánto tiempo pierde en la primera vuelta contra la trazada
        if (!s.v) e.launch = { from: e.dist, clock: this.launchClock(car, e.u), worst: 0 };
      }
      return e;
    });
    this.agentsList = this.cars.filter((e) => e.kind === 'agent');
    this.ahead = new Map(); // "i,j" → si i iba adelante de j
    this.pending = []; // pasadas a confirmar: { passer, passed, t, clean }
    return this.agentsList.map((e) => this.observe(e));
  }

  newEpisode(e) {
    Object.assign(e, {
      grass: 0,
      stuck: 0,
      back: 0,
      ret: 0,
      steps: 0,
      lapStart: null,
      epDist: 0,
      lag: 0,
      lagRef: 0,
      launchCost: 0,
      passes: 0,
      passed: 0,
      hits: 0,
      faults: 0,
      slow: 0,
      danger: 0,
      weaves: 0,
      rescues: 0,
      defDir: 0,
      moves: 0,
      behind: 0,
      ext: undefined,
    });
  }

  observe(e) {
    return observe(
      this.track,
      e.car,
      e.u,
      this.cars.map((o) => o.car),
      new Float32Array(OBS_SIZE),
    );
  }

  raceDist(e) {
    return e.start + e.dist;
  }

  // o en el marco de e: [adelante, a la derecha] (m)
  rel(e, o) {
    const M = this.track.meters,
      { car } = e;
    const ca = Math.cos(car.angle),
      sa = Math.sin(car.angle);
    const dx = (o.car.x - car.x) * M,
      dy = (o.car.y - car.y) * M;
    return [dx * ca + dy * sa, -dx * sa + dy * ca];
  }

  // actions: [volante, pedal] de cada agente, en orden. Devuelve un resultado por agente, como RaceEnv.step
  step(actions) {
    const { track, line, cars } = this;
    const L = track.length,
      M = track.meters;
    const all = cars.map((e) => e.car);
    const rewards = new Float32Array(this.agentsList.length);
    const laps = this.agentsList.map(() => null);
    this.agentsList.forEach((e, k) => {
      const steer = clamp(actions[ACTIONS * k]),
        pedal = clamp(actions[ACTIONS * k + 1]);
      e.input = { steer, throttle: Math.max(0, pedal), brake: Math.max(0, -pedal) };
    });
    const states = cars.map((e) => ({ car: e.car, st: e.u, lat: sampleField(track.lat, track.W, e.car.x, e.car.y) }));
    for (let s = 0; s < SUBSTEPS; s++) {
      for (const c of all) c.draft = slipstream(c, all, M);
      cars.forEach((e, i) => {
        const input =
          e.kind === 'agent'
            ? e.input
            : e.driver.drive(
                DT,
                track,
                line,
                states[i],
                states.filter((_, j) => j !== i),
              );
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
        if (carHit) e.lastHit = this.time;
        if (e.car.onGrass) e.lastGrass = this.time;
        if (k >= 0) {
          rewards[k] -= WALL_PENALTY * e.wallHit;
          if (carHit) {
            const fault = this.hitAhead(e) || this.squeezed(e);
            const crowd = this.crowded(e) ? this.rewards.crowd : 1;
            rewards[k] -= CAR_PENALTY * carHit * (fault ? this.contactScale * crowd : CAR_PENALTY_HIT);
            e.hits++;
            if (fault) e.faults++;
          }
        }
        // avance sobre la línea central
        const u = stationAt(track, e.car.x, e.car.y);
        if (u < 0) return;
        let du = u - e.u;
        if (du < -L / 2) {
          du += L;
          if (k >= 0) {
            if (e.lapStart !== null) {
              laps[k] = this.time - e.lapStart;
              recordPace(this.id, laps[k] / this.idealLap(e));
            }
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
          if (!e.car.onGrass || m < 0) rewards[k] += PROGRESS_REWARD * (m < 0 ? 1 : this.rewards.progress) * m;
          e.epDist += m;
          e.back = m < 0 ? e.back - m : Math.max(0, e.back - m);
        }
      });
    }
    const dt = DT * SUBSTEPS;
    this.passes(rewards);
    this.agentsList.forEach((e, k) => {
      rewards[k] -= this.lag(e);
      rewards[k] -= this.danger(e, dt);
      rewards[k] -= this.weave(e, dt);
      if (this.rewards.paceFloor) rewards[k] -= this.slow(e, dt);
    });

    this.steps++;
    const truncated = this.steps >= this.length;
    const results = this.agentsList.map((e, k) => {
      const car = e.car;
      if (car.onGrass) {
        rewards[k] -= GRASS_PENALTY;
        e.grass += dt;
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
      if (truncated || retired) {
        info.episode = {
          r: e.ret,
          l: e.steps,
          dist: e.epDist,
          track: this.id,
          scenario: this.scenario,
          damage: this.damage,
          retired,
          passes: e.passes,
          passed: e.passed,
          hits: e.hits,
          faults: e.faults,
          slow: e.slow,
          lag: e.lag,
          lagRef: e.lagRef,
          launchCost: e.launchCost,
          danger: e.danger,
          weaves: e.weaves,
          rescues: e.rescues,
        };
      }
      return {
        obs: null,
        reward: rewards[k],
        done: retired,
        truncated: truncated && !retired,
        info,
        e,
        rescue,
        retired,
      };
    });
    // los rescatados vuelven a la pista donde estaban, a un costado y despacio, sin cortar el episodio (con su auto
    // como estaba); los que abandonaron, igual pero arreglados y con un episodio nuevo
    for (const r of results) {
      const e = r.e;
      if (r.retired) r.obs = this.observe(e);
      if (r.rescue || r.retired) {
        const old = e.car;
        const side = (this.rand() < 0.5 ? -1 : 1) * halfWidthAt(track, e.u) * M * 0.6;
        e.car = this.place(e.u, side, 10);
        Object.assign(e.car, {
          setup: old.setup,
          wear: old.wear,
          wearRate: old.wearRate,
          ownTune: old.ownTune,
          ownAir: old.ownAir,
          damageLevel: old.damageLevel,
          damage: r.retired ? NO_DAMAGE : old.damage,
        });
        e.car.placeOn(track);
        Object.assign(e, { grass: 0, stuck: 0, back: 0, launch: null });
        if (r.retired) this.newEpisode(e);
      }
      if (r.retired) r.next = this.observe(e);
      else r.obs = this.observe(e);
      delete r.rescue;
      delete r.retired;
    }
    // los rivales que abandonaron y ya quedaron parados salen de la carrera (y de las pasadas por confirmar)
    if (this.cars.some((e) => e.car.gone)) {
      this.cars = this.cars.filter((e) => !e.car.gone);
      this.ahead = new Map();
      this.pending = this.pending.filter((p) => !p.passer.car.gone && !p.passed.car.gone);
    }
    return results;
  }

  // Pasadas entre autos cercanos (al menos uno agente). Un cambio de orden queda pendiente PASS_HOLD segundos;
  // si sigue así, cuenta: premio al que pasó y castigo al pasado, sólo si fue limpia
  passes(rewards) {
    const { cars, time } = this;
    const reward = (e, x) => {
      const k = this.agentsList.indexOf(e);
      if (k >= 0) rewards[k] += x;
    };
    for (let i = 0; i < cars.length; i++) {
      for (let j = i + 1; j < cars.length; j++) {
        const a = cars[i],
          b = cars[j];
        if (a.kind !== 'agent' && b.kind !== 'agent') continue;
        const gap = this.raceDist(a) - this.raceDist(b);
        const key = `${i},${j}`,
          was = this.ahead.get(key),
          now = gap > 0;
        this.ahead.set(key, now);
        if (was === undefined || was === now || Math.abs(gap) > PASS_GAP) continue;
        const [passer, passed] = now ? [a, b] : [b, a];
        // si era una pasada pendiente al revés, se deshace
        const back = this.pending.findIndex((p) => p.passer === passed && p.passed === passer);
        if (back >= 0) {
          this.pending.splice(back, 1);
          continue;
        }
        const crowd = cars.filter((o) => o !== passer && Math.hypot(...this.rel(passer, o)) < CROWD_RANGE).length;
        this.pending.push({
          passer,
          passed,
          t: time,
          clean: crowd <= CROWD_MAX && time - passer.lastHit > PASS_CLEAN && time - passer.lastGrass > PASS_CLEAN,
        });
      }
    }
    this.pending = this.pending.filter((p) => {
      if (time - p.t < PASS_HOLD) return true;
      // en el rato que siguió tampoco tuvo que tocar a nadie ni irse al pasto
      if (p.clean && p.passer.lastHit < p.t && p.passer.lastGrass < p.t) {
        reward(p.passer, PASS_REWARD * this.rewards.pass);
        reward(p.passed, -PASSED_PENALTY * this.rewards.pass);
        if (p.passer.kind === 'agent') p.passer.passes++;
        if (p.passed.kind === 'agent') p.passed.passed++;
      }
      return false;
    });
  }

  // Peligro: el auto que tiene adelante en su carril, si al ritmo que se le acerca lo alcanza en menos de TTC
  danger(e, dt) {
    let worst = 0;
    const look = this.rewards.crowd > 1 && this.crowded(e) ? TTC_CROWD : 1;
    const TTC_AHEAD = TTC * look,
      TTC_LAT = TTC_SIDE * look;
    const { car } = e;
    const ca = Math.cos(car.angle),
      sa = Math.sin(car.angle);
    const vx = ca * car.speed - sa * car.slip,
      vy = sa * car.speed + ca * car.slip;
    for (const o of this.cars) {
      if (o === e) continue;
      const [fwd, side] = this.rel(e, o);
      if (fwd <= 0 || fwd > 40 || Math.abs(side) > 2.2) continue;
      const oc = Math.cos(o.car.angle),
        os = Math.sin(o.car.angle);
      const ovx = oc * o.car.speed - os * o.car.slip,
        ovy = os * o.car.speed + oc * o.car.slip;
      const closing = (vx - ovx) * ca + (vy - ovy) * sa;
      if (closing <= 0) continue;
      const ttc = Math.max(0, fwd - 5) / closing; // 5 m: el largo de un auto
      if (ttc < TTC_AHEAD) worst = Math.max(worst, 1 - ttc / TTC_AHEAD);
    }
    // de costado: el que tiene al lado, si se le va encima y a ese ritmo lo toca en menos de TTC_SIDE
    for (const o of this.cars) {
      if (o === e) continue;
      const [fwd, side] = this.rel(e, o);
      if (Math.abs(fwd) > ALONGSIDE || Math.abs(side) > 4) continue;
      const toward = this.lateralToward(e, o);
      if (toward <= 0) continue;
      const ttc = Math.max(0, Math.abs(side) - CAR_WIDTH) / toward;
      if (ttc < TTC_LAT) worst = Math.max(worst, 1 - ttc / TTC_LAT);
    }
    if (worst > 0) e.danger += dt;
    return DANGER_PENALTY * worst;
  }

  // Segundos hasta cada celda de la vuelta largando desde u parado (o a v0 m/s): la trazada para ese auto (más lenta
  // con menos agarre, como en el piso de ritmo), pero acelerando desde v0 con lo que da su motor
  launchClock(car, u, v0 = 0) {
    const { track } = this,
      L = track.length,
      M = track.meters,
      n = this.line.speed.length;
    const g = Math.sqrt(Math.min(1, car.setup.grip)),
      lim = car.limits;
    const clock = new Float32Array(L + 1);
    let v = v0;
    for (let i = 0; i < L; i++) {
      const cap = this.line.speed[(Math.floor(mod(u, L)) + i + 1) % n] * g;
      const next = Math.min(cap, Math.sqrt(v * v + 2 * Math.max(0, lim.accel(v)) * M));
      clock[i + 1] = clock[i] + (2 * M) / Math.max(1, v + next);
      v = next;
    }
    return clock;
  }

  // vuelta de la trazada para el auto de e (s; con menos agarre, más lenta, como en el piso de ritmo)
  idealLap(e) {
    return this.clock[this.clock.length - 1] / Math.sqrt(Math.min(1, e.car.setup.grip));
  }

  // Largada: lo que pierde en la primera vuelta desde parado (lag, s) contra su ritmo de vuelta lanzada en ese
  // circuito (lagRef: los segundos de trazada que lleva recorridos, para su auto). Deja de medirse al completar la
  // vuelta o si lo rescatan. Devuelve el castigo (con launch) por lo que pierde de más (ver LAUNCH_START)
  lag(e) {
    const { launch } = e;
    if (!launch) return 0;
    const L = this.track.length,
      M = this.track.meters;
    const d = e.dist - launch.from;
    if (d >= L * M) {
      e.launch = null;
      return 0;
    }
    const lap = this.idealLap(e);
    e.lagRef = launch.clock[Math.max(0, Math.floor(d / M))];
    e.lag = this.time - e.lagRef * paceOf(this.id);
    if (!this.rewards.launch) return 0;
    const excess = e.lag - LAUNCH_START - (LAUNCH_LAP * e.lagRef) / lap;
    if (excess <= launch.worst) return 0;
    const more = excess - Math.max(0, launch.worst);
    launch.worst = excess;
    if (excess <= 0) return 0;
    const cost = this.rewards.launch * LAUNCH_PENALTY * more * (1 + excess / LAUNCH_SCALE);
    e.launchCost += cost;
    return cost;
  }

  // Piso de ritmo: con nadie adelante en su carril a menos de FREE_ROAD metros (o siempre, con paceAlways, salvo en
  // un amontonamiento), por debajo de PACE_FLOOR de la velocidad de la trazada para su auto paga en proporción a lo
  // que le falta
  slow(e, dt) {
    const crowded = this.rewards.paceAlways && this.crowded(e);
    const free = this.rewards.paceAlways
      ? !crowded || this.rewards.paceCrowd > 0
      : !this.cars.some((o) => {
          if (o === e) return false;
          const [fwd, side] = this.rel(e, o);
          return fwd > 0 && fwd < FREE_ROAD && Math.abs(side) < 4;
        });
    const level = crowded ? this.rewards.paceCrowd : PACE_FLOOR;
    const floor = level * this.lineSpeed(e.u) * Math.sqrt(Math.min(1, e.car.setup.grip));
    if (!free || e.car.speed >= floor) return 0;
    e.slow += dt;
    return PACE_PENALTY * dt * (1 - Math.max(0, e.car.speed) / floor);
  }

  // Zigzag defendiendo: en recta, con un auto pegado atrás, el primer movimiento vale y volver también; cambiar
  // de dirección otra vez se castiga. Sin nadie atrás se reinicia la cuenta; en un pelotón no aplica
  weave(e, dt) {
    const { track } = this,
      M = track.meters;
    const behind = this.cars.some((o) => {
      if (o === e) return false;
      const [fwd, side] = this.rel(e, o);
      return fwd < -2 && fwd > -25 && Math.abs(side) < 4;
    });
    e.behind = behind ? 0 : e.behind + dt;
    if (e.behind > 2) {
      e.defDir = 0;
      e.moves = 0;
    }
    // posición de costado en la pista (m); ext: hasta dónde llegó en el último movimiento
    const lat = sampleField(track.lat, track.W, e.car.x, e.car.y) * M;
    // recta: el rumbo de la pista casi no cambia 50 m antes y 100 m después
    const h = (d) => trackHeading(track, e.u + d / M);
    const turn = (a, b) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
    // en un pelotón (más de 2 autos cerca) esquivar es lo que corresponde: la regla es para los duelos
    const crowd = this.cars.filter((o) => o !== e && Math.hypot(...this.rel(e, o)) < CROWD_RANGE).length;
    if (!behind || crowd > CROWD_MAX || turn(h(-50), h(0)) > 0.15 || turn(h(0), h(100)) > 0.15) {
      e.ext = lat;
      return 0;
    }
    e.ext ??= lat;
    const d = lat - e.ext;
    if (e.defDir === 0) {
      // primer movimiento: vale
      if (Math.abs(d) > WEAVE_MOVE) [e.defDir, e.ext] = [Math.sign(d), lat];
      return 0;
    }
    if (d * e.defDir > 0) {
      e.ext = lat; // sigue para el mismo lado
      return 0;
    }
    if (-d * e.defDir < WEAVE_MOVE) return 0;
    // cambió de dirección: volver a la trazada vale una vez; la siguiente ya es zigzag
    [e.defDir, e.ext] = [-e.defDir, lat];
    if (++e.moves < 2) return 0;
    e.weaves++;
    return WEAVE_PENALTY;
  }

  // Velocidad de e de costado (respecto de la pista) hacia o (m/s): positiva si se le va encima
  lateralToward(e, o) {
    const { track } = this,
      M = track.meters;
    const h = trackHeading(track, e.u);
    const nx = -Math.sin(h),
      ny = Math.cos(h);
    const lat = (c) => {
      const ca = Math.cos(c.angle),
        sa = Math.sin(c.angle);
      return (ca * c.speed - sa * c.slip) * nx + (sa * c.speed + ca * c.slip) * ny;
    };
    const dir = Math.sign((o.car.x - e.car.x) * M * nx + (o.car.y - e.car.y) * M * ny);
    return lat(e.car) * dir;
  }

  // ¿amontonamiento? más de CROWD_CLOSE autos a menos de CROWD_NEAR metros
  crowded(e) {
    let n = 0;
    for (const o of this.cars)
      if (o !== e && Math.hypot(...this.rel(e, o)) < CROWD_NEAR && ++n > CROWD_CLOSE) return true;
    return false;
  }

  // ¿apretó él a un auto que tenía al lado? Es culpa suya si se le fue encima más rápido de lo que el otro se acercó
  squeezed(e) {
    return this.cars.some((o) => {
      if (o === e) return false;
      const [fwd, side] = this.rel(e, o);
      if (Math.abs(fwd) > ALONGSIDE || Math.abs(side) > 4) return false;
      const mine = this.lateralToward(e, o);
      return mine > SQUEEZE_SPEED && mine >= this.lateralToward(o, e);
    });
  }

  // ¿había un auto justo adelante suyo (le pegó él)?
  hitAhead(e) {
    return this.cars.some((o) => {
      if (o === e) return false;
      const [fwd, side] = this.rel(e, o);
      return fwd > 0 && fwd < 7 && Math.abs(side) < 2.5;
    });
  }
}

const clamp = (v) => Math.max(-1, Math.min(1, Number.isFinite(v) ? v : 0));
