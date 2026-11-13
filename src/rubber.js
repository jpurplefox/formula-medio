// Goma sobre el asfalto: un mapa de la pista (filas a lo largo de la línea central, carriles de un borde al otro)
// que se va oscureciendo por donde pasan las ruedas durante la carrera. Arranca con una franja tenue sobre la
// trazada ideal, como si antes hubiera corrido otra categoría.
//
// Los renderers leen `bytes` (0..255 por casillero, filas × LANES) y `version`, que cambia cada vez que se
// actualizan los bytes. side (de costado a la línea central) y st (sobre ella) van en celdas, como en el render.
//
// La goma también agarra (gripAt, que car.js aplica a cada rueda sobre el asfalto): RUBBER_GRIP más de agarre de
// la pista limpia a la negra del todo. El auto está calibrado con vueltas de clasificación, con la trazada como al
// largar (la franja de la otra categoría), así que ahí da 1: fuera de la trazada se agarra un poco menos desde el
// principio y, a medida que se marca, la trazada agarra cada vez más (y salirse para pasar cuesta más).

const RUBBER_LANES = 32;
export const RUBBER_DARK = 0.4; // cuánto oscurece la goma al máximo (0..1)
const BASE = 0.35; // la franja de la otra categoría: fracción del máximo en el centro de la trazada
const BASE_W = 0.9; // medio ancho de esa franja (celdas)
const WHEEL_M = 0.8; // de la línea del auto a cada rueda (m)
const WHEEL_SPREAD_M = 0.35; // medio ancho de la marca de cada rueda (m)
// cuánta goma deja una rueda por metro, sin exigir el agarre y al límite; la marca se ve
// 1 - exp(-goma / SATURATION): con unas 3 vueltas de 22 autos la trazada ya está clara y a las 10, bien negra
const PER_M = 0.4,
  PER_M_LIMIT = 1.6,
  SATURATION = 25;
const REFRESH = 0.5; // cada cuánto se recalculan los bytes (s)
const MAX_ROWS = 4096; // las texturas no pueden ser más largas
const RUBBER_GRIP = 0.06; // fuera de la trazada al largar, 2 % menos de agarre; con la trazada negra, 4 % más

export class RubberMap {
  // offset: por dónde pasa la trazada ideal en cada celda de la línea central (racingline.js)
  constructor(track, offset) {
    this.length = track.length;
    this.rows = Math.min(MAX_ROWS, Math.ceil(track.length));
    this.span = Math.max(...track.halfWidths) + 0.6; // de la línea central al último carril (celdas), un poco más que la pista
    this.lanes = RUBBER_LANES;
    this.meters = track.meters;
    this.rubber = new Float32Array(this.rows * this.lanes); // la que dejaron los autos
    this.base = new Float32Array(this.rows * this.lanes); // la de antes, 0..1
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
    this.prev = new Map(); // fila de la última pasada de cada auto
    this.refresh();
  }

  laneSide(l) {
    return (((l + 0.5) / this.lanes) * 2 - 1) * this.span;
  }

  // Lo que dejó cada auto en este cuadro. cars: [{ car, st, lat }] (st y lat en celdas, como carState)
  update(dt, cars) {
    for (const { car, st, lat } of cars) {
      const row = Math.floor((st / this.length) * this.rows) % this.rows;
      const last = this.prev.get(car);
      this.prev.set(car, row);
      if (last === undefined || car.onGrass || car.speed < 1) continue;
      // las filas que cruzó desde el cuadro anterior (a fondo, puede saltear alguna)
      let steps = (row - last + this.rows) % this.rows;
      if (steps === 0 || steps > 8) continue;
      // más goma cuanto más se exige el agarre: doblar, frenar o acelerar fuerte, y si desliza
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

  // las dos ruedas: una marca de cada lado de la línea del auto, más fuerte en el centro
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

  // Vuelve a la pista del principio de la carrera, con `amount` de goma ya puesta sobre la trazada (como si se
  // hubieran corrido unas vueltas; SATURATION es una marca clara). Para entrenar con la pista en cualquier momento
  // de la carrera sin armar el mapa de nuevo.
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

  // 0..1 en un punto de la pista (para el render sin WebGL), interpolando entre carriles
  static sample(map, st, side) {
    const { rows, lanes, span, bytes } = map;
    const row = Math.floor((st / map.length) * rows) % rows;
    const x = ((side / span + 1) / 2) * lanes - 0.5;
    if (x <= -0.5 || x >= lanes - 0.5) return 0;
    const l = Math.max(0, Math.min(lanes - 2, Math.floor(x))),
      f = Math.max(0, Math.min(1, x - l));
    return (bytes[row * lanes + l] * (1 - f) + bytes[row * lanes + l + 1] * f) / 255;
  }

  // agarre de una rueda en ese punto respecto del de la trazada al largar (1)
  static gripAt(map, st, side) {
    return 1 + RUBBER_GRIP * (RubberMap.sample(map, st, side) - BASE);
  }
}
