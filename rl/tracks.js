// Builds the tracks in Node, the same way the game does: from telemetry (tools/layout.py) or, for tracks that come
// from an image, from the mask exported by rl/bake.html.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { TRACKS } from '../tracks/index.js';
import { buildTrackFromLayout, buildTrackFromMask } from '../src/sim/track.js';
import { unpackMask } from './mask.js';

const root = (p) => fileURLToPath(new URL('../' + p, import.meta.url));

export function loadTrack(id) {
  const def = TRACKS.find((t) => t.id === id);
  if (!def) throw new Error(`Track ${id} does not exist`);
  if (def.layout) return buildTrackFromLayout(JSON.parse(readFileSync(root(def.layout), 'utf8')), def);
  const mask = unpackMask(readFileSync(root(`rl/tracks/${id}.mask`)));
  const elevation = def.elevation ? JSON.parse(readFileSync(root(def.elevation), 'utf8')) : null;
  return buildTrackFromMask(mask, def, elevation);
}

export const TRACK_IDS = TRACKS.map((t) => t.id);
