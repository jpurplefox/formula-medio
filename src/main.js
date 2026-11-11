import { TRACKS } from '../tracks/index.js';
import { buildTrackFromLayout, sampleField, stationAt, RIDGE } from './sim/track.js';
import { loadImage, buildTrack } from './load/trackimage.js';
import { Renderer, rgb } from './render/renderer.js';
import { GLRenderer } from './render/glrenderer.js';
import {
  Car,
  cornerGrip,
  DEFAULT_PROFILE,
  FUEL_PER_KM,
  isSolid,
  limitsOn,
  rearMargin,
  RIVAL_AIDS,
  TRACTION_CONTROL,
  wheelAngle,
} from './sim/car.js';
import { racingLine } from './sim/racingline.js';
import { boardTexture, treeTexture } from './render/sprites.js';
import { carModel, STEERING, TCAM, WHEEL_R } from './render/carmodel.js';
import { Driver } from './drivers/ai.js';
import { lineFrame, pointAt } from './sim/lineframe.js';
import { gridSlots } from './race/grid.js';
import { Cockpit } from './render/cockpit.js';
import { CAMERA_MODES, CAMERA_NAMES, Recorder, replayCamera, tvCameras } from './ui/replay.js';
import {
  DEFAULT_RIVALS,
  DIFFICULTIES,
  LAP_OPTIONS,
  RIVAL_OPTIONS,
  TEAMS,
  car as teamCar,
  gridOrder,
  rivalCars,
  rivalPaces,
  rivalSetups,
} from './race/teams.js';
import { EngineAudio } from './audio/audio.js';
import { GAME_NET, NeuralDriver, Policy } from './drivers/policy.js';
import { HumanDriver } from './drivers/human.js';
import { Gamepad } from './input/gamepad.js';
import { Keyboard } from './input/keyboard.js';
import { Hud, SHIFT_LIGHTS } from './ui/hud.js';
import { Race } from './race/race.js';
import { RubberMap } from './sim/rubber.js';
import { DESIGNS } from './render/teamliveries.js';
import { airDensity, carLimits, DEFAULT_TUNE, GRAVITY } from './sim/dynamics.js';
import { DAMAGE_LEVELS, NO_DAMAGE } from './sim/damage.js';
import { drawCar, drawShape, trackShape } from './ui/menuview.js';

const VIEW_W = 960;
const VIEW_H = 540;
const UI_SCALE = VIEW_W / 480; // los dibujos 2D (semáforo, volante) están pensados para 480 píxeles de ancho
const GHOST_STEP = 1 / 30;
const EYE_HEIGHT = 2.4; // vista exterior: metros sobre el piso
const CAM_BEHIND = 8; // vista exterior: metros detrás del centro del auto
const COCKPIT_EYE = 0.74; // vista de cabina: altura de los ojos del piloto (m)
const COCKPIT_BACK = 0.1; // vista de cabina: los ojos, detrás del centro del auto (m)
const WHEEL_TURN_RATE = 6; // 1/s: qué tan rápido sigue el volante a la dirección
const PADDLE_TIME = 0.2; // s: lo que dura el tirón de la leva al cambiar
const PADDLE_PULL = 0.018; // m: cuánto la acerca el piloto
const BUZZ = 0.05; // rad: lo que tiembla el volante en el pasto (en los pianos, la mitad)
// la cabeza se inclina con las mismas fuerzas que la carrocería, bastante más: hacia afuera en las curvas y hacia
// adelante al frenar (veces el rolido y el cabeceo de la suspensión)
const HEAD_ROLL = 6;
const HEAD_DIVE = 5;
const CAR_PROFILE = 'cars/f1-2025.json'; // ajustado con tools/calibrate.js
const REPLAY_DELAY = 6; // segundos de resultado antes de que empiece la repetición
const SETTINGS_KEY = 'formula-medio-settings';
const OLD_SETTINGS_KEY = 'raycast-racer-settings'; // de cuando el juego se llamaba Raycast Racer

// lo que se elige en el menú (se recuerda en el navegador): modo (carrera o contrarreloj), equipo y piloto (driver: 0
// el primero, 1 el segundo), dificultad,
// circuito, vueltas, cantidad de rivales, vista con la que se larga (view: cabina o exterior), daños (damage.js), volúmenes y tu puesta a punto en cada circuito donde la cambiaste (tunes).
// El sonido arranca siempre apagado (se prende con N o desde el menú) y eso no se recuerda.
const settings = {
  mode: 'race',
  team: 'hierrari',
  driver: 0,
  difficulty: 'dificil',
  track: TRACKS[0].id,
  laps: 3,
  rivals: DEFAULT_RIVALS,
  view: 'cockpit',
  damage: 'real',
  gearbox: 'auto',
  traction: 'high',
  abs: true,
  sound: false,
  volMaster: 0.8,
  volEngines: 1,
  volMusic: 0.6,
  tunes: {},
};
// ?prueba: las teclas 1 a 9 rompen piezas de tu auto y 0 lo arregla, para probar cómo maneja con daños
const DAMAGE_TEST = new URLSearchParams(location.search).has('prueba');
const MODES = [
  { value: 'race', label: 'Carrera' },
  { value: 'trial', label: 'Contrarreloj' },
];
// v: versión de lo guardado; antes de la 2 los rivales venían en 21 y se pasan a los 10 nuevos (uno por equipo)
const SETTINGS_VERSION = 2;
try {
  const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? localStorage.getItem(OLD_SETTINGS_KEY)) || {};
  if (!(saved.v >= SETTINGS_VERSION) || !RIVAL_OPTIONS.includes(saved.rivals)) delete saved.rivals;
  Object.assign(settings, saved, { sound: false, v: SETTINGS_VERSION });
} catch {
  // sin almacenamiento: quedan los valores por defecto
}
const saveSettings = () => {
  try {
    const { sound: _, ...kept } = settings;
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(kept));
  } catch {
    // no pasa nada si no se puede guardar
  }
};
const teamById = (id) => TEAMS.find((t) => t.id === id) || TEAMS[0];
const audio = new EngineAudio();

// aplica la configuración de sonido: prendido o apagado, volúmenes, y música si está el menú
function applySound() {
  audio.setVolumes({ master: settings.volMaster, engines: settings.volEngines, music: settings.volMusic });
  if (!settings.sound) {
    audio.stopAll();
    return;
  }
  audio.start();
  audio.playMusic(menuOpen());
}
// el navegador sólo deja arrancar el audio después de una tecla o un click
addEventListener('pointerdown', () => settings.sound && audio.start());

// la imagen se dibuja con la placa de video (WebGL) si se puede; si no (o con ?cpu en la dirección), con el
// procesador como antes
const canvas = document.getElementById('view');
let renderer = new URLSearchParams(location.search).has('cpu') ? null : GLRenderer.create(canvas, VIEW_W, VIEW_H);
if (!renderer) {
  canvas.width = VIEW_W;
  canvas.height = VIEW_H;
  renderer = new Renderer(canvas);
}
// encima, en un canvas aparte, lo que se dibuja en 2D: el volante y el semáforo
const overlay = document.getElementById('overlay');
overlay.width = VIEW_W;
overlay.height = VIEW_H;
const ctx = overlay.getContext('2d');

const $ = (id) => document.getElementById(id);
const hud = new Hud($, { ctx, scale: UI_SCALE, ghostStep: GHOST_STEP });

const ghostModel = carModel('#3aa0ff', '#ffffff');
// el modelo 3D de cada equipo se arma la primera vez que hace falta (la decoración tarda un poco)
const teamModels = new Map();
// el modelo de cada auto: { team, slot, number } (los dos de un equipo cambian el número y el color de la T)
// sharp: la decoración con el doble de resolución, para el auto propio (desde la cabina se ve de muy cerca)
const modelFor = ({ team: t, slot, number }, sharp = 1) => {
  const key = `${t.id}/${slot}/${sharp}`;
  if (!teamModels.has(key))
    teamModels.set(key, carModel(t.color, t.helmet, number, t.accent, TCAM[slot], { sharp, design: DESIGNS[t.id] }));
  return teamModels.get(key);
};
let wheelSpin = 0; // cuánto giraron las ruedas (rad), para animarlas
let lastDraw = 0;
const treeTex = treeTexture();
const boardTex = new Map([200, 150, 100, 50].map((d) => [d, boardTexture(d)]));
const cockpit = new Cockpit();
let cockpitView = true; // C alterna cabina / exterior; cada carrera larga con la vista elegida en el menú
let showGuide = true; // G muestra u oculta la trazada ideal
const guides = new WeakMap(); // trazada ideal de cada circuito, se calcula una vez
const AI_BRAKE_USE = 0.93; // los rivales frenan más al límite que la trazada que ves (que usa el 85%)
const aiLines = new WeakMap(); // trazada de los rivales de cada circuito
const tvCams = new WeakMap(); // cámaras de TV de cada circuito, para la repetición

