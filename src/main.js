import { TRACKS } from '../tracks/index.js';
import { loadImage, buildTrack, buildTrackFromLayout, sampleField, stationAt, RIDGE, T } from './track.js';
import { Renderer, rgb } from './renderer.js';
import { GLRenderer } from './glrenderer.js';
import { Car, cornerGrip, DEFAULT_PROFILE, FUEL_PER_KM, keyboardSteer, LAUNCH_WINDOW, isSolid, limitsOn, rearMargin, RIVAL_AIDS, slipstream, TEMP_HIGH, TEMP_LOW, TRACTION_CONTROL, wheelAngle } from './car.js';
import { racingLine } from './racingline.js';
import { boardTexture, treeTexture } from './sprites.js';
import { carModel, STEERING, TCAM, WHEEL_R } from './carmodel.js';
import { Driver, gridSlots, lineFrame, pointAt } from './ai.js';
import { collideCars } from './collision.js';
import { Cockpit } from './cockpit.js';
import { CAMERA_MODES, CAMERA_NAMES, Recorder, replayCamera, tvCameras } from './replay.js';
import { DEFAULT_RIVALS, DIFFICULTIES, LAP_OPTIONS, RIVAL_OPTIONS, TEAMS, car as teamCar, gridOrder, rivalCars, rivalPaces, rivalSetups } from './teams.js';
import { EngineAudio } from './audio.js';
import { NeuralDriver, Policy } from './policy.js';
import { LIGHTS_OUT, lightsAt, lightsDuration, randomHold } from './lights.js';
import { RubberMap } from './rubber.js';
import { DESIGNS } from './teamliveries.js';
import { airDensity, carLimits, DEFAULT_TUNE, GRAVITY } from './dynamics.js';
import { DAMAGE_LEVELS, damaged, NO_DAMAGE } from './damage.js';
import { drawCar, drawShape, trackShape } from './menuview.js';

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
const SHIFT_LIGHTS = 15;
const REPLAY_DELAY = 6; // segundos de resultado antes de que empiece la repetición
const SETTINGS_KEY = 'raycast-racer-settings';

