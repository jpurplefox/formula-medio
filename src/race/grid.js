import { lineFrame, pointAt } from '../sim/lineframe.js';

// Grilla de largada detrás de la línea: de a dos, alternando de costado, cada puesto 8 m más atrás
export function gridSlots(track, count) {
  const f = lineFrame(track),
    M = track.meters;
  const slots = [];
  for (let i = 0; i < count; i++) {
    const back = (12 + i * 8) / M;
    const side = ((i % 2 ? -1 : 1) * 3) / M;
    slots.push({ ...pointAt(f, f.length - back, side), back: back * M }); // back: metros detrás de la línea
  }
  return slots;
}
