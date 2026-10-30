// Arma en Node los circuitos exportados por rl/bake.html (máscara + alturas), igual que el juego.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { TRACKS } from '../tracks/index.js';
import { buildTrackFromMask } from '../src/track.js';
import { unpackMask } from './mask.js';

const root = (p) => fileURLToPath(new URL('../' + p, import.meta.url));

export function loadTrack(id) {
  const def = TRACKS.find((t) => t.id === id);
  if (!def) throw new Error(`No existe el circuito ${id}`);
  const mask = unpackMask(readFileSync(root(`rl/tracks/${id}.mask`)));
  const elevation = def.elevation ? JSON.parse(readFileSync(root(def.elevation), 'utf8')) : null;
  return buildTrackFromMask(mask, def, elevation);
}

export const TRACK_IDS = TRACKS.map((t) => t.id);