// ---------- entrada ----------
const SHIFT_UP = ['KeyX', 'KeyE', 'KeyO'];
const SHIFT_DOWN = ['KeyZ', 'KeyQ', 'KeyU'];

const keyboard = new Keyboard(window, (e, names) => {
  if ((e.code.startsWith('Arrow') || e.code === 'Space') && !menuOpen()) e.preventDefault();
  // en el menú Enter lo maneja press (si no, además apretaría el botón que tiene el foco)
  if (e.code === 'Enter' && menuOpen()) e.preventDefault();
  if (settings.sound) audio.start(); // el navegador sólo deja arrancar el audio después de una tecla o un click
  if (e.code === 'KeyN' && !e.repeat) {
    toggleSound();
    hud.flash(settings.sound ? 'Sonido' : 'Silencio');
  }
  press(names, e.repeat);
});

// una tecla (o un botón del joystick, que se traduce a la tecla que hace lo mismo): names son sus nombres
function press(names, repeat = false) {
  const is = (...codes) => codes.some((c) => names.includes(c));
  if (menuOpen()) {
    // Enter: en la principal larga (o abre la tarjeta que tiene el foco); en las otras, vuelve
    const go = document.activeElement?.closest?.('[data-screen="main"] [data-go]');
    if (screen === 'main') {
      if (is('Enter')) go ? go.click() : startRace();
    } else if (is('Escape', 'Backspace', 'Enter')) showScreen('main');
    else if (is('ArrowLeft', 'ArrowRight') && document.activeElement?.type !== 'range')
      stepChoice(is('ArrowLeft') ? -1 : 1);
    return;
  }
  if (is('Escape') && game) {
    openMenu();
    return;
  }
  if (is('KeyR') && game) resetGame(game.track);
  if (!game || repeat) return;
  if (game.replay) {
    replayKey(game.replay, is);
    return;
  }
  // cambios, con la caja manual (se elige en el menú, no en carrera): X/E/O sube, Z/Q/U baja
  const dir = is(...SHIFT_UP) ? 1 : is(...SHIFT_DOWN) ? -1 : 0;
  if (dir && game.car.manual && !game.car.shift(dir)) hud.flash('Muy rápido para bajar');
  if (is('KeyC')) {
    cockpitView = !cockpitView;
    hud.flash(cockpitView ? 'Vista cabina' : 'Vista exterior');
  }
  if (is('KeyG')) {
    showGuide = !showGuide;
    hud.flash(showGuide ? 'Trazada ideal' : 'Sin trazada');
  }
  if (DAMAGE_TEST) testDamage(game.car, names);
}

// Teclas de prueba (?prueba): cada una rompe un poco más una pieza; 0 arregla todo
const TEST_KEYS = {
  Digit1: ['frontWing', 0, 'Alerón delantero izquierdo'],
  Digit2: ['frontWing', 1, 'Alerón delantero derecho'],
  Digit3: ['rearWing', 0, 'Alerón trasero izquierdo'],
  Digit4: ['rearWing', 1, 'Alerón trasero derecho'],
  Digit5: ['sidepod', 0, 'Pontón izquierdo'],
  Digit6: ['sidepod', 1, 'Pontón derecho'],
  Digit7: ['tyre', 2, 'Pinchazo trasera izquierda'],
  Digit8: ['suspension', 1, 'Suspensión delantera derecha'],
  Digit9: ['suspension', 0, 'Dirección rota'],
};
function testDamage(car, names) {
  if (names.includes('Digit0')) {
    car.damage = NO_DAMAGE;
    hud.flash('Auto arreglado');
    return;
  }
  const key = names.find((n) => TEST_KEYS[n]);
  if (!key) return;
  const [part, i, label] = TEST_KEYS[key],
    d = car.damage;
  const step = part === 'tyre' ? 1e-3 : key === 'Digit9' ? 1 : 0.35;
  const value = Math.min(1, d[part][i] + step);
  car.damage = {
    ...d,
    [part]: d[part].map((x, k) => (k === i ? value : x)),
    retired: key === 'Digit9' ? label : d.retired,
  };
  hud.flash(part === 'tyre' ? label : `${label} ${Math.round(value * 100)} %`);
}

function readInput(dt, speed) {
  // flechas, WASD o IJKL, más el joystick: lo que se pise más fuerte de los dos
  const k = keyboard.read(dt, speed);
  return {
    throttle: Math.max(k.throttle, pad.throttle),
    brake: Math.max(k.brake, pad.brake),
    steer: Math.max(-1, Math.min(1, k.steer + pad.steer)),
  };
}

// el joystick: Start abre el menú o, en el menú, larga
const pad = new Gamepad({
  onButton: (names) => press(names[0] === 'Start' ? [menuOpen() ? 'Enter' : 'Escape'] : names),
  onChange: (id) => {
    $('pad-status').textContent = id ? `Joystick: ${id}` : 'Joystick: ninguno (conectalo y apretá cualquier botón)';
    if (id && game) hud.flash('Joystick conectado');
  },
});

// ---------- estado del juego ----------
let game = null;
let lastGame = null; // la última carrera, para conservar el mejor tiempo y el fantasma al volver del menú
let carProfile = DEFAULT_PROFILE;
// Los rivales manejan con la red del juego (GAME_NET en policy.js); con ?ia=models/otra.json, con otra, y con
// ?ia=clasica, con la IA de siempre (ai.js), que es también la que queda si la red no carga
const IA_PARAM = new URLSearchParams(location.search).get('ia') || GAME_NET;
const NEURAL_URL = IA_PARAM === 'clasica' ? null : IA_PARAM;
let neuralPolicy = null;

function resetGame(track) {
  cockpitView = settings.view !== 'chase';
  const prev = game || lastGame;
  const prevBest = prev && prev.track === track ? prev.player.lap.best : null;
  const prevGhost = prev && prev.track === track ? prev.ghost : null;
  const team = teamById(settings.team);
  const difficulty = DIFFICULTIES.find((d) => d.id === settings.difficulty) || DIFFICULTIES[2];
  const trial = settings.mode === 'trial';
  // en contrarreloj no hay rivales
  const others = trial ? [] : rivalCars(team, settings.rivals, settings.driver);
  const paces = rivalPaces(difficulty, others.length),
    setups = rivalSetups(difficulty, others.length);
  // grilla: los rivales adelante (los mejores autos tienden a largar primero) y vos al final
  const slots = gridSlots(track, others.length + 1),
    grid = gridOrder(others.length);
  const spawn = slots[others.length];
  const car = Object.assign(new Car(spawn.x, spawn.y, spawn.angle, carProfile), {
    manual: settings.gearbox === 'manual',
    tc: TRACTION_CONTROL[settings.traction] ?? 0,
    abs: !!settings.abs,
    ownTune: settings.tunes[settings.track] ?? null,
  }).placeOn(track);
  const mine = teamCar(team, settings.driver);
  const player = {
    name: 'Vos',
    team: team.name,
    code: 'VOS',
    number: mine.number,
    color: team.color,
    car,
    driver: new HumanDriver(),
    model: modelFor(mine, 2),
    gridBack: spawn.back,
  };
  const rivals = others
    .map((o, i) => {
      const t = o.team,
        s = slots[grid[i]],
        c = Object.assign(new Car(s.x, s.y, s.angle, carProfile), RIVAL_AIDS).placeOn(track);
      // con la red, la dificultad es el auto: más o menos agarre y potencia
      if (neuralPolicy) c.setup = setups[i];
      return {
        name: o.name,
        team: t.name,
        code: o.code,
        number: o.number,
        color: t.color,
        car: c,
        driver: neuralPolicy ? new NeuralDriver(neuralPolicy) : new Driver(paces[i], i + 1),
        model: modelFor(o),
        spin: 0,
        gridBack: s.back,
      };
    })
    .sort((a, b) => a.gridBack - b.gridBack); // en orden de grilla: así los muestra la tabla antes de largar
  const wearRate = RACE_WEAR / (wearLaps({ trial, laps: settings.laps }) * track.length * track.meters);
  // nafta: en carrera, la justa para las vueltas que son (se va gastando y el auto se aliviana); en contrarreloj,
  // como en clasificación: unos kilos que no se gastan
  const fuel = trial
    ? { fuel: TRIAL_FUEL, fuelFlow: 0 }
    : { fuel: (FUEL_PER_KM * settings.laps * (track.length * track.meters)) / 1000 };
  for (const e of [...rivals, player]) Object.assign(e.car, { wearRate, damageLevel: settings.damage, ...fuel });
  game = {
    track,
    car,
    player,
    trial,
    laps: trial ? Infinity : settings.laps, // en contrarreloj se dan vueltas hasta que vuelvas al menú
    entries: [...rivals, player],
    recorder: new Recorder(others.length + 1), // la carrera, para la repetición
    replayIn: null, // cuánto falta para que empiece la repetición (cuando terminás)
    replay: null, // { t, mode, target, tv } mientras se ve la repetición
    resultsShown: false,
    rec: [],
    recClock: 0,
    ghost: prevGhost,
    progressLog: [],
    wrongWay: false,
  };
  hud.towerClock = 0;
  if (!guides.has(track)) guides.set(track, racingLine(track, limitsOn(carProfile, track)));
  // la goma arranca con la franja tenue de otra categoría sobre la trazada y la carrera la va marcando
  game.rubber = new RubberMap(track, guides.get(track).offset);
  for (const e of game.entries) e.car.rubber = game.rubber; // y agarra según cuánta haya (car.js)
  if (!aiLines.has(track))
    aiLines.set(track, racingLine(track, limitsOn(carProfile, track), { brakeUse: AI_BRAKE_USE }));
  // la carrera (race/race.js): grilla, semáforo, largadas, vueltas, abandonos y orden. Vos quedás en pista aunque
  // abandones (donde paraste)
  game.race = new Race({
    track,
    entries: game.entries,
    laps: game.laps,
    line: aiLines.get(track),
    rubber: game.rubber,
    stays: player,
  });
  player.lap.best = prevBest;
  if (!tvCams.has(track)) tvCams.set(track, tvCameras(track));
  hud.stage.classList.remove('replay');
  hud.stage.classList.toggle('trial', trial);
  hud.drawMinimapBase(track);
}

