// Marcas de goma de bloqueos y patinadas: sólo se ven (no cambian el agarre, eso es rubber.js). Una imagen que
// cubre todo el mapa, con varios puntos por celda, donde cada rueda que desliza pinta una línea del ancho de la goma
// desde donde estaba en el cuadro anterior hasta donde está ahora: así quedan las frenadas, las largadas y las donas,
// vaya como vaya el auto. No pinta en el pasto ni en la leca (ahí no queda goma). La dibuja el render con WebGL
// (glrenderer.js): oscurece el asfalto, los pianos y las escapatorias asfaltadas.

import { spinAmount } from './smoke.js';

const WHEELS = [[1.65, -0.8], [1.65, 0.8], [-1.7, -0.79], [-1.7, 0.79]]; // adelante y al costado del centro (m), como WHEELS de car.js
const HALF_W = 0.2; // medio ancho de la huella (m)
// cuánto oscurece cada pasada de la rueda (0..1, se acumula pasada a pasada): bloqueada, fijo (arrastra todo lo que
// avanza); patinando, según lo que desliza la goma (gira de más y va de costado) contra lo que avanza esa rueda, con
// un mínimo (a fondo también marca algo); y todo según cuánto patina (spinAmount): saliendo de una curva, poco
const LOCK_PASS = 0.7, SPIN_PASS = 0.25, SPIN_MIN = 0.2;
const SPIN_SLIP = 6; // m/s que patina de más una rueda que perdió tracción (SPIN_SPEED de car.js)
const MIN_LOCK_SPEED = 3; // m/s: un bloqueo más despacio no deja marca
const CLEAN = new Set(['grass', 'gravel']);
const MAX_SIDE = 4096; // las texturas no pueden ser más grandes (en algunas placas)

export class SkidMarks {
  constructor(track) {
    this.k = Math.max(2, Math.min(6, Math.floor(MAX_SIDE / Math.max(track.W, track.H)))); // puntos por celda
    this.w = track.W * this.k;
    this.h = track.H * this.k;
    this.data = new Uint8Array(this.w * this.h);
    this.meters = track.meters;
    this.prev = new Map(); // por auto: dónde estaba cada rueda que venía marcando (o null)
    this.dirty = null; // { x0, y0, x1, y1 }: lo que cambió desde que el render lo subió
    this.version = 0;
  }

  update(dt, cars) {
    for (const car of cars) this.car(dt, car);
  }

  car(dt, car) {
    const lockF = car.locked?.[0], lockR = car.locked?.[1], spin = car.wheelspin && !lockR;
    const v = Math.abs(car.speed), prev = this.prev.get(car) ?? [null, null, null, null];
    this.prev.set(car, prev);
    const M = this.meters, ca = Math.cos(car.angle), sa = Math.sin(car.angle);
    for (let i = 0; i < 4; i++) {
      const front = i < 2, locked = front ? lockF : lockR;
      // cómo se mueve esa rueda sobre el piso (la del auto más la que le da el giro)
      const [f, r] = WHEELS[i], w = car.omega || 0;
      const along = car.speed - w * r, side = (car.slip || 0) + w * f;
      let strength = 0;
      if (locked && v >= MIN_LOCK_SPEED) strength = LOCK_PASS;
      else if (!front && spin) strength = Math.min(1, Math.max(SPIN_MIN, (SPIN_PASS * Math.hypot(side, SPIN_SLIP)) / Math.max(2, Math.hypot(along, side)))) * (0.2 + 0.8 * spinAmount(car));
      if (!strength || CLEAN.has(car.wheels?.[i])) {
        prev[i] = null;
        continue;
      }
      const x = (car.x + (ca * f - sa * r) / M) * this.k, y = (car.y + (sa * f + ca * r) / M) * this.k;
      const from = prev[i] ?? [x, y];
      // si saltó mucho (el auto reapareció en otro lado), no une las dos puntas
      if (Math.hypot(x - from[0], y - from[1]) < 6 * this.k) this.line(from[0], from[1], x, y, strength);
      prev[i] = [x, y];
    }
  }

  // una línea de goma de (x0, y0) a (x1, y1) (en puntos de la imagen), más oscura en el medio de la huella
  line(x0, y0, x1, y1, strength) {
    const hw = (HALF_W / this.meters) * this.k + 0.5;
    const ex = x1 - x0, ey = y1 - y0, len2 = ex * ex + ey * ey || 1e-6;
    const bx0 = Math.max(0, Math.floor(Math.min(x0, x1) - hw)), bx1 = Math.min(this.w - 1, Math.ceil(Math.max(x0, x1) + hw));
    const by0 = Math.max(0, Math.floor(Math.min(y0, y1) - hw)), by1 = Math.min(this.h - 1, Math.ceil(Math.max(y0, y1) + hw));
    if (bx0 > bx1 || by0 > by1) return;
    for (let py = by0; py <= by1; py++) {
      for (let px = bx0; px <= bx1; px++) {
        const cx = px + 0.5 - x0, cy = py + 0.5 - y0;
        const t = Math.max(0, Math.min(1, (cx * ex + cy * ey) / len2));
        const d = Math.hypot(cx - ex * t, cy - ey * t) / hw;
        if (d >= 1) continue;
        const a = Math.min(1, strength * (1 - d * d));
        const i = py * this.w + px;
        this.data[i] = Math.round(255 - (255 - this.data[i]) * (1 - a));
      }
    }
    const d = this.dirty;
    this.dirty = d ? { x0: Math.min(d.x0, bx0), y0: Math.min(d.y0, by0), x1: Math.max(d.x1, bx1), y1: Math.max(d.y1, by1) } : { x0: bx0, y0: by0, x1: bx1, y1: by1 };
    this.version++;
  }
}
