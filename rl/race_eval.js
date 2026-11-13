// Mide una red en carrera: 22 autos desde la grilla, la mitad con la red y la mitad con la IA de siempre
// (ritmos de Difícil), intercalados. Cuando el primero completa las vueltas se ordenan por distancia recorrida.
//
//   node rl/race_eval.js models/v22/fase18.json [circuitos separados por coma] [vueltas]
//
// Informa la posición promedio de cada grupo, cuántos puestos ganó la red desde la largada, toques entre autos (cada
// contacto que empieza después de medio segundo sin tocarse)
// (en los que estuvo la red), cuántos de esos provocó la red (le pegó al de adelante o apretó al de al lado) y segundos
// en el pasto (con dos ruedas o más; aparte, con una sola rueda afuera). Para ver cómo larga: cuánto más lenta que su
// mejor vuelta es la primera de cada auto de la red (desde que cruza la línea; en fila india se pierden segundos).
//
// Con JUEGO=1 es la carrera del juego: todos los autos con la red salvo uno, la IA de siempre al ritmo más alto de
// Difícil, que hace de jugador (largando del medio). Informa toques por auto de la red, cuántos provocó, pasto y en
// cuánto tiempo terminó el primero las vueltas (el ritmo). Con DIFICULTAD (facil, normal, dificil, experto) las redes
// llevan el agarre y la potencia de esa dificultad en el juego (src/teams.js) y el jugador, su ritmo más alto.
//
// Con DANOS (reduced o real) los golpes rompen (damage.js): informa además abandonos y piezas rotas por carrera.
// Con TOQUES=1 informa dónde se dan los toques de la red: en qué vuelta (la suya), en los primeros segundos de la
// carrera, contra el jugador, con cuántos autos cerca y qué tan fuertes.
// Con GOLPES=1 informa qué tan fuertes son los golpes en cada pieza (para ajustar STRENGTH de damage.js).
//
// Con SPREAD (por ejemplo 0.05) cada auto de la grilla es un poco distinto, siempre igual para una misma semilla,
// y cada carrera se corre dos veces intercambiando qué autos maneja la red: así ningún resultado depende de la
// suerte con los autos. Las gomas se gastan como en el juego (del todo al terminar la carrera).

import { readFileSync } from 'node:fs';
import { Driver, gridSlots } from '../src/ai.js';
import { Car, FUEL_PER_KM, isSolid, LAUNCH_WINDOW, limitsOn, slipstream, TRACTION_CONTROL } from '../src/car.js';

const NET_TC = TRACTION_CONTROL[process.env.TC ?? 'low']; // TC=off|low|high: control de tracción de los autos de la red
const NET_ABS = process.env.ABS !== '0'; // ABS=0: sin ABS
import { LIGHTS_OUT, lightsAt, lightsDuration, randomHold } from '../src/lights.js';
import { randomSetup, rng } from './env.js';
import { collideCars, logHits } from '../src/collision.js';
import { NeuralDriver, Policy } from '../src/policy.js';
import { racingLine } from '../src/racingline.js';
import { trackHeading } from '../src/sensors.js';
import { sampleField, stationAt } from '../src/track.js';
import { loadTrack, TRACK_IDS } from './tracks.js';
import { RubberMap } from '../src/rubber.js';
import { DIFFICULTIES, rivalSetups } from '../src/teams.js';
import { damaged, setDamageRandom, zoneAt } from '../src/damage.js';

const [file, ids, lapsArg] = process.argv.slice(2);
const policy = new Policy(JSON.parse(readFileSync(file, 'utf8')));
const profile = JSON.parse(readFileSync(new URL('../cars/f1-2025.json', import.meta.url), 'utf8'));
const DT = 1 / 60,
  CARS = Number(process.env.CARS ?? 22),
  LAPS = Number(lapsArg ?? 3);
const SPREAD = Number(process.env.SPREAD ?? 0);
const GAME = process.env.JUEGO === '1',
  PLAYER = Math.floor(CARS / 2);
