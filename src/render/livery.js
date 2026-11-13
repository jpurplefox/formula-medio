// Car livery, drawn in code on a canvas: a single image (atlas) with three zones.
// - Right side and left side: the car seen from the side (x along it, z up).
//   They are the same drawing; on one of them the text is mirrored, so it reads correctly from both sides.
// - Top: the car seen from above (x along it, y across it).
// Everything is drawn in meters, with the same scale in both directions (LIVERY_S texels per meter).
// Also: the tyre sidewall, with the compound's color band and lettering that turns with the wheel,
// the tread, of worn rubber, and the rim face, with its spokes.

import { canvasTexture } from './textures.js';

const SIZE = 1024;
export const LIVERY_S = 176; // texels per meter
export const HALF_L = 2.9; // the atlas covers x from -HALF_L to HALF_L (m)
export const HALF_W = 1.1; // the top zone covers y from -HALF_W to HALF_W (m)
export const TALL = 1.1; // the side zones cover z from 0 to TALL (m)
export const SIDE_R = 4; // row where the right side starts
export const SIDE_L = 206; // row where the left side starts
export const TOP = 410; // row where the top zone starts

const FONT = 'ui-sans-serif, "Helvetica Neue", Arial, sans-serif';

// Sponsor lettering: each one with its own typeface, so they don't all look alike
const FONTS = {
  black: `italic 900 100px ${FONT}`,
  wide: `900 100px "Arial Black", ${FONT}`,
  serif: `italic 700 100px Georgia, "Times New Roman", serif`,
  mono: `700 100px "Courier New", monospace`,
  narrow: `700 100px "Arial Narrow", "Avenir Next Condensed", ${FONT}`,
  round: `800 100px "Trebuchet MS", Verdana, ${FONT}`,
  thin: `300 100px "Helvetica Neue", ${FONT}`,
  impact: `100px Impact, "Haettenschweiler", "Arial Narrow", ${FONT}`,
};

// Text in meters: centered at (a, b) of the zone's plane, with height h (m).
// m = [a, b, c, d] says where the text's right and "up" point on the canvas.
// s: the sponsor ({ t: text, c: color, font, bg: color pill behind it, line: letter outline, shield: instead
// of the pill, a shield straight on top and rounded below, with a border of that color and a green pinstripe inside });
// w: the maximum width (m): if it doesn't fit, the letters get narrower
function label(g, s, X, Y, h, m, w = Infinity) {
  if (typeof s === 'string') s = { t: s };
  g.save();
  const k = (h * LIVERY_S) / 100; // the letter is drawn 100 px tall and scaled
  const sc = g.getTransform().a; // the atlas may be drawn larger (sharp in liveryTexture)
  g.font = FONTS[s.font ?? 'black'];
  const tw = g.measureText(s.t).width + (s.shield ? 110 : s.bg ? 50 : 0);
  const sx = Math.min(1, (w * LIVERY_S) / (tw * k));
  g.setTransform(m[0] * k * sx * sc, m[1] * k * sx * sc, m[2] * k * sc, m[3] * k * sc, X * sc, Y * sc);
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  if (s.shield) {
    const shield = (k) => {
      g.beginPath();
      g.moveTo((-tw / 2) * k, -72 * k);
      g.lineTo((tw / 2) * k, -72 * k);
      g.lineTo((tw / 2) * k, -10);
      g.ellipse(0, -10, (tw / 2) * k, 88 * k, 0, 0, Math.PI);
      g.closePath();
    };
    shield(1);
    g.fillStyle = s.bg;
    g.fill();
    g.lineWidth = 12;
    g.strokeStyle = s.shield;
    g.stroke();
    shield(0.9);
    g.lineWidth = 5;
    g.strokeStyle = '#2f9a3c';
    g.stroke();
  } else if (s.bg) {
    g.fillStyle = s.bg;
    g.beginPath();
    g.roundRect(-tw / 2, -66, tw, 132, 22);
    g.fill();
  }
  if (s.line) {
    g.lineWidth = 14;
    g.lineJoin = 'round';
    g.strokeStyle = s.line;
    g.strokeText(s.t, 0, 0);
  }
  g.fillStyle = s.c ?? '#ffffff';
  g.fillText(s.t, 0, 0);
  g.restore();
}

