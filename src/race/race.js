// A race: the grid with the start lights, the starts, the cars moving (sim/traffic.js), the retirements, the laps
// (valid if the whole lap was driven), the finish, the order and the gaps between cars. It is used by the game
// (main.js) and by the measurement of game-like races (rl/race_eval.js): that way both are the same race.
//
// Drivers come from outside (drivers/): any object with drive(dt, track, line, me, others) → { throttle, brake,
// steer }, where me and others are { car, st, lat }. Those that also have grid(dt, track, me, others) and seesLights
// (the player and the network that sees the start lights) handle their own start: on the grid they choose the revs
// (with revUp and revDown, or with the throttle) and start when they accelerate after the lights go out. The rest rev
// up to their own target and start with their own reaction time.
//
// Each entry is { car, driver, ... } (the rest, like the name or the color, belongs to whoever builds it). The race
// adds its own: lap (laps and times), st and lat (where it is on the track), dist (meters driven), out (when it
// retired) and the time it passed each point of the track (for the gap to the car ahead).
import { lightsAt, lightsDuration, LIGHTS_OUT, randomHold } from '../sim/lights.js';
import { LAUNCH_WINDOW } from '../sim/car.js';
import { sampleField, stationAt } from '../sim/track.js';
import { stepCars } from '../sim/traffic.js';

const VALID_LAP = 0.75; // a lap counts if it covered at least this fraction of the track without cutting corners
const PROGRESS_JUMP = 40; // cells: a bigger progress jump is a shortcut (or crossing the line in reverse)
/** @type {RaceEvent[]} */
const NO_EVENTS = []; // (nothing is ever added to it: emit builds a new list)

/**
 * A built track (sim/track.js).
 * @typedef {ReturnType<typeof import('../sim/track.js').buildTrackFromLayout>} Track
 */
/**
 * What a driver asks for in one step.
 * @typedef {{ throttle: number, brake: number, steer: number, revUp?: number, revDown?: number }} Input
 */
/**
 * Where a car is, as drivers see it: the car, its position along the centerline and sideways (cells).
 * @typedef {{ car: import('../sim/car.js').Car, st: number, lat: number }} CarState
 */
/**
 * The driver port (drivers/): the classic AI, the network and the player implement it. grid and seesLights, only
 * those that handle their own start.
 * @typedef {object} Driver
 * @property {(dt: number, track: Track, line: object, me: CarState, others: CarState[]) => Input} drive
 * @property {(dt: number, track: Track, me: object, others: object[]) => Input} [grid]
 * @property {boolean} [seesLights]
 */
/**
 * A car's laps: completed laps, whether it has started (crossed the line for the first time), the time of the
 * current lap and the last and best (s, null if there is none yet).
 * @typedef {{ laps: number, started: boolean, time: number, last: number | null, best: number | null,
 *   prevAlong: number, maxProgress: number }} Lap
 */
/**
 * A car in the race. car and driver are set by whoever builds it (plus anything else it wants: name, color...); the
 * rest, by the race.
 * @typedef {{ car: import('../sim/car.js').Car, driver: Driver, lap?: Lap, st?: number, lat?: number,
 *   dist?: number, out?: number, carHit?: number, [key: string]: any }} Entry
 */
/**
 * What happened in a step: 'start' (crossed the line for the first time), 'lap' (completed a lap in time s; best if
 * it is its best), 'invalid' (crossed without driving the whole lap), 'finish' (finished, in position place) and
 * 'retire'.
 * @typedef {{ type: 'start' | 'lap' | 'invalid' | 'finish' | 'retire', entry: Entry, time?: number,
 *   best?: boolean, place?: number }} RaceEvent
 */

// Position relative to the start line: along it (negative: before crossing it) and sideways (cells)
export function lineCoords(track, x, y) {
  const { line } = track;
  const ax = x - line.x,
    ay = y - line.y;
  return { along: ax * line.dx + ay * line.dy, side: -ax * line.dy + ay * line.dx };
}

const managesStart = (e) => typeof e.driver.grid === 'function' && e.driver.seesLights;

