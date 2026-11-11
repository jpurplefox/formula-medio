// Measures a network in a race: 22 cars from the grid, half with the network and half with the classic AI
// (Difícil (hard) paces), alternating. When the first car completes the laps, they are ordered by distance covered.
//
//   node rl/race_eval.js models/v22/fase18.json [comma-separated tracks] [laps]
//
// Reports the average position of each group, how many places the network gained from the start, contacts between
// cars (each contact that starts after half a second without touching) (those involving the network), how many of
// those the network caused (hit the car ahead or squeezed the car alongside) and seconds on the grass (with two or
// more wheels; separately, with only one wheel off). To see how it starts: how much slower than its best lap the
// first lap of each network car is (from when it crosses the line; in single file, seconds are lost).
//
// With GAME=1 it is the game's race: every car with the network except one, the classic AI at the highest Difícil
// (hard) pace, acting as the player (starting from the middle). Reports contacts per network car, how many it
// caused, grass and how long the first car took to finish the laps (the pace). With DIFFICULTY (easy, normal, hard,
// expert) the networks get the grip and power of that difficulty in the game (src/race/teams.js) and the player,
// its highest pace.
//
// With DAMAGE (reduced or real) hits break things (damage.js): it also reports retirements and broken parts per race.
// With CONTACTS=1 it reports where the network's contacts happen: on which lap (its own), in the first seconds of the
// race, against the player, with how many cars nearby and how hard.
// With HITS=1 it reports how hard the hits on each part are (to tune STRENGTH in damage.js).
//
// With SPREAD (for example 0.05) each car on the grid is a little different, always the same for a given seed,
// and each race is run twice swapping which cars the network drives: that way no result depends on luck with the
// cars. Tyres wear as in the game (fully worn at the end of the race).

import { readFileSync } from 'node:fs';
import { Driver } from '../src/drivers/ai.js';
import { gridSlots } from '../src/race/grid.js';
import { Car, FUEL_PER_KM, limitsOn, TRACTION_CONTROL } from '../src/sim/car.js';
import { randomSetup, rng } from './env.js';
import { logHits } from '../src/sim/collision.js';
import { NeuralDriver, Policy } from '../src/drivers/policy.js';
import { racingLine } from '../src/sim/racingline.js';
import { trackHeading } from '../src/drivers/sensors.js';
import { loadTrack, TRACK_IDS } from './tracks.js';
import { RubberMap } from '../src/sim/rubber.js';
import { Race } from '../src/race/race.js';
import { DIFFICULTIES, rivalSetups } from '../src/race/teams.js';
import { damaged, setDamageRandom, zoneAt } from '../src/sim/damage.js';

const NET_TC = TRACTION_CONTROL[process.env.TC ?? 'low']; // TC=off|low|high: traction control of the network's cars
const NET_ABS = process.env.ABS !== '0'; // ABS=0: no ABS

const [file, ids, lapsArg] = process.argv.slice(2);
const policy = new Policy(JSON.parse(readFileSync(file, 'utf8')));
const profile = JSON.parse(readFileSync(new URL('../cars/f1-2025.json', import.meta.url), 'utf8'));
const DT = 1 / 60,
  CARS = Number(process.env.CARS ?? 22),
  LAPS = Number(lapsArg ?? 3);
const SPREAD = Number(process.env.SPREAD ?? 0);
const GAME = process.env.GAME === '1',
  PLAYER = Math.floor(CARS / 2);
const LEVEL = GAME && DIFFICULTIES.find((d) => d.id === process.env.DIFFICULTY);
const PACES = LEVEL ? [LEVEL.paces[0], LEVEL.paces[0]] : [1.06, 0.98]; // Difícil (hard)
const LEVEL_SETUPS = LEVEL && rivalSetups(LEVEL, CARS - 1);
const DAMAGE = process.env.DAMAGE ?? 'off';
const WHERE = process.env.CONTACTS === '1';
// hits per part and by what they hit (car or wall), for HITS=1
const HITS = process.env.HITS === '1' ? new Map() : null;
if (HITS) {
  logHits((car, lx, ly, hit, other) => {
    const key = `${zoneAt(lx, ly).part.padEnd(10)} vs ${other ? other.part : 'wall'}`;
    if (!HITS.has(key)) HITS.set(key, []);
    HITS.get(key).push(hit);
  });
}