// Color de la trazada según la velocidad del auto: verde = se puede acelerar, amarillo = mantener o
// levantar, rojo = hay que frenar. Desde el auto hacia adelante se proyecta la velocidad: acelerando
// a fondo mientras se pueda; donde la trazada pide ir más lento que eso, es zona de frenada
// (y se supone que el auto frenó hasta esa velocidad).
const GUIDE_GREEN = [40, 205, 70],
  GUIDE_YELLOW = [245, 205, 40],
  GUIDE_RED = [235, 35, 35];
function paintGuide(guide, track, car) {
  const { speed, color } = guide;
  const L = speed.length;
  const ds = track.meters;
  const u0 = Math.max(0, stationAt(track, car.x, car.y) | 0);
  let v = Math.max(0, car.speed);
  for (let k = 0; k < L; k++) {
    const u = (u0 + k) % L;
    const target = speed[u];
    // de -2 m/s (sobra) a +3 m/s (falta frenar): verde → amarillo → rojo
    const t = Math.min(1, Math.max(0, (v - target + 2) / 5)) * 2;
    const [a, b] = t < 1 ? [GUIDE_GREEN, GUIDE_YELLOW] : [GUIDE_YELLOW, GUIDE_RED];
    const f = t < 1 ? t : t - 1;
    color[u] = rgb((a[0] + (b[0] - a[0]) * f) | 0, (a[1] + (b[1] - a[1]) * f) | 0, (a[2] + (b[2] - a[2]) * f) | 0);
    v = v > target ? target : Math.min(target, Math.sqrt(v * v + 2 * Math.max(0, car.limits.accel(v)) * ds));
  }
}

function update(dt) {
  const g = game,
    r = g.race,
    me = g.player;
  me.driver.input = readInput(dt, g.car.speed);
  const racing = r.started; // con el semáforo prendido sólo se suben las vueltas
  for (const ev of r.step(dt)) raceEvent(g, ev);
  if (racing) {
    const cars = g.entries.filter((e) => e === me || !e.car.gone).map((e) => e.car);
    for (const e of g.entries) {
      if (e !== me) e.spin = (e.spin + (e.car.speed * dt) / WHEEL_R) % (Math.PI * 2);
      e.head = turnHead(e.head, lookYaw(e.car, cars, g.track), dt);
      const c = e.car;
      e.body = suspension(e.body, c.speed * c.omega, (c.speed - (e.prevSpeed ?? c.speed)) / dt, dt);
      e.prevSpeed = c.speed;
      e.paddles = paddles(e.paddles, c.gear, dt);
    }
    g.recorder.add(dt, g.entries);
  }

  if (me.lap.started) {
    // tu vuelta, para el fantasma de contrarreloj
    g.recClock += dt;
    while (g.recClock >= GHOST_STEP) {
      g.recClock -= GHOST_STEP;
      g.rec.push(g.car.x, g.car.y);
    }
    // contramano: el progreso viene bajando sostenidamente
    const p = g.track.progress[Math.floor(g.car.y) * g.track.W + Math.floor(g.car.x)];
    g.progressLog.push(p);
    if (g.progressLog.length > 45) g.progressLog.shift();
    const first = g.progressLog[0],
      lastP = g.progressLog[g.progressLog.length - 1];
    g.wrongWay = first >= 0 && lastP >= 0 && first - lastP > 6 && first - lastP < 200 && g.car.speed > 3;
  }
}

// Lo que pasó en la carrera, en pantalla: tus vueltas, los abandonos y la llegada
function raceEvent(g, { type, entry: e, time, best, place }) {
  const me = e === g.player;
  if (type === 'retire') {
    if (me) {
      hud.flash(`Abandono: ${e.car.damage.retired.toLowerCase()}`);
      g.replayIn = REPLAY_DELAY;
    } else hud.flash(`Abandona ${e.code}`);
  }
  if (type === 'finish' && me) {
    hud.flash(`¡Terminaste ${place}º!`);
    g.replayIn = REPLAY_DELAY;
  }
  if (!me || !['start', 'lap', 'invalid'].includes(type)) return;
  if (type === 'invalid') hud.flash('Vuelta inválida');
  if (type === 'lap') {
    if (best && g.trial) g.ghost = Float32Array.from(g.rec); // el fantasma es la mejor vuelta de contrarreloj
    hud.flash(best ? `¡Mejor vuelta! ${hud.fmt(time)}` : `Vuelta ${hud.fmt(time)}`);
  }
  // cada cruce de la línea empieza a grabar la vuelta de nuevo
  g.rec = [];
  g.recClock = 0;
}

// ---------- carrera ----------
// ---------- dibujo ----------
// posición del fantasma en la muestra u (con decimales), interpolando entre las dos grabadas más cercanas
function ghostAt(ghost, u) {
  const last = ghost.length / 2 - 1;
  u = Math.min(last, Math.max(0, u));
  const i = Math.min(last - 1, Math.floor(u)),
    t = u - i;
  return [
    ghost[2 * i] + (ghost[2 * i + 2] - ghost[2 * i]) * t,
    ghost[2 * i + 1] + (ghost[2 * i + 3] - ghost[2 * i + 1]) * t,
  ];
}

// árboles y carteles del circuito, como sprites (tamaños en metros, pasados a celdas)
function trackSprites(track) {
  const M = track.meters;
  const sprites = track.trees.map((t) => ({
    x: t.x,
    y: t.y,
    z: t.z,
    width: (4 * t.scale) / M,
    height: (8 * t.scale) / M,
    tex: treeTex,
  }));
  // carteles de frenada: 3,2 m de ancho por 2,7 m de alto (tablero sobre patas), grandes para leerlos a tiempo
  for (const b of track.boards)
    sprites.push({ x: b.x, y: b.y, z: b.z, width: 3.2 / M, height: 2.7 / M, tex: boardTex.get(b.meters) });
  return sprites;
}

// motores de todos los autos, escuchados desde la cámara (vx, vy: a qué velocidad se mueve, en m/s)
function playEngines(cars, cam, M, vx, vy, inside) {
  if (!settings.sound) return;
  audio.update(cars, { x: cam.x * M, y: cam.y * M, angle: cam.angle, vx, vy }, inside);
}

// ---------- repetición ----------
function startReplay(g) {
  g.replay = { t: 0, mode: 'auto', target: g.entries.indexOf(g.player), tv: {} };
  hud.stage.classList.add('replay');
}