const LEVEL = GAME && DIFFICULTIES.find((d) => d.id === process.env.DIFICULTAD);
const PACES = LEVEL ? [LEVEL.paces[0], LEVEL.paces[0]] : [1.06, 0.98]; // Difícil
const LEVEL_SETUPS = LEVEL && rivalSetups(LEVEL, CARS - 1);
const DAMAGE = process.env.DANOS ?? 'off';
const WHERE = process.env.TOQUES === '1';
// golpes por pieza y por contra qué (auto o muro), para GOLPES=1
const HITS = process.env.GOLPES === '1' ? new Map() : null;
if (HITS) {
  logHits((car, lx, ly, hit, other) => {
    const key = `${zoneAt(lx, ly).part.padEnd(10)} contra ${other ? other.part : 'muro'}`;
    if (!HITS.has(key)) HITS.set(key, []);
    HITS.get(key).push(hit);
  });
}

function race(track, seed, swap) {
  const rand = rng(seed);
  // lo que es al azar dentro de la física (choques), también con semilla: la misma red da siempre lo mismo
  Math.random = rng(seed + 7);
  setDamageRandom(rng(seed + 11));
  const setups = Array.from({ length: CARS }, () => randomSetup(rand, SPREAD));
  const line = racingLine(track, limitsOn(profile, track), { brakeUse: 0.93 });
  const slots = gridSlots(track, CARS);
  const L = track.length;
  let ai = 0;
  const entries = slots.map((s, k) => {
    const car = new Car(s.x, s.y, s.angle, profile);
    const net = GAME ? k !== PLAYER : k % 2 === (swap ? 1 : 0);
    if (SPREAD) car.setup = setups[k];
    if (LEVEL && net) car.setup = LEVEL_SETUPS[k < PLAYER ? k : k - 1];
    car.wearRate = 1 / (LAPS * track.length * track.meters);
    car.fuel = (FUEL_PER_KM * LAPS * (track.length * track.meters)) / 1000; // la nafta, como en el juego
    if (net) Object.assign(car, { tc: NET_TC, abs: NET_ABS }); // y las redes, con las ayudas que llevan en el juego
    car.damageLevel = DAMAGE;
    const pace = PACES[0] + ((PACES[1] - PACES[0]) * ai) / (CARS / 2 - 1);
    if (!net) ai++;
    return {
      car,
      net,
      grid: k,
      driver: net ? new NeuralDriver(policy) : new Driver(pace, k + 1),
      u: stationAt(track, car.x, car.y),
      dist: -s.back,
      cross: [],
      where: [],
      lastTouch: -1e9,
      hits: 0,
      fault: 0,
      grass: 0,
      wheel: 0,
    };
  });
  const cars = entries.map((e) => e.car);
  // la goma, como en el juego: arranca con la franja de otra categoría y la carrera la marca (y agarra según cuánta haya)
  const rubber = new RubberMap(track, line.offset);
  for (const c of cars) c.rubber = rubber;
  // el semáforo, como en el juego (main.js): la IA de siempre (y las redes que no lo ven) sube hasta sus vueltas y
  // larga con su reacción; las redes que lo ven suben y bajan las vueltas ellas y largan al acelerar
  const total = lightsDuration(randomHold(rand));
  const sees = (e) => e.net && policy.lights;
  const rest = (e) => entries.filter((o) => o !== e);
  for (const e of entries)
    Object.assign(e, { revTarget: LAUNCH_WINDOW[0] - 300 + rand() * 1500, react: 0.12 + rand() * 0.22 });
  for (let c = 0; c < total; c += DT) {
    const lights = lightsAt(c, total);
    for (const e of entries) {
      if (sees(e)) {
        e.car.lights = lights;
        const inp = e.driver.grid(DT, track, e, rest(e));
        e.car.revBy(DT, inp.revUp, inp.revDown);
        e.car.throttle = inp.throttle;
      } else e.car.rev(DT, e.car.rpm < e.revTarget);
    }
  }
  for (const e of entries) {
    if (!sees(e)) continue;
    Object.assign(e.car, { lights: LIGHTS_OUT });
    e.react = 0;
    if (e.driver.input.throttle > 0) e.car.launch();
    else e.wait = true;
  }
  // antes de largar: la IA reacciona; la red que no venía acelerando, larga cuando acelera
  const started = (e) => {
    if (e.react > 0) {
      e.react -= DT;
      e.car.rev(DT, e.car.rpm < e.revTarget);
      if (e.react <= 0) e.car.launch();
      return false;
    }
    if (e.wait) {
      if (e.driver.grid(DT, track, e, rest(e)).throttle <= 0) {
        e.car.rev(DT, false);
        return false;
      }
      e.car.launch();
      e.wait = false;
    }
    return true;
  };
  let t = 0;
  for (; t < 600; t += DT) {
    const states = entries.map((e) => ({
      car: e.car,
      st: e.u,
      lat: sampleField(track.lat, track.W, e.car.x, e.car.y),
    }));
    const racing = cars.filter((c) => !c.gone); // los que abandonaron y ya sacaron no están más en la pista
    for (const c of racing) c.draft = slipstream(c, racing, track.meters);
    entries.forEach(
      (e, i) =>
        e.car.gone ||
        !started(e) ||
        e.car.update(
          DT,
          e.driver.drive(
            DT,
            track,
            line,
            states[i],
            states.filter((_, j) => j !== i && !entries[j].car.gone),
          ),
          track,
        ),
    );
    rubber.update(DT, states);
    const before = cars.map((c) => c.bump);
    collideCars(racing, track, isSolid);
    let leader = 0;
    entries.forEach((e, i) => {
      // un toque es un contacto que empieza después de medio segundo sin tocarse (un roce largo cuenta una vez)
      const touch = e.car.bump > before[i] + 0.05,
        fresh = touch && t - e.lastTouch > 0.5;
      if (touch) e.lastTouch = t;
      if (fresh) {
        e.hits++;
        if (atFault(track, e, entries)) e.fault++;
        if (WHERE && e.net) {
          // vuelta propia (desde que cruzó la línea), si fue contra el jugador y cuántos autos tenía a menos de 30 m
          const M = track.meters,
            dist = (o) => Math.hypot(o.car.x - e.car.x, o.car.y - e.car.y) * M;
          const near = entries.filter((o) => o !== e && dist(o) < 30).length;
          const other = entries.filter((o) => o !== e).reduce((a, o) => (dist(o) < dist(a) ? o : a));
          e.where.push({ lap: e.cross.length, t, player: !other.net, near, hit: e.car.bump - before[i] });
        }
      }
      if (e.car.onGrass) e.grass += DT;
      else if (e.car.grass > 0) e.wheel += DT;
      const u = stationAt(track, e.car.x, e.car.y);
      if (u < 0) return;
      let du = u - e.u;
      if (du < -L / 2) du += L;
      else if (du > L / 2) du -= L;
      e.u = u;
      e.dist += du * track.meters;
      // cuándo cruza la línea en cada vuelta
      while (e.dist >= e.cross.length * L * track.meters) e.cross.push(t);
      leader = Math.max(leader, e.dist);
    });
    if (leader >= LAPS * L * track.meters) break;
  }
  const order = [...entries].sort((a, b) => b.dist - a.dist);
  order.forEach((e, p) => (e.pos = p + 1));
  const group = (net) => entries.filter((e) => e.net === net);
  const avg = (xs, f) => xs.reduce((a, e) => a + f(e), 0) / xs.length;
  // primera vuelta contra la mejor de las siguientes, de los autos de la red que completaron al menos dos
  const laps = (e) => e.cross.slice(1).map((c, k) => c - e.cross[k]);
  const lap1Of = (xs) => {
    const timed = xs.filter((e) => laps(e).length >= 2);
    return timed.length ? avg(timed, (e) => laps(e)[0] - Math.min(...laps(e).slice(1))) : 0;
  };
  const lap1 = lap1Of(group(true)),
    aiLap1 = lap1Of(group(false));
  // vuelta de la trazada (para comparar: primera y mejor vuelta contra ella, autos de la red)
  const ideal = line.speed.reduce((a, v) => a + track.meters / Math.max(1, v), 0);
  const timed = group(true).filter((e) => laps(e).length >= 2);
  const vsLine = timed.length
    ? [
        avg(timed, (e) => laps(e)[0] - ideal),
        avg(timed, (e) => Math.min(...laps(e).slice(1)) - ideal),
        avg(timed, (e) => e.cross[0]),
      ]
    : [0, 0, 0];
  return {
    net: avg(group(true), (e) => e.pos),
    ai: avg(group(false), (e) => e.pos),
    gained: avg(group(true), (e) => e.grid + 1 - e.pos),
    hits: group(true).reduce((a, e) => a + e.hits, 0),
    fault: group(true).reduce((a, e) => a + e.fault, 0),
    aiHits: group(false).reduce((a, e) => a + e.hits, 0),
    grass: group(true).reduce((a, e) => a + e.grass, 0),
    wheel: group(true).reduce((a, e) => a + e.wheel, 0),
    podium: order
      .slice(0, 3)
      .map((e) => (e.net ? 'red' : 'IA'))
      .join(' '),
    // daños: abandonos, alerones rotos del todo y gomas pinchadas
    out: entries.filter((e) => e.car.damage.retired).length,
    wings: entries.filter((e) => [...e.car.damage.frontWing, ...e.car.damage.rearWing].some((x) => x >= 1)).length,
    flats: entries.reduce((a, e) => a + e.car.damage.tyre.filter((x) => x > 0).length, 0),
    hurt: entries.filter((e) => damaged(e.car.damage)).length,
    where: group(true).flatMap((e) => e.where),
    lap1,
    aiLap1,
    vsLine,
    time: t,
    nets: group(true).length,
    player: group(false)[0]?.pos,
  };
}

