import { TRACKS } from '../tracks/index.js';
import { buildTrackFromLayout, sampleField, stationAt, RIDGE } from './sim/track.js';
import { loadImage, buildTrack } from './load/trackimage.js';
import { Renderer, rgb } from './render/renderer.js';
import { GLRenderer } from './render/glrenderer.js';
import {
  Car,
  DEFAULT_PROFILE,
  FUEL_PER_KM,
  isSolid,
  limitsOn,
  RIVAL_AIDS,
  TRACTION_CONTROL,
  wheelAngle,
} from './sim/car.js';
import { racingLine } from './sim/racingline.js';
import { boardTexture, treeTexture } from './render/sprites.js';
import { carModel, STEERING, TCAM, WHEEL_R } from './render/carmodel.js';
import { Driver } from './drivers/ai.js';
import { gridSlots } from './race/grid.js';
import { Cockpit } from './render/cockpit.js';
import { CAMERA_MODES, CAMERA_NAMES, Recorder, replayCamera, tvCameras } from './ui/replay.js';
import { DIFFICULTIES, car as teamCar, gridOrder, rivalCars, rivalPaces, rivalSetups, teamById } from './race/teams.js';
import { EngineAudio } from './audio/audio.js';
import { GAME_NET, NeuralDriver, Policy } from './drivers/policy.js';
import { HumanDriver } from './drivers/human.js';
import { Gamepad } from './input/gamepad.js';
import { Keyboard } from './input/keyboard.js';
import { Hud, SHIFT_LIGHTS } from './ui/hud.js';
import { settings } from './ui/settings.js';
import { hideMenu, menuOpen, menuScreen, renderMenu, setupMenu, showMenu, showScreen, stepChoice } from './ui/menu.js';
import { buzz, headTilt, lookYaw, paddles, suspension, turnHead } from './ui/pilot.js';
import { Race } from './race/race.js';
import { RubberMap } from './sim/rubber.js';
import { DESIGNS } from './render/teamliveries.js';
import { NO_DAMAGE } from './sim/damage.js';

const VIEW_W = 960;
const VIEW_H = 540;
const UI_SCALE = VIEW_W / 480; // the 2D drawings (start lights, steering wheel) are designed for 480 pixels wide
const GHOST_STEP = 1 / 30;
const EYE_HEIGHT = 2.4; // exterior view: meters above the ground
const CAM_BEHIND = 8; // exterior view: meters behind the car's center
const COCKPIT_EYE = 0.74; // cockpit view: height of the driver's eyes (m)
const COCKPIT_BACK = 0.1; // cockpit view: the eyes, behind the car's center (m)
const WHEEL_TURN_RATE = 6;
const CAR_PROFILE = 'cars/f1-2025.json'; // tuned with tools/calibrate.js
const REPLAY_DELAY = 6; // seconds of results before the replay starts
// ?test: keys 1 to 9 break parts of your car and 0 repairs it, to test how it drives with damage
const DAMAGE_TEST = new URLSearchParams(location.search).has('test');
const audio = new EngineAudio();

// applies the sound settings: on or off, volumes, and music if the menu is open
function applySound() {
  audio.setVolumes({ master: settings.volMaster, engines: settings.volEngines, music: settings.volMusic });
  if (!settings.sound) {
    audio.stopAll();
    return;
  }
  audio.start();
  audio.playMusic(menuOpen());
}
// the browser only lets audio start after a key press or a click
addEventListener('pointerdown', () => settings.sound && audio.start());

// the image is drawn on the GPU (WebGL) if possible; if not (or with ?cpu in the address), on the
// CPU as before
const canvas = document.getElementById('view');
let renderer = new URLSearchParams(location.search).has('cpu') ? null : GLRenderer.create(canvas, VIEW_W, VIEW_H);
if (!renderer) {
  canvas.width = VIEW_W;
  canvas.height = VIEW_H;
  renderer = new Renderer(canvas);
}
// on top, on a separate canvas, what is drawn in 2D: the steering wheel and the start lights
const overlay = document.getElementById('overlay');
overlay.width = VIEW_W;
overlay.height = VIEW_H;
const ctx = overlay.getContext('2d');