// C cambia la cámara; ←/→ (o J/L, A/D) cambian el auto que se sigue
function replayKey(r, is) {
  const n = game.entries.length;
  if (is('KeyC')) r.mode = CAMERA_MODES[(CAMERA_MODES.indexOf(r.mode) + 1) % CAMERA_MODES.length];
  if (is('ArrowRight', 'KeyL', 'KeyD')) r.target = (r.target + 1) % n;
  if (is('ArrowLeft', 'KeyJ', 'KeyA')) r.target = (r.target + n - 1) % n;
  r.tv = {};
}

async function drawReplay() {
  const g = game,
    r = g.replay,
    { track } = g;
  const M = track.meters;
  const poses = g.recorder.at(r.t);
  const pose = poses[r.target];
  const heightAt = (x, y) => sampleField(track.height, track.W, x, y);
  // la cabeza de cada piloto, como en la carrera (la repetición no la graba)
  r.heads ??= poses.map(() => 0);
  r.heads = poses.map((p, k) => turnHead(r.heads[k], lookYaw(p, poses, track), 1 / 60));
  // la suspensión, con las aceleraciones que salen de comparar con un instante después
  const next = g.recorder.at(r.t + 0.1);
  r.bodies ??= [];
  r.bodies = poses.map((p, k) => {
    const q = next[k],
      omega = Math.atan2(Math.sin(q.angle - p.angle), Math.cos(q.angle - p.angle)) / 0.1;
    return suspension(r.bodies[k], p.speed * omega, (q.speed - p.speed) / 0.1, 1 / 60);
  });
  r.paddles ??= [];
  r.paddles = poses.map((p, k) => paddles(r.paddles[k], p.gear, 1 / 60));
  const models = g.entries.map((e, k) => {
    const p = poses[k];
    return {
      model: e.model,
      x: p.x,
      y: p.y,
      z: heightAt(p.x, p.y),
      angle: p.angle,
      meters: M,
      pitch: Math.atan(p.slope),
      roll: r.bodies[k].roll,
      dive: r.bodies[k].dive,
      steer: wheelAngle(p.steer, p.speed, g.car.limits),
      spin: (p.dist / WHEEL_R) % (Math.PI * 2),
      head: r.heads[k],
      ...tyres(g, p.dist),
      shadow: true,
      wheelTurn: p.steer * STEERING.turn,
      headTilt: headTilt(r.bodies[k]),
      paddle: r.paddles[k].pull,
    };
  });
  const cam = replayCamera(r.mode, pose, track, tvCams.get(track), r.tv, r.t, renderer.w / 2 / 0.7);
  renderer.guide = null;
  renderer.rubber = g.rubber; // como quedó al terminar
  // sonido: se escucha desde la cámara; la de TV está quieta, las demás van con el auto
  const moving = cam.mode !== 'tv';
  playEngines(
    poses.map((p) => ({ ...p, x: p.x * M, y: p.y * M })),
    cam,
    M,
    moving ? Math.cos(pose.angle) * pose.speed : 0,
    moving ? Math.sin(pose.angle) * pose.speed : 0,
    cam.mode === 'onboard' ? r.target : -1,
  );
  audio.surface({}); // en la repetición no suenan los pianos
  await renderer.render(track, cam, trackSprites(track), models);
  ctx.clearRect(0, 0, VIEW_W, VIEW_H);

  // cartel: auto que se sigue, su posición en ese momento, cámara y tiempo de carrera
  // la posición en ese momento: lo que recorrió cada uno, descontando cuán atrás largó en la grilla
  const e = g.entries[r.target];
  const ahead = (k) => poses[k].dist - g.entries[k].gridBack;
  const order = g.entries.map((_, k) => k).sort((a, b) => ahead(b) - ahead(a));
  const html =
    `<b>REPETICIÓN</b> <span><i style="background:${e.color}"></i>${e.name} · P${order.indexOf(r.target) + 1}</span>` +
    `<span>${Math.round(Math.abs(pose.speed) * 3.6)} km/h</span><span>${hud.fmt(r.t)}</span>` +
    `<small>Cámara: ${CAMERA_NAMES[r.mode]}${r.mode === 'auto' ? ` (${CAMERA_NAMES[cam.mode]})` : ''} · C cámara · ←→ auto · R nueva carrera · Esc menú</small>`;
  if (hud.replay.innerHTML !== html) hud.replay.innerHTML = html;
  hud.drawMinimapAt(
    track,
    poses.map((p, k) => [p.x, p.y, g.entries[k].color, k === r.target]),
  );
}

// ---------- suspensión: rolido y cabeceo de la carrocería ----------
// La carrocería se inclina hacia afuera en las curvas (según la aceleración de costado) y baja la trompa al frenar
// (la sube un poco al acelerar). La sigue un resorte amortiguado: tarda un instante en inclinarse y en volver.
// Un F1 es muy duro, así que es poquito.
const ROLL_MAX = 0.026; // rad (1,5°) con ROLL_G de aceleración de costado
const ROLL_G = 45; // m/s²
const DIVE_PER = 0.0004; // rad de cabeceo por cada m/s² de frenada (a fondo, ~1,1°)
const DIVE_MAX = 0.022; // rad
const SPRING = 90; // 1/s²: rigidez del resorte
const DAMPING = 14; // 1/s: amortiguación (un poco menos que la crítica: casi no rebota)

// b: { roll, dive, vRoll, vDive }; aLat: aceleración de costado (+ doblando a la derecha), aLon: hacia adelante
function suspension(b, aLat, aLon, dt) {
  b ??= { roll: 0, dive: 0, vRoll: 0, vDive: 0 };
  const roll = Math.max(-1, Math.min(1, aLat / ROLL_G)) * ROLL_MAX;
  const dive = Math.max(-DIVE_MAX, Math.min(DIVE_MAX, -aLon * DIVE_PER));
  b.vRoll += (SPRING * (roll - b.roll) - DAMPING * b.vRoll) * dt;
  b.vDive += (SPRING * (dive - b.dive) - DAMPING * b.vDive) * dt;
  b.roll += b.vRoll * dt;
  b.dive += b.vDive * dt;
  return b;
}

// ---------- desgaste de las gomas ----------
// Largan nuevas: lisas y brillantes. El brillo se va en la primera parte de la primera vuelta. El desgaste es
// físico (car.js: se gastan más cuanto más se las exige y agarran menos) y está calibrado para que, manejando
// normal, se gasten del todo al terminar la carrera; las marcas en la banda lo muestran.
const SHINE_LAPS = 0.6; // vueltas que dura el brillo
const TRIAL_FUEL = 5; // kg
// manejando normal, las gomas llegan al final de la carrera con este desgaste: justo antes de donde se caen de golpe
// (WEAR_CLIFF_FROM de car.js). El que las maltrata (deslizando, bloqueando, recalentándolas) se queda sin gomas antes
const RACE_WEAR = 0.8;
const TRIAL_WEAR_LAPS = 3; // en contrarreloj, vueltas hasta el desgaste completo

const wearLaps = (g) => (g.trial ? TRIAL_WEAR_LAPS : g.laps);

// wear: el desgaste del auto (en la repetición no se guarda: se estima por la distancia recorrida)
function tyres(g, dist, wear = null) {
  const laps = dist / (g.track.length * g.track.meters);
  return { wear: wear ?? Math.min(1, laps / wearLaps(g)), shine: Math.max(0, 1 - laps / SHINE_LAPS) };
}

// ---------- hacia dónde mira cada piloto ----------
// En orden: el auto de adelante si hay uno cerca dentro de ±10° de su rumbo; si no, el vértice de la próxima curva;
// si no hay curva a la vista, de frente. La cabeza gira de a poco y hasta cierto punto.
const LOOK_CONE = (10 * Math.PI) / 180;
const LOOK_CAR = 60; // m: hasta dónde sigue a un auto
const LOOK_AHEAD = [8, 140]; // m adelante donde busca la próxima curva
const LOOK_CORNER = 0.9; // es curva si la trazada va ahí a menos de esta fracción de lo más rápido del tramo
const LOOK_MAX = 0.5; // rad: lo más que gira la cabeza
const LOOK_RATE = 4; // 1/s

const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));

