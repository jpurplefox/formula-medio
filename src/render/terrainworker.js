// Worker that draws the sky and terrain for a strip of screen columns (see TerrainPool in renderer.js).
// Uses the same Renderer as the main thread, without a canvas: it draws in memory and returns its strip.

import { Renderer } from './renderer.js';

let r = null,
  x0 = 0,
  x1 = 0,
  track = null,
  offset = null,
  rubber = null;

onmessage = ({ data: m }) => {
  if (m.type === 'init') {
    r = new Renderer({ width: m.w, height: m.h });
    x0 = m.x0;
    x1 = m.x1;
  } else if (m.type === 'track') {
    track = m.track;
    offset = m.offset;
  } else if (m.type === 'frame') {
    r.guide = m.guideColor && offset ? { offset, color: m.guideColor } : null;
    if (typeof m.rubber === 'object') rubber = m.rubber; // null, or a new copy of the rubber map
    r.rubber = rubber;
    r.setZoom(m.zoom);
    r.drawColumns(track, m.cam, m.horizon, x0, x1);
    // pack the strip (row by row) and the depth marks of its columns
    const { w, h, buf, clip } = r;
    const sw = x1 - x0;
    const pix = new Uint32Array(m.pix.buffer);
    for (let y = 0; y < h; y++) pix.set(buf.subarray(y * w + x0, y * w + x1), y * sw);
    const out = new Int16Array(m.clip.buffer);
    out.set(clip.subarray(x0 * (out.length / sw), x1 * (out.length / sw)));
    postMessage({ pix, clip: out }, [pix.buffer, out.buffer]);
  }
};