// Where each sponsor goes, on fairly flat parts of the bodywork, so they don't get cut. From the side: [x, z, height,
// max width] (m): the sidepod (the main one, large, before it drops), the engine cover, the nose, the cockpit, the
// lower sidepod and the rear wing endplates. From above: [x, y, height, max width], text running along the car: the
// engine cover, the rear wing flap, the nose, the front wing and in front of the cockpit.
export const SIDE_SLOTS = {
  pod: [-0.25, 0.4, 0.11, 0.62],
  cover: [-1.3, 0.66, 0.1, 0.62],
  nose: [2.12, 0.27, 0.065, 0.5],
  cockpit: [0.86, 0.47, 0.055, 0.34],
  podLow: [-0.75, 0.27, 0.05, 0.6],
  plate: [-2.24, 0.885, 0.11, 0.42],
  plateLow: [-2.38, 0.58, 0.06, 0.34],
};
export const TOP_SLOTS = {
  cover: [-1.45, 0, 0.1, 0.9],
  flap: [-2.35, 0, 0.12, 0.85],
  nose: [2.32, 0, 0.06, 0.4],
  wing: [2.32, 0.48, 0.05, 0.2],
  front: [0.92, 0, 0.055, 0.3],
};

// The car's side profile (x, z), so the drawings follow its lines: the top of the sidepods, of the engine
// cover (in the middle and at the shoulders) and of the nose
export const LINES = {
  pod: [
    [0.58, 0.56],
    [0.3, 0.69],
    [-0.3, 0.7],
    [-0.75, 0.6],
    [-1.15, 0.47],
    [-1.5, 0.36],
    [-1.8, 0.3],
    [-2.3, 0.27],
  ],
  cover: [
    [-0.42, 0.8],
    [-0.6, 0.97],
    [-0.95, 0.95],
    [-1.25, 0.86],
    [-1.55, 0.74],
    [-1.95, 0.56],
    [-2.3, 0.41],
  ],
  shoulder: [
    [-0.42, 0.775],
    [-0.6, 0.75],
    [-0.95, 0.62],
    [-1.25, 0.47],
    [-1.55, 0.36],
    [-1.95, 0.3],
    [-2.3, 0.28],
  ],
  nose: [
    [2.9, 0.138],
    [2.74, 0.209],
    [2.62, 0.259],
    [2.4, 0.345],
    [2.1, 0.448],
    [1.7, 0.557],
    [1.15, 0.635],
  ],
};

// Tools to draw a zone in meters: from the side (a, b) = (x, z) and from above (a, b) = (x, y).
// poly: a filled polygon; band: what lies between two lines running front to back (lists of [a, b]
// traversed end to end); along: a gradient along the car, from a0 to a1, between the given colors;
// text: a sponsor in a slot from the list (SIDE_SLOTS or TOP_SLOTS)
function zone(g, X, Y, m, slots, mirror = 1) {
  const path = (pts) => {
    g.beginPath();
    pts.forEach(([a, b], i) => (i ? g.lineTo(X(a), Y(b)) : g.moveTo(X(a), Y(b))));
    g.closePath();
  };
  const z = {
    g,
    X,
    Y,
    poly(pts, fill) {
      path(pts);
      g.fillStyle = fill;
      g.fill();
    },
    band(lo, hi, fill) {
      z.poly([...lo, ...[...hi].reverse()], fill);
    },
    rect(a0, b0, a1, b1, fill) {
      z.poly(
        [
          [a0, b0],
          [a1, b0],
          [a1, b1],
          [a0, b1],
        ],
        fill,
      );
    },
    along(a0, a1, stops) {
      const gr = g.createLinearGradient(X(a0), 0, X(a1), 0);
      stops.forEach((c, i) => gr.addColorStop(i / (stops.length - 1), c));
      return gr;
    },
    circle(a, b, r, fill) {
      g.beginPath();
      g.arc(X(a), Y(b), r * LIVERY_S, 0, Math.PI * 2);
      g.fillStyle = fill;
      g.fill();
    },
    // the same on the other side (from above): b → -b
    both(fn) {
      fn(1);
      fn(-1);
    },
    text(slot, s, b = null) {
      const [a, bb, h, w] = slots[slot];
      label(g, s, X(a), Y(b ?? bb), h * (s.size ?? 1), m, w);
    },
    mirror,
  };
  return z;
}

// the top part of a line, shifted by dz
export const shift = (line, dz) => line.map(([a, b]) => [a, b + dz]);

// One side: the team paint (design.side), the black floor, the number on the sidepod and the sponsors
function drawSide(g, row, color, design, number, mirror) {
  const S = LIVERY_S;
  const right = mirror ? [-1, 0, 0, 1] : [1, 0, 0, 1];
  const z = zone(
    g,
    (x) => (x + HALF_L) * S,
    (h) => row + (TALL - h) * S,
    right,
    SIDE_SLOTS,
    mirror ? -1 : 1,
  );
  g.fillStyle = color;
  g.fillRect(0, row, SIZE, TALL * S);
  design.side(z);
  // lower part in black, like the floor
  g.fillStyle = '#18181c';
  g.fillRect(0, z.Y(0.19), SIZE, 0.19 * S);
  label(
    g,
    { t: number, c: design.number ?? '#ffffff', line: design.numberLine ?? '#111111' },
    z.X(0.27),
    z.Y(0.47),
    0.2,
    right,
  );
  for (const [slot, s] of Object.entries(design.sponsors.side)) z.text(slot, s);
}