// ángulo (rad, + a la derecha) hacia donde quiere mirar el piloto de car; cars: todos los autos (incluido él)
function lookYaw(car, cars, track) {
  const M = track.meters;
  let best = Infinity,
    yaw = 0;
  for (const o of cars) {
    if (o === car) continue;
    const dx = o.x - car.x,
      dy = o.y - car.y,
      d = Math.hypot(dx, dy) * M;
    const rel = wrapAngle(Math.atan2(dy, dx) - car.angle);
    if (d < LOOK_CAR && d < best && Math.abs(rel) <= LOOK_CONE) {
      best = d;
      yaw = rel;
    }
  }
  if (best < Infinity) return yaw;
  const line = guides.get(track),
    u = stationAt(track, car.x, car.y);
  if (!line || u < 0) return 0;
  // el punto más lento de la trazada en el tramo de adelante; si es un vértice de verdad, se mira ahí
  const L = line.speed.length,
    a = Math.round(u + LOOK_AHEAD[0] / M),
    b = Math.round(u + LOOK_AHEAD[1] / M);
  let lo = Infinity,
    hi = 0,
    at = a;
  for (let i = a; i <= b; i++) {
    const v = line.speed[((i % L) + L) % L];
    if (v < lo) {
      lo = v;
      at = i;
    }
    if (v > hi) hi = v;
  }
  if (at === a || lo > hi * LOOK_CORNER) return 0;
  const p = pointAt(lineFrame(track), at, line.offset[((at % L) + L) % L]);
  return wrapAngle(Math.atan2(p.y - car.y, p.x - car.x) - car.angle);
}

// las levas: al subir de marcha el piloto tira de la derecha y al bajar, de la izquierda; el tirón va y vuelve
function paddles(p, gear, dt) {
  p ??= { gear, up: 0, down: 0 };
  if (gear > p.gear && p.gear > 0) p.up = PADDLE_TIME;
  else if (gear < p.gear && gear > 0) p.down = PADDLE_TIME;
  p.gear = gear;
  p.up = Math.max(0, p.up - dt);
  p.down = Math.max(0, p.down - dt);
  const pull = (t) => Math.sin((Math.PI * t) / PADDLE_TIME) * PADDLE_PULL;
  p.pull = [pull(p.down), pull(p.up)];
  return p;
}

// cuánto tiembla el volante: en el pasto, en la leca y en los pianos, más cuanto más rápido, y con el salto de la
// salchicha (cambia en cada cuadro)
const buzz = (c) =>
  ((c.rough ?? c.grass) * Math.min(1, Math.abs(c.speed) / 25) +
    (c.onKerb ? Math.min(1, Math.abs(c.speed) / 35) * 0.5 : 0) +
    (c.jolt ?? 0)) *
  BUZZ *
  (Math.random() * 2 - 1);

// la cabeza del piloto, inclinada por las fuerzas: [hacia el costado, hacia adelante]
const headTilt = (body) => [(body?.roll ?? 0) * HEAD_ROLL, (body?.dive ?? 0) * HEAD_DIVE];

function turnHead(head = 0, target, dt) {
  target = Math.max(-LOOK_MAX, Math.min(LOOK_MAX, target));
  return head + (target - head) * Math.min(1, dt * LOOK_RATE);
}

async function draw(time) {
  const g = game;
  const car = g.car;
  const M = g.track.meters;
  const sprites = trackSprites(g.track);
  const { track } = g;
  const heightAt = (x, y) => sampleField(track.height, track.W, x, y);
  const models = [];
  if (g.trial && g.ghost && g.player.lap.started && g.ghost.length >= 4) {
    // la vuelta se grabó 30 veces por segundo y se dibuja más seguido: interpolamos entre muestras
    // para que avance suave, y el rumbo sale de puntos un poco antes y un poco después, para que no tiemble
    const u = g.player.lap.time / GHOST_STEP - 1;
    const [gx, gy] = ghostAt(g.ghost, u);
    const [ax, ay] = ghostAt(g.ghost, u - 3);
    const [bx, by] = ghostAt(g.ghost, u + 3);
    const angle = bx !== ax || by !== ay ? Math.atan2(by - ay, bx - ax) : car.angle;
    const fx = Math.cos(angle),
      fy = Math.sin(angle);
    const pitch = Math.atan((heightAt(gx + fx * 1.5, gy + fy * 1.5) - heightAt(gx - fx * 1.5, gy - fy * 1.5)) / 3);
    models.push({ model: ghostModel, x: gx, y: gy, z: heightAt(gx, gy), angle, pitch, meters: M, alpha: 0.55 });
  }

  // rivales
  for (const e of g.entries) {
    if (e === g.player || e.car.gone) continue;
    const c = e.car;
    models.push({
      // arriba del piano o de la salchicha, el auto sube y se inclina con las ruedas que se levantan
      model: e.model,
      x: c.x,
      y: c.y,
      z: heightAt(c.x, c.y) + c.lift,
      angle: c.angle,
      meters: M,
      pitch: Math.atan(c.slope),
      roll: (e.body?.roll ?? 0) + c.liftRoll,
      dive: (e.body?.dive ?? 0) + c.liftDive,
      steer: wheelAngle(c.steer, c.speed, c.limits),
      spin: e.spin,
      head: e.head,
      ...tyres(g, e.dist, c.wear),
      shadow: true,
      wheelTurn: c.steer * STEERING.turn + buzz(c),
      headTilt: headTilt(e.body),
      paddle: e.paddles?.pull,
    });
  }

  // cámara en la cabina o un poco detrás del auto, a la altura del terreno,
  // con traqueteo en el pasto, en la leca, en los pianos y al chocar
  const shake =
    (car.rough ?? car.grass) * Math.min(1, Math.abs(car.speed) / 25) * 3 +
    (car.onKerb ? Math.min(1, Math.abs(car.speed) / 35) * 1.2 : 0) +
    car.bump * 4 +
    car.jolt * 5;
  // contra un muro, la cámara de afuera se acerca hasta que deja de estar adentro
  let behind = (cockpitView ? COCKPIT_BACK : CAM_BEHIND) / M;
  while (behind > 0 && isSolid(track, car.x - Math.cos(car.angle) * behind, car.y - Math.sin(car.angle) * behind))
    behind -= 0.2;
  behind = Math.max(0, behind);
  const cam = {
    x: car.x - Math.cos(car.angle) * behind,
    y: car.y - Math.sin(car.angle) * behind,
    angle: car.angle + car.steer * (cockpitView ? 0.02 : 0.04),
  };
  cam.ground = heightAt(cam.x, cam.y);
  cam.z = Math.max(cam.ground, heightAt(car.x, car.y)) + (cockpitView ? COCKPIT_EYE : EYE_HEIGHT) / M + car.lift;
  // inclinamos la vista según la pendiente (en subida se mira más arriba); desde la cabina,
  // el horizonte va más arriba para que la pista se vea por encima del auto
  const shakeY = Math.sin(time * 0.045) * shake * UI_SCALE;
  cam.pitch =
    (cockpitView ? -28 : -40) * UI_SCALE +
    car.slope * renderer.P * 0.6 +
    shakeY -
    (cockpitView ? (g.player.body?.dive ?? 0) * renderer.P : 0); // frenando, la vista baja con la trompa
  const line = guides.get(track);
  const guide = showGuide ? line : null;
  if (guide) paintGuide(guide, track, car);
  renderer.guide = guide;
  renderer.rubber = g.rubber;
  // nuestro auto en 3D
  const dt = Math.min(0.1, Math.max(0, (time - lastDraw) / 1000));
  lastDraw = time;
  wheelSpin = (wheelSpin + (car.speed * dt) / WHEEL_R) % (Math.PI * 2);
  // el volante sigue a la dirección con un poco de demora, como las manos (con teclado la dirección salta)
  g.player.wheelTurn =
    (g.player.wheelTurn ?? 0) +
    (car.steer * STEERING.turn - (g.player.wheelTurn ?? 0)) * Math.min(1, dt * WHEEL_TURN_RATE);
  // desde la cabina se ve el mismo auto, sin el casco (ahí está la cámara) y sin rolido; la pendiente,
  // en la misma medida en que la cámara la sigue, así la carrocería queda quieta en la pantalla
  models.push({
    model: g.player.model,
    x: car.x,
    y: car.y,
    z: heightAt(car.x, car.y) + car.lift,
    angle: car.angle,
    meters: M,
    pitch: Math.atan(car.slope) * (cockpitView ? 0.6 : 1),
    // la carrocería rola y cabecea sobre la suspensión; desde la cabina no, porque la cámara va pegada a ella
    // (ahí el cabeceo mueve la vista: ver cam.pitch)
    roll: cockpitView ? 0 : (g.player.body?.roll ?? 0) + car.liftRoll,
    dive: cockpitView ? 0 : (g.player.body?.dive ?? 0) + car.liftDive,
    steer: wheelAngle(car.steer, car.speed, car.limits),
    spin: wheelSpin,
    head: g.player.head,
    ...tyres(g, g.player.dist, car.wear),
    shadow: true,
    hide: cockpitView ? 'helmet' : null,
    // el volante gira con la dirección y muestra la marcha; desde la cabina la pintura de tan cerca brilla menos
    wheelTurn: g.player.wheelTurn + buzz(car),
    screen: cockpit.screen(car),
    gloss: cockpitView ? 0.35 : 1,
    headTilt: headTilt(g.player.body),
    paddle: g.player.paddles?.pull,
  });
  playEngines(
    g.entries.map((e) => ({
      rpm: e.car.rpm,
      throttle: e.car.throttle,
      gear: e.car.gear,
      x: e.car.x * M,
      y: e.car.y * M,
      angle: e.car.angle,
      speed: e.car.speed,
    })),
    cam,
    M,
    Math.cos(car.angle) * car.speed,
    Math.sin(car.angle) * car.speed,
    cockpitView ? g.entries.indexOf(g.player) : -1,
  );
  // las ruedas propias sobre el piano, el verde o la salchicha
  if (settings.sound) {
    const on = (w) => car.wheels.filter((x) => x === w).length / 4;
    audio.surface({
      kerb: on('kerb') + on('sausage'),
      green: on('green'),
      speed: car.speed,
      ridge: RIDGE * M,
      jolt: car.jolt,
    });
  }
  await renderer.render(track, cam, sprites, models);
  ctx.clearRect(0, 0, VIEW_W, VIEW_H);

  if (!g.race.started || g.race.time < 1) hud.drawLights(g);

  // HUD
  hud.speed.textContent = Math.round(Math.abs(car.speed) * 3.6);
  // la ayuda se esconde mientras manejás (tapa la cabina) y vuelve cuando parás
  hud.help.classList.toggle('hidden', Math.abs(car.speed) > 3);
  hud.gear.textContent = car.gear === 0 ? 'R' : car.gear;
  hud.rpm.textContent = Math.round(car.rpm / 100) * 100;
  hud.mode.textContent = (car.manual ? 'MAN' : 'AUTO') + (car.absCut ? ' · ABS' : '') + (car.tcCut ? ' · TC' : '');
  // luces de cambio: se van prendiendo desde 9.000 rpm hasta el corte (verde, rojo, azul)
  const lit = Math.round(((car.rpm - 9000) / (car.profile.maxRpm * 0.97 - 9000)) * SHIFT_LIGHTS);
  const leds = hud.lights.children;
  for (let i = 0; i < SHIFT_LIGHTS; i++) leds[i].className = i < lit ? (i < 5 ? 'g' : i < 10 ? 'r' : 'b') : '';
  hud.lights.classList.toggle('flash', lit >= SHIFT_LIGHTS && Math.floor(time / 80) % 2 === 0);
  const lap = g.player.lap;
  hud.lap.textContent = g.trial ? lap.laps + 1 : `${Math.min(g.laps, lap.laps + 1)}/${g.laps}`;
  hud.pos.textContent = `${g.race.order().indexOf(g.player) + 1}/${g.entries.length}`;
  hud.drawTower(g, time);
  hud.drawDamage(g, time);
  hud.drawTyres(car, time);
  hud.drawResults(g);
  hud.time.textContent = lap.started ? hud.fmt(lap.time) : hud.fmt(null);
  hud.last.textContent = hud.fmt(lap.last);
  hud.best.textContent = hud.fmt(lap.best);
  if (g.wrongWay && hud.flashTimer <= 0) {
    hud.msg.textContent = '¡CONTRAMANO!';
    hud.msg.classList.add('show');
  } else if (hud.flashTimer <= 0) {
    hud.msg.classList.remove('show');
  }

  hud.drawMinimap(g);
}