// lo que se elige en el menú (se recuerda en el navegador): modo (carrera o contrarreloj), equipo y piloto (driver: 0
// el primero, 1 el segundo), dificultad,
// circuito, vueltas, cantidad de rivales, daños (damage.js), volúmenes y tu puesta a punto en cada circuito donde la cambiaste (tunes).
// El sonido arranca siempre apagado (se prende con N o desde el menú) y eso no se recuerda.
const settings = { mode: 'race', team: 'hierrari', driver: 0, difficulty: 'dificil', track: TRACKS[0].id, laps: 3, rivals: DEFAULT_RIVALS, damage: 'real', gearbox: 'auto', traction: 'high', abs: true, sound: false, volMaster: 0.8, volEngines: 1, volMusic: 0.6, tunes: {} };
// ?prueba: las teclas 1 a 9 rompen piezas de tu auto y 0 lo arregla, para probar cómo maneja con daños
const DAMAGE_TEST = new URLSearchParams(location.search).has('prueba');
const MODES = [
  { value: 'race', label: 'Carrera' },
  { value: 'trial', label: 'Contrarreloj' },
];
// v: versión de lo guardado; antes de la 2 los rivales venían en 21 y se pasan a los 10 nuevos (uno por equipo)
const SETTINGS_VERSION = 2;
try {
  const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {};
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
const hud = {
  speed: $('speed'), gear: $('gear'), rpm: $('rpm'), mode: $('mode'), lights: $('lights'),
  help: $('help'), damage: $('damage'), tyres: $('tyres'), lap: $('lap'), pos: $('pos'), results: $('results'), replay: $('replay'), tower: $('tower'), stage: $('stage'), time: $('time'), last: $('last'), best: $('best'), msg: $('msg'),
};
for (let i = 0; i < SHIFT_LIGHTS; i++) hud.lights.appendChild(document.createElement('i'));
const minimap = $('minimap');
const mctx = minimap.getContext('2d');

const ghostModel = carModel('#3aa0ff', '#ffffff');
// el modelo 3D de cada equipo se arma la primera vez que hace falta (la decoración tarda un poco)
const teamModels = new Map();
// el modelo de cada auto: { team, slot, number } (los dos de un equipo cambian el número y el color de la T)
// sharp: la decoración con el doble de resolución, para el auto propio (desde la cabina se ve de muy cerca)
const modelFor = ({ team: t, slot, number }, sharp = 1) => {
  const key = `${t.id}/${slot}/${sharp}`;
  if (!teamModels.has(key)) teamModels.set(key, carModel(t.color, t.helmet, number, t.accent, TCAM[slot], { sharp, design: DESIGNS[t.id] }));
  return teamModels.get(key);
};
let wheelSpin = 0; // cuánto giraron las ruedas (rad), para animarlas
let lastDraw = 0;
const treeTex = treeTexture();
const boardTex = new Map([200, 150, 100, 50].map((d) => [d, boardTexture(d)]));
const cockpit = new Cockpit();
let cockpitView = true; // C alterna cabina / exterior
let showGuide = true; // G muestra u oculta la trazada ideal
const guides = new WeakMap(); // trazada ideal de cada circuito, se calcula una vez
const AI_BRAKE_USE = 0.93; // los rivales frenan más al límite que la trazada que ves (que usa el 85%)
const aiLines = new WeakMap(); // trazada de los rivales de cada circuito
const tvCams = new WeakMap(); // cámaras de TV de cada circuito, para la repetición

// ---------- entrada ----------
// Cada tecla se reconoce por su posición (e.code, como en un teclado QWERTY) y también por la letra
// que escribe (e.key), así funciona igual con distribuciones o teclados no convencionales.
const keys = new Set();
const held = new Map(); // e.code → nombres que agregó, para sacarlos al soltar
const SHIFT_UP = ['KeyX', 'KeyE', 'KeyO'];
const SHIFT_DOWN = ['KeyZ', 'KeyQ', 'KeyU'];

function keyNames(e) {
  const names = [e.code];
  if (e.key.length === 1 && /[a-z]/i.test(e.key)) names.push('Key' + e.key.toUpperCase());
  return names;
}

addEventListener('keydown', (e) => {
  if ((e.code.startsWith('Arrow') || e.code === 'Space') && !menuOpen()) e.preventDefault();
  // en el menú Enter lo maneja press (si no, además apretaría el botón que tiene el foco)
  if (e.code === 'Enter' && menuOpen()) e.preventDefault();
  if (settings.sound) audio.start(); // el navegador sólo deja arrancar el audio después de una tecla o un click
  if (e.code === 'KeyN' && !e.repeat) {
    toggleSound();
    flash(settings.sound ? 'Sonido' : 'Silencio');
  }
  const names = keyNames(e);
  held.set(e.code, names);
  for (const n of names) keys.add(n);
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
    else if (is('ArrowLeft', 'ArrowRight') && document.activeElement?.type !== 'range') stepChoice(is('ArrowLeft') ? -1 : 1);
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
  if (dir && game.car.manual && !game.car.shift(dir)) flash('Muy rápido para bajar');
  if (is('KeyC')) {
    cockpitView = !cockpitView;
    flash(cockpitView ? 'Vista cabina' : 'Vista exterior');
  }
  if (is('KeyG')) {
    showGuide = !showGuide;
    flash(showGuide ? 'Trazada ideal' : 'Sin trazada');
  }
  if (DAMAGE_TEST) testDamage(game.car, names);
}

// Teclas de prueba (?prueba): cada una rompe un poco más una pieza; 0 arregla todo
const TEST_KEYS = {
  Digit1: ['frontWing', 0, 'Alerón delantero izquierdo'], Digit2: ['frontWing', 1, 'Alerón delantero derecho'],
  Digit3: ['rearWing', 0, 'Alerón trasero izquierdo'], Digit4: ['rearWing', 1, 'Alerón trasero derecho'],
  Digit5: ['sidepod', 0, 'Pontón izquierdo'], Digit6: ['sidepod', 1, 'Pontón derecho'],
  Digit7: ['tyre', 2, 'Pinchazo trasera izquierda'], Digit8: ['suspension', 1, 'Suspensión delantera derecha'],
  Digit9: ['suspension', 0, 'Dirección rota'],
};
function testDamage(car, names) {
  if (names.includes('Digit0')) {
    car.damage = NO_DAMAGE;
    flash('Auto arreglado');
    return;
  }
  const key = names.find((n) => TEST_KEYS[n]);
  if (!key) return;
  const [part, i, label] = TEST_KEYS[key], d = car.damage;
  const step = part === 'tyre' ? 1e-3 : key === 'Digit9' ? 1 : 0.35;
  const value = Math.min(1, d[part][i] + step);
  car.damage = { ...d, [part]: d[part].map((x, k) => (k === i ? value : x)), retired: key === 'Digit9' ? label : d.retired };
  flash(part === 'tyre' ? label : `${label} ${Math.round(value * 100)} %`);
}

// Daños de tu auto: aparece sólo si hay algo roto. El auto visto desde arriba (la trompa para arriba), cada pieza
// de su color según cuánto está rota, y abajo la lista.
const DAMAGE_PARTS = [
  // pieza, índice, rectángulo en m (x adelante de 2,8 a -2,8; y a la derecha de -1 a 1), nombre
  ['frontWing', 0, [2.25, 2.8, -0.95, 0], 'Alerón del. izq.'], ['frontWing', 1, [2.25, 2.8, 0, 0.95], 'Alerón del. der.'],
  ['suspension', 0, [1.3, 2.0, -1.0, -0.6], 'Susp. del. izq.'], ['suspension', 1, [1.3, 2.0, 0.6, 1.0], 'Susp. del. der.'],
  ['sidepod', 0, [-1.3, 1.0, -0.8, -0.3], 'Pontón izq.'], ['sidepod', 1, [-1.3, 1.0, 0.3, 0.8], 'Pontón der.'],
  ['suspension', 2, [-2.05, -1.35, -1.0, -0.6], 'Susp. tras. izq.'], ['suspension', 3, [-2.05, -1.35, 0.6, 1.0], 'Susp. tras. der.'],
  ['rearWing', 0, [-2.8, -2.3, -0.5, 0], 'Alerón tras. izq.'], ['rearWing', 1, [-2.8, -2.3, 0, 0.5], 'Alerón tras. der.'],
];
const WHEEL_NAMES = ['del. izq.', 'del. der.', 'tras. izq.', 'tras. der.'];
const damageColor = (x) => (x <= 0 ? '#3a4150' : x < 0.34 ? '#ffd400' : x < 0.67 ? '#ff8a00' : '#ff3b30');
let damageClock = 0;
function drawDamage(g, time) {
  if (time - damageClock < 200) return;
  damageClock = time;
  const d = g.car.damage, show = damaged(d);
  hud.damage.classList.toggle('show', show);
  if (!show) return;
  const X = (y) => 30 + y * 20, Y = (x) => 60 - x * 20;
  const rect = ([x0, x1, y0, y1], fill, extra = '') => `<rect x="${X(y0)}" y="${Y(x1)}" width="${(y1 - y0) * 20}" height="${(x1 - x0) * 20}" rx="1.5" fill="${fill}"${extra}/>`;
  let svg = rect([1.0, 2.25, -0.25, 0.25], '#3a4150') + rect([-2.3, 1.0, -0.3, 0.3], '#3a4150'); // trompa y chasis
  const lines = [];
  for (const [part, i, box, name] of DAMAGE_PARTS) {
    const x = d[part][i];
    const flat = part === 'suspension' && d.tyre[i] > 0;
    // rota del todo: sólo el contorno, como si faltara; con la goma pinchada, un borde rojo cortado
    const outline = ' fill-opacity="0" stroke="#ff3b30" stroke-width="1.2" stroke-dasharray="2 1.5"';
    svg += rect(box, damageColor(x), x >= 1 ? outline : flat ? ' stroke="#ff3b30" stroke-width="1.5" stroke-dasharray="2 1.5"' : '');
    if (x > 0) lines.push(`<span style="color:${damageColor(x)}">${name} ${x >= 1 ? '<b>roto</b>' : `${Math.round(x * 100)} %`}</span>`);
  }
  d.tyre.forEach((t, i) => t > 0 && lines.push(`<span style="color:#ff2a2a">Pinchazo ${WHEEL_NAMES[i]}</span>`));
  if (d.retired) lines.push(`<b>Abandono: ${d.retired.toLowerCase()}</b>`);
  const html = `<svg viewBox="0 0 60 120" aria-label="Daños del auto">${svg}</svg><div>${lines.join('<br>')}</div>`;
  if (hud.damage.innerHTML !== html) hud.damage.innerHTML = html;
}
// Las gomas del panel: el color de cada una es su temperatura (azul fría, verde en su punto, de amarilla a roja
// pasada), con los °C; la barrita, la goma que le queda; un borde blanco, que está bloqueada o patinando
const TYRE_COLD = 50, TYRE_HOT = 40; // °C por debajo y por encima de la ventana hasta el azul y el rojo plenos
function tyreColor(t) {
  const hue = t < TEMP_LOW ? 130 + 80 * Math.min(1, (TEMP_LOW - t) / TYRE_COLD) : t > TEMP_HIGH ? 130 * (1 - Math.min(1, (t - TEMP_HIGH) / TYRE_HOT)) : 130;
  return `hsl(${hue.toFixed(0)} 75% 55%)`;
}
let tyresClock = 0;
function drawTyres(car, time) {
  if (time - tyresClock < 150) return;
  tyresClock = time;
  const cells = hud.tyres.children;
  for (let i = 0; i < 4; i++) {
    const c = cells[i], t = car.tyreTemp[i], left = Math.round((1 - car.tyreWear[i]) * 100);
    const html = `${Math.round(t)}<u style="width:${left}%"></u>`;
    if (c.innerHTML !== html) c.innerHTML = html;
    c.style.background = tyreColor(t);
    c.classList.toggle('slide', car.locked[i >> 1] || (i > 1 && car.wheelspin));
  }
}
addEventListener('keyup', (e) => {
  for (const n of held.get(e.code) ?? keyNames(e)) keys.delete(n);
  held.delete(e.code);
});
addEventListener('blur', () => {
  keys.clear();
  held.clear();
});

let keySteer = 0; // el volante con teclado, que va subiendo de a poco (keyboardSteer en car.js)
function readInput(dt, speed) {
  // flechas, WASD o IJKL, más el joystick: lo que se pise más fuerte de los dos
  const left = keys.has('ArrowLeft') || keys.has('KeyA') || keys.has('KeyJ');
  const right = keys.has('ArrowRight') || keys.has('KeyD') || keys.has('KeyL');
  const up = keys.has('ArrowUp') || keys.has('KeyW') || keys.has('KeyI');
  const down = keys.has('ArrowDown') || keys.has('KeyS') || keys.has('KeyK') || keys.has('Space');
  keySteer = keyboardSteer(keySteer, (right ? 1 : 0) - (left ? 1 : 0), speed, dt);
  return {
    throttle: Math.max(up ? 1 : 0, pad.throttle),
    brake: Math.max(down ? 1 : 0, pad.brake),
    steer: Math.max(-1, Math.min(1, keySteer + pad.steer)),
  };
}

// ---------- joystick ----------
// Con la Gamepad API y el mapeo estándar (los de Xbox y PlayStation): el gatillo derecho acelera y el izquierdo
// frena, la palanca izquierda dobla, y los tres son progresivos. Los botones hacen lo mismo que una tecla:
// RB/R1 sube de marcha (X), LB/L1 baja (Z), Y/△ cambia la cámara (C), X/□ la trazada (G),
// Start abre el menú o larga (Esc / Enter), Back/Share reinicia (R) y la cruceta elige el auto en la repetición.
const STICK_DEAD = 0.08; // zona muerta de la palanca: cerca del centro no dobla
const STEER_CURVE = 1.5; // la palanca dobla menos al principio, para corregir fino a alta velocidad
const TRIGGER_DEAD = 0.04;
const PAD_KEYS = { 4: 'KeyZ', 5: 'KeyX', 3: 'KeyC', 2: 'KeyG', 8: 'KeyR', 14: 'ArrowLeft', 15: 'ArrowRight' };
const pad = { throttle: 0, brake: 0, steer: 0, pressed: [] };

// El navegador recién muestra un joystick cuando se aprieta un botón con la página abierta. Si hay varios, usa el
// primero con mapeo estándar. Los que no lo tienen (algunos genéricos, o según el navegador) suelen traer los
// gatillos como ejes que en reposo valen -1: el primero frena y el segundo acelera.
let padId = null;
const padRest = new Map(); // id → valores de los ejes la primera vez que se lo vio (en reposo)

function pollPad() {
  const pads = [...(navigator.getGamepads?.() ?? [])].filter(Boolean);
  const gp = pads.find((g) => g.mapping === 'standard') ?? pads[0];
  if ((gp?.id ?? null) !== padId) {
    padId = gp?.id ?? null;
    $('pad-status').textContent = gp ? `Joystick: ${gp.id}` : 'Joystick: ninguno (conectalo y apretá cualquier botón)';
    if (gp && game) flash('Joystick conectado');
  }
  if (!gp) {
    Object.assign(pad, { throttle: 0, brake: 0, steer: 0 });
    return;
  }
  if (!padRest.has(gp.id)) padRest.set(gp.id, [...gp.axes]);
  const value = (i) => gp.buttons[i]?.value ?? 0;
  const dead = (x) => Math.max(0, (x - TRIGGER_DEAD) / (1 - TRIGGER_DEAD));
  let brake = value(6), throttle = value(7);
  if (gp.mapping !== 'standard') {
    const triggers = padRest.get(gp.id).map((a, i) => (i >= 2 && a < -0.5 ? i : -1)).filter((i) => i >= 0);
    if (triggers.length >= 2) {
      brake = Math.max(brake, (gp.axes[triggers[0]] + 1) / 2);
      throttle = Math.max(throttle, (gp.axes[triggers[1]] + 1) / 2);
    }
  }
  const x = gp.axes[0] ?? 0, mag = Math.max(0, (Math.abs(x) - STICK_DEAD) / (1 - STICK_DEAD));
  pad.throttle = dead(throttle);
  pad.brake = dead(brake);
  pad.steer = Math.sign(x) * Math.min(1, mag) ** STEER_CURVE;
  gp.buttons.forEach((b, i) => {
    if (b.pressed && !pad.pressed[i]) {
      if (i === 9) press([menuOpen() ? 'Enter' : 'Escape']);
      else if (PAD_KEYS[i]) press([PAD_KEYS[i]]);
    }
    pad.pressed[i] = b.pressed;
  });
}

// ---------- estado del juego ----------
let game = null;
let lastGame = null; // la última carrera, para conservar el mejor tiempo y el fantasma al volver del menú
let carProfile = DEFAULT_PROFILE;
// Los rivales manejan con la red entrenada (rl/CURRICULO.md); con ?ia=models/fase7.json, con otra, y con ?ia=clasica,
// con la IA de siempre (ai.js), que es también la que queda si la red no carga
const CURRENT_NET = 'models/v22/fase18.json';
const IA_PARAM = new URLSearchParams(location.search).get('ia') || CURRENT_NET;
const NEURAL_URL = IA_PARAM === 'clasica' ? null : IA_PARAM;
let neuralPolicy = null;

function resetGame(track) {
  const prev = game || lastGame;
  const prevBest = prev && prev.track === track ? prev.best : null;
  const prevGhost = prev && prev.track === track ? prev.ghost : null;
  const team = teamById(settings.team);
  const difficulty = DIFFICULTIES.find((d) => d.id === settings.difficulty) || DIFFICULTIES[2];
  const trial = settings.mode === 'trial';
  // en contrarreloj no hay rivales
  const others = trial ? [] : rivalCars(team, settings.rivals, settings.driver);
  const paces = rivalPaces(difficulty, others.length), setups = rivalSetups(difficulty, others.length);
  // grilla: los rivales adelante (los mejores autos tienden a largar primero) y vos al final
  const slots = gridSlots(track, others.length + 1), grid = gridOrder(others.length);
  const spawn = slots[others.length];
  const car = Object.assign(new Car(spawn.x, spawn.y, spawn.angle, carProfile), { manual: settings.gearbox === 'manual', tc: TRACTION_CONTROL[settings.traction] ?? 0, abs: !!settings.abs, ownTune: settings.tunes[settings.track] ?? null }).placeOn(track);
  const mine = teamCar(team, settings.driver);
  const player = { name: 'Vos', team: team.name, code: 'VOS', number: mine.number, color: team.color, car, driver: null, race: newRace(track, car), model: modelFor(mine, 2), dist: 0, gridBack: spawn.back };
  const rivals = others.map((o, i) => {
    const t = o.team, s = slots[grid[i]], c = Object.assign(new Car(s.x, s.y, s.angle, carProfile), RIVAL_AIDS).placeOn(track);
    // con la red, la dificultad es el auto: más o menos agarre y potencia
    if (neuralPolicy) c.setup = setups[i];
    return {
      name: o.name, team: t.name, code: o.code, number: o.number, color: t.color, car: c, race: newRace(track, c),
      driver: neuralPolicy ? new NeuralDriver(neuralPolicy) : new Driver(paces[i], i + 1),
      model: modelFor(o), spin: 0, dist: 0, gridBack: s.back,
      // en la grilla cada rival acelera hasta unas vueltas propias y reacciona al semáforo con su tiempo
      revTarget: LAUNCH_WINDOW[0] - 300 + Math.random() * 1500, react: 0.12 + Math.random() * 0.22,
    };
  }).sort((a, b) => a.gridBack - b.gridBack); // en orden de grilla: así los muestra la tabla antes de largar
  const wearRate = RACE_WEAR / (wearLaps({ trial, laps: settings.laps }) * track.length * track.meters);
  // nafta: en carrera, la justa para las vueltas que son (se va gastando y el auto se aliviana); en contrarreloj,
  // como en clasificación: unos kilos que no se gastan
  const fuel = trial ? { fuel: TRIAL_FUEL, fuelFlow: 0 } : { fuel: FUEL_PER_KM * settings.laps * (track.length * track.meters) / 1000 };
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
    raceTime: 0,
    finished: [], // orden de llegada: { entry, time }
    countdown: 0, // segundos hasta que se apaga el semáforo (se calcula abajo)
    lightsTotal: 0,
    awaitLaunch: false, // si al apagarse el semáforo no estabas acelerando: largás cuando acelerás
    running: false, // la vuelta empieza al cruzar la línea
    lapTime: 0,
    lap: 0,
    last: null,
    best: prevBest,
    lapMaxProgress: 0,
    prevAlong: lineCoords(track, spawn.x, spawn.y).along,
    resultsShown: false,
    rec: [],
    recClock: 0,
    ghost: prevGhost,
    progressLog: [],
    wrongWay: false,
  };
  const L = Math.ceil(track.path.st[track.path.n]);
  for (const e of game.entries) {
    e.passTimes = new Float32Array(L * ((trial ? 1 : game.laps) + 3)).fill(-1); // hora de paso por cada celda (ver timePasses)
    e.lastPass = -1;
  }
  towerClock = 0;
  game.lightsTotal = game.countdown = lightsDuration(randomHold());
  if (!guides.has(track)) guides.set(track, racingLine(track, limitsOn(carProfile, track)));
  // la goma arranca con la franja tenue de otra categoría sobre la trazada y la carrera la va marcando
  game.rubber = new RubberMap(track, guides.get(track).offset);
  for (const e of game.entries) e.car.rubber = game.rubber; // y agarra según cuánta haya (car.js)
  if (!aiLines.has(track)) aiLines.set(track, racingLine(track, limitsOn(carProfile, track), { brakeUse: AI_BRAKE_USE }));
  if (!tvCams.has(track)) tvCams.set(track, tvCameras(track));
  hud.stage.classList.remove('replay');
  hud.stage.classList.toggle('trial', trial);
  drawMinimapBase(track);
}

// Color de la trazada según la velocidad del auto: verde = se puede acelerar, amarillo = mantener o
// levantar, rojo = hay que frenar. Desde el auto hacia adelante se proyecta la velocidad: acelerando
// a fondo mientras se pueda; donde la trazada pide ir más lento que eso, es zona de frenada
// (y se supone que el auto frenó hasta esa velocidad).
const GUIDE_GREEN = [40, 205, 70], GUIDE_YELLOW = [245, 205, 40], GUIDE_RED = [235, 35, 35];
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

function lineCoords(track, x, y) {
  const { line } = track;
  const ax = x - line.x, ay = y - line.y;
  return { along: ax * line.dx + ay * line.dy, side: -ax * line.dy + ay * line.dx };
}

// si el rival lo maneja una red que ve el semáforo (sensors.js): sube las vueltas y larga ella
const seesLights = (e) => e.driver instanceof NeuralDriver && e.driver.policy.lights;

function update(dt) {
  const g = game;
  const input = readInput(dt, g.car.speed);

  // con el semáforo en rojo los autos quedan quietos en la grilla, pero se puede subir de vueltas
  if (g.countdown > 0) {
    g.countdown -= dt;
    g.car.rev(dt, input.throttle);
    // los rivales con una red que ve el semáforo suben y bajan las vueltas ellos (sensors.js); los demás, hasta las suyas
    const lights = lightsAt(g.lightsTotal - Math.max(0, g.countdown), g.lightsTotal);
    for (const e of g.entries) {
      if (!e.driver) continue;
      if (seesLights(e)) {
        e.car.lights = lights;
        const inp = e.driver.grid(dt, g.track, e, g.entries.filter((o) => o !== e));
        e.car.revBy(dt, inp.revUp, inp.revDown);
        e.car.throttle = inp.throttle;
      } else e.car.rev(dt, e.car.rpm < e.revTarget);
    }
    // se apagan las luces: el que viene acelerando suelta el embrague ya
    if (g.countdown <= 0) {
      if (input.throttle) g.car.launch();
      else g.awaitLaunch = true;
      // las redes que ven el semáforo: como vos, sin la reacción de la IA (la pone la red, al acelerar)
      for (const e of g.entries) {
        if (!e.driver || !seesLights(e)) continue;
        e.car.lights = LIGHTS_OUT;
        e.react = 0;
        if (e.driver.input.throttle > 0) e.car.launch();
        else e.gridWait = true;
      }
    }
  } else {
    g.raceTime += dt;
    // si no estabas acelerando, largás cuando acelerás
    if (g.awaitLaunch) {
      if (input.throttle) {
        g.car.launch();
        g.awaitLaunch = false;
      } else g.car.rev(dt, false);
    }
    // los rivales que abandonaron y ya sacaron de la pista no cuentan más (vos quedás donde paraste)
    const cars = g.entries.filter((e) => e === g.player || !e.car.gone).map((e) => e.car);
    for (const c of cars) c.draft = slipstream(c, cars, g.track.meters);
    if (!g.awaitLaunch) g.car.update(dt, input, g.track);
    const line = aiLines.get(g.track);
    const states = g.entries.map((e) => carState(g.track, e));
    g.entries.forEach((e, i) => {
      if (!e.driver || e.car.gone) return;
      // una red que no venía acelerando cuando se apagaron las luces: larga cuando acelera
      if (e.gridWait) {
        if (e.driver.grid(dt, g.track, e, g.entries.filter((o) => o !== e)).throttle > 0) {
          e.car.launch();
          e.gridWait = false;
        } else {
          e.car.rev(dt, false);
          return;
        }
      }
      // cada rival tarda un poquito en reaccionar al semáforo
      if (e.react > 0) {
        e.react -= dt;
        e.car.rev(dt, e.car.rpm < e.revTarget);
        if (e.react <= 0) e.car.launch();
        return;
      }
      const others = states.filter((_, j) => j !== i && !g.entries[j].car.gone);
      e.car.update(dt, e.driver.drive(dt, g.track, line, states[i], others), g.track);
      e.spin = (e.spin + (e.car.speed * dt) / WHEEL_R) % (Math.PI * 2);
    });
    collideCars(cars, g.track, isSolid);
    for (const e of g.entries) if (e.car.damage.retired && e.out === undefined) retire(g, e);
    for (const e of g.entries) {
      e.head = turnHead(e.head, lookYaw(e.car, cars, g.track), dt);
      const c = e.car;
      e.body = suspension(e.body, c.speed * c.omega, (c.speed - (e.prevSpeed ?? c.speed)) / dt, dt);
      e.prevSpeed = c.speed;
      e.paddles = paddles(e.paddles, c.gear, dt);
    }
    for (const e of g.entries) if (e.driver) raceLine(g, e);
    for (const e of g.entries) e.dist += Math.abs(e.car.speed) * dt;
    g.rubber.update(dt, states);
    g.recorder.add(dt, g.entries);
    timePasses(g);
  }

  // cruce de la línea de largada
  const { along, side } = lineCoords(g.track, g.car.x, g.car.y);
  if (g.prevAlong < 0 && along >= 0 && Math.abs(side) < g.track.line.half) {
    if (!g.running) {
      g.running = true;
      g.player.race.started = true;
    } else if (g.lapMaxProgress > g.track.maxProgress * 0.75) {
      completeLap(g);
    } else {
      flash('Vuelta inválida');
    }
    g.lapTime = 0;
    g.lapMaxProgress = 0;
    g.rec = [];
    g.recClock = 0;
  }
  g.prevAlong = along;

  if (g.running) {
    g.lapTime += dt;
    const ix = Math.floor(g.car.x), iy = Math.floor(g.car.y);
    const p = g.track.progress[iy * g.track.W + ix];
    // sólo cuenta el progreso continuo (evita atajos y cruzar la línea marcha atrás)
    if (p >= 0 && p <= g.lapMaxProgress + 40) g.lapMaxProgress = Math.max(g.lapMaxProgress, p);

    g.recClock += dt;
    while (g.recClock >= GHOST_STEP) {
      g.recClock -= GHOST_STEP;
      g.rec.push(g.car.x, g.car.y);
    }

    // contramano: el progreso viene bajando sostenidamente
    g.progressLog.push(p);
    if (g.progressLog.length > 45) g.progressLog.shift();
    const first = g.progressLog[0], lastP = g.progressLog[g.progressLog.length - 1];
    g.wrongWay = first >= 0 && lastP >= 0 && first - lastP > 6 && first - lastP < 200 && g.car.speed > 3;
  }
}

// ---------- carrera ----------
// estado de carrera de un auto: vueltas completas y si ya cruzó la línea por primera vez (largó)
function newRace(track, car) {
  return { laps: 0, started: false, prevAlong: lineCoords(track, car.x, car.y).along, maxProgress: 0 };
}

// posición sobre la línea central y de costado, para el piloto automático y para ordenar la carrera
function carState(track, e) {
  const st = stationAt(track, e.car.x, e.car.y);
  e.st = st >= 0 ? st : (e.st ?? 0);
  e.lat = sampleField(track.lat, track.W, e.car.x, e.car.y);
  return { car: e.car, st: e.st, lat: e.lat };
}

// vueltas de los rivales: cada cruce de la línea, si dieron la vuelta completa
function raceLine(g, e) {
  const { track } = g;
  const r = e.race;
  const { along, side } = lineCoords(track, e.car.x, e.car.y);
  const p = track.progress[Math.floor(e.car.y) * track.W + Math.floor(e.car.x)];
  if (p >= 0 && p <= r.maxProgress + 40) r.maxProgress = Math.max(r.maxProgress, p);
  if (r.prevAlong < 0 && along >= 0 && Math.abs(side) < track.line.half) {
    if (!r.started) r.started = true;
    else if (r.maxProgress > track.maxProgress * 0.75) {
      r.laps++;
      if (r.laps === g.laps) finish(g, e);
    }
    r.maxProgress = 0;
  }
  r.prevAlong = along;
}

// abandono: queda último (entre los que abandonaron, el que más anduvo) y, si sos vos, la carrera terminó
function retire(g, e) {
  e.out = g.raceTime;
  if (e === g.player) {
    flash(`Abandono: ${e.car.damage.retired.toLowerCase()}`);
    g.replayIn = REPLAY_DELAY;
  } else flash(`Abandona ${e.code}`);
}

function finish(g, e) {
  if (g.finished.some((f) => f.entry === e)) return;
  g.finished.push({ entry: e, time: g.raceTime });
  if (e === g.player) {
    flash(`¡Terminaste ${g.finished.length}º!`);
    g.replayIn = REPLAY_DELAY;
  }
}

// orden de carrera: primero los que llegaron, en orden; después por vueltas y distancia recorrida
// distancia de carrera (celdas de la línea central): vueltas completas más lo recorrido de la actual;
// antes de cruzar la línea por primera vez, negativa (están en la grilla)
function raceDistance(g, e) {
  const L = g.track.path.st[g.track.path.n];
  const st = e.st ?? 0;
  return e.race.started ? e.race.laps * L + st : st - L;
}

function raceOrder(g) {
  const progress = (e) => {
    const done = g.finished.findIndex((f) => f.entry === e);
    return done >= 0 ? 1e9 - done : raceDistance(g, e) - (e.out !== undefined ? 1e8 : 0);
  };
  return [...g.entries].sort((a, b) => progress(b) - progress(a));
}

// Cronometraje: cada auto anota a qué hora pasó por cada celda de la línea central, vuelta tras vuelta.
// Así la distancia con el de adelante es cuánto hace que el de adelante pasó por donde está ahora el de atrás.
function timePasses(g) {
  const L = g.track.path.st[g.track.path.n];
  for (const e of g.entries) {
    const i = Math.floor(raceDistance(g, e) + L);
    if (e.lastPass < 0) e.lastPass = i; // primera anotación: desde la grilla
    // en la línea, la vuelta y la posición no cambian en el mismo cuadro: un salto grande se ignora
    if (i <= e.lastPass || i - e.lastPass > 40 || i >= e.passTimes.length) continue;
    e.passTimes.fill(g.raceTime, Math.max(0, e.lastPass + 1), i + 1);
    e.lastPass = i;
  }
}

// diferencia (s) del auto `behind` con el de adelante (`ahead`); o vueltas de diferencia
function interval(g, ahead, behind) {
  const fa = g.finished.find((f) => f.entry === ahead), fb = g.finished.find((f) => f.entry === behind);
  if (fa && fb) return `+${(fb.time - fa.time).toFixed(1)}`;
  const L = g.track.path.st[g.track.path.n];
  const da = raceDistance(g, ahead), db = raceDistance(g, behind);
  if (da - db > L) return `+${Math.floor((da - db) / L)} V`;
  const t = ahead.passTimes[Math.floor(db + L)];
  return t >= 0 && db > -L ? `+${(g.raceTime - t).toFixed(1)}` : '';
}

// tabla de posiciones (como la de la TV): posición, auto y distancia con el de adelante
let towerClock = 0;
function drawTower(g, time) {
  if (time - towerClock < 200) return; // 5 veces por segundo alcanza, y se lee mejor
  towerClock = time;
  const order = raceOrder(g);
  const rows = order.map((e, i) => {
    const gap = e.out !== undefined ? 'AB' : i === 0 ? (g.finished.some((f) => f.entry === e) ? 'Final' : 'Líder') : interval(g, order[i - 1], e);
    const me = e === g.player ? ' class="me"' : '';
    return `<tr${me}><td>${i + 1}</td><td><i style="background:${e.color}"></i>${e.code}<small>${e.number}</small></td><td>${gap}</td></tr>`;
  });
  const html = `<table>${rows.join('')}</table>`;
  if (hud.tower.innerHTML !== html) hud.tower.innerHTML = html;
}

// tabla de resultados: aparece cuando terminás
function drawResults(g) {
  const show = g.finished.some((f) => f.entry === g.player) || g.player.out !== undefined;
  hud.results.classList.toggle('show', show);
  if (!show) return;
  const first = g.finished[0]?.time;
  const rows = raceOrder(g).map((e, i) => {
    const f = g.finished.find((x) => x.entry === e);
    const gap = e.out !== undefined ? 'Abandono' : !f ? 'en pista' : i === 0 ? fmt(f.time) : `+${(f.time - first).toFixed(3)}`;
    const me = e === g.player ? ' class="me"' : '';
    return `<tr${me}><td>${i + 1}</td><td><i style="background:${e.color}"></i>${e.name}<small>${e.team}</small></td><td>${gap}</td></tr>`;
  });
  const html = `<h3>Resultado</h3><table>${rows.join('')}</table><p>R para correr de nuevo · Esc menú</p>`;
  if (hud.results.innerHTML !== html) hud.results.innerHTML = html;
}

function completeLap(g) {
  g.lap++;
  g.player.race.laps = g.lap;
  if (g.lap === g.laps) finish(g, g.player);
  g.last = g.lapTime;
  if (g.best === null || g.lapTime < g.best) {
    g.best = g.lapTime;
    if (g.trial) g.ghost = Float32Array.from(g.rec); // el fantasma es la mejor vuelta de contrarreloj
    flash(`¡Mejor vuelta! ${fmt(g.lapTime)}`);
  } else {
    flash(`Vuelta ${fmt(g.lapTime)}`);
  }
}

let flashTimer = 0;
function flash(text) {
  hud.msg.textContent = text;
  hud.msg.classList.add('show');
  flashTimer = 2.5;
}

function fmt(t) {
  if (t === null) return '--:--.---';
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(3).padStart(6, '0')}`;
}

// ---------- dibujo ----------
// posición del fantasma en la muestra u (con decimales), interpolando entre las dos grabadas más cercanas
function ghostAt(ghost, u) {
  const last = ghost.length / 2 - 1;
  u = Math.min(last, Math.max(0, u));
  const i = Math.min(last - 1, Math.floor(u)), t = u - i;
  return [ghost[2 * i] + (ghost[2 * i + 2] - ghost[2 * i]) * t, ghost[2 * i + 1] + (ghost[2 * i + 3] - ghost[2 * i + 1]) * t];
}

// árboles y carteles del circuito, como sprites (tamaños en metros, pasados a celdas)
function trackSprites(track) {
  const M = track.meters;
  const sprites = track.trees.map((t) => ({ x: t.x, y: t.y, z: t.z, width: (4 * t.scale) / M, height: (8 * t.scale) / M, tex: treeTex }));
  // carteles de frenada: 3,2 m de ancho por 2,7 m de alto (tablero sobre patas), grandes para leerlos a tiempo
  for (const b of track.boards) sprites.push({ x: b.x, y: b.y, z: b.z, width: 3.2 / M, height: 2.7 / M, tex: boardTex.get(b.meters) });
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
  const g = game, r = g.replay, { track } = g;
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
    const q = next[k], omega = Math.atan2(Math.sin(q.angle - p.angle), Math.cos(q.angle - p.angle)) / 0.1;
    return suspension(r.bodies[k], p.speed * omega, (q.speed - p.speed) / 0.1, 1 / 60);
  });
  r.paddles ??= [];
  r.paddles = poses.map((p, k) => paddles(r.paddles[k], p.gear, 1 / 60));
  const models = g.entries.map((e, k) => {
    const p = poses[k];
    return {
      model: e.model, x: p.x, y: p.y, z: heightAt(p.x, p.y), angle: p.angle, meters: M,
      pitch: Math.atan(p.slope), roll: r.bodies[k].roll, dive: r.bodies[k].dive,
      steer: wheelAngle(p.steer, p.speed, g.car.limits), spin: (p.dist / WHEEL_R) % (Math.PI * 2), head: r.heads[k], ...tyres(g, p.dist), shadow: true,
      wheelTurn: p.steer * STEERING.turn, headTilt: headTilt(r.bodies[k]), paddle: r.paddles[k].pull,
    };
  });
  const cam = replayCamera(r.mode, pose, track, tvCams.get(track), r.tv, r.t, renderer.w / 2 / 0.7);
  renderer.guide = null;
  renderer.rubber = g.rubber; // como quedó al terminar
  // sonido: se escucha desde la cámara; la de TV está quieta, las demás van con el auto
  const moving = cam.mode !== 'tv';
  playEngines(poses.map((p) => ({ ...p, x: p.x * M, y: p.y * M })), cam, M,
    moving ? Math.cos(pose.angle) * pose.speed : 0, moving ? Math.sin(pose.angle) * pose.speed : 0, cam.mode === 'onboard' ? r.target : -1);
  audio.surface({}); // en la repetición no suenan los pianos
  await renderer.render(track, cam, trackSprites(track), models);
  ctx.clearRect(0, 0, VIEW_W, VIEW_H);

  // cartel: auto que se sigue, su posición en ese momento, cámara y tiempo de carrera
  // la posición en ese momento: lo que recorrió cada uno, descontando cuán atrás largó en la grilla
  const e = g.entries[r.target];
  const ahead = (k) => poses[k].dist - g.entries[k].gridBack;
  const order = g.entries.map((_, k) => k).sort((a, b) => ahead(b) - ahead(a));
  const html = `<b>REPETICIÓN</b> <span><i style="background:${e.color}"></i>${e.name} · P${order.indexOf(r.target) + 1}</span>`
    + `<span>${Math.round(Math.abs(pose.speed) * 3.6)} km/h</span><span>${fmt(r.t)}</span>`
    + `<small>Cámara: ${CAMERA_NAMES[r.mode]}${r.mode === 'auto' ? ` (${CAMERA_NAMES[cam.mode]})` : ''} · C cámara · ←→ auto · R nueva carrera · Esc menú</small>`;
  if (hud.replay.innerHTML !== html) hud.replay.innerHTML = html;
  drawMinimapAt(track, poses.map((p, k) => [p.x, p.y, g.entries[k].color, k === r.target]));
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
  let best = Infinity, yaw = 0;
  for (const o of cars) {
    if (o === car) continue;
    const dx = o.x - car.x, dy = o.y - car.y, d = Math.hypot(dx, dy) * M;
    const rel = wrapAngle(Math.atan2(dy, dx) - car.angle);
    if (d < LOOK_CAR && d < best && Math.abs(rel) <= LOOK_CONE) { best = d; yaw = rel; }
  }
  if (best < Infinity) return yaw;
  const line = guides.get(track), u = stationAt(track, car.x, car.y);
  if (!line || u < 0) return 0;
  // el punto más lento de la trazada en el tramo de adelante; si es un vértice de verdad, se mira ahí
  const L = line.speed.length, a = Math.round(u + LOOK_AHEAD[0] / M), b = Math.round(u + LOOK_AHEAD[1] / M);
  let lo = Infinity, hi = 0, at = a;
  for (let i = a; i <= b; i++) {
    const v = line.speed[((i % L) + L) % L];
    if (v < lo) { lo = v; at = i; }
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
const buzz = (c) => ((c.rough ?? c.grass) * Math.min(1, Math.abs(c.speed) / 25) + (c.onKerb ? Math.min(1, Math.abs(c.speed) / 35) * 0.5 : 0) + (c.jolt ?? 0))
  * BUZZ * (Math.random() * 2 - 1);

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
  if (g.trial && g.ghost && g.running && g.ghost.length >= 4) {
    // la vuelta se grabó 30 veces por segundo y se dibuja más seguido: interpolamos entre muestras
    // para que avance suave, y el rumbo sale de puntos un poco antes y un poco después, para que no tiemble
    const u = g.lapTime / GHOST_STEP - 1;
    const [gx, gy] = ghostAt(g.ghost, u);
    const [ax, ay] = ghostAt(g.ghost, u - 3);
    const [bx, by] = ghostAt(g.ghost, u + 3);
    const angle = bx !== ax || by !== ay ? Math.atan2(by - ay, bx - ax) : car.angle;
    const fx = Math.cos(angle), fy = Math.sin(angle);
    const pitch = Math.atan((heightAt(gx + fx * 1.5, gy + fy * 1.5) - heightAt(gx - fx * 1.5, gy - fy * 1.5)) / 3);
    models.push({ model: ghostModel, x: gx, y: gy, z: heightAt(gx, gy), angle, pitch, meters: M, alpha: 0.55 });
  }

  // rivales
  for (const e of g.entries) {
    if (!e.driver || e.car.gone) continue;
    const c = e.car;
    models.push({
      // arriba del piano o de la salchicha, el auto sube y se inclina con las ruedas que se levantan
      model: e.model, x: c.x, y: c.y, z: heightAt(c.x, c.y) + c.lift, angle: c.angle, meters: M,
      pitch: Math.atan(c.slope), roll: (e.body?.roll ?? 0) + c.liftRoll, dive: (e.body?.dive ?? 0) + c.liftDive,
      steer: wheelAngle(c.steer, c.speed, c.limits), spin: e.spin, head: e.head, ...tyres(g, e.dist, c.wear), shadow: true,
      wheelTurn: c.steer * STEERING.turn + buzz(c), headTilt: headTilt(e.body), paddle: e.paddles?.pull,
    });
  }

  // cámara en la cabina o un poco detrás del auto, a la altura del terreno,
  // con traqueteo en el pasto, en la leca, en los pianos y al chocar
  const shake =
    (car.rough ?? car.grass) * Math.min(1, Math.abs(car.speed) / 25) * 3 +
    (car.onKerb ? Math.min(1, Math.abs(car.speed) / 35) * 1.2 : 0) +
    car.bump * 4 + car.jolt * 5;
  // contra un muro, la cámara de afuera se acerca hasta que deja de estar adentro
  let behind = (cockpitView ? COCKPIT_BACK : CAM_BEHIND) / M;
  while (behind > 0 && isSolid(track, car.x - Math.cos(car.angle) * behind, car.y - Math.sin(car.angle) * behind)) behind -= 0.2;
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
  cam.pitch = (cockpitView ? -28 : -40) * UI_SCALE + car.slope * renderer.P * 0.6 + shakeY
    - (cockpitView ? (g.player.body?.dive ?? 0) * renderer.P : 0); // frenando, la vista baja con la trompa
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
  g.player.wheelTurn = (g.player.wheelTurn ?? 0) + (car.steer * STEERING.turn - (g.player.wheelTurn ?? 0)) * Math.min(1, dt * WHEEL_TURN_RATE);
  // desde la cabina se ve el mismo auto, sin el casco (ahí está la cámara) y sin rolido; la pendiente,
  // en la misma medida en que la cámara la sigue, así la carrocería queda quieta en la pantalla
  models.push({
    model: g.player.model, x: car.x, y: car.y, z: heightAt(car.x, car.y) + car.lift, angle: car.angle, meters: M,
    pitch: Math.atan(car.slope) * (cockpitView ? 0.6 : 1),
    // la carrocería rola y cabecea sobre la suspensión; desde la cabina no, porque la cámara va pegada a ella
    // (ahí el cabeceo mueve la vista: ver cam.pitch)
    roll: cockpitView ? 0 : (g.player.body?.roll ?? 0) + car.liftRoll, dive: cockpitView ? 0 : (g.player.body?.dive ?? 0) + car.liftDive,
    steer: wheelAngle(car.steer, car.speed, car.limits), spin: wheelSpin, head: g.player.head, ...tyres(g, g.player.dist, car.wear), shadow: true, hide: cockpitView ? 'helmet' : null,
    // el volante gira con la dirección y muestra la marcha; desde la cabina la pintura de tan cerca brilla menos
    wheelTurn: g.player.wheelTurn + buzz(car), screen: cockpit.screen(car), gloss: cockpitView ? 0.35 : 1,
    headTilt: headTilt(g.player.body), paddle: g.player.paddles?.pull,
  });
  playEngines(g.entries.map((e) => ({ rpm: e.car.rpm, throttle: e.car.throttle, gear: e.car.gear, x: e.car.x * M, y: e.car.y * M, angle: e.car.angle, speed: e.car.speed })),
    cam, M, Math.cos(car.angle) * car.speed, Math.sin(car.angle) * car.speed, cockpitView ? g.entries.indexOf(g.player) : -1);
  // las ruedas propias sobre el piano, el verde o la salchicha
  if (settings.sound) {
    const on = (w) => car.wheels.filter((x) => x === w).length / 4;
    audio.surface({ kerb: on('kerb') + on('sausage'), green: on('green'), speed: car.speed, ridge: RIDGE * M, jolt: car.jolt });
  }
  await renderer.render(track, cam, sprites, models);
  ctx.clearRect(0, 0, VIEW_W, VIEW_H);

  if (g.countdown > 0 || g.raceTime < 1) drawLights(g);

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
  hud.lap.textContent = g.trial ? g.lap + 1 : `${Math.min(g.laps, g.lap + 1)}/${g.laps}`;
  hud.pos.textContent = `${raceOrder(g).indexOf(g.player) + 1}/${g.entries.length}`;
  drawTower(g, time);
  drawDamage(g, time);
  drawTyres(car, time);
  drawResults(g);
  hud.time.textContent = g.running ? fmt(g.lapTime) : fmt(null);
  hud.last.textContent = fmt(g.last);
  hud.best.textContent = fmt(g.best);
  if (g.wrongWay && flashTimer <= 0) {
    hud.msg.textContent = '¡CONTRAMANO!';
    hud.msg.classList.add('show');
  } else if (flashTimer <= 0) {
    hud.msg.classList.remove('show');
  }

  drawMinimap(g);
}

// Semáforo de largada, como el de la F1: cinco columnas con dos luces rojas cada una.
// Se prenden de a una por segundo y, después de una espera al azar, se apagan todas: ahí se larga.
function drawLights(g) {
  const elapsed = g.lightsTotal - Math.max(0, g.countdown);
  const { lit } = lightsAt(elapsed, g.lightsTotal);
  const w = 26, gap = 6, x0 = 240 - (5 * w + 4 * gap) / 2, y0 = 22;
  ctx.save();
  ctx.scale(UI_SCALE, UI_SCALE);
  ctx.fillStyle = 'rgba(10,10,12,0.9)';
  ctx.fillRect(x0 - 8, y0 - 6, 5 * w + 4 * gap + 16, 2 * w + 10);
  for (let i = 0; i < 5; i++) {
    const x = x0 + i * (w + gap);
    ctx.fillStyle = '#1b1b1f';
    ctx.fillRect(x, y0 - 2, w, 2 * w + 2);
    for (let row = 0; row < 2; row++) {
      ctx.beginPath();
      ctx.arc(x + w / 2, y0 + w / 2 + row * w, w * 0.36, 0, Math.PI * 2);
      ctx.fillStyle = i < lit ? '#ff1e1e' : '#3a0d0d';
      if (i < lit) {
        ctx.shadowColor = '#ff2a2a';
        ctx.shadowBlur = 10;
      }
      ctx.fill();
      ctx.shadowBlur = 0;
    }
  }
  ctx.restore();
}

let minimapBase = null;
function drawMinimapBase(track) {
  const { W, H, tiles } = track;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d');
  const img = g.createImageData(W, H);
  const d = new Uint32Array(img.data.buffer);
  for (let i = 0; i < W * H; i++) {
    const t = tiles[i];
    if (t === T.ROAD) d[i] = 0xf0ffffff;
    else if (t === T.WALL) d[i] = 0x50ffffff;
  }
  g.putImageData(img, 0, 0);
  minimap.width = 220;
  minimap.height = Math.round((220 * H) / W);
  minimapBase = c;
}

function drawMinimap(g) {
  const { W } = g.track;
  const k = minimap.width / W;
  mctx.clearRect(0, 0, minimap.width, minimap.height);
  mctx.drawImage(minimapBase, 0, 0, minimap.width, minimap.height);
  if (g.trial && g.ghost && g.running) {
    const i = Math.min(Math.floor(g.lapTime / GHOST_STEP), g.ghost.length / 2 - 1) * 2;
    dot(g.ghost[i] * k, g.ghost[i + 1] * k, '#3aa0ff');
  }
  for (const e of g.entries) if (e.driver && !e.car.gone) dot(e.car.x * k, e.car.y * k, e.color, 3);
  dot(g.car.x * k, g.car.y * k, g.player.color);
}

// minimapa de la repetición: dots = [[x, y, color, destacado]]
function drawMinimapAt(track, dots) {
  const k = minimap.width / track.W;
  mctx.clearRect(0, 0, minimap.width, minimap.height);
  mctx.drawImage(minimapBase, 0, 0, minimap.width, minimap.height);
  for (const [x, y, color, big] of [...dots].sort((a, b) => a[3] - b[3])) dot(x * k, y * k, color, big ? 5 : 3);
}

function dot(x, y, color, r = 4) {
  mctx.beginPath();
  mctx.arc(x, y, r, 0, Math.PI * 2);
  mctx.fillStyle = color;
  mctx.fill();
  mctx.strokeStyle = '#000';
  mctx.stroke();
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
  pollPad();
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
      (game.replay ? drawReplay(now) : draw(now)).finally(() => { drawing = false; });
    }
    flashTimer -= dt;
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
  const [img, elevation] = await Promise.all([loadImage(def.image), def.elevation ? fetch(def.elevation).then((r) => r.json()) : null]);
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
    flash('No se pudo cargar el circuito');
  } finally {
    button.textContent = 'Largar';
    starting = false;
  }
}

// una fila de botones: elegir uno lo marca, lo guarda en settings[key] y vuelve a dibujar el menú
// (o.html: el contenido del botón; o.el: le agrega ese elemento al final)
function choices(el, options, key, onChange) {
  el.replaceChildren(...options.map((o) => {
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
  }));
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
  const laps = settings.mode === 'trial' ? 'contrarreloj' : `${settings.laps} ${settings.laps === 1 ? 'vuelta' : 'vueltas'}`;
  $('card-track-info').textContent = laps;
  drawTrackPreview($('track-thumb'), settings.track, (shape) => {
    if (shape?.length) $('card-track-info').textContent = `${km(shape.length)} · ${laps}`;
  });
  $('tile-tune').textContent = tuneSummary();
  const rivals = `${settings.rivals} ${settings.rivals === 1 ? 'rival' : 'rivales'}`;
  $('tile-options').textContent = (settings.mode === 'trial' ? [] : [rivals, DIFFICULTY().name.toLowerCase()])
    .concat([`daños ${DAMAGE().name.toLowerCase()}`, `caja ${GEARBOXES.find((b) => b.value === settings.gearbox).label.toLowerCase()}`, `control de tracción ${TRACTION().label.toLowerCase()}`, settings.abs ? 'ABS' : 'sin ABS']).join(' · ');
}

// ---- el auto ----
let carView = { yaw: 0.75, pitch: 0.28 }; // desde dónde se mira el auto grande (se gira arrastrándolo)
const carPreviewModel = (team) => modelFor(teamCar(team, settings.driver));
function drawCarPreview(canvas, team, view) {
  drawCar(canvas, carPreviewModel(team), view);
}

function renderCars() {
  const team = teamById(settings.team);
  choices($('menu-teams'), TEAMS.map((t) => ({
    value: t.id,
    html: `<span class="car" style="--c:${t.color};--a:${t.accent};--h:${t.helmet}"><i></i></span>${t.name}`,
  })), 'team');
  $('car-name').innerHTML = `<i class="swatch" style="background:${team.color}"></i>${team.name}`;
  choices($('menu-drivers'), team.drivers.map(([name, , n], slot) => ({ value: slot, label: `#${n} ${name}` })), 'driver');
}

