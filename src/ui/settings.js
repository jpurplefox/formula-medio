// What is chosen in the menu, remembered in the browser (localStorage). If it can't be read or saved (private
// browsing, blocked storage), the defaults stay and the game plays the same.
import { DEFAULT_RIVALS, RIVAL_OPTIONS } from '../race/teams.js';
import { TRACKS } from '../../tracks/index.js';

const SETTINGS_KEY = 'formula-medio-settings';
const OLD_SETTINGS_KEY = 'raycast-racer-settings'; // from when the game was called Raycast Racer

// mode (race or time trial), team and driver (driver: 0 the first, 1 the second), difficulty, track, laps,
// number of rivals, view at the start (view: cockpit or exterior), damage (damage.js), gearbox, assists,
// volumes and your setup on each track where you changed it (tunes).
// Sound always starts off (it is turned on with N or from the menu) and that is not remembered.
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

// v: version of the saved data; before 2 the rivals defaulted to 21 and are moved to the new 10 (one per team)
const SETTINGS_VERSION = 2;
const OLD_DIFFICULTIES = { facil: 'easy', dificil: 'hard', experto: 'expert' };
try {
  const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? localStorage.getItem(OLD_SETTINGS_KEY)) || {};
  if (!(saved.v >= SETTINGS_VERSION) || !RIVAL_OPTIONS.includes(saved.rivals)) delete saved.rivals;
  saved.difficulty = OLD_DIFFICULTIES[saved.difficulty] ?? saved.difficulty;
  Object.assign(settings, saved, { sound: false, v: SETTINGS_VERSION });
} catch {
  // no storage: the defaults stay
}

export const saveSettings = () => {
  try {
    const { sound: _, ...kept } = settings;
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(kept));
  } catch {
    // nothing happens if it can't be saved
  }
};
