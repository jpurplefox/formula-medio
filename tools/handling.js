// Prueba de manejo sin pantalla, para ajustar la física de las gomas (car.js):
//   skidpad  en un círculo de radio fijo, sobre asfalto plano, el volante a fondo y la velocidad justa: cuánto dobla
//            el auto (aceleración lateral) comparado con lo que dice dynamics.js (lim.lateral). Tiene que dar ~1.
//   vueltas  la IA clásica (ai.js) solo en cada circuito, 3 vueltas: mejor vuelta, tiempo en el pasto, golpes y
//            trompos (giro de más de 90° entre la trompa y para dónde va).
//
//   node tools/handling.js [circuitos separados por coma | skidpad [volante 0..1]]
//   KEYBOARD=1 (acelerador y freno todo o nada y volante con toques, como con teclado)  TC=off|low|high (control de tracción)  ABS=1
//   PACE=1.06 (ritmo de la IA)  TUNE='{"front":10,"rear":1,"balance":5}' (puesta a punto)

import { readFileSync } from 'node:fs';
import { Driver } from '../src/drivers/ai.js';
import { gridSlots } from '../src/race/grid.js';
import { Car, keyboardSteer, limitsOn, TRACTION_CONTROL } from '../src/sim/car.js';
import { racingLine } from '../src/sim/racingline.js';
import { sampleField, stationAt } from '../src/sim/track.js';
import { loadTrack, TRACK_IDS } from '../rl/tracks.js';

const profile = JSON.parse(readFileSync(new URL('../cars/f1-2025.json', import.meta.url), 'utf8'));
const DT = 1 / 60,
  LAPS = 3,
  MAX_TIME = 400;

// asfalto plano e infinito (para el skidpad)
function flat() {
  const W = 64,
    H = 64,
    n = W * H;
  return {
    W,
    H,
    meters: 1e4,
    sdf: new Float32Array(n).fill(1e3),
    height: new Float32Array(n),
    runoff: 1e3,
    kerbs: [],
    air: undefined,
  };
}

// Skidpad: a cada velocidad, con el volante a fondo, la aceleración lateral que logra en régimen
function skidpad(steer = 1) {
  const track = flat();
  console.log('km/h   lateral  dynamics  razón   deriva°');
  for (const kmh of [60, 100, 150, 200, 250, 300]) {
    const v = kmh / 3.6;
    const car = new Car(32, 32, 0, profile);
    car.speed = v;
    let ay = 0,
      beta = 0,
      n = 0;
    for (let t = 0; t < 6; t += DT) {
      car.speed = v; // velocidad fija: sólo interesa lo lateral
      car.update(DT, { throttle: 0, brake: 0, steer }, track);
      if (t > 4) {
        ay += Math.abs(car.omega) * v;
        beta += Math.atan2(car.slip, car.speed);
        n++;
      }
    }
    const lat = car.limits.lateral(v);
    console.log(
      `${String(kmh).padStart(4)}  ${(ay / n).toFixed(1).padStart(7)}  ${lat.toFixed(1).padStart(8)}  ${(ay / n / lat).toFixed(2).padStart(5)}  ${(((beta / n) * 180) / Math.PI).toFixed(1).padStart(7)}`,
    );
  }
}

function laps(track) {
  const line = racingLine(track, limitsOn(profile, track), { brakeUse: 0.93 });
  const slot = gridSlots(track, 1)[0];
  const car = new Car(slot.x, slot.y, slot.angle, profile);
  car.tc = TRACTION_CONTROL[process.env.TC ?? 'off'];
  car.abs = !!process.env.ABS;
  if (process.env.TUNE) car.ownTune = JSON.parse(process.env.TUNE); // puesta a punto propia, p. ej. {"front":10,"rear":1,"balance":5}
  car.launch();
  car.throttle = 1;
  const driver = new Driver(+(process.env.PACE ?? 1.06), 1);
  let prev = stationAt(track, car.x, car.y),
    st = prev,
    last = null,
    grass = 0,
    tc = 0,
    taps = 0,
    keySteer = 0,
    hits = 0,
    spins = 0,
    wasSpun = false;
  const temps = [0, 0, 0, 0],
    hot = [0, 0, 0, 0];
  let locks = 0,
    slides = 0,
    steps = 0;
  const times = [];
  for (let t = 0; t < MAX_TIME && times.length < LAPS; t += DT) {
    const s = stationAt(track, car.x, car.y);
    if (s >= 0) st = s;
    const input = driver.drive(DT, track, line, { car, st, lat: sampleField(track.lat, track.W, car.x, car.y) }, []);
    if (process.env.KEYBOARD) {
      // como con teclado: el acelerador todo o nada y el volante con toques (las teclas se aprietan y sueltan para
      // promediar lo que pide la IA), que suben de a poco como en el juego
      input.throttle = input.throttle > 0 ? 1 : 0;
      input.brake = input.brake > 0.15 ? 1 : 0;
      taps += input.steer;
      const key = taps > 0.5 ? 1 : taps < -0.5 ? -1 : 0;
      taps -= key;
      keySteer = keyboardSteer(keySteer, key, car.speed, DT);
      input.steer = keySteer;
    }
    const bump = car.bump;
    car.update(DT, input, track);
    if (car.bump > bump + 0.05) hits++;
    if (car.onGrass) grass += DT;
    if (car.tcCut) tc += DT;
    if (car.locked[0] || car.locked[1]) locks += DT;
    if (car.wheelspin) slides += DT;
    if (times.length) {
      steps++;
      car.tyreTemp.forEach((x, i) => {
        temps[i] += x;
        hot[i] = Math.max(hot[i], x);
      });
    }
    const spun = Math.abs(car.slip) > Math.abs(car.speed) && Math.hypot(car.slip, car.speed) > 5;
    if (spun && !wasSpun) spins++;
    wasSpun = spun;
    const u = stationAt(track, car.x, car.y);
    if (u < 0) continue;
    if (u - prev < -track.length / 2) {
      if (last !== null) times.push(t - last);
      last = t;
    }
    prev = u;
  }
  return {
    times,
    grass,
    hits,
    spins,
    tc: tc / Math.max(1, times.length + 1),
    locks,
    slides,
    temps: temps.map((x, i) => `${Math.round(x / Math.max(1, steps))}/${Math.round(hot[i])}`),
  };
}

const tcNote = (tc) =>
  process.env.TC && process.env.TC !== 'off' ? `  control de tracción ${tc.toFixed(1)} s/vuelta` : '';
const arg = process.argv[2];
if (arg === 'skidpad') skidpad(+(process.argv[3] ?? 1));
else {
  for (const id of arg ? arg.split(',') : TRACK_IDS) {
    const { times, grass, hits, spins, tc, locks, slides, temps } = laps(loadTrack(id));
    const best = times.length ? Math.min(...times).toFixed(2) : '—';
    console.log(
      `${id.padEnd(12)} mejor ${best.padStart(7)}  vueltas ${times
        .map((l) => l.toFixed(1))
        .join(' ')
        .padEnd(
          17,
        )} pasto ${grass.toFixed(1)} s  golpes ${hits}  trompos ${spins}  bloqueos ${locks.toFixed(1)} s  patina ${slides.toFixed(1)} s  gomas °C media/máx ${temps.join(' ')}${tcNote(tc)}`,
    );
  }
}