// Seen from above: the team paint (design.top), the number on the nose (it reads looking at the car head-on,
// like the real ones) and the sponsors (they read from behind, looking forward)
function drawTop(g, color, design, number) {
  const S = LIVERY_S;
  const up = [0, 1, -1, 0]; // rotated text: reads from behind, looking forward
  const down = [0, -1, 1, 0]; // and the other way: reads from the front
  const z = zone(
    g,
    (x) => (x + HALF_L) * S,
    (y) => TOP + (y + HALF_W) * S,
    up,
    TOP_SLOTS,
  );
  g.fillStyle = color;
  g.fillRect(0, TOP, SIZE, 2 * HALF_W * S);
  design.top(z);
  // number on the nose, on a circle
  g.fillStyle = design.numberDisc ?? '#f4f4f4';
  g.beginPath();
  g.arc(z.X(1.75), z.Y(0), 0.12 * S, 0, Math.PI * 2);
  g.fill();
  label(g, { t: number, c: '#111111' }, z.X(1.75), z.Y(0), 0.13, down);
  for (const [slot, s] of Object.entries(design.sponsors.top)) {
    // the front wing ones go in pairs, one on each side
    if (slot === 'wing') z.both((k) => z.text(slot, s, k * TOP_SLOTS[slot][1]));
    else z.text(slot, s);
  }
}

// The default livery, for whatever is not a team car (the time trial ghost): a band in the detail color from the
// nose to the tail and a couple of sponsors
export const plainDesign = (color, accent) => ({
  side(z) {
    z.band(
      shift(LINES.nose, -0.2).concat([
        [0.2, 0.31],
        [-1.0, 0.33],
        [-2.4, 0.3],
      ]),
      [
        [2.7, 0.25],
        [1.2, 0.33],
        [0.2, 0.37],
        [-1.0, 0.39],
        [-2.4, 0.35],
      ],
      accent,
    );
    z.rect(-1.8, 0.56, -0.95, 0.41, accent);
    z.rect(-2.55, 1.0, -1.95, 0.76, accent);
  },
  top(z) {
    z.rect(-2.3, -0.035, 2.65, 0.035, accent);
    z.both((k) => z.rect(2.15, k * 0.45, 2.6, k * 0.97, accent));
  },
  sponsors: {
    side: { cover: { t: 'RAYCAST', c: color }, nose: { t: 'VOXEL', c: accent }, plate: { t: 'RAYCAST', c: color } },
    top: { cover: { t: 'RAYCAST', c: accent, line: '#111111' }, flap: { t: 'RAYCAST', c: accent } },
  },
});

// Livery atlas for a car
// color: bodywork (whatever faces forward or backward keeps this color); design: the team's paint and sponsors
// (teamliveries.js); sharp: the atlas at sharp times the resolution (for the player's own car, which is seen very
// close up from the cockpit); texture coordinates are multiplied the same way. It also carries the drawing (art), for
// the car views in the menu
export function liveryTexture(color, design, number, sharp = 1) {
  const c = document.createElement('canvas');
  c.width = c.height = SIZE * sharp;
  const g = c.getContext('2d');
  g.scale(sharp, sharp);
  g.fillStyle = color;
  g.fillRect(0, 0, SIZE, SIZE);
  drawSide(g, SIDE_R, color, design, number, false);
  drawSide(g, SIDE_L, color, design, number, true);
  drawTop(g, color, design, number);
  return Object.assign(canvasTexture(c), { art: c });
}

export const SIDEWALL_SIZE = 256;
export const SIDEWALL_S = 128 / 0.37; // texels per meter: the wheel (radius 0.36 m) fills almost the whole square
export const TREAD_SIZE = 256;
export const RIM_SIZE = 256;
export const RIM_S = 128 / 0.235; // texels per meter: the rim face (radius 0.229 m) fills almost the whole square

// Tyre sidewall: dark rubber, compound band and lettering around it
export function sidewallTexture(compound = '#e0262b') {
  const c = document.createElement('canvas');
  c.width = c.height = SIDEWALL_SIZE;
  const g = c.getContext('2d');
  const m = SIDEWALL_SIZE / 2,
    S = SIDEWALL_S;
  g.fillStyle = '#343438';
  g.fillRect(0, 0, SIDEWALL_SIZE, SIDEWALL_SIZE);
  g.strokeStyle = compound;
  g.lineWidth = 0.022 * S;
  g.beginPath();
  g.arc(m, m, 0.245 * S, 0, Math.PI * 2);
  g.stroke();
  // lettering following the circle, on both sides
  g.fillStyle = '#d8d8dc';
  g.font = `bold ${Math.round(0.045 * S)}px ${FONT}`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  const word = 'FIRELLO'; // the tyre supplier
  for (const base of [-Math.PI / 2, Math.PI / 2]) {
    for (let i = 0; i < word.length; i++) {
      const a = base + (i - (word.length - 1) / 2) * 0.17;
      g.save();
      g.translate(m + Math.cos(a) * 0.282 * S, m + Math.sin(a) * 0.282 * S);
      g.rotate(a + Math.PI / 2);
      g.fillText(word[i], 0, 0);
      g.restore();
    }
  }
  return canvasTexture(c);
}

