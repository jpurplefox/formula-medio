// Track definitions.
// The F1 ones come from telemetry (tools/layout.py): centerline in meters, heights and lap length.
//   layout     → layout generated with tools/layout.py
//   circuit    → short name of the track in OpenF1 (tools/layout.py, tools/lapcompare.js)
//   altitude   → meters above sea level: higher up the air is less dense (less downforce and less drag)
//   tune       → default setup (src/sim/dynamics.js): wings from 1 to 10 and mechanical balance from -5 to 5,
//                as the teams run there (little wing where the straight matters, a lot where there are corners)
//   rotate     → (optional) degrees to rotate the layout (telemetry comes in another orientation than the drawings)
//   widthMeters → track width in meters
//   runoff     → cells of runoff between the track and the walls
//   elevationScale → (optional) exaggerates or softens the heights; 1 = real slopes
//   surfaces   → (optional, also on image tracks) what is in the runoff, overriding the automatic choice (asphalt
//                outside slow corners, gravel outside fast ones, grass elsewhere; see track.js):
//                [[from, to, side, material], ...], in meters from the start line; side 'left', 'right' or 'both';
//                material 'grass', 'gravel' or 'asphalt'
//   kerb       → (optional) [r, g, b] colors of the kerb stripes, repeated in order (up to 4);
//                otherwise white and red
//   kerbStyle  → (optional) what the kerbs look like (KERB_STYLE in src/sim/track.js): stripe (length of each stripe,
//                cells), width (kerb width, cells), line (white line between the track and the kerb), green (width of
//                the abrasive green strip behind the kerb, 0 = no green), sausage (sausage kerbs in the tightest
//                corners)
// A custom track (or one without telemetry) comes from an image; the coordinates (start, towards) are in pixels of
// the original image.
//   image      → image of the layout: a dark line on a light background
//   scale      → how many image pixels make up one map cell
//   threshold  → luminance (0-255) below which a pixel is track
//   widen      → extra cells to widen the track
//   runoff     → cells of runoff between the track and the walls
//   start      → a point on the start line
//   towards    → a point in the direction of travel from the start
//   elevation  → (optional) height profile generated with tools/elevation.py
//   elevationScale → (optional) exaggerates or softens the heights; 1 = real slopes
//   widthMeters → (optional) track width in meters; otherwise, the drawing's
//   lengthMeters → (optional) lap length in meters, if there is no height profile (which already includes it)
//   open       → (optional) erases lines narrower than 2·open+1 cells touching the layout
//                (pit lane, old chicanes, the flag pole)
//   paint      → (optional) segments to retrace in black, in image pixels: [[x0, y0, x1, y1, width], ...]
//                (where the checkered flag cuts the track; a segment of length 0 is a point)
//   smooth     → (optional) smoothing passes over the centerline; more on small images, where the lines come out
//                stepped and the car would brake on the straights (default 3)
export const TRACKS = [
  {
    id: 'interlagos',
    name: 'Interlagos',
    circuit: 'Interlagos',
    altitude: 785,
    tune: { front: 6, rear: 6, balance: 0 },
    layout: 'tracks/interlagos.layout.json',
    rotate: 76,
    widthMeters: 15,
    runoff: 3,
    kerb: [
      [0, 156, 59],
      [255, 214, 0],
      [0, 56, 150],
    ], // Brazil: green, yellow and blue
    kerbStyle: { stripe: 1.6, width: 0.9, green: 0.8 },
  },
  {
    id: 'monza',
    name: 'Monza',
    circuit: 'Monza',
    altitude: 160,
    tune: { front: 1, rear: 1, balance: 0 },
    layout: 'tracks/monza.layout.json',
    rotate: -87,
    widthMeters: 14,
    runoff: 3,
    kerb: [
      [0, 140, 69],
      [240, 240, 240],
      [205, 33, 42],
    ], // Italy: green, white and red
    kerbStyle: { stripe: 2.4, width: 1.0, green: 0.6 }, // long stripes
  },
  {
    id: 'albertpark',
    name: 'Albert Park',
    circuit: 'Melbourne',
    altitude: 10,
    tune: { front: 6, rear: 6, balance: 0 },
    layout: 'tracks/albertpark.layout.json',
    rotate: -48,
    widthMeters: 14,
    runoff: 3,
    kerb: [
      [0, 132, 61],
      [255, 205, 0],
    ], // Australia: green and gold
    kerbStyle: { stripe: 1.4, width: 0.8, green: 0, sausage: false }, // street circuit in a park: no green
  },
  {
    id: 'barcelona',
    name: 'Barcelona',
    circuit: 'Catalunya',
    altitude: 110,
    tune: { front: 8, rear: 8, balance: 0 },
    layout: 'tracks/barcelona.layout.json',
    rotate: 5,
    widthMeters: 14,
    runoff: 3,
    kerb: [
      [200, 16, 46],
      [255, 196, 0],
    ], // Spain: red and yellow
    kerbStyle: { stripe: 1.6, width: 0.9, green: 1.0 },
  },
  {
    id: 'montreal',
    name: 'Montreal',
    circuit: 'Montreal',
    altitude: 15,
    tune: { front: 4, rear: 4, balance: 0 },
    layout: 'tracks/montreal.layout.json',
    rotate: 102,
    widthMeters: 12,
    runoff: 3,
    kerb: [
      [216, 6, 33],
      [240, 240, 240],
    ], // Canada: red and white
    kerbStyle: { stripe: 1.2, width: 0.7, green: 0, line: false }, // narrow kerbs right against the asphalt
  },
  {
    id: 'spa',
    name: 'Spa',
    circuit: 'Spa-Francorchamps',
    altitude: 400,
    tune: { front: 3, rear: 3, balance: 0 },
    layout: 'tracks/spa.layout.json',
    rotate: -104,
    widthMeters: 13,
    runoff: 3,
    kerb: [
      [30, 30, 30],
      [253, 218, 36],
      [239, 51, 64],
    ], // Belgium: black, yellow and red
    kerbStyle: { stripe: 2.0, width: 1.0, green: 0.8 },
  },
  {
    id: 'silverstone',
    name: 'Silverstone',
    circuit: 'Silverstone',
    altitude: 150,
    tune: { front: 5, rear: 5, balance: 0 },
    layout: 'tracks/silverstone.layout.json',
    rotate: -71,
    widthMeters: 15,
    runoff: 3,
    kerb: [
      [1, 33, 105],
      [240, 240, 240],
      [200, 16, 46],
    ], // United Kingdom: blue, white and red
    kerbStyle: { stripe: 1.6, width: 0.9, green: 1.0 },
  },
  {
    id: 'redbullring',
    name: 'Red Bull Ring',
    circuit: 'Spielberg',
    altitude: 680,
    tune: { front: 5, rear: 5, balance: 0 },
    layout: 'tracks/redbullring.layout.json',
    rotate: 9,
    widthMeters: 13,
    runoff: 3,
    kerb: [
      [237, 41, 57],
      [240, 240, 240],
    ], // Austria: red and white
    kerbStyle: { stripe: 1.6, width: 0.9, green: 1.2 }, // lots of abrasive green behind the kerbs
  },
];
