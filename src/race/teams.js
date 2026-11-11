// Teams (parodies of the F1 ones, with their colors) and difficulty levels.

// color: bodywork; accent: livery stripe and details; helmet: helmet; drivers: its two drivers (name, code for the
// standings table and number), made up from the 2026 grid. As in F1, the first one carries the camera on top, the
// "T", in black and the second in yellow (as on the real 2026 grid); if you pick that team, you drive the car of the
// driver you choose.
export const TEAMS = [
  {
    id: 'hierrari',
    name: 'Hierrari',
    code: 'HIE',
    color: '#d40000',
    accent: '#ffe600',
    helmet: '#ffe600',
    drivers: [
      ['Carlos Le Clic', 'LEC', '16'],
      ['Luis Jamónton', 'JAM', '44'],
    ],
  },
  {
    id: 'merchoedes',
    name: 'Merchoedes',
    code: 'MER',
    color: '#c3c8cd',
    accent: '#00b5a5',
    helmet: '#1a1a1a',
    drivers: [
      ['Jorge Rústico', 'RUS', '63'],
      ['Kimi Antojo', 'ANT', '12'],
    ],
  },
  {
    id: 'redtoro',
    name: 'Red Toro',
    code: 'RTO',
    color: '#1b2550',
    accent: '#e8002d',
    helmet: '#ffc906',
    drivers: [
      ['Max Verstapón', 'VER', '3'],
      ['Isaac Hachar', 'HAC', '6'],
    ],
  },
  {
    id: 'mclarron',
    name: 'McLarrón',
    code: 'MCL',
    color: '#ff8000',
    accent: '#2a73d6',
    helmet: '#47c7fc',
    drivers: [
      ['Óscar Pistacho', 'PIS', '81'],
      ['Lando Nórdico', 'NOR', '1'],
    ],
  },
  {
    id: 'austin',
    name: 'Austin Martini',
    code: 'AUS',
    color: '#00594f',
    accent: '#cedc00',
    helmet: '#cedc00',
    drivers: [
      ['Lance Trol', 'TRO', '18'],
      ['Fernando Alondra', 'ALO', '14'],
    ],
  },
  {
    id: 'allpain',
    name: 'Allpain',
    code: 'ALL',
    color: '#0078c1',
    accent: '#f363b9',
    helmet: '#f363b9',
    drivers: [
      ['Pedro Gaseosa', 'GAS', '10'],
      ['Franco Colapuntos', 'COL', '43'],
    ],
  },
  {
    id: 'willyams',
    name: 'Willyams',
    code: 'WIL',
    color: '#0b2463',
    accent: '#ffffff',
    helmet: '#ffffff',
    drivers: [
      ['Alex Albóndiga', 'ALB', '23'],
      ['Carlos Santo', 'SAN', '55'],
    ],
  },
  {
    id: 'audios',
    name: 'Audiós',
    code: 'AUD',
    color: '#a3a8ae',
    accent: '#ff2d2d',
    helmet: '#d6dadf',
    drivers: [
      ['Nico Increíble', 'INC', '27'],
      ['Gabriel Borbotón', 'BOR', '5'],
    ],
  },
  {
    id: 'haash',
    name: 'Haash',
    code: 'HAA',
    color: '#e9e9e9',
    accent: '#d50000',
    helmet: '#d50000',
    drivers: [
      ['Esteban Ocono', 'OCO', '31'],
      ['Oliver Bermudas', 'BER', '87'],
    ],
  },
  {
    id: 'alfatorito',
    name: 'AlfaTorito',
    code: 'ALF',
    color: '#f2f2f2',
    accent: '#1634cc',
    helmet: '#e8e8e8',
    drivers: [
      ['Arvid Blablá', 'BLA', '41'],
      ['Liam Leyson', 'LEY', '30'],
    ],
  },
  {
    id: 'cadillaque',
    name: 'Cadillaque',
    code: 'CAD',
    color: '#141414',
    accent: '#c9a54a',
    helmet: '#f2f2f2',
    drivers: [
      ['Checo Pereza', 'PER', '11'],
      ['Valtteri Botas', 'BOT', '77'],
    ],
  },
];