// Tread: x around the wheel (it tiles, so everything drawn wraps to the other side),
// y across, from one sidewall to the other through the shoulders. Rubber with fine grain, the contact patch a bit
// lighter and duller, darker shoulders and dragged rubber marks along the lap, which show it is turning.
export function treadTexture() {
  const N = TREAD_SIZE;
  const c = document.createElement('canvas');
  c.width = c.height = N;
  const g = c.getContext('2d');
  let seed = 7;
  const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  // across: dark shoulders, lighter band
  const across = g.createLinearGradient(0, 0, 0, N);
  across.addColorStop(0, '#202024');
  across.addColorStop(0.2, '#2b2b30');
  across.addColorStop(0.3, '#34343a');
  across.addColorStop(0.7, '#34343a');
  across.addColorStop(0.8, '#2b2b30');
  across.addColorStop(1, '#202024');
  g.fillStyle = across;
  g.fillRect(0, 0, N, N);
  // rubber marks along the lap, mostly over the contact patch
  for (let i = 0; i < 90; i++) {
    const x = rand() * N,
      y = N * (0.22 + rand() * 0.56),
      len = 8 + rand() * 50,
      h = 1 + rand() * 3;
    g.fillStyle = rand() < 0.6 ? `rgba(70,70,76,${0.25 + rand() * 0.3})` : `rgba(14,14,16,${0.3 + rand() * 0.3})`;
    for (const dx of [0, -N]) g.fillRect(x + dx, y, len, h);
  }
  // fine grain
  const img = g.getImageData(0, 0, N, N),
    d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const k = (rand() - 0.5) * 10;
    d[i] += k;
    d[i + 1] += k;
    d[i + 2] += k;
  }
  g.putImageData(img, 0, 0);
  return canvasTexture(c);
}

// Rim face, seen from the side and centered: the rim edge, ten metal spokes in pairs coming out of the hub
// and, between the spokes, the dark gap with the slotted brake disc behind.
export function rimTexture() {
  const N = RIM_SIZE,
    m = N / 2,
    S = RIM_S;
  const c = document.createElement('canvas');
  c.width = c.height = N;
  const g = c.getContext('2d');
  const disc = (r, fill) => {
    g.beginPath();
    g.arc(m, m, r * S, 0, Math.PI * 2);
    g.fillStyle = fill;
    g.fill();
  };
  // background: the gap between the spokes
  g.fillStyle = '#0d0d0f';
  g.fillRect(0, 0, N, N);
  // brake disc, with curved slots
  disc(0.17, '#2c2c30');
  disc(0.09, '#0d0d0f');
  g.strokeStyle = '#19191c';
  g.lineWidth = 0.006 * S;
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * Math.PI * 2;
    g.beginPath();
    g.arc(m + Math.cos(a) * 0.13 * S, m + Math.sin(a) * 0.13 * S, 0.035 * S, a + 0.6, a + 2.2);
    g.stroke();
  }
  // spokes: in pairs, wider at the hub and thin toward the rim, with a light edge on one side
  const spoke = (a, w0, w1, fill) => {
    const p = (r, w) => [m + (Math.cos(a) * r - Math.sin(a) * w) * S, m + (Math.sin(a) * r + Math.cos(a) * w) * S];
    g.beginPath();
    g.moveTo(...p(0.05, -w0));
    g.lineTo(...p(0.215, -w1));
    g.lineTo(...p(0.215, w1));
    g.lineTo(...p(0.05, w0));
    g.closePath();
    g.fillStyle = fill;
    g.fill();
  };
  for (let i = 0; i < 5; i++) {
    for (const d of [-0.16, 0.16]) {
      const a = (i / 5) * Math.PI * 2 + d;
      spoke(a, 0.022, 0.012, '#4f535b');
      spoke(a + 0.025, 0.014, 0.007, '#8d929c');
    }
  }
  // rim (the inner edge of the wheel) and hub
  g.strokeStyle = '#6f747d';
  g.lineWidth = 0.02 * S;
  g.beginPath();
  g.arc(m, m, 0.218 * S, 0, Math.PI * 2);
  g.stroke();
  disc(0.065, '#5a5e66');
  disc(0.05, '#3b3e44');
  return canvasTexture(c);
}