const $ = (id) => document.getElementById(id);
const hud = new Hud($, { ctx, scale: UI_SCALE, ghostStep: GHOST_STEP });

const ghostModel = carModel('#3aa0ff', '#ffffff');
// each team's 3D model is built the first time it is needed (the livery takes a while)
const teamModels = new Map();
// each car's model: { team, slot, number } (the two cars of a team change the number and the color of the T)
// sharp: the livery at double resolution, for the player's own car (from the cockpit it is seen very close)
const modelFor = ({ team: t, slot, number }, sharp = 1) => {
  const key = `${t.id}/${slot}/${sharp}`;
  if (!teamModels.has(key))
    teamModels.set(key, carModel(t.color, t.helmet, number, t.accent, TCAM[slot], { sharp, design: DESIGNS[t.id] }));
  return teamModels.get(key);
};
let wheelSpin = 0; // how much the wheels have turned (rad), to animate them
let lastDraw = 0;
const treeTex = treeTexture();
const boardTex = new Map([200, 150, 100, 50].map((d) => [d, boardTexture(d)]));
const cockpit = new Cockpit();
let cockpitView = true; // C toggles cockpit / exterior; each race starts with the view chosen in the menu
let showGuide = true; // G shows or hides the racing line
const guides = new WeakMap(); // racing line of each track, computed once
const AI_BRAKE_USE = 0.93; // rivals brake closer to the limit than the racing line you see (which uses 85%)
const aiLines = new WeakMap(); // rivals' racing line for each track
const tvCams = new WeakMap(); // TV cameras of each track, for the replay

// ---------- input ----------
const SHIFT_UP = ['KeyX', 'KeyE', 'KeyO'];
const SHIFT_DOWN = ['KeyZ', 'KeyQ', 'KeyU'];

const keyboard = new Keyboard(window, (e, names) => {
  if ((e.code.startsWith('Arrow') || e.code === 'Space') && !menuOpen()) e.preventDefault();
  // in the menu Enter is handled by press (otherwise it would also press the focused button)
  if (e.code === 'Enter' && menuOpen()) e.preventDefault();
  if (settings.sound) audio.start(); // the browser only lets audio start after a key press or a click
  if (e.code === 'KeyN' && !e.repeat) {
    toggleSound();
    hud.flash(settings.sound ? 'Sonido' : 'Silencio');
  }
  press(names, e.repeat);
});

