// Equipos (parodias de los de la F1, con sus colores) y niveles de dificultad.

// color: carrocería; accent: franja y detalles de la decoración; helmet: casco; numbers: los de sus dos autos
// (como en la F1, el primero lleva la cámara de arriba, la "T", negra y el segundo, amarilla)
export const TEAMS = [
  { id: 'hierrari', name: 'Hierrari', code: 'HIE', color: '#d40000', accent: '#ffe600', helmet: '#ffe600', numbers: ['5', '44'] },
  { id: 'merchoedes', name: 'Merchoedes', code: 'MER', color: '#c3c8cd', accent: '#00b5a5', helmet: '#1a1a1a', numbers: ['8', '63'] },
  { id: 'redtoro', name: 'Red Toro', code: 'RTO', color: '#1b2550', accent: '#e8002d', helmet: '#ffc906', numbers: ['11', '22'] },
  { id: 'mclarron', name: 'McLarrón', code: 'MCL', color: '#ff8000', accent: '#2a73d6', helmet: '#47c7fc', numbers: ['12', '81'] },
  { id: 'austin', name: 'Austin Martini', code: 'AUS', color: '#00594f', accent: '#cedc00', helmet: '#cedc00', numbers: ['15', '18'] },
  { id: 'allpain', name: 'Allpain', code: 'ALL', color: '#0078c1', accent: '#f363b9', helmet: '#f363b9', numbers: ['17', '10'] },
  { id: 'willyams', name: 'Willyams', code: 'WIL', color: '#003aa8', accent: '#ffffff', helmet: '#ffffff', numbers: ['19', '23'] },
  { id: 'audios', name: 'Audiós', code: 'AUD', color: '#5b6067', accent: '#ff2d2d', helmet: '#d6dadf', numbers: ['21', '27'] },
  { id: 'haash', name: 'Haash', code: 'HAA', color: '#e9e9e9', accent: '#d50000', helmet: '#d50000', numbers: ['25', '31'] },
  { id: 'alfatorito', name: 'AlfaTorito', code: 'ALF', color: '#24364f', accent: '#ffffff', helmet: '#e8e8e8', numbers: ['28', '6'] },
  { id: 'cadillaque', name: 'Cadillaque', code: 'CAD', color: '#141414', accent: '#c9a54a', helmet: '#f2f2f2', numbers: ['30', '77'] },
];

// Ritmo de los rivales: del más rápido (pole) al más lento, repartido parejo entre los 21
// (fracción de la velocidad de su trazada; en Interlagos, 1,1 da vueltas de ~68,8 s, 1,06 de ~69,7 s,
// 0,98 de ~71,9 s, 0,93 de ~75 s y 0,87 de ~80 s). En las curvas lentas no pasan de 0,975 (ai.js).
export const DIFFICULTIES = [
  { id: 'facil', name: 'Fácil', hint: 'Vueltas de ~75 a 80 s', paces: [0.93, 0.87] },
  { id: 'normal', name: 'Normal', hint: 'Vueltas de ~71,5 a 74 s', paces: [0.985, 0.945] },
  { id: 'dificil', name: 'Difícil', hint: 'Vueltas de ~69,5 a 72 s', paces: [1.06, 0.98] },
  { id: 'experto', name: 'Experto', hint: 'Vueltas de ~69 a 70 s, todos juntos', paces: [1.1, 1.06] },
];

export function rivalPaces(difficulty, count) {
  const [fast, slow] = difficulty.paces;
  return Array.from({ length: count }, (_, i) => fast + ((slow - fast) * i) / Math.max(1, count - 1));
}

export const LAP_OPTIONS = [1, 3, 5, 10];

// Los autos de la carrera: 2 por equipo. Vos manejás el primero de tu equipo; los rivales son los dos de cada
// uno de los otros equipos (empezando por el que sigue al tuyo en la lista) y al final tu compañero.
// Cada auto: { team, slot (0 o 1), number }
export function rivalCars(team) {
  const i = TEAMS.indexOf(team);
  const cars = [];
  for (let k = 1; k < TEAMS.length; k++) {
    const t = TEAMS[(i + k) % TEAMS.length];
    cars.push(car(t, 0), car(t, 1));
  }
  return [...cars, car(team, 1)];
}

export const car = (team, slot) => ({ team, slot, number: team.numbers[slot] });
