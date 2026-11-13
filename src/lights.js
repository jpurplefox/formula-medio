// Semáforo de largada, como en la F1: se prenden 5 luces rojas, una por segundo, y después de una espera al azar se
// apagan todas: ahí se larga. Lo usan el juego (main.js), las carreras de entrenamiento (rl/herd.js) y la medición
// de carreras como las del juego (rl/race_eval.js), y la red lo ve en sus entradas (sensors.js)

export const LIGHT_FIRST = 1; // cuándo se prende la primera (s)
const LIGHT_GAP = 1; // entre una luz y la siguiente (s)
const LIGHT_HOLD = [0.4, 2.6]; // cuánto quedan las 5 prendidas antes de apagarse (s, al azar entre estos)

// cuánto dura la cuenta desde que arranca hasta que se apagan, con una espera de hold s con las 5 prendidas
export const lightsDuration = (hold) => LIGHT_FIRST + 4 * LIGHT_GAP + hold;

// una espera al azar entre las de LIGHT_HOLD (random: una función que da entre 0 y 1)
export const randomHold = (random = Math.random) => LIGHT_HOLD[0] + (LIGHT_HOLD[1] - LIGHT_HOLD[0]) * random();

// Cómo está el semáforo a los elapsed s de la cuenta, que se apaga a los total s: luces prendidas, segundos desde
// que se prendió la última (0 si no hay ninguna) y si ya se apagaron (se largó)
export function lightsAt(elapsed, total) {
  if (elapsed >= total) return { lit: 0, since: 0, out: true };
  const lit = Math.min(5, Math.max(0, Math.floor((elapsed - LIGHT_FIRST) / LIGHT_GAP) + 1));
  return { lit, since: lit ? elapsed - LIGHT_FIRST - (lit - 1) * LIGHT_GAP : 0, out: false };
}

// en carrera (o sin semáforo): apagadas
export const LIGHTS_OUT = Object.freeze({ lit: 0, since: 0, out: true });
