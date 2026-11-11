import { lineFrame, pointAt } from '../sim/lineframe.js';

// Starting grid behind the line: two by two, alternating sides, each slot 8 m further back
export function gridSlots(track, count) {
  const f = lineFrame(track),
    M = track.meters;
  const slots = [];
  for (let i = 0; i < count; i++) {
    const back = (12 + i * 8) / M;
    const side = ((i % 2 ? -1 : 1) * 3) / M;
    slots.push({ ...pointAt(f, f.length - back, side), back: back * M }); // back: meters behind the line
  }
  return slots;
}