// Rivals' pace: from the fastest (pole) to the slowest, spread evenly among the 21
// (fraction of the speed of their racing line; at Interlagos, 1.1 gives laps of ~68.8 s, 1.06 of ~69.7 s,
// 0.98 of ~71.9 s, 0.93 of ~75 s and 0.87 of ~80 s). In slow corners they don't go above 0.975 (ai.js).
// With the trained network (rl/) the pace is not chosen: the car sets it. setups: grip and power of the fastest and
// the slowest (1 = yours). The network (v5) was trained with cars from 0.85 to 1.2; a bit lower it still stays off
// the grass.
// Measured with GAME=1 DIFFICULTY=… node rl/race_eval.js: the winner takes 260 s (Fácil), 251 s (Normal), 243 s
// (Difícil) and 237 s (Experto), and a player at the classic AI's fastest pace on that difficulty finishes
// 5th, 4th, 6th and 9th.
// With the classic AI, at Interlagos: laps of ~75 to 80 s (Fácil), ~71.5 to 74 s (Normal), ~69.5 to 72 s (Difícil)
// and ~69 to 70 s (Experto).
export const DIFFICULTIES = [
  { id: 'easy', name: 'Fácil', paces: [0.93, 0.87], setups: [0.83, 0.78] },
  { id: 'normal', name: 'Normal', paces: [0.985, 0.945], setups: [0.89, 0.84] },
  { id: 'hard', name: 'Difícil', paces: [1.06, 0.98], setups: [0.95, 0.9] },
  { id: 'expert', name: 'Experto', paces: [1.1, 1.06], setups: [1.02, 0.98] },
];

const spread = ([fast, slow], count) =>
  Array.from({ length: count }, (_, i) => fast + ((slow - fast) * i) / Math.max(1, count - 1));

export const rivalPaces = (difficulty, count) => spread(difficulty.paces, count);

// Grip and power of each rival with the network, from the fastest to the slowest (the rest like yours)
export const rivalSetups = (difficulty, count) =>
  spread(difficulty.setups, count).map((k) => ({ power: k, topSpeed: 1, grip: k, brakes: 1, wear: 1 }));

export const LAP_OPTIONS = [1, 3, 5, 10];

// Championship standings, from the best team to the worst (update it as the season goes on). Rivals go in this
// order: those from the best teams start at the front and get the highest pace (classic AI) or grip and power
// (network) of the chosen difficulty.
const STANDINGS = [
  'merchoedes',
  'hierrari',
  'mclarron',
  'redtoro',
  'allpain',
  'haash',
  'alfatorito',
  'audios',
  'willyams',
  'austin',
  'cadillaque',
];

// How many rivals can be picked in the menu: with 10 (the default), one from each rival team; with all of them, the
// full grid
export const RIVAL_OPTIONS = [1, 3, 7, 10, 21];
export const DEFAULT_RIVALS = TEAMS.length - 1;

// The race cars: 2 per team. You drive your driver's car (slot) in your team; the rivals are the other 21 (your
// teammate included), sorted by the championship. With one per rival team (DEFAULT_RIVALS), the first driver of each
// of the other teams. With any other count, they are taken spread from end to end of the full list, so there are
// still fast and slow cars (with only one, the one from the best team).
// Each car: { team, slot (0 or 1), number }
export function rivalCars(team, count = Infinity, slot = 0) {
  const rank = (t) => STANDINGS.indexOf(t.id);
  const ranked = [...TEAMS].sort((a, b) => rank(a) - rank(b));
  if (count === DEFAULT_RIVALS) return ranked.filter((t) => t !== team).map((t) => car(t, 0));
  const all = ranked.flatMap((t) => (t === team ? [car(t, 1 - slot)] : [car(t, 0), car(t, 1)]));
  if (count >= all.length) return all;
  return Array.from({ length: count }, (_, i) => all[count > 1 ? Math.round((i * (all.length - 1)) / (count - 1)) : 0]);
}

export const teamById = (id) => TEAMS.find((t) => t.id === id) || TEAMS[0];

export const car = (team, slot) => {
  const [name, code, number] = team.drivers[slot];
  return { team, slot, name, code, number };
};

// Grid slot of each rival (in rivalCars order): as in qualifying, the best cars usually start at the front, but any
// of them can end up to about GRID_MIX places further forward or back
const GRID_MIX = 6;
export function gridOrder(count, rand = Math.random) {
  const order = Array.from({ length: count }, (_, i) => ({ i, key: i + GRID_MIX * rand() })).sort(
    (a, b) => a.key - b.key,
  );
  const slot = new Array(count);
  order.forEach(({ i }, k) => (slot[i] = k));
  return slot;
}