// El auto grande gira solo, despacio, como en una vitrina; arrastrándolo se lo gira a mano (y un poco para arriba o
// abajo), y al soltarlo sigue girando solo después de un rato
const TURNTABLE = 0.35; // rad/s
const TURNTABLE_WAIT = 2.5; // s quieto después de soltarlo
let carDrag = null, carIdleSince = 0;
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
    if (!carDrag && now - carIdleSince > TURNTABLE_WAIT * 1000) carView = { ...carView, yaw: carView.yaw + TURNTABLE * dt };
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
  trackShape(def).then((shape) => {
    if (canvas.dataset.track !== id) return; // ya se eligió otro
    drawShape(canvas, shape.points, opts);
    then?.(shape);
  }).catch((err) => console.warn('No se pudo dibujar el trazado:', err));
}

function trackList() {
  return TRACKS.map((t) => ({ value: t.id, label: t.name }));
}

function renderTracks() {
  const list = trackList();
  choices($('menu-tracks'), list.map((t) => {
    const c = document.createElement('canvas');
    return { ...t, el: c };
  }), 'track', () => {});
  // los dibujitos se hacen después de que los botones están en la página (necesitan su tamaño)
  for (const [i, b] of [...$('menu-tracks').children].entries()) {
    drawTrackPreview(b.querySelector('canvas'), list[i].value, null, { color: b.classList.contains('on') ? '#ffd400' : '#c8ced8', line: 1.3 });
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
    $('track-stats').innerHTML = stats(length).map(([k, v]) => `<div><small>${k}</small><b>${v}</b></div>`).join('');
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
const CIRCUIT_KINDS = [[2, 'muy rápido'], [4.5, 'rápido'], [6.5, 'mixto'], [Infinity, 'lento']];

// cambiar de auto o de circuito con las flechas (o los botones ‹ ›)
function stepChoice(step) {
  if (screen === 'car') {
    const i = TEAMS.findIndex((t) => t.id === settings.team);
    settings.team = TEAMS[(i + step + TEAMS.length) % TEAMS.length].id;
  } else if (screen === 'track') {
    const list = trackList(), i = list.findIndex((t) => t.value === settings.track);
    settings.track = list[(i + step + list.length) % list.length].value;
  } else return;
  saveSettings();
  renderMenu();
}
for (const b of menu.querySelectorAll('[data-step]')) b.addEventListener('click', () => stepChoice(+b.dataset.step));

// ---- opciones ----
const GEARBOXES = [
  { value: 'auto', label: 'Automática', hint: 'Los cambios se pasan solos' },
  { value: 'manual', label: 'Manual', hint: 'Subís con O o X y bajás con U o Z (en el joystick, RB sube y LB baja)' },
];
const TRACTIONS = [
  { value: 'high', label: 'Alto', hint: 'Corta motor antes de que la cola se suelte: para manejar con teclado' },
  { value: 'low', label: 'Bajo', hint: 'Deja usar casi todo el agarre de la cola: más rápido, pero hay que dosificar un poco' },
  { value: 'off', label: 'Apagado', hint: 'Como los F1 de verdad: acelerando a fondo en una curva lenta, la cola se va' },
];
const ABS_OPTIONS = [
  { value: true, label: 'Sí', hint: 'Los frenos sueltan antes de que las ruedas se bloqueen: para manejar con teclado, que frena todo o nada' },
  { value: false, label: 'No', hint: 'Como los F1 de verdad: el pedal a fondo sólo sirve a alta velocidad; a medida que el auto frena hay que ir soltándolo o las ruedas se bloquean' },
];
const TRACTION = () => TRACTIONS.find((t) => t.value === settings.traction) || TRACTIONS[0];
function renderOptions() {
  choices($('menu-diff'), DIFFICULTIES.map((d) => ({ value: d.id, label: d.name })), 'difficulty');
  choices($('menu-rivals'), RIVAL_OPTIONS.map((n) => ({ value: n, label: String(n) })), 'rivals');
  choices($('menu-laps'), LAP_OPTIONS.map((n) => ({ value: n, label: String(n) })), 'laps');
  choices($('menu-damage'), DAMAGE_LEVELS.map((l) => ({ value: l.id, label: l.name })), 'damage');
  $('menu-damage-hint').textContent = DAMAGE().hint;
  choices($('menu-gearbox'), GEARBOXES, 'gearbox');
  $('menu-gearbox-hint').textContent = GEARBOXES.find((b) => b.value === settings.gearbox).hint;
  choices($('menu-traction'), TRACTIONS, 'traction');
  $('menu-traction-hint').textContent = TRACTION().hint;
  choices($('menu-abs'), ABS_OPTIONS, 'abs');
  $('menu-abs-hint').textContent = ABS_OPTIONS.find((a) => a.value === !!settings.abs).hint;
  choices($('menu-sound'), [{ value: true, label: 'Sí' }, { value: false, label: 'No' }], 'sound', applySound);
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
const TUNE_SLIDERS = [['tune-front', 'front'], ['tune-rear', 'rear'], ['tune-balance', 'balance'], ['tune-brake', 'brake']];
const SIGNED_TUNE = ['balance', 'brake'];
const trackDef = () => TRACKS.find((t) => t.id === settings.track);
const trackTune = () => trackDef()?.tune ?? DEFAULT_TUNE;
const myTune = () => settings.tunes[settings.track] ?? trackTune();
// según cuánto más agarra la cola que la trompa (rearMargin de car.js; parejo da 0,15): con mucho margen la trompa no
// dobla; con poco, frenando en curva o al soltar el freno la cola se va; sin margen, se va siempre
const BALANCE_WORDS = [[0, 'sobrevira'], [0.08, 'nervioso'], [0.12, 'ágil'], [0.2, 'estable'], [Infinity, 'subvira']];
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
  const t = myTune(), own = settings.tunes[settings.track];
  $('tune-title').textContent = `Puesta a punto · ${trackDef()?.name ?? ''}`;
  for (const [id, key] of TUNE_SLIDERS) {
    const value = t[key] ?? 0; // (las puestas guardadas antes de que hubiera reparto de frenada no lo traen)
    $(id).value = value;
    $(id + '-v').textContent = SIGNED_TUNE.includes(key) ? signed(value) : value;
  }
  $('tune-reset').hidden = !own; // sólo hay algo para borrar si es la tuya
  const now = tuneLimits(t), base = tuneLimits(trackTune());
  // al lado de cada número, cuánto cambió respecto de la recomendada
  const diff = (a, b, unit, digits) => (own && Math.abs(a - b) >= 10 ** -digits / 2
    ? ` <em class="${a > b ? 'up' : 'down'}">${a > b ? '+' : '−'}${Math.abs(a - b).toFixed(digits).replace('.', ',')}${unit}</em>` : '');
  $('tune-stats').innerHTML = [
    ['Velocidad punta', `${Math.round(now.top)} km/h${diff(now.top, base.top, '', 0)}`],
    ['Agarre a 250 km/h', `${now.grip.toFixed(1).replace('.', ',')} g${diff(now.grip, base.grip, '', 1)}`],
    ['Curva lenta', now.slow],
    ['Curva rápida', now.fast],
  ].map(([k, v]) => `<div><small>${k}</small><b>${v}</b></div>`).join('');
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
const VOLUME_SLIDERS = [['vol-master', 'volMaster'], ['vol-engines', 'volEngines'], ['vol-music', 'volMusic']];
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
  carProfile = await fetch(CAR_PROFILE).then((r) => r.json()).catch(() => DEFAULT_PROFILE);
  if (NEURAL_URL) neuralPolicy = await Policy.load(NEURAL_URL).catch((err) => (console.warn('No se pudo cargar la red:', err), null));
  if (!TRACKS.some((t) => t.id === settings.track)) settings.track = TRACKS[0].id;
  audio.setVolumes({ master: settings.volMaster, engines: settings.volEngines, music: settings.volMusic });
  openMenu();
  await loadTrack(settings.track);
})().catch((err) => {
  console.error(err);
  hud.msg.textContent = 'No se pudo cargar el circuito. ¿Abriste el juego con un servidor local?';
  hud.msg.classList.add('show');
});
