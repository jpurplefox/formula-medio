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

export const RUBBER_LANES = 32;
export const RUBBER_DARK = 0.4; // cuánto oscurece la goma al máximo (0..1)
const BASE = 0.35; // la franja de la otra categoría: fracción del máximo en el centro de la trazada
const BASE_W = 0.9; // medio ancho de esa franja (celdas)
const WHEEL_M = 0.8; // de la línea del auto a cada rueda (m)
const WHEEL_SPREAD_M = 0.35; // medio ancho de la marca de cada rueda (m)
// cuánta goma deja una rueda por metro, sin exigir el agarre y al límite; la marca se ve
// 1 - exp(-goma / SATURATION): con unas 3 vueltas de 22 autos la trazada ya está clara y a las 10, bien negra
const PER_M = 0.4, PER_M_LIMIT = 1.6, SATURATION = 25;
const REFRESH = 0.5; // cada cuánto se recalculan los bytes (s)
const MAX_ROWS = 4096; // las texturas no pueden ser más largas
// Pasto gastado (sólo se ve, no cambia el agarre): otra grilla igual de larga que la goma, pero medida desde el
// borde de la pista hacia afuera, de cada lado (WEAR_SIDE_LANES carriles hasta WEAR_REACH celdas), como la textura:
// los de la izquierda al revés y después los de la derecha, así los dos lados se tocan en el borde. Se marca en el
// momento por donde pisan las ruedas fuera de la pista, del ancho de la rueda. Arranca gastado donde la trazada
// pega al borde (y un poco después, a la salida de las curvas), como si ya hubieran corrido otras carreras.
export const WEAR_REACH = 6; // celdas desde el borde
export const WEAR_SIDE_LANES = 32; // carriles de cada lado (~0.4 m)
const WEAR_PER_M = 1.5, WEAR_SATURATION = 3; // una pasada aplasta el pasto y deja tierra entrecortada; varias, pelan todo
const TYRE_HALF_M = 0.35; // medio ancho de la huella de una rueda en el pasto (m)
const WEAR_BASE = 0.6, WEAR_BASE_AT = 1.8, WEAR_BASE_W = 2.2, WEAR_EXIT = 24; // el desgaste de antes: máximo, a cuánto del borde (celdas, pasando el piano), medio ancho y largo hacia la salida (filas)
export const RUBBER_GRIP = 0.06; // fuera de la trazada al largar, 2 % menos de agarre; con la trazada negra, 4 % más

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
    // el pasto: medio ancho de la pista en cada fila, para saber qué rueda está afuera
    this.halfWidths = Float32Array.from({ length: this.rows }, (_, r) => track.halfWidths[Math.min(track.halfWidths.length - 1, Math.floor((r * this.length) / this.rows))]);
    this.wearLanes = 2 * WEAR_SIDE_LANES;
    this.wearReach = WEAR_REACH;
    this.wear = new Float32Array(this.rows * this.wearLanes);
    this.wearBase = this.baseWear(offset);
    this.wearBytes = new Uint8Array(this.rows * this.wearLanes);
    this.wearVersion = 0; // cambia cada vez que cambian los bytes del pasto; wearDirty: filas cambiadas desde entonces
    this.wearDirty = null;
    this.wearRefresh(0, this.rows - 1);
    this.version = 0;
    this.clock = REFRESH;
    this.prev = new Map(); // fila de la última pasada de cada auto
    this.refresh();
  }

  // donde la trazada (con las ruedas) llega al borde, el pasto de ese lado ya está gastado, y sigue un poco
  // más adelante, por donde se abren los autos a la salida
  baseWear(offset) {
    const L = WEAR_SIDE_LANES, base = new Float32Array(this.rows * 2 * L);
    const wheel = WHEEL_M / this.meters;
    for (let r = 0; r < this.rows; r++) {
      const off = offset[Math.min(offset.length - 1, Math.floor((r * this.length) / this.rows))];
      const near = Math.min(1, Math.max(0, (Math.abs(off) + wheel - this.halfWidths[r] + 0.8) / 0.8));
      if (near <= 0) continue;
      const sign = Math.sign(off) || 1;
      for (let k = 0; k < WEAR_EXIT; k++) {
        const row = (r + k) % this.rows;
        const amount = WEAR_BASE * near * (1 - k / WEAR_EXIT);
        for (let j = 0; j < L; j++) {
          const d = Math.abs(this.wearOut(j) - WEAR_BASE_AT) / WEAR_BASE_W;
          if (d >= 1) continue;
          const i = row * 2 * L + this.wearLane(sign, j);
          base[i] = Math.max(base[i], amount * (1 - d * d));
        }
      }
    }
    return base;
  }

  // el carril j (desde el borde) de un lado, en la grilla; y a cuánto del borde está su centro (celdas)
  wearLane(sign, j) {
    return sign < 0 ? WEAR_SIDE_LANES - 1 - j : WEAR_SIDE_LANES + j;
  }

  wearOut(j) {
    return ((j + 0.5) * WEAR_REACH) / WEAR_SIDE_LANES;
  }

  laneSide(l) {
    return ((l + 0.5) / this.lanes * 2 - 1) * this.span;
  }

  // Lo que dejó cada auto en este cuadro. cars: [{ car, st, lat }] (st y lat en celdas, como carState)
  update(dt, cars) {
    for (const { car, st, lat } of cars) {
      const row = Math.floor((st / this.length) * this.rows) % this.rows;
      const last = this.prev.get(car);
      this.prev.set(car, row);
      if (last === undefined) continue;
      // las filas que cruzó desde el cuadro anterior (a fondo, puede saltear alguna)
      let steps = (row - last + this.rows) % this.rows;
      if (steps === 0 || steps > 8) continue;
      // más goma cuanto más se exige el agarre: doblar, frenar o acelerar fuerte, y si desliza
      const use = Math.min(1.5, (car.speed * Math.abs(car.omega) + Math.abs(car.aLon)) / 40 + Math.abs(car.slip) / 5);
      // las ruedas que van por el pasto lo gastan, más si deslizan o frenan (aunque vaya cruzado o marcha atrás): lo
      // de cada fila que cruzó entera (no lo de este cuadro: a menos de una fila por cuadro se perdería el resto)
      const worn = ((this.length * this.meters) / this.rows) * WEAR_PER_M * (1 + use);
      for (let k = 1; k <= steps; k++) this.trample((last + k) % this.rows, lat, worn);
      if (car.speed < 1) continue;
      if (car.onGrass) continue;
      const amount = (car.speed * dt * (PER_M + (PER_M_LIMIT - PER_M) * use)) / steps;
      for (let k = 1; k <= steps; k++) this.deposit((last + k) % this.rows, lat, amount);
    }
    this.clock -= dt;
    if (this.clock <= 0) {
      this.clock = REFRESH;
      this.refresh();
    }
  }

  // como deposit, pero en el pasto: sólo las ruedas que están fuera de la pista, y se ve enseguida
  trample(row, lat, amount) {
    const L = WEAR_SIDE_LANES, laneW = WEAR_REACH / L, hw = this.halfWidths[row];
    const spread = Math.max(TYRE_HALF_M / this.meters, laneW * 0.75);
    for (const side of [-1, 1]) {
      const at = lat + (side * WHEEL_M) / this.meters, out = Math.abs(at) - hw, sign = Math.sign(at);
      if (out < -spread || out > WEAR_REACH + spread) continue;
      const j0 = Math.max(0, Math.floor((out - spread) / laneW)), j1 = Math.min(L - 1, Math.floor((out + spread) / laneW));
      for (let j = j0; j <= j1; j++) {
        const d = Math.abs(this.wearOut(j) - out) / spread;
        if (d < 1) this.wear[row * 2 * L + this.wearLane(sign, j)] += amount * (1 - d * d);
      }
    }
    this.wearRefresh(row, row);
  }

  // recalcula los bytes del pasto de esas filas y las marca como cambiadas
  wearRefresh(r0, r1) {
    const { wear, wearBase, wearBytes, wearLanes } = this;
    for (let i = r0 * wearLanes; i < (r1 + 1) * wearLanes; i++) {
      const fresh = 1 - Math.exp(-wear[i] / WEAR_SATURATION);
      wearBytes[i] = Math.round(255 * (1 - (1 - wearBase[i]) * (1 - fresh)));
    }
    const d = this.wearDirty;
    this.wearDirty = d ? { lo: Math.min(d.lo, r0), hi: Math.max(d.hi, r1) } : { lo: r0, hi: r1 };
    this.wearVersion++;
  }

  // las dos ruedas: una marca de cada lado de la línea del auto, más fuerte en el centro
  deposit(row, lat, amount) {
    const laneW = (2 * this.span) / this.lanes, spread = WHEEL_SPREAD_M / this.meters;
    for (const side of [-1, 1]) {
      const at = lat + (side * WHEEL_M) / this.meters;
      const l0 = Math.max(0, Math.floor(((at - spread + this.span) / laneW))), l1 = Math.min(this.lanes - 1, Math.floor((at + spread + this.span) / laneW));
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
    this.wear.fill(0);
    this.wearRefresh(0, this.rows - 1);
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
    const l = Math.max(0, Math.min(lanes - 2, Math.floor(x))), f = Math.max(0, Math.min(1, x - l));
    return (bytes[row * lanes + l] * (1 - f) + bytes[row * lanes + l + 1] * f) / 255;
  }

  // cuánto está gastado el pasto en ese punto, 0..1: out = cuánto afuera del borde (celdas), side = de qué lado
  static wearAt(map, st, out, side) {
    if (out < 0 || out >= WEAR_REACH) return 0;
    const L = WEAR_SIDE_LANES, row = Math.floor((st / map.length) * map.rows) % map.rows;
    const x = L + (side < 0 ? -1 : 1) * (out / WEAR_REACH) * L - 0.5; // como la textura: 0 en el borde, en el medio
    const l = Math.max(0, Math.min(2 * L - 2, Math.floor(x))), f = Math.max(0, Math.min(1, x - l));
    const b = map.wearBytes, i = row * 2 * L + l;
    return (b[i] * (1 - f) + b[i + 1] * f) / 255;
  }

  // agarre de una rueda en ese punto respecto del de la trazada al largar (1)
  static gripAt(map, st, side) {
    return 1 + RUBBER_GRIP * (RubberMap.sample(map, st, side) - BASE);
  }
}
