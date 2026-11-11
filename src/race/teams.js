// Equipos (parodias de los de la F1, con sus colores) y niveles de dificultad.

// color: carrocería; accent: franja y detalles de la decoración; helmet: casco; drivers: sus dos pilotos (nombre,
// sigla para la tabla y número), inventados a partir de la grilla de 2026. Como en la F1, el primero lleva la cámara
// de arriba, la "T", negra y el segundo, amarilla (como en la grilla de 2026 de verdad); si elegís ese equipo, manejás el auto del piloto que elijas.
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

// Ritmo de los rivales: del más rápido (pole) al más lento, repartido parejo entre los 21
// (fracción de la velocidad de su trazada; en Interlagos, 1,1 da vueltas de ~68,8 s, 1,06 de ~69,7 s,
// 0,98 de ~71,9 s, 0,93 de ~75 s y 0,87 de ~80 s). En las curvas lentas no pasan de 0,975 (ai.js).
// Con la red entrenada (rl/) el ritmo no se elige: lo da el auto. setups: agarre y potencia del más rápido y del más
// lento (1 = el tuyo). La red (v5) se entrenó con autos de 0,85 a 1,2; un poco más abajo sigue sin pisar el pasto.
// Medido con JUEGO=1 DIFICULTAD=… node rl/race_eval.js: el ganador tarda 260 s (Fácil), 251 s (Normal), 243 s
// (Difícil) y 237 s (Experto), y un jugador al ritmo más rápido de la IA de siempre en esa dificultad termina
// 5.º, 4.º, 6.º y 9.º.
// Con la IA de siempre, en Interlagos: vueltas de ~75 a 80 s (Fácil), ~71,5 a 74 s (Normal), ~69,5 a 72 s (Difícil)
// y ~69 a 70 s (Experto).
export const DIFFICULTIES = [
  { id: 'facil', name: 'Fácil', paces: [0.93, 0.87], setups: [0.83, 0.78] },
  { id: 'normal', name: 'Normal', paces: [0.985, 0.945], setups: [0.89, 0.84] },
  { id: 'dificil', name: 'Difícil', paces: [1.06, 0.98], setups: [0.95, 0.9] },
  { id: 'experto', name: 'Experto', paces: [1.1, 1.06], setups: [1.02, 0.98] },
];

const spread = ([fast, slow], count) =>
  Array.from({ length: count }, (_, i) => fast + ((slow - fast) * i) / Math.max(1, count - 1));

export const rivalPaces = (difficulty, count) => spread(difficulty.paces, count);

// Agarre y potencia de cada rival con la red, del más rápido al más lento (el resto como el tuyo)
export const rivalSetups = (difficulty, count) =>
  spread(difficulty.setups, count).map((k) => ({ power: k, topSpeed: 1, grip: k, brakes: 1, wear: 1 }));

export const LAP_OPTIONS = [1, 3, 5, 10];

// Cómo viene el campeonato, del mejor equipo al peor (actualizarlo a medida que avanza la temporada). Los rivales
// van en este orden: los de los mejores equipos largan adelante y reciben el ritmo (IA de siempre) o el agarre y la
// potencia (red) más altos de la dificultad elegida.
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

// Cuántos rivales se pueden elegir en el menú: con 10 (lo que viene elegido), uno de cada equipo rival; con todos, la
// grilla completa
export const RIVAL_OPTIONS = [1, 3, 7, 10, 21];
export const DEFAULT_RIVALS = TEAMS.length - 1;

// Los autos de la carrera: 2 por equipo. Vos manejás el de tu piloto (slot) en tu equipo; los rivales son los otros
// 21 (tu compañero incluido), ordenados por el campeonato. Con uno por equipo rival (DEFAULT_RIVALS), el primer piloto
// de cada uno de los otros equipos. Con otra cantidad (count), se toman repartidos de punta a punta de la lista
// completa, así sigue habiendo autos rápidos y lentos (con uno solo, el del mejor equipo).
// Cada auto: { team, slot (0 o 1), number }
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

// Lugar en la grilla de cada rival (en el orden de rivalCars): como en una clasificación, los mejores autos suelen
// largar adelante, pero cualquiera puede quedar hasta unos GRID_MIX puestos más adelante o más atrás
const GRID_MIX = 6;
export function gridOrder(count, rand = Math.random) {
  const order = Array.from({ length: count }, (_, i) => ({ i, key: i + GRID_MIX * rand() })).sort(
    (a, b) => a.key - b.key,
  );
  const slot = new Array(count);
  order.forEach(({ i }, k) => (slot[i] = k));
  return slot;
}
