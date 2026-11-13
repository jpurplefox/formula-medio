// The menu: a main screen with the chosen car and track (on cards with their drawing) and the mode, and a
// separate screen for each thing: choosing the car, choosing the track, the setup and the options (difficulty,
// laps, damage and sound). The choices are kept in settings (ui/settings.js). What belongs to the game (starting, the
// sound, the car models) is passed in by main.js with setupMenu.
import { TRACKS } from '../../tracks/index.js';
import { cornerGrip, rearMargin } from '../sim/car.js';
import { DAMAGE_LEVELS } from '../sim/damage.js';
import { airDensity, carLimits, DEFAULT_TUNE, GRAVITY } from '../sim/dynamics.js';
import { DIFFICULTIES, LAP_OPTIONS, RIVAL_OPTIONS, TEAMS, car as teamCar, teamById } from '../race/teams.js';
import { drawCar, drawShape, trackShape } from './menuview.js';
import { saveSettings, settings } from './settings.js';

const $ = (id) => document.getElementById(id);
const MODES = [
  { value: 'race', label: 'Carrera' },
  { value: 'trial', label: 'Contrarreloj' },
];

// app: { startRace(), toggleSound(), applySound(), audio, carProfile(), modelFor(car) }
let app = null;
export function setupMenu(deps) {
  app = deps;
}

// A main screen with the chosen car and track (on cards with their drawing) and the mode, and a separate screen
// for each thing: choosing the car, choosing the track, the setup and the options (difficulty, laps,
// damage and sound)
const menu = $('menu');
export const menuOpen = () => menu.classList.contains('open');

export function showMenu() {
  menu.classList.add('open');
  showScreen('main');
}

export function hideMenu() {
  menu.classList.remove('open');
}
export const menuScreen = () => screen;
let screen = 'main';

export function showScreen(name) {
  screen = name;
  for (const el of menu.querySelectorAll('.screen')) el.classList.toggle('on', el.dataset.screen === name);
  menu.scrollTop = 0;
  renderMenu();
  // focus: on the main screen, on Largar; on the others, on the chosen item
  const focus = name === 'main' ? $('menu-start') : menu.querySelector(`[data-screen="${name}"] button.on`);
  (focus ?? menu.querySelector(`[data-screen="${name}"] button`))?.focus({ preventScroll: true });
}
for (const b of menu.querySelectorAll('[data-go]')) b.addEventListener('click', () => showScreen(b.dataset.go));

// a row of buttons: choosing one marks it, saves it in settings[key] and redraws the menu
// (o.html: the button content; o.el: appends that element at the end)
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