// a key (or a gamepad button, translated to the key that does the same): names are its names
function press(names, repeat = false) {
  const is = (...codes) => codes.some((c) => names.includes(c));
  if (menuOpen()) {
    // Enter: on the main screen it starts (or opens the focused card); on the others, it goes back
    const go = document.activeElement?.closest?.('[data-screen="main"] [data-go]');
    if (menuScreen() === 'main') {
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
  // gear changes, with the manual gearbox (chosen in the menu, not during the race): X/E/O up, Z/Q/U down
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

// Test keys (?test): each one breaks a part a bit more; 0 repairs everything
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
  // arrows, WASD or IJKL, plus the gamepad: whichever of the two is pressed harder
  const k = keyboard.read(dt, speed);
  return {
    throttle: Math.max(k.throttle, pad.throttle),
    brake: Math.max(k.brake, pad.brake),
    steer: Math.max(-1, Math.min(1, k.steer + pad.steer)),
  };
}

// the gamepad: Start opens the menu or, in the menu, starts the race
const pad = new Gamepad({
  onButton: (names) => press(names[0] === 'Start' ? [menuOpen() ? 'Enter' : 'Escape'] : names),
  onChange: (id) => {
    $('pad-status').textContent = id ? `Joystick: ${id}` : 'Joystick: ninguno (conectalo y apretá cualquier botón)';
    if (id && game) hud.flash('Joystick conectado');
  },
});

// ---------- game state ----------
let game = null;
let lastGame = null; // the last race, to keep the best time and the ghost when coming back from the menu
let carProfile = DEFAULT_PROFILE;
// Rivals drive with the game network (GAME_NET in policy.js); with ?ai=models/other.json, with another one, and with
// ?ai=classic, with the classic AI (ai.js), which is also what remains if the network doesn't load
const AI_PARAM = new URLSearchParams(location.search).get('ai') || GAME_NET;
const NEURAL_URL = AI_PARAM === 'classic' ? null : AI_PARAM;
let neuralPolicy = null;

function resetGame(track) {
  cockpitView = settings.view !== 'chase';
  const prev = game || lastGame;
  const prevBest = prev && prev.track === track ? prev.player.lap.best : null;
  const prevGhost = prev && prev.track === track ? prev.ghost : null;
  const team = teamById(settings.team);
  const difficulty = DIFFICULTIES.find((d) => d.id === settings.difficulty) || DIFFICULTIES[2];
  const trial = settings.mode === 'trial';
  // in time trial there are no rivals
  const others = trial ? [] : rivalCars(team, settings.rivals, settings.driver);
  const paces = rivalPaces(difficulty, others.length),
    setups = rivalSetups(difficulty, others.length);
  // grid: the rivals in front (the best cars tend to start first) and you at the back
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
      // with the network, the difficulty is the car: more or less grip and power
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
    .sort((a, b) => a.gridBack - b.gridBack); // in grid order, as the standings tower shows them before the start
  const wearRate = RACE_WEAR / (wearLaps({ trial, laps: settings.laps }) * track.length * track.meters);
  // fuel: in the race, just enough for the laps to run (it burns off and the car gets lighter); in time trial,
  // as in qualifying: a few kilos that are not burned
  const fuel = trial
    ? { fuel: TRIAL_FUEL, fuelFlow: 0 }
    : { fuel: (FUEL_PER_KM * settings.laps * (track.length * track.meters)) / 1000 };
  for (const e of [...rivals, player]) Object.assign(e.car, { wearRate, damageLevel: settings.damage, ...fuel });
  game = {
    track,
    car,
    player,
    trial,
    laps: trial ? Infinity : settings.laps, // in time trial laps go on until you return to the menu
    entries: [...rivals, player],
    recorder: new Recorder(others.length + 1), // the race, for the replay
    replayIn: null, // how long until the replay starts (when you finish)
    replay: null, // { t, mode, target, tv } while the replay is being watched
    resultsShown: false,
    rec: [],
    recClock: 0,
    ghost: prevGhost,
    progressLog: [],
    wrongWay: false,
  };
  hud.towerClock = 0;
  if (!guides.has(track)) guides.set(track, racingLine(track, limitsOn(carProfile, track)));
  // the rubber starts with the faint strip of another series on the racing line and the race keeps laying it down
  game.rubber = new RubberMap(track, guides.get(track).offset);
  for (const e of game.entries) e.car.rubber = game.rubber; // and grip depends on how much there is (car.js)
  if (!aiLines.has(track))
    aiLines.set(track, racingLine(track, limitsOn(carProfile, track), { brakeUse: AI_BRAKE_USE }));
  // the race (race/race.js): grid, start lights, starts, laps, retirements and order. You stay on track even if you
  // retire (where you stopped)
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

// Racing line color by the car's speed: green = you can accelerate, yellow = hold or
// lift, red = you need to brake. From the car forward the speed is projected: accelerating
// flat out while possible; where the racing line asks to go slower than that, it is a braking zone
// (and the car is assumed to have braked down to that speed).
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
    // from -2 m/s (to spare) to +3 m/s (still need to brake): green → yellow → red
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
  const racing = r.started; // with the start lights on only the revs go up
  for (const ev of r.step(dt)) raceEvent(g, ev);
  if (racing) {
    const cars = g.entries.filter((e) => e === me || !e.car.gone).map((e) => e.car);
    for (const e of g.entries) {
      if (e !== me) e.spin = (e.spin + (e.car.speed * dt) / WHEEL_R) % (Math.PI * 2);
      e.head = turnHead(e.head, lookYaw(e.car, cars, g.track, guides.get(g.track)), dt);
      const c = e.car;
      e.body = suspension(e.body, c.speed * c.omega, (c.speed - (e.prevSpeed ?? c.speed)) / dt, dt);
      e.prevSpeed = c.speed;
      e.paddles = paddles(e.paddles, c.gear, dt);
    }
    g.recorder.add(dt, g.entries);
  }

  if (me.lap.started) {
    // your lap, for the time trial ghost
    g.recClock += dt;
    while (g.recClock >= GHOST_STEP) {
      g.recClock -= GHOST_STEP;
      g.rec.push(g.car.x, g.car.y);
    }
    // wrong way: progress keeps going down
    const p = g.track.progress[Math.floor(g.car.y) * g.track.W + Math.floor(g.car.x)];
    g.progressLog.push(p);
    if (g.progressLog.length > 45) g.progressLog.shift();
    const first = g.progressLog[0],
      lastP = g.progressLog[g.progressLog.length - 1];
    g.wrongWay = first >= 0 && lastP >= 0 && first - lastP > 6 && first - lastP < 200 && g.car.speed > 3;
  }
}

// What happened in the race, on screen: your laps, the retirements and the finish
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
    if (best && g.trial) g.ghost = Float32Array.from(g.rec); // the ghost is the best time trial lap
    hud.flash(best ? `¡Mejor vuelta! ${hud.fmt(time)}` : `Vuelta ${hud.fmt(time)}`);
  }
  // each line crossing starts recording the lap again
  g.rec = [];
  g.recClock = 0;
}

