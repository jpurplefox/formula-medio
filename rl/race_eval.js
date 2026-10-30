// Mide una red en carrera: 22 autos desde la grilla, la mitad con la red y la mitad con la IA de siempre
// (ritmos de Difícil), intercalados. Cuando el primero completa las vueltas se ordenan por distancia recorrida.
//
//   node rl/race_eval.js models/etapa2.json [circuitos separados por coma] [vueltas]
//
// Informa la posición promedio de cada grupo, cuántos puestos ganó la red desde la largada, toques entre autos
// (en los que estuvo la red) y segundos en el pasto.

import { readFileSync } from 'node:fs';
import { Driver, gridSlots } from '../src/ai.js';
import { Car, isSolid, slipstream } from '../src/car.js';
import { collideCars } from '../src/collision.js';
import { NeuralDriver, Policy } from '../src/policy.js';
import { racingLine } from '../src/racingline.js';
import { sampleField, stationAt } from '../src/track.js';
import { loadTrack, TRACK_IDS } from './tracks.js';

const [file, ids, lapsArg] = process.argv.slice(2);
const policy = new Policy(JSON.parse(readFileSync(file, 'utf8')));
const profile = JSON.parse(readFileSync(new URL('../cars/f1-2023.json', import.meta.url), 'utf8'));
const DT = 1 / 60, CARS = Number(process.env.CARS ?? 22), LAPS = Number(lapsArg ?? 3);
const PACES = [1.06, 0.98]; // Difícil

function race(track) {
  const line = racingLine(track, profile, { brakeUse: 0.93 });
  const slots = gridSlots(track, CARS);
  const L = track.length;
  let ai = 0;
  const entries = slots.map((s, k) => {
    const car = new Car(s.x, s.y, s.angle, profile);
    const net = k % 2 === 0;
    const pace = PACES[0] + ((PACES[1] - PACES[0]) * ai) / (CARS / 2 - 1);
    if (!net) ai++;
    car.throttle = 1;
    car.launch();
    return { car, net, grid: k, driver: net ? new NeuralDriver(policy) : new Driver(pace, k + 1), u: stationAt(track, car.x, car.y), dist: -s.back, hits: 0, grass: 0 };
  });
  const cars = entries.map((e) => e.car);
  for (let t = 0; t < 600; t += DT) {
    const states = entries.map((e) => ({ car: e.car, st: e.u, lat: sampleField(track.lat, track.W, e.car.x, e.car.y) }));
    for (const c of cars) c.draft = slipstream(c, cars, track.meters);
    entries.forEach((e, i) => e.car.update(DT, e.driver.drive(DT, track, line, states[i], states.filter((_, j) => j !== i)), track));
    const before = cars.map((c) => c.bump);
    collideCars(cars, track, isSolid);
    let leader = 0;
    entries.forEach((e, i) => {
      if (e.car.bump > before[i] + 0.05) e.hits++;
      if (e.car.onGrass) e.grass += DT;
      const u = stationAt(track, e.car.x, e.car.y);
      if (u < 0) return;
      let du = u - e.u;
      if (du < -L / 2) du += L;
      else if (du > L / 2) du -= L;
      e.u = u;
      e.dist += du * track.meters;
      leader = Math.max(leader, e.dist);
    });
    if (leader >= LAPS * L * track.meters) break;
  }
  const order = [...entries].sort((a, b) => b.dist - a.dist);
  order.forEach((e, p) => (e.pos = p + 1));
  const group = (net) => entries.filter((e) => e.net === net);
  const avg = (xs, f) => xs.reduce((a, e) => a + f(e), 0) / xs.length;
  return {
    net: avg(group(true), (e) => e.pos), ai: avg(group(false), (e) => e.pos),
    gained: avg(group(true), (e) => e.grid + 1 - e.pos),
    hits: group(true).reduce((a, e) => a + e.hits, 0), aiHits: group(false).reduce((a, e) => a + e.hits, 0),
    grass: group(true).reduce((a, e) => a + e.grass, 0),
    podium: order.slice(0, 3).map((e) => (e.net ? 'red' : 'IA')).join(' '),
  };
}

const all = [];
for (const id of ids ? ids.split(',') : TRACK_IDS) {
  const r = race(loadTrack(id));
  all.push(r);
  console.log(`${id.padEnd(12)} posición media: red ${r.net.toFixed(1)}, IA ${r.ai.toFixed(1)} · puestos ganados por la red ${r.gained.toFixed(1)} · toques red ${r.hits}, IA ${r.aiHits} · pasto red ${r.grass.toFixed(1)} s · podio ${r.podium}`);
}
const mean = (f) => (all.reduce((a, r) => a + f(r), 0) / all.length).toFixed(2);
console.log(`total: posición media red ${mean((r) => r.net)}, IA ${mean((r) => r.ai)} · toques red ${mean((r) => r.hits)} por carrera · pasto red ${mean((r) => r.grass)} s`);
