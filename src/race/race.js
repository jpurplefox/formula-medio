// Una carrera: la grilla con el semáforo, las largadas, los autos andando (sim/traffic.js), los abandonos, las vueltas
// (válidas si se dio la vuelta entera), la llegada, el orden y la distancia entre autos. La usan el juego (main.js)
// y la medición de carreras como las del juego (rl/race_eval.js): así las dos son la misma carrera.
//
// Los pilotos vienen de afuera (drivers/): cualquier objeto con drive(dt, track, line, me, others) → { throttle,
// brake, steer }, donde me y others son { car, st, lat }. Los que además tienen grid(dt, track, me, others) y
// seesLights (el jugador y la red que ve el semáforo) manejan su largada: en la grilla deciden las vueltas (con
// revUp y revDown, o con el acelerador) y largan cuando aceleran con las luces apagadas. Los demás suben hasta unas
// vueltas propias y largan con su tiempo de reacción.
//
// Cada entrada es { car, driver, ... } (lo demás, como el nombre o el color, es de quien la arma). La carrera le
// agrega lo suyo: lap (vueltas y tiempos), st y lat (dónde está sobre la pista), dist (metros andados), out (cuándo
// abandonó) y la hora de paso por cada punto de la pista (para la distancia con el de adelante).
import { lightsAt, lightsDuration, LIGHTS_OUT, randomHold } from '../sim/lights.js';
import { LAUNCH_WINDOW } from '../sim/car.js';
import { sampleField, stationAt } from '../sim/track.js';
import { stepCars } from '../sim/traffic.js';

const VALID_LAP = 0.75; // una vuelta vale si recorrió al menos esta parte del circuito sin cortar camino
const PROGRESS_JUMP = 40; // celdas: un salto de progreso mayor es un atajo (o cruzar la línea marcha atrás)
const NO_EVENTS = Object.freeze([]);

// Posición respecto de la línea de largada: a lo largo (negativo: antes de cruzarla) y de costado (celdas)
export function lineCoords(track, x, y) {
  const { line } = track;
  const ax = x - line.x,
    ay = y - line.y;
  return { along: ax * line.dx + ay * line.dy, side: -ax * line.dy + ay * line.dx };
}

const managesStart = (e) => typeof e.driver.grid === 'function' && e.driver.seesLights;

export class Race {
  // track: el circuito; entries: los autos, en el orden en que chocan entre sí (el de la grilla da igual);
  // laps: vueltas (Infinity: hasta que se deje); line: la trazada por la que manejan los pilotos; rubber: la goma de
  // la pista (rubber.js) o null; random: el azar de la largada (la espera del semáforo y las reacciones);
  // stays: la entrada que queda en pista aunque abandone (el jugador: se queda donde paró)
  constructor({ track, entries, laps, line, rubber = null, random = Math.random, stays = null }) {
    Object.assign(this, { track, entries, laps, line, rubber, stays });
    this.time = 0; // segundos desde que se apagaron las luces
    this.finished = []; // orden de llegada: { entry, time }
    this.lightsTotal = this.countdown = lightsDuration(randomHold(random));
    const L = Math.ceil(track.path.st[track.path.n]);
    for (const e of entries) {
      const along = lineCoords(track, e.car.x, e.car.y).along;
      e.lap = { laps: 0, started: false, time: 0, last: null, best: null, prevAlong: along, maxProgress: 0 };
      e.dist = 0;
      e.out = undefined;
      // hora de paso por cada celda de la línea central, vuelta tras vuelta (ver timePasses)
      e.passTimes = new Float32Array(L * ((Number.isFinite(laps) ? laps : 1) + 3)).fill(-1);
      e.lastPass = -1;
      e.waiting = false;
      // los que no manejan su largada suben hasta unas vueltas propias y reaccionan al semáforo con su tiempo
      if (!managesStart(e))
        Object.assign(e, { revTarget: LAUNCH_WINDOW[0] - 300 + random() * 1500, react: 0.12 + random() * 0.22 });
      this.place(e);
    }
  }

