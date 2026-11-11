// Rubber on the asphalt: a map of the track (rows along the centerline, lanes from one edge to the other) that
// darkens wherever the wheels go during the race. It starts with a faint strip on the racing line, as if another
// series had raced there before.
//
// The renderers read `bytes` (0..255 per cell, rows × LANES) and `version`, which changes every time the bytes are
// updated. side (sideways from the centerline) and st (along it) are in cells, as in the renderer.
//
// The rubber also grips (gripAt, which car.js applies to each wheel on the asphalt): RUBBER_GRIP more grip from the
// clean track to fully black. The car is calibrated with qualifying laps, with the racing line as at the start (the
// other series' strip), so it gives 1 there: off the racing line there is a little less grip from the beginning
// and, as it gets marked, the racing line grips more and more (and going off line to overtake costs more).

const RUBBER_LANES = 32;
export const RUBBER_DARK = 0.4; // how much the rubber darkens at most (0..1)
const BASE = 0.35; // the other series' strip: fraction of the maximum at the center of the racing line
const BASE_W = 0.9; // half width of that strip (cells)
const WHEEL_M = 0.8; // from the car's line to each wheel (m)
const WHEEL_SPREAD_M = 0.35; // half width of each wheel's mark (m)
// how much rubber a wheel leaves per meter, with the grip unused and at the limit; the mark shows as
// 1 - exp(-rubber / SATURATION): after about 3 laps of 22 cars the racing line is already clear and after 10, quite
// black
const PER_M = 0.4,
  PER_M_LIMIT = 1.6,
  SATURATION = 25;
const REFRESH = 0.5; // how often the bytes are recomputed (s)
const MAX_ROWS = 4096; // textures can't be longer
const RUBBER_GRIP = 0.06; // off the racing line at the start, 2 % less grip; with the racing line black, 4 % more

export class RubberMap {
  // offset: where the racing line runs at each centerline cell (racingline.js)
  constructor(track, offset) {
    this.length = track.length;
    this.rows = Math.min(MAX_ROWS, Math.ceil(track.length));
    // from the centerline to the last lane (cells), a little more than the track
    this.span = Math.max(...track.halfWidths) + 0.6;
    this.lanes = RUBBER_LANES;
    this.meters = track.meters;
    this.rubber = new Float32Array(this.rows * this.lanes); // the rubber the cars left
    this.base = new Float32Array(this.rows * this.lanes); // the earlier one, 0..1
    for (let r = 0; r < this.rows; r++) {
      const off = offset[Math.min(offset.length - 1, Math.floor((r * this.length) / this.rows))];
      for (let l = 0; l < this.lanes; l++) {
        const d = Math.abs(this.laneSide(l) - off) / BASE_W;
        if (d < 1) this.base[r * this.lanes + l] = BASE * (1 - d * d);
      }
    }
    this.bytes = new Uint8Array(this.rows * this.lanes);
    this.version = 0;
    this.clock = REFRESH;
    this.prev = new Map(); // row of each car's last pass
    this.refresh();
  }

  laneSide(l) {
    return (((l + 0.5) / this.lanes) * 2 - 1) * this.span;
  }

  // What each car left in this frame. cars: [{ car, st, lat }] (st and lat in cells, like carState)
  update(dt, cars) {
    for (const { car, st, lat } of cars) {
      const row = Math.floor((st / this.length) * this.rows) % this.rows;
      const last = this.prev.get(car);
      this.prev.set(car, row);
      if (last === undefined || car.onGrass || car.speed < 1) continue;
      // the rows it crossed since the previous frame (flat out, it can skip some)
      let steps = (row - last + this.rows) % this.rows;
      if (steps === 0 || steps > 8) continue;
      // more rubber the harder the grip is used: turning, braking or accelerating hard, and if it slides
      const use = Math.min(1.5, (car.speed * Math.abs(car.omega) + Math.abs(car.aLon)) / 40 + Math.abs(car.slip) / 5);
      const amount = (car.speed * dt * (PER_M + (PER_M_LIMIT - PER_M) * use)) / steps;
      for (let k = 1; k <= steps; k++) this.deposit((last + k) % this.rows, lat, amount);
    }
    this.clock -= dt;
    if (this.clock <= 0) {
      this.clock = REFRESH;
      this.refresh();
    }
  }

  // the two wheels: one mark on each side of the car's line, stronger in the center
  deposit(row, lat, amount) {
    const laneW = (2 * this.span) / this.lanes,
      spread = WHEEL_SPREAD_M / this.meters;
    for (const side of [-1, 1]) {
      const at = lat + (side * WHEEL_M) / this.meters;
      const l0 = Math.max(0, Math.floor((at - spread + this.span) / laneW)),
        l1 = Math.min(this.lanes - 1, Math.floor((at + spread + this.span) / laneW));
      for (let l = l0; l <= l1; l++) {
        const d = Math.abs(this.laneSide(l) - at) / spread;
        if (d < 1) this.rubber[row * this.lanes + l] += amount * (1 - d * d);
      }
    }
  }

  // Goes back to the track at the start of the race, with `amount` of rubber already laid on the racing line (as if
  // a few laps had been run; SATURATION is a clear mark). To train with the track at any point of the race without
  // rebuilding the map.
  reset(amount = 0) {
    const { rubber, base } = this;
    for (let i = 0; i < rubber.length; i++) rubber[i] = (amount * base[i]) / BASE;
    this.prev.clear();
    this.clock = REFRESH;
    this.refresh();
  }

  refresh() {
    const { rubber, base, bytes } = this;
    for (let i = 0; i < bytes.length; i++) {
      const fresh = 1 - Math.exp(-rubber[i] / SATURATION);
      bytes[i] = Math.round(255 * (1 - (1 - base[i]) * (1 - fresh)));
    }
    this.version++;
  }

  // 0..1 at a point on the track (for the renderer without WebGL), interpolating between lanes
  static sample(map, st, side) {
    const { rows, lanes, span, bytes } = map;
    const row = Math.floor((st / map.length) * rows) % rows;
    const x = ((side / span + 1) / 2) * lanes - 0.5;
    if (x <= -0.5 || x >= lanes - 0.5) return 0;
    const l = Math.max(0, Math.min(lanes - 2, Math.floor(x))),
      f = Math.max(0, Math.min(1, x - l));
    return (bytes[row * lanes + l] * (1 - f) + bytes[row * lanes + l + 1] * f) / 255;
  }

  // grip of a wheel at that point relative to the racing line's at the start (1)
  static gripAt(map, st, side) {
    return 1 + RUBBER_GRIP * (RubberMap.sample(map, st, side) - BASE);
  }
}