// ---------- race ----------
// ---------- drawing ----------
// ghost position at sample u (with decimals), interpolating between the two nearest recorded ones
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

// the track's trees and signs, as sprites (sizes in meters, converted to cells)
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
  // braking boards: 3.2 m wide by 2.7 m high (board on legs), big enough to read in time
  for (const b of track.boards)
    sprites.push({ x: b.x, y: b.y, z: b.z, width: 3.2 / M, height: 2.7 / M, tex: boardTex.get(b.meters) });
  return sprites;
}

// engines of all cars, heard from the camera (vx, vy: how fast it moves, in m/s)
function playEngines(cars, cam, M, vx, vy, inside) {
  if (!settings.sound) return;
  audio.update(cars, { x: cam.x * M, y: cam.y * M, angle: cam.angle, vx, vy }, inside);
}

// ---------- replay ----------
function startReplay(g) {
  g.replay = { t: 0, mode: 'auto', target: g.entries.indexOf(g.player), tv: {} };
  hud.stage.classList.add('replay');
}

// C changes the camera; ←/→ (or J/L, A/D) change the car being followed
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
  // each driver's head, as in the race (the replay doesn't record it)
  r.heads ??= poses.map(() => 0);
  r.heads = poses.map((p, k) => turnHead(r.heads[k], lookYaw(p, poses, track, guides.get(track)), 1 / 60));
  // the suspension, with the accelerations obtained by comparing with a moment later
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
  renderer.rubber = g.rubber; // as it was at the finish
  // sound: heard from the camera; the TV one stands still, the others move with the car
  const moving = cam.mode !== 'tv';
  playEngines(
    poses.map((p) => ({ ...p, x: p.x * M, y: p.y * M })),
    cam,
    M,
    moving ? Math.cos(pose.angle) * pose.speed : 0,
    moving ? Math.sin(pose.angle) * pose.speed : 0,
    cam.mode === 'onboard' ? r.target : -1,
  );
  audio.surface({}); // in the replay the kerbs make no sound
  await renderer.render(track, cam, trackSprites(track), models);
  ctx.clearRect(0, 0, VIEW_W, VIEW_H);

  // caption: car being followed, its position at that moment, camera and race time
  // the position at that moment: what each one covered, minus how far back it started on the grid
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