// ---------- bucle ----------
// Tope de cuadros: en pantallas rápidas (120 Hz o más) se saltea un refresco de cada dos, así no se dibuja más de
// lo que hace falta. El margen deja pasar todos los de una pantalla de 60 o 75 Hz (cortar 75 a 60 haría tirones).
const MIN_FRAME = 1000 / 60 - 5; // ms
let lastTime = performance.now();
let drawing = false;
function frame(now) {
  if (now - lastTime < MIN_FRAME) {
    requestAnimationFrame(frame);
    return;
  }
  const dt = Math.min(0.05, (now - lastTime) / 1000);
  lastTime = now;
  pad.poll();
  if (game) {
    // al terminar, unos segundos de resultado y después la repetición (la carrera queda en pausa)
    if (game.replayIn !== null && !game.replay) {
      game.replayIn -= dt;
      if (game.replayIn <= 0) startReplay(game);
    }
    if (game.replay) game.replay.t = (game.replay.t + dt) % Math.max(1, game.recorder.duration);
    else update(dt);
    // el cielo y el terreno se dibujan en otros hilos: si el cuadro anterior todavía no terminó, éste se saltea
    if (!drawing) {
      drawing = true;
      (game.replay ? drawReplay(now) : draw(now)).finally(() => {
        drawing = false;
      });
    }
    hud.tick(dt);
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// ---------- carga de circuitos ----------
const builtTracks = new Map(); // circuitos ya armados, por id

async function loadTrack(id) {
  if (builtTracks.has(id)) return builtTracks.get(id);
  const def = TRACKS.find((t) => t.id === id) || TRACKS[0];
  if (def.layout) {
    // el trazado sacado de la telemetría (tools/layout.py)
    const track = buildTrackFromLayout(await fetch(def.layout).then((r) => r.json()), def);
    builtTracks.set(def.id, track);
    return track;
  }
  const [img, elevation] = await Promise.all([
    loadImage(def.image),
    def.elevation ? fetch(def.elevation).then((r) => r.json()) : null,
  ]);
  const track = buildTrack(img, def, elevation);
  builtTracks.set(def.id, track);
  return track;
}

// ---------- menú ----------
// Una pantalla principal con el auto y el circuito elegidos (en tarjetas con su dibujo) y el modo, y una pantalla
// aparte para cada cosa: elegir el auto, elegir el circuito, la puesta a punto y las opciones (dificultad, vueltas,
// daños y sonido)
const menu = $('menu');
const menuOpen = () => menu.classList.contains('open');
let screen = 'main';

function openMenu() {
  audio.silence();
  audio.playMusic(settings.sound);
  if (game) lastGame = game;
  game = null;
  hud.stage.classList.remove('replay');
  hud.results.classList.remove('show');
  menu.classList.add('open');
  showScreen('main');
}

function showScreen(name) {
  screen = name;
  for (const el of menu.querySelectorAll('.screen')) el.classList.toggle('on', el.dataset.screen === name);
  menu.scrollTop = 0;
  renderMenu();
  // el foco: en la principal, en Largar; en las otras, en lo elegido
  const focus = name === 'main' ? $('menu-start') : menu.querySelector(`[data-screen="${name}"] button.on`);
  (focus ?? menu.querySelector(`[data-screen="${name}"] button`))?.focus({ preventScroll: true });
}
for (const b of menu.querySelectorAll('[data-go]')) b.addEventListener('click', () => showScreen(b.dataset.go));

let starting = false;
async function startRace() {
  if (starting) return;
  starting = true;
  const button = $('menu-start');
  button.textContent = 'Cargando…';
  try {
    const track = await loadTrack(settings.track);
    menu.classList.remove('open');
    audio.playMusic(false);
    resetGame(track);
  } catch (err) {
    console.error(err);
    hud.flash('No se pudo cargar el circuito');
  } finally {
    button.textContent = 'Largar';
    starting = false;
  }
}

// una fila de botones: elegir uno lo marca, lo guarda en settings[key] y vuelve a dibujar el menú
// (o.html: el contenido del botón; o.el: le agrega ese elemento al final)
function choices(el, options, key, onChange) {
  el.replaceChildren(
    ...options.map((o) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = settings[key] === o.value ? 'on' : '';
      if (o.html) b.innerHTML = o.html;
      else b.textContent = o.label;
      if (o.el) b.prepend(o.el);
      b.addEventListener('click', () => {
        settings[key] = o.value;
        saveSettings();
        onChange?.();
        renderMenu();
      });
      return b;
    }),
  );
}

const DAMAGE = () => DAMAGE_LEVELS.find((l) => l.id === settings.damage) || DAMAGE_LEVELS[2];
const DIFFICULTY = () => DIFFICULTIES.find((d) => d.id === settings.difficulty) || DIFFICULTIES[2];
const km = (m) => `${(m / 1000).toFixed(2).replace('.', ',')} km`;

function renderMenu() {
  choices($('menu-mode'), MODES, 'mode');
  menu.classList.toggle('trial', settings.mode === 'trial');
  const sound = $('sound-toggle');
  sound.textContent = settings.sound ? '♪ Sonido' : '♪ Sin sonido';
  sound.classList.toggle('on', settings.sound);
  menu.classList.toggle('mute', !settings.sound);
  if (screen === 'main') renderMain();
  if (screen === 'car') renderCars();
  if (screen === 'track') renderTracks();
  if (screen === 'tune') renderTune();
  if (screen === 'options') renderOptions();
}

function renderMain() {
  const team = teamById(settings.team);
  $('card-team').innerHTML = `<i class="swatch" style="background:${team.color}"></i>${team.name}`;
  $('card-drivers').textContent = team.drivers[settings.driver][0];
  drawCarPreview($('car-thumb'), team, { yaw: 0.75, pitch: 0.3, zoom: 1.12 });
  const def = trackDef();
  $('card-track').textContent = def?.name ?? '';
  const laps =
    settings.mode === 'trial' ? 'contrarreloj' : `${settings.laps} ${settings.laps === 1 ? 'vuelta' : 'vueltas'}`;
  $('card-track-info').textContent = laps;
  drawTrackPreview($('track-thumb'), settings.track, (shape) => {
    if (shape?.length) $('card-track-info').textContent = `${km(shape.length)} · ${laps}`;
  });
  $('tile-tune').textContent = tuneSummary();
  const rivals = `${settings.rivals} ${settings.rivals === 1 ? 'rival' : 'rivales'}`;
  $('tile-options').textContent = (settings.mode === 'trial' ? [] : [rivals, DIFFICULTY().name.toLowerCase()])
    .concat([
      `cámara ${VIEW().label.toLowerCase()}`,
      `daños ${DAMAGE().name.toLowerCase()}`,
      `caja ${GEARBOXES.find((b) => b.value === settings.gearbox).label.toLowerCase()}`,
      `control de tracción ${TRACTION().label.toLowerCase()}`,
      settings.abs ? 'ABS' : 'sin ABS',
    ])
    .join(' · ');
}

// ---- el auto ----
let carView = { yaw: 0.75, pitch: 0.28 }; // desde dónde se mira el auto grande (se gira arrastrándolo)
const carPreviewModel = (team) => modelFor(teamCar(team, settings.driver));
function drawCarPreview(canvas, team, view) {
  drawCar(canvas, carPreviewModel(team), view);
}

function renderCars() {
  const team = teamById(settings.team);
  choices(
    $('menu-teams'),
    TEAMS.map((t) => ({
      value: t.id,
      html: `<span class="car" style="--c:${t.color};--a:${t.accent};--h:${t.helmet}"><i></i></span>${t.name}`,
    })),
    'team',
  );
  $('car-name').innerHTML = `<i class="swatch" style="background:${team.color}"></i>${team.name}`;
  choices(
    $('menu-drivers'),
    team.drivers.map(([name, , n], slot) => ({ value: slot, label: `#${n} ${name}` })),
    'driver',
  );
}

// El auto grande gira solo, despacio, como en una vitrina; arrastrándolo se lo gira a mano (y un poco para arriba o
// abajo), y al soltarlo sigue girando solo después de un rato
const TURNTABLE = 0.35; // rad/s
const TURNTABLE_WAIT = 2.5; // s quieto después de soltarlo
let carDrag = null,
  carIdleSince = 0;
{
  const big = $('car-big');
  big.addEventListener('pointerdown', (e) => {
    carDrag = { x: e.clientX, y: e.clientY, ...carView };
    big.setPointerCapture(e.pointerId);
  });
  big.addEventListener('pointermove', (e) => {
    if (!carDrag) return;
    carView = {
      yaw: carDrag.yaw + (e.clientX - carDrag.x) * 0.012,
      pitch: Math.min(1.2, Math.max(0.05, carDrag.pitch + (e.clientY - carDrag.y) * 0.006)),
    };
  });
  const release = () => {
    carDrag = null;
    carIdleSince = performance.now();
  };
  big.addEventListener('pointerup', release);
  big.addEventListener('pointercancel', release);
}

// lo que se mueve en el menú: el auto que gira y el punto que da la vuelta al circuito (una vuelta en LAP_PREVIEW s)
const LAP_PREVIEW = 9;
let menuTime = 0;
let shownShape = null; // el trazado del circuito grande, para el punto que lo recorre
function animateMenu(now) {
  const dt = Math.min(0.1, (now - (menuTime || now)) / 1000);
  menuTime = now;
  if (menuOpen() && screen === 'car') {
    if (!carDrag && now - carIdleSince > TURNTABLE_WAIT * 1000)
      carView = { ...carView, yaw: carView.yaw + TURNTABLE * dt };
    drawCarPreview($('car-big'), teamById(settings.team), carView);
  }
  if (menuOpen() && screen === 'track' && shownShape) {
    drawShape($('track-big'), shownShape, { dot: ((now / 1000) % LAP_PREVIEW) / LAP_PREVIEW });
  }
  requestAnimationFrame(animateMenu);
}
requestAnimationFrame(animateMenu);

// ---- el circuito ----
// el trazado de un circuito (id) en el canvas; then(forma) cuando está, con forma.length (m) si se sabe
function drawTrackPreview(canvas, id, then, opts) {
  const def = TRACKS.find((t) => t.id === id);
  canvas.dataset.track = id;
  trackShape(def)
    .then((shape) => {
      if (canvas.dataset.track !== id) return; // ya se eligió otro
      drawShape(canvas, shape.points, opts);
      then?.(shape);
    })
    .catch((err) => console.warn('No se pudo dibujar el trazado:', err));
}

function trackList() {
  return TRACKS.map((t) => ({ value: t.id, label: t.name }));
}

function renderTracks() {
  const list = trackList();
  choices(
    $('menu-tracks'),
    list.map((t) => {
      const c = document.createElement('canvas');
      return { ...t, el: c };
    }),
    'track',
    () => {},
  );
  // los dibujitos se hacen después de que los botones están en la página (necesitan su tamaño)
  for (const [i, b] of [...$('menu-tracks').children].entries()) {
    drawTrackPreview(b.querySelector('canvas'), list[i].value, null, {
      color: b.classList.contains('on') ? '#ffd400' : '#c8ced8',
      line: 1.3,
    });
  }
  const def = trackDef();
  $('track-name').textContent = def?.name ?? '';
  const stats = (length) => {
    const wing = (def.tune.front + def.tune.rear) / 2;
    return [
      ['Largo', length ? km(length) : '…'],
      ['Altura sobre el mar', `${def.altitude} m`],
      ['Circuito', CIRCUIT_KINDS.find(([max]) => wing <= max)[1]],
    ];
  };
  const showStats = (length) => {
    $('track-stats').innerHTML = stats(length)
      .map(([k, v]) => `<div><small>${k}</small><b>${v}</b></div>`)
      .join('');
  };
  showStats();
  shownShape = null;
  drawTrackPreview($('track-big'), settings.track, (shape) => {
    shownShape = shape?.points;
    if (shape?.length) showStats(shape.length);
  });
}
// qué clase de circuito es, según cuánto alerón llevan los equipos ahí (de 1 a 10): poco donde se va mucho tiempo a
// fondo, mucho donde hay curvas lentas
const CIRCUIT_KINDS = [
  [2, 'muy rápido'],
  [4.5, 'rápido'],
  [6.5, 'mixto'],
  [Infinity, 'lento'],
];

// cambiar de auto o de circuito con las flechas (o los botones ‹ ›)
function stepChoice(step) {
  if (screen === 'car') {
    const i = TEAMS.findIndex((t) => t.id === settings.team);
    settings.team = TEAMS[(i + step + TEAMS.length) % TEAMS.length].id;
  } else if (screen === 'track') {
    const list = trackList(),
      i = list.findIndex((t) => t.value === settings.track);
    settings.track = list[(i + step + list.length) % list.length].value;
  } else return;
  saveSettings();
  renderMenu();
}
for (const b of menu.querySelectorAll('[data-step]')) b.addEventListener('click', () => stepChoice(+b.dataset.step));

// ---- opciones ----
const GEARBOXES = [
  { value: 'auto', label: 'Automática' }, // Los cambios se pasan solos
  { value: 'manual', label: 'Manual' }, // Subís con O o X y bajás con U o Z (en el joystick, RB sube y LB baja)
];
const TRACTIONS = [
  { value: 'high', label: 'Alto' }, // Corta motor antes de que la cola se suelte: para manejar con teclado
  { value: 'low', label: 'Bajo' }, // Deja usar casi todo el agarre de la cola: más rápido, pero hay que dosificar un poco
  { value: 'off', label: 'Apagado' }, // Como los F1 de verdad: acelerando a fondo en una curva lenta, la cola se va
];
const ABS_OPTIONS = [
  { value: true, label: 'Sí' }, // Los frenos sueltan antes de que las ruedas se bloqueen: para manejar con teclado, que frena todo o nada
  { value: false, label: 'No' }, // Como los F1 de verdad: el pedal a fondo sólo sirve a alta velocidad; a medida que el auto frena hay que ir soltándolo o las ruedas se bloquean
];
const TRACTION = () => TRACTIONS.find((t) => t.value === settings.traction) || TRACTIONS[0];
const VIEWS = [
  { value: 'cockpit', label: 'Cabina' }, // Desde los ojos del piloto, con el volante y la trompa adelante
  { value: 'chase', label: 'Exterior' }, // Desde atrás y arriba del auto: se ve mejor dónde está la pista
];
const VIEW = () => VIEWS.find((v) => v.value === settings.view) || VIEWS[0];
function renderOptions() {
  choices(
    $('menu-diff'),
    DIFFICULTIES.map((d) => ({ value: d.id, label: d.name })),
    'difficulty',
  );
  choices(
    $('menu-rivals'),
    RIVAL_OPTIONS.map((n) => ({ value: n, label: String(n) })),
    'rivals',
  );
  choices(
    $('menu-laps'),
    LAP_OPTIONS.map((n) => ({ value: n, label: String(n) })),
    'laps',
  );
  choices($('menu-view'), VIEWS, 'view');
  choices(
    $('menu-damage'),
    DAMAGE_LEVELS.map((l) => ({ value: l.id, label: l.name })),
    'damage',
  );
  choices($('menu-gearbox'), GEARBOXES, 'gearbox');
  choices($('menu-traction'), TRACTIONS, 'traction');
  choices($('menu-abs'), ABS_OPTIONS, 'abs');
  choices(
    $('menu-sound'),
    [
      { value: true, label: 'Sí' },
      { value: false, label: 'No' },
    ],
    'sound',
    applySound,
  );
  for (const [id, key] of VOLUME_SLIDERS) $(id).value = Math.round(settings[key] * 100);
}
$('sound-toggle').addEventListener('click', () => toggleSound());
function toggleSound() {
  settings.sound = !settings.sound;
  applySound();
  if (menuOpen()) renderMenu();
}

// Puesta a punto: la tuya en este circuito o, si no la cambiaste, la recomendada (la que llevan los equipos ahí, tracks/index.js;
// los rivales usan siempre esa). Abajo, cómo queda el auto: punta, agarre en curva rápida y balance.
const TUNE_SLIDERS = [
  ['tune-front', 'front'],
  ['tune-rear', 'rear'],
  ['tune-balance', 'balance'],
  ['tune-brake', 'brake'],
];
const SIGNED_TUNE = ['balance', 'brake'];
const trackDef = () => TRACKS.find((t) => t.id === settings.track);
const trackTune = () => trackDef()?.tune ?? DEFAULT_TUNE;
const myTune = () => settings.tunes[settings.track] ?? trackTune();
// según cuánto más agarra la cola que la trompa (rearMargin de car.js; parejo da 0,15): con mucho margen la trompa no
// dobla; con poco, frenando en curva o al soltar el freno la cola se va; sin margen, se va siempre
const BALANCE_WORDS = [
  [0, 'sobrevira'],
  [0.08, 'nervioso'],
  [0.12, 'ágil'],
  [0.2, 'estable'],
  [Infinity, 'subvira'],
];
const signed = (v) => (v > 0 ? `+${v}` : `${v}`);
function tuneSummary() {
  const t = myTune();
  return `${settings.tunes[settings.track] ? 'Con tus cambios' : 'Recomendada'}: alerón delantero ${t.front}, trasero ${t.rear}`;
}
function tuneLimits(t) {
  const lim = carLimits(carProfile, t, airDensity(trackDef()?.altitude ?? 0));
  const balance = (v) => BALANCE_WORDS.find(([max]) => rearMargin(lim, v) < max)[1];
  return { top: lim.topSpeed * 3.6, grip: cornerGrip(lim, 70) / GRAVITY, slow: balance(25), fast: balance(70) };
}
function renderTune() {
  const t = myTune(),
    own = settings.tunes[settings.track];
  $('tune-title').textContent = `Puesta a punto · ${trackDef()?.name ?? ''}`;
  for (const [id, key] of TUNE_SLIDERS) {
    const value = t[key] ?? 0; // (las puestas guardadas antes de que hubiera reparto de frenada no lo traen)
    $(id).value = value;
    $(id + '-v').textContent = SIGNED_TUNE.includes(key) ? signed(value) : value;
  }
  $('tune-reset').hidden = !own; // sólo hay algo para borrar si es la tuya
  const now = tuneLimits(t),
    base = tuneLimits(trackTune());
  // al lado de cada número, cuánto cambió respecto de la recomendada
  const diff = (a, b, unit, digits) =>
    own && Math.abs(a - b) >= 10 ** -digits / 2
      ? ` <em class="${a > b ? 'up' : 'down'}">${a > b ? '+' : '−'}${Math.abs(a - b)
          .toFixed(digits)
          .replace('.', ',')}${unit}</em>`
      : '';
  $('tune-stats').innerHTML = [
    ['Velocidad punta', `${Math.round(now.top)} km/h${diff(now.top, base.top, '', 0)}`],
    ['Agarre a 250 km/h', `${now.grip.toFixed(1).replace('.', ',')} g${diff(now.grip, base.grip, '', 1)}`],
    ['Curva lenta', now.slow],
    ['Curva rápida', now.fast],
  ]
    .map(([k, v]) => `<div><small>${k}</small><b>${v}</b></div>`)
    .join('');
  const where = trackDef()?.name ?? 'este circuito';
  $('tune-hint').textContent = own
    ? `Cambiaste la recomendada. Tus cambios quedan guardados y se usan cada vez que corras en ${where}.`
    : `Esta es la recomendada para ${where}. Si cambiás algo, se guarda para la próxima vez que corras acá.`;
}
for (const [id, key] of TUNE_SLIDERS) {
  $(id).addEventListener('input', (e) => {
    settings.tunes = { ...settings.tunes, [settings.track]: { ...myTune(), [key]: +e.target.value } };
    saveSettings();
    renderTune();
  });
}
$('tune-reset').addEventListener('click', () => {
  const { [settings.track]: _, ...rest } = settings.tunes;
  settings.tunes = rest;
  saveSettings();
  renderTune();
});

// los dibujos dependen del tamaño de la ventana
addEventListener('resize', () => menuOpen() && renderMenu());

// volúmenes: general, motores y música (de 0 a 100 en el menú)
const VOLUME_SLIDERS = [
  ['vol-master', 'volMaster'],
  ['vol-engines', 'volEngines'],
  ['vol-music', 'volMusic'],
];
for (const [id, key] of VOLUME_SLIDERS) {
  $(id).addEventListener('input', (e) => {
    settings[key] = e.target.value / 100;
    saveSettings();
    applySound();
  });
}
$('menu-start').addEventListener('click', () => {
  if (settings.sound) audio.start();
  startRace();
});

// al abrir: el perfil del auto y el circuito elegido la última vez, y el menú
(async () => {
  carProfile = await fetch(CAR_PROFILE)
    .then((r) => r.json())
    .catch(() => DEFAULT_PROFILE);
  if (NEURAL_URL)
    neuralPolicy = await Policy.load(NEURAL_URL).catch((err) => (console.warn('No se pudo cargar la red:', err), null));
  if (!TRACKS.some((t) => t.id === settings.track)) settings.track = TRACKS[0].id;
  audio.setVolumes({ master: settings.volMaster, engines: settings.volEngines, music: settings.volMusic });
  openMenu();
  await loadTrack(settings.track);
})().catch((err) => {
  console.error(err);
  hud.msg.textContent = 'No se pudo cargar el circuito. ¿Abriste el juego con un servidor local?';
  hud.msg.classList.add('show');
});
