// Equipos (parodias de los de la F1, con sus colores) y niveles de dificultad.

// color: carrocería; accent: franja y detalles de la decoración; helmet: casco; number: el número del auto
export const TEAMS = [
  { id: 'hierrari', name: 'Hierrari', code: 'HIE', color: '#d40000', accent: '#ffe600', helmet: '#ffe600', number: '5' },
  { id: 'merchoedes', name: 'Merchoedes', code: 'MER', color: '#c3c8cd', accent: '#00b5a5', helmet: '#1a1a1a', number: '8' },
  { id: 'redtoro', name: 'Red Toro', code: 'RTO', color: '#1b2550', accent: '#e8002d', helmet: '#ffc906', number: '11' },
  { id: 'mclarron', name: 'McLarrón', code: 'MCL', color: '#ff8000', accent: '#2a73d6', helmet: '#47c7fc', number: '12' },
  { id: 'austin', name: 'Austin Martini', code: 'AUS', color: '#00594f', accent: '#cedc00', helmet: '#cedc00', number: '15' },
  { id: 'allpain', name: 'Allpain', code: 'ALL', color: '#0078c1', accent: '#f363b9', helmet: '#f363b9', number: '17' },
  { id: 'willyams', name: 'Willyams', code: 'WIL', color: '#003aa8', accent: '#ffffff', helmet: '#ffffff', number: '19' },
  { id: 'audios', name: 'Audiós', code: 'AUD', color: '#5b6067', accent: '#ff2d2d', helmet: '#d6dadf', number: '21' },
  { id: 'haash', name: 'Haash', code: 'HAA', color: '#e9e9e9', accent: '#d50000', helmet: '#d50000', number: '25' },
  { id: 'alfatorito', name: 'AlfaTorito', code: 'ALF', color: '#24364f', accent: '#ffffff', helmet: '#e8e8e8', number: '28' },
  { id: 'cadillaque', name: 'Cadillaque', code: 'CAD', color: '#141414', accent: '#c9a54a', helmet: '#f2f2f2', number: '30' },
];

// Ritmo de los 5 rivales, de la pole hacia atrás (fracción de la velocidad de su trazada; en Interlagos,
// 1,1 da vueltas de ~68,8 s, 1,06 de ~69,7 s, 0,98 de ~71,9 s, 0,93 de ~75 s y 0,87 de ~80 s).
// En las curvas lentas no pasan de 0,975 (ai.js).
export const DIFFICULTIES = [
  { id: 'facil', name: 'Fácil', hint: 'Vueltas de ~75 a 80 s', paces: [0.93, 0.915, 0.9, 0.885, 0.87] },
  { id: 'normal', name: 'Normal', hint: 'Vueltas de ~71,5 a 74 s', paces: [0.985, 0.975, 0.965, 0.955, 0.945] },
  { id: 'dificil', name: 'Difícil', hint: 'Vueltas de ~69,5 a 72 s', paces: [1.06, 1.04, 1.02, 1.0, 0.98] },
  { id: 'experto', name: 'Experto', hint: 'Vueltas de ~69 a 70 s, todos juntos', paces: [1.1, 1.09, 1.08, 1.07, 1.06] },
];

export const LAP_OPTIONS = [1, 3, 5, 10];

// los 5 rivales: los equipos que siguen al tuyo en la lista
export function rivalTeams(team) {
  const i = TEAMS.indexOf(team);
  return [1, 2, 3, 4, 5].map((k) => TEAMS[(i + k) % TEAMS.length]);
}