export class Race {
  // track: the track; entries: the cars, in the order in which they collide with each other (grid order doesn't
  // matter); laps: laps (Infinity: until stopped); line: the racing line the drivers follow; rubber: the track's
  // rubber (rubber.js) or null; random: the randomness of the start (the start lights hold and the reactions);
  // stays: the entry that stays on track even if it retires (the player: it stays where it stopped)
  /**
   * @param {object} o
   * @param {Track} o.track
   * @param {Entry[]} o.entries
   * @param {number} o.laps
   * @param {object} o.line
   * @param {import('../sim/rubber.js').RubberMap | null} [o.rubber]
   * @param {() => number} [o.random]
   * @param {Entry | null} [o.stays]
   */
  constructor({ track, entries, laps, line, rubber = null, random = Math.random, stays = null }) {
    this.track = track;
    this.entries = entries;
    this.laps = laps;
    this.line = line;
    this.rubber = rubber;
    this.stays = stays;
    /** @type {RaceEvent[]} */
    this.events = NO_EVENTS;
    this.time = 0; // seconds since the lights went out
    /** @type {{ entry: Entry, time: number }[]} */
    this.finished = []; // finishing order
    this.lightsTotal = this.countdown = lightsDuration(randomHold(random));
    const L = Math.ceil(track.path.st[track.path.n]);
    for (const e of entries) {
      const along = lineCoords(track, e.car.x, e.car.y).along;
      e.lap = { laps: 0, started: false, time: 0, last: null, best: null, prevAlong: along, maxProgress: 0 };
      e.dist = 0;
      e.out = undefined;
      // time it passed each centerline cell, lap after lap (see timePasses)
      e.passTimes = new Float32Array(L * ((Number.isFinite(laps) ? laps : 1) + 3)).fill(-1);
      e.lastPass = -1;
      e.waiting = false;
      // those that don't handle their own start rev up to their own target and react to the lights with their own time
      if (!managesStart(e))
        Object.assign(e, { revTarget: LAUNCH_WINDOW[0] - 300 + random() * 1500, react: 0.12 + random() * 0.22 });
      this.place(e);
    }
  }

  get started() {
    return this.countdown <= 0;
  }

  // the start lights now: lights on, since when and whether they already went out
  lights() {
    return lightsAt(this.lightsTotal - Math.max(0, this.countdown), this.lightsTotal);
  }

  // One step of dt seconds. Returns what happened: [{ type: 'start' | 'lap' | 'invalid' | 'finish' | 'retire', entry,
  // time?, best? }] ('start': crossed the line for the first time; 'lap': completed a lap in time s, best if it is
  // its best)
  /** @param {number} dt @returns {RaceEvent[]} */
  step(dt) {
    this.events = NO_EVENTS;
    if (this.countdown > 0) this.grid(dt);
    else this.run(dt);
    return this.events;
  }

  /** @param {RaceEvent} event */
  emit(event) {
    if (this.events === NO_EVENTS) this.events = [];
    this.events.push(event);
  }

  // With the start lights on the cars stay still on the grid, but they can rev up. When the lights go out, those that
  // handle their own start and are on the throttle release the clutch; the others, when they accelerate.
  grid(dt) {
    const { track, entries } = this;
    this.countdown -= dt;
    const lights = this.lights();
    for (const e of entries) {
      if (!managesStart(e)) {
        e.car.rev(dt, e.car.rpm < e.revTarget);
        continue;
      }
      e.car.lights = lights;
      const inp = (e.gridInput = e.driver.grid(dt, track, e, this.others(e)));
      if ('revUp' in inp) {
        e.car.revBy(dt, inp.revUp, inp.revDown);
        e.car.throttle = inp.throttle;
      } else e.car.rev(dt, inp.throttle);
    }
    if (this.countdown > 0) return;
    for (const e of entries) {
      if (!managesStart(e)) continue;
      e.car.lights = LIGHTS_OUT;
      if (e.gridInput.throttle > 0) e.car.launch();
      else e.waiting = true;
    }
  }

  run(dt) {
    const { track, line } = this;
    this.time += dt;
    // those that retired and were already removed from the track no longer count
    const racing = this.entries.filter((e) => e === this.stays || !e.car.gone);
    const states = racing.map((e) => this.place(e));
    const { hit } = stepCars(
      track,
      racing.map((e) => e.car),
      dt,
      (i) => {
        const e = racing[i];
        if (e.car.gone || !this.launched(e, dt)) return null;
        return e.driver.drive(
          dt,
          track,
          line,
          states[i],
          states.filter((_, j) => j !== i && !racing[j].car.gone),
        );
      },
    );
    // carHit: how hard it was hit by another car in this step (0: not at all), for whoever measures contacts
    for (const e of this.entries) e.carHit = 0;
    racing.forEach((e, i) => (e.carHit = hit[i]));
    for (const e of this.entries) {
      if (e.car.damage.retired && e.out === undefined) {
        e.out = this.time;
        this.emit({ type: 'retire', entry: e });
      }
      this.lapLine(e, dt);
      e.dist += Math.abs(e.car.speed) * dt;
    }
    this.rubber?.update(dt, states);
    this.timePasses();
  }