// ¿El toque lo provocó e? Le pegó al de adelante, o se le fue encima de costado al de al lado más rápido de lo que el
// otro se acercó (como el castigo de rl/race.js)
function atFault(track, e, entries) {
  const M = track.meters,
    c = e.car,
    ca = Math.cos(c.angle),
    sa = Math.sin(c.angle);
  const h = trackHeading(track, e.u),
    nx = -Math.sin(h),
    ny = Math.cos(h);
  const lat = (k) => {
    const a = Math.cos(k.angle),
      b = Math.sin(k.angle);
    return (a * k.speed - b * k.slip) * nx + (b * k.speed + a * k.slip) * ny;
  };
  return entries.some((o) => {
    if (o === e) return false;
    const dx = (o.car.x - c.x) * M,
      dy = (o.car.y - c.y) * M;
    const fwd = dx * ca + dy * sa,
      side = -dx * sa + dy * ca;
    if (fwd > 0 && fwd < 7 && Math.abs(side) < 2.5) return true;
    if (Math.abs(fwd) > 5.5 || Math.abs(side) > 4) return false;
    const dir = Math.sign(dx * nx + dy * ny);
    const mine = lat(c) * dir,
      theirs = -lat(o.car) * dir;
    return mine > 0.5 && mine >= theirs;
  });
}