// ---------- tyre wear ----------
// They start new: smooth and shiny. The shine goes away in the first part of the first lap. Wear is
// physical (car.js: they wear more the harder they are pushed, and grip less) and is calibrated so that, driving
// normally, they are fully worn at the end of the race; the marks on the tread show it.
const SHINE_LAPS = 0.6; // laps the shine lasts
const TRIAL_FUEL = 5; // kg
// driving normally, the tyres reach the end of the race with this wear: just before where they suddenly drop off
// (WEAR_CLIFF_FROM in car.js). Whoever abuses them (sliding, locking, overheating them) runs out of tyres earlier
const RACE_WEAR = 0.8;
const TRIAL_WEAR_LAPS = 3; // in time trial, laps until fully worn

const wearLaps = (g) => (g.trial ? TRIAL_WEAR_LAPS : g.laps);

// wear: the car's wear (not saved in the replay: estimated from the distance covered)
function tyres(g, dist, wear = null) {
  const laps = dist / (g.track.length * g.track.meters);
  return { wear: wear ?? Math.min(1, laps / wearLaps(g)), shine: Math.max(0, 1 - laps / SHINE_LAPS) };
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
    // the lap was recorded 30 times per second and is drawn more often: we interpolate between samples
    // so it moves smoothly, and the heading comes from points a bit before and a bit after, so it doesn't jitter
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

  // rivals
  for (const e of g.entries) {
    if (e === g.player || e.car.gone) continue;
    const c = e.car;
    models.push({
      // on top of the kerb or the sausage kerb, the car rises and leans with the wheels that lift
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

  // camera in the cockpit or a bit behind the car, at terrain height,
  // with shaking on the grass, on the gravel, on the kerbs and in crashes
  const shake =
    (car.rough ?? car.grass) * Math.min(1, Math.abs(car.speed) / 25) * 3 +
    (car.onKerb ? Math.min(1, Math.abs(car.speed) / 35) * 1.2 : 0) +
    car.bump * 4 +
    car.jolt * 5;
  // against a wall, the outside camera moves closer until it is no longer inside it
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
  // we tilt the view with the slope (uphill it looks higher); from the cockpit,
  // the horizon goes higher so the track is seen above the car
  const shakeY = Math.sin(time * 0.045) * shake * UI_SCALE;
  cam.pitch =
    (cockpitView ? -28 : -40) * UI_SCALE +
    car.slope * renderer.P * 0.6 +
    shakeY -
    (cockpitView ? (g.player.body?.dive ?? 0) * renderer.P : 0); // under braking, the view drops with the nose
  const line = guides.get(track);
  const guide = showGuide ? line : null;
  if (guide) paintGuide(guide, track, car);
  renderer.guide = guide;
  renderer.rubber = g.rubber;
  // our car in 3D
  const dt = Math.min(0.1, Math.max(0, (time - lastDraw) / 1000));
  lastDraw = time;
  wheelSpin = (wheelSpin + (car.speed * dt) / WHEEL_R) % (Math.PI * 2);
  // the steering wheel follows the steering with a bit of delay, like the hands (with the keyboard the steering jumps)
  g.player.wheelTurn =
    (g.player.wheelTurn ?? 0) +
    (car.steer * STEERING.turn - (g.player.wheelTurn ?? 0)) * Math.min(1, dt * WHEEL_TURN_RATE);
  // from the cockpit the same car is seen, without the helmet (the camera is there) and without roll; the slope,
  // to the same extent the camera follows it, so the body stays still on the screen
  models.push({
    model: g.player.model,
    x: car.x,
    y: car.y,
    z: heightAt(car.x, car.y) + car.lift,
    angle: car.angle,
    meters: M,
    pitch: Math.atan(car.slope) * (cockpitView ? 0.6 : 1),
    // the body rolls and pitches on the suspension; not from the cockpit, because the camera is attached to it
    // (there the pitch moves the view: see cam.pitch)
    roll: cockpitView ? 0 : (g.player.body?.roll ?? 0) + car.liftRoll,
    dive: cockpitView ? 0 : (g.player.body?.dive ?? 0) + car.liftDive,
    steer: wheelAngle(car.steer, car.speed, car.limits),
    spin: wheelSpin,
    head: g.player.head,
    ...tyres(g, g.player.dist, car.wear),
    shadow: true,
    hide: cockpitView ? 'helmet' : null,
    // the steering wheel turns with the steering and shows the gear; from the cockpit the paint, seen so close,
    // shines less
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
  // the player's wheels on the kerb, the green or the sausage kerb
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
  // the help hides while you drive (it covers the cockpit) and comes back when you stop
  hud.help.classList.toggle('hidden', Math.abs(car.speed) > 3);
  hud.gear.textContent = car.gear === 0 ? 'R' : car.gear;
  hud.rpm.textContent = Math.round(car.rpm / 100) * 100;
  hud.mode.textContent = (car.manual ? 'MAN' : 'AUTO') + (car.absCut ? ' · ABS' : '') + (car.tcCut ? ' · TC' : '');
  // shift lights: they light up from 9,000 rpm up to the rev limiter (green, red, blue)
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

// ---------- loop ----------
// Frame cap: on fast screens (120 Hz or more) one refresh out of two is skipped, so no more is drawn than
// needed. The margin lets through every frame of a 60 or 75 Hz screen (cutting 75 to 60 would stutter).
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
    // at the finish, a few seconds of results and then the replay (the race is paused)
    if (game.replayIn !== null && !game.replay) {
      game.replayIn -= dt;
      if (game.replayIn <= 0) startReplay(game);
    }
    if (game.replay) game.replay.t = (game.replay.t + dt) % Math.max(1, game.recorder.duration);
    else update(dt);
    // the sky and the terrain are drawn in other threads: if the previous frame isn't done yet, this one is skipped
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

// ---------- track loading ----------
const builtTracks = new Map(); // tracks already built, by id

async function loadTrack(id) {
  if (builtTracks.has(id)) return builtTracks.get(id);
  const def = TRACKS.find((t) => t.id === id) || TRACKS[0];
  if (def.layout) {
    // the layout taken from telemetry (tools/layout.py)
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

// ---------- menu ----------
function openMenu() {
  audio.silence();
  audio.playMusic(settings.sound);
  if (game) lastGame = game;
  game = null;
  hud.stage.classList.remove('replay');
  hud.results.classList.remove('show');
  showMenu();
}

let starting = false;
async function startRace() {
  if (starting) return;
  starting = true;
  const button = $('menu-start');
  button.textContent = 'Cargando…';
  try {
    const track = await loadTrack(settings.track);
    hideMenu();
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

function toggleSound() {
  settings.sound = !settings.sound;
  applySound();
  if (menuOpen()) renderMenu();
}

setupMenu({
  startRace,
  toggleSound,
  applySound,
  audio,
  carProfile: () => carProfile,
  modelFor,
});

// on open: the car profile and the track chosen last time, and the menu
(async () => {
  carProfile = await fetch(CAR_PROFILE)
    .then((r) => r.json())
    .catch(() => DEFAULT_PROFILE);
  if (NEURAL_URL)
    neuralPolicy = await Policy.load(NEURAL_URL).catch(
      (err) => (console.warn('Could not load the network:', err), null),
    );
  if (!TRACKS.some((t) => t.id === settings.track)) settings.track = TRACKS[0].id;
  audio.setVolumes({ master: settings.volMaster, engines: settings.volEngines, music: settings.volMusic });
  openMenu();
  await loadTrack(settings.track);
})().catch((err) => {
  console.error(err);
  hud.msg.textContent = 'No se pudo cargar el circuito. ¿Abriste el juego con un servidor local?';
  hud.msg.classList.add('show');
});