export function renderMenu() {
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

// ---- the car ----
let carView = { yaw: 0.75, pitch: 0.28 }; // where the big car is viewed from (it is rotated by dragging it)
const carPreviewModel = (team) => app.modelFor(teamCar(team, settings.driver));
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

// The big car turns by itself, slowly, as in a showcase; dragging it rotates it by hand (and a bit up or
// down), and after releasing it, it turns by itself again after a while
const TURNTABLE = 0.35; // rad/s
const TURNTABLE_WAIT = 2.5; // s still after releasing it
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

// what moves in the menu: the rotating car and the dot going around the track (one lap in LAP_PREVIEW s)
const LAP_PREVIEW = 9;
let menuTime = 0;
let shownShape = null; // the layout of the big track, for the dot that goes around it
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

// ---- the track ----
// a track's layout (id) on the canvas; then(shape) when ready, with shape.length (m) if known
function drawTrackPreview(canvas, id, then, opts) {
  const def = TRACKS.find((t) => t.id === id);
  canvas.dataset.track = id;
  trackShape(def)
    .then((shape) => {
      if (canvas.dataset.track !== id) return; // another one was already chosen
      drawShape(canvas, shape.points, opts);
      then?.(shape);
    })
    .catch((err) => console.warn('Could not draw the layout:', err));
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
  // the little drawings are made after the buttons are on the page (they need their size)
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
// what kind of track it is, by how much wing the teams run there (1 to 10): little where a lot of time is spent at
// full throttle, a lot where there are slow corners
const CIRCUIT_KINDS = [
  [2, 'muy rápido'],
  [4.5, 'rápido'],
  [6.5, 'mixto'],
  [Infinity, 'lento'],
];

// switch car or track with the arrows (or the ‹ › buttons)
export function stepChoice(step) {
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
  { value: 'auto', label: 'Automática' }, // Gears change by themselves
  { value: 'manual', label: 'Manual' }, // Shift up with O or X and down with U or Z (on the gamepad, RB up and LB down)
];
const TRACTIONS = [
  { value: 'high', label: 'Alto' }, // Cuts power before the rear lets go: for driving with the keyboard
  { value: 'low', label: 'Bajo' }, // Allows almost all the rear grip: faster, but needs some throttle control
  { value: 'off', label: 'Apagado' }, // Like real F1 cars: full throttle in a slow corner, the rear steps out
];
const ABS_OPTIONS = [
  // Sí: the brakes release before the wheels lock: for driving with the keyboard, which brakes all or nothing
  // No: like real F1 cars: full pedal only works at high speed; as the car slows you have to ease off or the wheels
  // lock
  { value: true, label: 'Sí' },
  { value: false, label: 'No' },
];
const TRACTION = () => TRACTIONS.find((t) => t.value === settings.traction) || TRACTIONS[0];
const VIEWS = [
  { value: 'cockpit', label: 'Cabina' }, // From the driver's eyes, with the steering wheel and the nose ahead
  { value: 'chase', label: 'Exterior' }, // From behind and above the car: you see better where the track is
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
    () => app.applySound(),
  );
  for (const [id, key] of VOLUME_SLIDERS) $(id).value = Math.round(settings[key] * 100);
}
$('sound-toggle').addEventListener('click', () => app.toggleSound());
// Setup: yours on this track or, if you didn't change it, the recommended one (what the teams run there,
// tracks/index.js; the rivals always use that one). Below, how the car ends up: top speed, fast-corner grip and
// balance.
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
// by how much more grip the rear has than the front (rearMargin in car.js; neutral gives 0.15): with a lot of margin
// the front doesn't turn; with little, braking into a corner or releasing the brake the rear steps out; with no
// margin, it always steps out
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
  const lim = carLimits(app.carProfile(), t, airDensity(trackDef()?.altitude ?? 0));
  const balance = (v) => BALANCE_WORDS.find(([max]) => rearMargin(lim, v) < max)[1];
  return { top: lim.topSpeed * 3.6, grip: cornerGrip(lim, 70) / GRAVITY, slow: balance(25), fast: balance(70) };
}
function renderTune() {
  const t = myTune(),
    own = settings.tunes[settings.track];
  $('tune-title').textContent = `Puesta a punto · ${trackDef()?.name ?? ''}`;
  for (const [id, key] of TUNE_SLIDERS) {
    const value = t[key] ?? 0; // (setups saved before brake bias existed don't have it)
    $(id).value = value;
    $(id + '-v').textContent = SIGNED_TUNE.includes(key) ? signed(value) : value;
  }
  $('tune-reset').hidden = !own; // there is only something to clear if it is yours
  const now = tuneLimits(t),
    base = tuneLimits(trackTune());
  // next to each number, how much it changed from the recommended one
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

// the drawings depend on the window size
addEventListener('resize', () => menuOpen() && renderMenu());

// volumes: master, engines and music (0 to 100 in the menu)
const VOLUME_SLIDERS = [
  ['vol-master', 'volMaster'],
  ['vol-engines', 'volEngines'],
  ['vol-music', 'volMusic'],
];
for (const [id, key] of VOLUME_SLIDERS) {
  $(id).addEventListener('input', (e) => {
    settings[key] = e.target.value / 100;
    saveSettings();
    app.applySound();
  });
}
$('menu-start').addEventListener('click', () => {
  if (settings.sound) app.audio.start();
  app.startRace();
});
