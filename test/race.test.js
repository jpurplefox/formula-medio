// race/race.js: the game's race, from the grid to the finish.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { Driver } from '../src/drivers/ai.js';
import { HumanDriver } from '../src/drivers/human.js';
import { gridSlots } from '../src/race/grid.js';
import { Race } from '../src/race/race.js';
import { Car, limitsOn } from '../src/sim/car.js';
import { racingLine } from '../src/sim/racingline.js';
import { rng } from '../rl/env.js';
import { DT, PROFILE, track } from './helpers.js';

const t = track('monza');
const line = racingLine(t, limitsOn(PROFILE, t), { brakeUse: 0.93 });

// a race of `cars` cars with the classic AI (and, if asked, the player at the back of the grid)
function race({ cars = 4, laps = 1, human = null } = {}) {
  const slots = gridSlots(t, cars + (human ? 1 : 0));
  const entries = Array.from({ length: cars }, (_, i) => ({
    code: `IA${i}`,
    car: new Car(slots[i].x, slots[i].y, slots[i].angle, PROFILE).placeOn(t),
    driver: new Driver(1 - i * 0.02, i + 1),
  }));
  if (human) {
    const s = slots[cars];
    entries.push({ code: 'VOS', car: new Car(s.x, s.y, s.angle, PROFILE).placeOn(t), driver: human });
  }
  return new Race({ track: t, entries, laps, line, random: rng(5), stays: human ? entries.at(-1) : null });
}

// runs until until(race, events) returns true (or for maxTime s), collecting the events
function runUntil(r, until, maxTime = 300) {
  const events = [];
  for (let s = 0; s < maxTime / DT && !until(r, events); s++) events.push(...r.step(DT));
  return events;
}

describe('Race', () => {
  test('while the start lights are on nobody moves; the lights come on one by one and go out', () => {
    const r = race();
    const start = r.entries.map((e) => [e.car.x, e.car.y]);
    const lit = new Set();
    runUntil(r, () => r.started, 10);
    for (let i = 0; i < r.entries.length; i++) assert.deepEqual([r.entries[i].car.x, r.entries[i].car.y], start[i]);
    assert.ok(r.started && r.time === 0);
    // watching the lights of another identical race, step by step
    const again = race();
    while (!again.started) {
      lit.add(again.lights().lit);
      again.step(DT);
    }
    assert.deepEqual([...lit].sort(), [0, 1, 2, 3, 4, 5]);
    assert.equal(again.lights().out, true);
  });

  test('a one-lap race: everyone starts, crosses the line, completes the lap and finishes in order', () => {
    const r = race({ cars: 4, laps: 1 });
    const events = runUntil(r, (rr) => rr.finished.length === 4);
    const of = (type) => events.filter((e) => e.type === type);
    assert.equal(of('start').length, 4);
    assert.equal(of('lap').length, 4);
    assert.equal(of('finish').length, 4);
    assert.equal(of('invalid').length, 0);
    // the Monza lap, with the classic AI and starting from behind the line
    for (const e of of('lap')) assert.ok(e.time > 75 && e.time < 100, `lap in ${e.time.toFixed(1)} s`);
    // the race order is the finishing order, and each finish's position is its place
    assert.deepEqual(
      r.order().map((e) => e.code),
      r.finished.map((f) => f.entry.code),
    );
    assert.deepEqual(
      of('finish').map((e) => e.place),
      [1, 2, 3, 4],
    );
    for (let i = 1; i < 4; i++) assert.ok(r.finished[i].time >= r.finished[i - 1].time);
  });

  test('the gap to the car ahead: in seconds, and between finishers, the finishing gap', () => {
    const r = race({ cars: 3, laps: 1 });
    runUntil(r, (rr) => rr.time > 40);
    const [first, second] = r.order();
    const gap = r.gap(first, second);
    assert.ok(gap && gap.time >= 0 && gap.time < 10);
    runUntil(r, (rr) => rr.finished.length === 3);
    const [a, b] = r.finished;
    assert.ok(Math.abs(r.gap(a.entry, b.entry).time - (b.time - a.time)) < 1e-9);
  });

  test('a retirement is announced once, ends up last and, once stopped, is removed from the track', () => {
    const r = race({ cars: 3 });
    runUntil(r, (rr) => rr.time > 20);
    const out = r.order()[0];
    out.car.damage = { ...out.car.damage, retired: 'Suspensión rota' };
    const events = runUntil(r, () => out.car.gone, 30);
    assert.equal(events.filter((e) => e.type === 'retire').length, 1);
    assert.equal(r.order().at(-1), out);
    assert.ok(out.out > 20);
    // and once out it is not moved again
    const at = [out.car.x, out.car.y];
    runUntil(r, (rr) => rr.time > out.out + 10, 20);
    assert.deepEqual([out.car.x, out.car.y], at);
  });

  test('the player revs up on the grid and, if not on throttle when the lights go out, starts when on throttle', () => {
    const me = new HumanDriver();
    const r = race({ cars: 1, human: me });
    const mine = r.entries.at(-1).car;
    me.input = { throttle: 1, brake: 0, steer: 0 };
    runUntil(r, (rr) => rr.lights().lit === 3, 10);
    assert.ok(mine.rpm > 8000); // on the grid, full throttle: revs up without moving
    me.input = { throttle: 0, brake: 0, steer: 0 };
    runUntil(r, (rr) => rr.started, 10);
    runUntil(r, (rr) => rr.time > 2, 5);
    assert.ok(mine.speed === 0, 'it started without throttle');
    me.input = { throttle: 1, brake: 0, steer: 0 };
    runUntil(r, (rr) => rr.time > 4, 5);
    assert.ok(mine.speed > 10);
  });
});
