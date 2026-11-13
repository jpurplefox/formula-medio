// Start lights, as in F1: 5 red lights come on, one per second, and after a random wait they all go out: that is
// the start. Used by the game (main.js), the training races (rl/herd.js) and the evaluation of game-like races
// (rl/race_eval.js), and the network sees them in its inputs (sensors.js)

export const LIGHT_FIRST = 1; // when the first one comes on (s)
const LIGHT_GAP = 1; // between one light and the next (s)
const LIGHT_HOLD = [0.4, 2.6]; // how long all 5 stay on before going out (s, random between these)

// how long the countdown lasts from its start until they go out, with a wait of hold s with all 5 on
export const lightsDuration = (hold) => LIGHT_FIRST + 4 * LIGHT_GAP + hold;

// a random wait within LIGHT_HOLD (random: a function that returns between 0 and 1)
export const randomHold = (random = Math.random) => LIGHT_HOLD[0] + (LIGHT_HOLD[1] - LIGHT_HOLD[0]) * random();

// The state of the start lights at elapsed s into the countdown, which goes out at total s: lights on, seconds since
// the last one came on (0 if none) and whether they already went out (the race started)
export function lightsAt(elapsed, total) {
  if (elapsed >= total) return { lit: 0, since: 0, out: true };
  const lit = Math.min(5, Math.max(0, Math.floor((elapsed - LIGHT_FIRST) / LIGHT_GAP) + 1));
  return { lit, since: lit ? elapsed - LIGHT_FIRST - (lit - 1) * LIGHT_GAP : 0, out: false };
}

// in the race (or with no start lights): out
export const LIGHTS_OUT = Object.freeze({ lit: 0, since: 0, out: true });