function race(track, seed, swap) {
  const rand = rng(seed);
  // what is random inside the physics (crashes) is also seeded: the same network always gives the same result
  Math.random = rng(seed + 7);
  setDamageRandom(rng(seed + 11));
  const setups = Array.from({ length: CARS }, () => randomSetup(rand, SPREAD));
  const line = racingLine(track, limitsOn(profile, track), { brakeUse: 0.93 });
  const slots = gridSlots(track, CARS);
  let ai = 0;
  const entries = slots.map((s, k) => {
    const car = new Car(s.x, s.y, s.angle, profile);
    const net = GAME ? k !== PLAYER : k % 2 === (swap ? 1 : 0);
    if (SPREAD) car.setup = setups[k];
    if (LEVEL && net) car.setup = LEVEL_SETUPS[k < PLAYER ? k : k - 1];
    car.wearRate = 1 / (LAPS * track.length * track.meters);
    car.fuel = (FUEL_PER_KM * LAPS * (track.length * track.meters)) / 1000; // fuel, as in the game
    if (net) Object.assign(car, { tc: NET_TC, abs: NET_ABS }); // and the networks, with the aids they use in the game
    car.damageLevel = DAMAGE;
    const pace = PACES[0] + ((PACES[1] - PACES[0]) * ai) / (CARS / 2 - 1);
    if (!net) ai++;
    return {
      car,
      net,
      grid: k,
      driver: net ? new NeuralDriver(policy) : new Driver(pace, k + 1),
      cross: [], // when it crossed the line: at the start and at the end of each lap
      where: [],
      lastTouch: -1e9,
      hits: 0,
      fault: 0,
      grass: 0,
      wheel: 0,
    };
  });
  // the game's race (src/race/race.js): grid, start lights, starts, rubber, laps and order, the same as in main.js
  const rubber = new RubberMap(track, line.offset);
  for (const e of entries) e.car.rubber = rubber;
  const r = new Race({ track, entries, laps: LAPS, line, rubber, random: rand });
  while (!r.started) r.step(DT);
  for (; r.time < 600 && !r.finished.length;) {
    const bump = entries.map((e) => e.car.bump);
    for (const ev of r.step(DT)) if (ev.type === 'start' || ev.type === 'lap') ev.entry.cross.push(r.time);
    const t = r.time;
    entries.forEach((e, i) => {
      // a contact is one that starts after half a second without touching (a long rub counts once)
      const touch = e.carHit > 0,
        fresh = touch && t - e.lastTouch > 0.5;
      if (touch) e.lastTouch = t;
      if (fresh) {
        e.hits++;
        if (atFault(track, e, entries)) e.fault++;
        if (WHERE && e.net) {
          // its own lap (since it crossed the line), whether it was against the player and how many cars were
          // within 30 m
          const M = track.meters,
            dist = (o) => Math.hypot(o.car.x - e.car.x, o.car.y - e.car.y) * M;
          const near = entries.filter((o) => o !== e && dist(o) < 30).length;
          const other = entries.filter((o) => o !== e).reduce((a, o) => (dist(o) < dist(a) ? o : a));
          e.where.push({ lap: e.cross.length, t, player: !other.net, near, hit: e.car.bump - bump[i] });
        }
      }
      if (e.car.onGrass) e.grass += DT;
      else if (e.car.grass > 0) e.wheel += DT;
    });
  }
  const t = r.time;
  const order = r.order();
  order.forEach((e, p) => (e.pos = p + 1));
  const group = (net) => entries.filter((e) => e.net === net);
  const avg = (xs, f) => xs.reduce((a, e) => a + f(e), 0) / xs.length;
  // first lap against the best of the following ones, for the network cars that completed at least two
  const laps = (e) => e.cross.slice(1).map((c, k) => c - e.cross[k]);
  const lap1Of = (xs) => {
    const timed = xs.filter((e) => laps(e).length >= 2);
    return timed.length ? avg(timed, (e) => laps(e)[0] - Math.min(...laps(e).slice(1))) : 0;
  };
  const lap1 = lap1Of(group(true)),
    aiLap1 = lap1Of(group(false));
  // racing line lap (for comparison: first and best lap against it, network cars)
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
      .map((e) => (e.net ? 'net' : 'AI'))
      .join(' '),
    // damage: retirements, fully broken wings and punctured tyres
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

// Did e cause the contact? It hit the car ahead, or moved sideways into the car alongside faster than the other car
// closed in (like the penalty in rl/race.js)
function atFault(track, e, entries) {
  const M = track.meters,
    c = e.car,
    ca = Math.cos(c.angle),
    sa = Math.sin(c.angle);
  const h = trackHeading(track, e.st),
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
        `${id.padEnd(12)} contacts per car ${(r.hits / r.nets).toFixed(1)} (caused ${(r.fault / r.nets).toFixed(1)}) · grass per car ${(r.grass / r.nets).toFixed(1)} s (one wheel ${(r.wheel / r.nets).toFixed(1)} s) · 1st lap +${r.lap1.toFixed(1)} s · won in ${r.time.toFixed(1)} s · the player finished P${r.player}`,
      );
      continue;
    }
    console.log(
      `${id.padEnd(12)} mean position: net ${r.net.toFixed(1)}, AI ${r.ai.toFixed(1)} · places gained by the net ${r.gained.toFixed(1)} · net contacts ${r.hits} (caused ${r.fault}), AI ${r.aiHits} · net grass ${r.grass.toFixed(1)} s · podium ${r.podium}`,
    );
  }
}
const mean = (f) => (all.reduce((a, r) => a + f(r), 0) / all.length).toFixed(2);
if (DAMAGE !== 'off') {
  console.log(
    `damage per race: ${mean((r) => r.hurt)} cars with something broken · ${mean((r) => r.wings)} with a wrecked wing` +
      ` · ${mean((r) => r.flats)} punctures · ${mean((r) => r.out)} retirements`,
  );
}
if (WHERE) {
  const hits = all.flatMap((r) => r.where),
    n = hits.length || 1;
  const pct = (f) => `${((100 * hits.filter(f).length) / n).toFixed(0)} %`;
  const strong = hits.filter((h) => h.hit > 1).length;
  console.log(
    `network contacts: ${(hits.length / all.length).toFixed(0)} per race · before crossing the line ${pct((h) => h.lap === 0)}` +
      ` · 1st lap ${pct((h) => h.lap === 1)} · 2nd ${pct((h) => h.lap === 2)} · 3rd ${pct((h) => h.lap >= 3)}` +
      ` · first 30 s ${pct((h) => h.t < 30)} · first 60 s ${pct((h) => h.t < 60)}` +
      ` · against the player ${pct((h) => h.player)} · with 3 or more cars nearby ${pct((h) => h.near >= 3)}` +
      ` · hard (over 1 m/s) ${pct((h) => h.hit > 1)}, of those in the first 30 s ${strong ? ((100 * hits.filter((h) => h.hit > 1 && h.t < 30).length) / strong).toFixed(0) : 0} %`,
  );
  const sorted = hits.map((h) => h.hit).sort((a, b) => a - b),
    q = (p) => (sorted[Math.floor(p * (sorted.length - 1))] ?? 0).toFixed(2);
  console.log(`contact strength (m/s): median ${q(0.5)} · 90 % ${q(0.9)} · 99 % ${q(0.99)} · max ${q(1)}`);
}
if (HITS) {
  const pct = (xs, p) => xs[Math.min(xs.length - 1, Math.floor(p * xs.length))].toFixed(1);
  console.log('hits (m/s): count per race · median · 90 % · 99 % · max');
  for (const [key, xs] of [...HITS].sort((a, b) => b[1].length - a[1].length)) {
    xs.sort((a, b) => a - b);
    console.log(
      `  ${key.padEnd(30)} ${(xs.length / all.length).toFixed(1).padStart(6)} · ${pct(xs, 0.5)} · ${pct(xs, 0.9)} · ${pct(xs, 0.99)} · ${xs.at(-1).toFixed(1)}`,
    );
  }
}
if (GAME) {
  console.log(
    `total: contacts per car ${mean((r) => r.hits / r.nets)} (caused ${mean((r) => r.fault / r.nets)}) · grass per car ${mean((r) => r.grass / r.nets)} s (one wheel ${mean((r) => r.wheel / r.nets)} s) · 1st lap +${mean((r) => r.lap1)} s (player +${mean((r) => r.aiLap1)} s) · winner's time ${mean((r) => r.time)} s · player position ${mean((r) => r.player)}`,
  );
  if (process.env.LINE)
    console.log(
      `against the racing line: 1st lap +${mean((r) => r.vsLine[0])} s · best +${mean((r) => r.vsLine[1])} s · crosses the line at ${mean((r) => r.vsLine[2])} s`,
    );
  process.exit(0);
}
console.log(
  `total: mean position net ${mean((r) => r.net)}, AI ${mean((r) => r.ai)} · net contacts ${mean((r) => r.hits)} per race (caused ${mean((r) => r.fault)}) · net grass ${mean((r) => r.grass)} s · 1st lap +${mean((r) => r.lap1)} s`,
);