  // Has it started yet? The one waiting to accelerate starts when it accelerates; the one that reacts, when its
  // reaction time runs out. Meanwhile, on the grid, it only raises or lowers the revs.
  /** @param {Entry} e @param {number} dt */
  launched(e, dt) {
    if (e.waiting) {
      if (e.driver.grid(dt, this.track, e, this.others(e)).throttle <= 0) {
        e.car.rev(dt, false);
        return false;
      }
      e.car.launch();
      e.waiting = false;
    }
    if (e.react > 0) {
      e.react -= dt;
      e.car.rev(dt, e.car.rpm < e.revTarget);
      if (e.react <= 0) e.car.launch();
      return false;
    }
    return true;
  }

  /** @param {Entry} e */
  others(e) {
    return this.entries.filter((o) => o !== e);
  }

  // where the car is on the track: position along the centerline and sideways (cells), for the drivers and for the
  // race order
  /** @param {Entry} e @returns {CarState} */
  place(e) {
    const { track } = this;
    const st = stationAt(track, e.car.x, e.car.y);
    e.st = st >= 0 ? st : (e.st ?? 0);
    e.lat = sampleField(track.lat, track.W, e.car.x, e.car.y);
    return { car: e.car, st: e.st, lat: e.lat };
  }

  // Laps: each line crossing counts if the whole lap was driven (no shortcuts)
  /** @param {Entry} e @param {number} dt */
  lapLine(e, dt) {
    const { track } = this,
      r = e.lap;
    const { along, side } = lineCoords(track, e.car.x, e.car.y);
    const p = track.progress[Math.floor(e.car.y) * track.W + Math.floor(e.car.x)];
    if (p >= 0 && p <= r.maxProgress + PROGRESS_JUMP) r.maxProgress = Math.max(r.maxProgress, p);
    if (r.prevAlong < 0 && along >= 0 && Math.abs(side) < track.line.half) {
      if (!r.started) {
        r.started = true;
        this.emit({ type: 'start', entry: e });
      } else if (r.maxProgress > track.maxProgress * VALID_LAP) {
        r.laps++;
        r.last = r.time;
        const best = r.best === null || r.time < r.best;
        if (best) r.best = r.time;
        this.emit({ type: 'lap', entry: e, time: r.time, best });
        if (r.laps === this.laps) this.finish(e);
      } else this.emit({ type: 'invalid', entry: e });
      r.maxProgress = 0;
      r.time = 0;
    }
    r.prevAlong = along;
    if (r.started) r.time += dt;
  }

  /** @param {Entry} e */
  finish(e) {
    if (this.finished.some((f) => f.entry === e)) return;
    this.finished.push({ entry: e, time: this.time });
    this.emit({ type: 'finish', entry: e, place: this.finished.length });
  }

  // race distance (centerline cells): completed laps plus what was covered of the current one; before crossing the
  // line for the first time, negative (they are on the grid)
  /** @param {Entry} e */
  distance(e) {
    const L = this.track.path.st[this.track.path.n];
    return e.lap.started ? e.lap.laps * L + e.st : e.st - L;
  }

  // race order: first those that finished, in order; then by distance; those that retired, at the end (among them,
  // the one that went furthest first)
  /** @returns {Entry[]} */
  order() {
    const progress = (e) => {
      const done = this.finished.findIndex((f) => f.entry === e);
      return done >= 0 ? 1e9 - done : this.distance(e) - (e.out !== undefined ? 1e8 : 0);
    };
    return [...this.entries].sort((a, b) => progress(b) - progress(a));
  }

  // Timing: each car records the time it passed each centerline cell, lap after lap. That way the gap to the car
  // ahead is how long ago the car ahead passed where the car behind is now.
  timePasses() {
    const L = this.track.path.st[this.track.path.n];
    for (const e of this.entries) {
      const i = Math.floor(this.distance(e) + L);
      if (e.lastPass < 0) e.lastPass = i; // first record: from the grid
      // at the line, the lap and the position don't change in the same frame: a big jump is ignored
      if (i <= e.lastPass || i - e.lastPass > PROGRESS_JUMP || i >= e.passTimes.length) continue;
      e.passTimes.fill(this.time, Math.max(0, e.lastPass + 1), i + 1);
      e.lastPass = i;
    }
  }

  // Gap from car `behind` to the car ahead (`ahead`): { time } in seconds, { laps } if it was lapped, or null if it
  // can't be known yet
  /**
   * @param {Entry} ahead
   * @param {Entry} behind
   * @returns {{ time?: number, laps?: number } | null}
   */
  gap(ahead, behind) {
    const fa = this.finished.find((f) => f.entry === ahead),
      fb = this.finished.find((f) => f.entry === behind);
    if (fa && fb) return { time: fb.time - fa.time };
    const L = this.track.path.st[this.track.path.n];
    const da = this.distance(ahead),
      db = this.distance(behind);
    if (da - db > L) return { laps: Math.floor((da - db) / L) };
    const t = ahead.passTimes[Math.floor(db + L)];
    return t >= 0 && db > -L ? { time: this.time - t } : null;
  }
}