  get started() {
    return this.countdown <= 0;
  }

  // el semáforo ahora: luces prendidas, desde cuándo y si ya se apagaron
  lights() {
    return lightsAt(this.lightsTotal - Math.max(0, this.countdown), this.lightsTotal);
  }

  // Un paso de dt segundos. Devuelve lo que pasó: [{ type: 'start' | 'lap' | 'invalid' | 'finish' | 'retire', entry,
  // time?, best? }] ('start': cruzó la línea por primera vez; 'lap': completó una vuelta en time s, best si es su mejor)
  step(dt) {
    this.events = NO_EVENTS;
    if (this.countdown > 0) this.grid(dt);
    else this.run(dt);
    return this.events;
  }

  emit(event) {
    if (this.events === NO_EVENTS) this.events = [];
    this.events.push(event);
  }

  // Con el semáforo prendido los autos quedan quietos en la grilla, pero se puede subir de vueltas. Al apagarse, los
  // que manejan su largada y vienen acelerando sueltan el embrague; los que no, cuando aceleren.
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
    // los que abandonaron y ya sacaron de la pista no cuentan más
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
    // carHit: cuánto golpe se llevó contra otro auto en este paso (0: nada), para quien mida los toques
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

  // ¿Ya largó? El que esperaba a acelerar larga cuando acelera; el que reacciona, cuando se le termina la reacción.
  // Mientras tanto, en la grilla, sólo sube o baja las vueltas.
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

  others(e) {
    return this.entries.filter((o) => o !== e);
  }

  // dónde está el auto sobre la pista: posición sobre la línea central y de costado (celdas), para los pilotos y
  // para el orden de carrera
  place(e) {
    const { track } = this;
    const st = stationAt(track, e.car.x, e.car.y);
    e.st = st >= 0 ? st : (e.st ?? 0);
    e.lat = sampleField(track.lat, track.W, e.car.x, e.car.y);
    return { car: e.car, st: e.st, lat: e.lat };
  }

  // Las vueltas: cada cruce de la línea cuenta si dio la vuelta entera (sin atajos)
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

  finish(e) {
    if (this.finished.some((f) => f.entry === e)) return;
    this.finished.push({ entry: e, time: this.time });
    this.emit({ type: 'finish', entry: e, place: this.finished.length });
  }

  // distancia de carrera (celdas de la línea central): vueltas completas más lo recorrido de la actual; antes de
  // cruzar la línea por primera vez, negativa (están en la grilla)
  distance(e) {
    const L = this.track.path.st[this.track.path.n];
    return e.lap.started ? e.lap.laps * L + e.st : e.st - L;
  }

  // orden de carrera: primero los que llegaron, en orden; después por distancia; los que abandonaron, al final
  // (entre ellos, el que más anduvo)
  order() {
    const progress = (e) => {
      const done = this.finished.findIndex((f) => f.entry === e);
      return done >= 0 ? 1e9 - done : this.distance(e) - (e.out !== undefined ? 1e8 : 0);
    };
    return [...this.entries].sort((a, b) => progress(b) - progress(a));
  }

  // Cronometraje: cada auto anota a qué hora pasó por cada celda de la línea central, vuelta tras vuelta. Así la
  // distancia con el de adelante es cuánto hace que el de adelante pasó por donde está ahora el de atrás.
  timePasses() {
    const L = this.track.path.st[this.track.path.n];
    for (const e of this.entries) {
      const i = Math.floor(this.distance(e) + L);
      if (e.lastPass < 0) e.lastPass = i; // primera anotación: desde la grilla
      // en la línea, la vuelta y la posición no cambian en el mismo cuadro: un salto grande se ignora
      if (i <= e.lastPass || i - e.lastPass > PROGRESS_JUMP || i >= e.passTimes.length) continue;
      e.passTimes.fill(this.time, Math.max(0, e.lastPass + 1), i + 1);
      e.lastPass = i;
    }
  }

  // Distancia del auto `behind` con el de adelante (`ahead`): { time } en segundos, { laps } si le sacó vueltas,
  // o null si todavía no se puede saber
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