const all = [];
for (const [n, id] of (ids ? ids.split(',') : TRACK_IDS).entries()) {
  for (const swap of SPREAD ? [false, true] : [false]) {
    const r = race(loadTrack(id), 1000 + n, swap);
    all.push(r);
    if (GAME) {
      console.log(
        `${id.padEnd(12)} toques por auto ${(r.hits / r.nets).toFixed(1)} (provocados ${(r.fault / r.nets).toFixed(1)}) · pasto por auto ${(r.grass / r.nets).toFixed(1)} s (una rueda ${(r.wheel / r.nets).toFixed(1)} s) · 1.ª vuelta +${r.lap1.toFixed(1)} s · ganó en ${r.time.toFixed(1)} s · el jugador terminó ${r.player}.º`,
      );
      continue;
    }
    console.log(
      `${id.padEnd(12)} posición media: red ${r.net.toFixed(1)}, IA ${r.ai.toFixed(1)} · puestos ganados por la red ${r.gained.toFixed(1)} · toques red ${r.hits} (provocados ${r.fault}), IA ${r.aiHits} · pasto red ${r.grass.toFixed(1)} s · podio ${r.podium}`,
    );
  }
}
const mean = (f) => (all.reduce((a, r) => a + f(r), 0) / all.length).toFixed(2);
if (DAMAGE !== 'off') {
  console.log(
    `daños por carrera: ${mean((r) => r.hurt)} autos con algo roto · ${mean((r) => r.wings)} con un alerón destrozado` +
      ` · ${mean((r) => r.flats)} pinchazos · ${mean((r) => r.out)} abandonos`,
  );
}
if (WHERE) {
  const hits = all.flatMap((r) => r.where),
    n = hits.length || 1;
  const pct = (f) => `${((100 * hits.filter(f).length) / n).toFixed(0)} %`;
  const strong = hits.filter((h) => h.hit > 1).length;
  console.log(
    `toques de la red: ${(hits.length / all.length).toFixed(0)} por carrera · antes de cruzar la línea ${pct((h) => h.lap === 0)}` +
      ` · 1.ª vuelta ${pct((h) => h.lap === 1)} · 2.ª ${pct((h) => h.lap === 2)} · 3.ª ${pct((h) => h.lap >= 3)}` +
      ` · primeros 30 s ${pct((h) => h.t < 30)} · primeros 60 s ${pct((h) => h.t < 60)}` +
      ` · contra el jugador ${pct((h) => h.player)} · con 3 o más autos cerca ${pct((h) => h.near >= 3)}` +
      ` · fuertes (más de 1 m/s) ${pct((h) => h.hit > 1)}, de esos en los primeros 30 s ${strong ? ((100 * hits.filter((h) => h.hit > 1 && h.t < 30).length) / strong).toFixed(0) : 0} %`,
  );
  const sorted = hits.map((h) => h.hit).sort((a, b) => a - b),
    q = (p) => (sorted[Math.floor(p * (sorted.length - 1))] ?? 0).toFixed(2);
  console.log(`fuerza de los toques (m/s): mediana ${q(0.5)} · 90 % ${q(0.9)} · 99 % ${q(0.99)} · máximo ${q(1)}`);
}
if (HITS) {
  const pct = (xs, p) => xs[Math.min(xs.length - 1, Math.floor(p * xs.length))].toFixed(1);
  console.log('golpes (m/s): cantidad por carrera · mediana · 90 % · 99 % · máximo');
  for (const [key, xs] of [...HITS].sort((a, b) => b[1].length - a[1].length)) {
    xs.sort((a, b) => a - b);
    console.log(
      `  ${key.padEnd(30)} ${(xs.length / all.length).toFixed(1).padStart(6)} · ${pct(xs, 0.5)} · ${pct(xs, 0.9)} · ${pct(xs, 0.99)} · ${xs.at(-1).toFixed(1)}`,
    );
  }
}
if (GAME) {
  console.log(
    `total: toques por auto ${mean((r) => r.hits / r.nets)} (provocados ${mean((r) => r.fault / r.nets)}) · pasto por auto ${mean((r) => r.grass / r.nets)} s (una rueda ${mean((r) => r.wheel / r.nets)} s) · 1.ª vuelta +${mean((r) => r.lap1)} s (jugador +${mean((r) => r.aiLap1)} s) · tiempo del ganador ${mean((r) => r.time)} s · jugador ${mean((r) => r.player)}.º`,
  );
  if (process.env.TRAZADA)
    console.log(
      `contra la trazada: 1.ª vuelta +${mean((r) => r.vsLine[0])} s · mejor +${mean((r) => r.vsLine[1])} s · cruza la línea a los ${mean((r) => r.vsLine[2])} s`,
    );
  process.exit(0);
}
console.log(
  `total: posición media red ${mean((r) => r.net)}, IA ${mean((r) => r.ai)} · toques red ${mean((r) => r.hits)} por carrera (provocados ${mean((r) => r.fault)}) · pasto red ${mean((r) => r.grass)} s · 1.ª vuelta +${mean((r) => r.lap1)} s`,
);
