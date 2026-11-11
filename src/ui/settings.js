// Lo que se elige en el menú, recordado en el navegador (localStorage). Si no se puede leer ni guardar (navegación
// privada, almacenamiento bloqueado), quedan los valores por defecto y se juega igual.
import { DEFAULT_RIVALS, RIVAL_OPTIONS } from '../race/teams.js';
import { TRACKS } from '../../tracks/index.js';

const SETTINGS_KEY = 'formula-medio-settings';
const OLD_SETTINGS_KEY = 'raycast-racer-settings'; // de cuando el juego se llamaba Raycast Racer

// modo (carrera o contrarreloj), equipo y piloto (driver: 0 el primero, 1 el segundo), dificultad, circuito, vueltas,
// cantidad de rivales, vista con la que se larga (view: cabina o exterior), daños (damage.js), caja, ayudas,
// volúmenes y tu puesta a punto en cada circuito donde la cambiaste (tunes).
// El sonido arranca siempre apagado (se prende con N o desde el menú) y eso no se recuerda.
export const settings = {
  mode: 'race',
  team: 'hierrari',
  driver: 0,
  difficulty: 'hard',
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

// v: versión de lo guardado; antes de la 2 los rivales venían en 21 y se pasan a los 10 nuevos (uno por equipo)
const SETTINGS_VERSION = 2;
const OLD_DIFFICULTIES = { facil: 'easy', dificil: 'hard', experto: 'expert' };
try {
  const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? localStorage.getItem(OLD_SETTINGS_KEY)) || {};
  if (!(saved.v >= SETTINGS_VERSION) || !RIVAL_OPTIONS.includes(saved.rivals)) delete saved.rivals;
  saved.difficulty = OLD_DIFFICULTIES[saved.difficulty] ?? saved.difficulty;
  Object.assign(settings, saved, { sound: false, v: SETTINGS_VERSION });
} catch {
  // sin almacenamiento: quedan los valores por defecto
}

export const saveSettings = () => {
  try {
    const { sound: _, ...kept } = settings;
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(kept));
  } catch {
    // no pasa nada si no se puede guardar
  }
};
