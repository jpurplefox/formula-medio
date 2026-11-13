// Humo de las ruedas: bocanadas que salen del contacto con el piso de las ruedas que deslizan, más de la de adentro
// de la curva (tiene menos carga: se bloquea o patina primero). Dos casos:
//   - bloqueo (car.locked, por eje): la goma frota a la velocidad del auto, así que el humo crece con ella, y sale
//     con algo de esa velocidad
//   - patinada (car.wheelspin, las de atrás): la goma gira más rápido de lo que avanza el auto, así que humea igual
//     aunque vaya despacio (una largada), y la rueda tira el humo hacia atrás
// Las ruedas que van por el pasto o la leca no humean. En el aire frenan rápido, suben, crecen y se desvanecen. Las dibuja el render con WebGL (glrenderer.js,
// drawSmoke). Todo en celdas, como el resto del mundo, salvo donde dice metros.

const WHEELS = [[1.65, 0.8], [-1.7, 0.79]]; // eje delantero y trasero: adelante del centro y medio ancho (m), como en carmodel.js
const PER_M = 1.4; // bloqueo: bocanadas por metro deslizado (por rueda, a carga pareja)
const MIN_SPEED = 4; // m/s: un bloqueo más despacio no llega a humear
const SPIN_RATE = 10; // patinada: bocanadas por segundo (por rueda, a carga pareja)
const SPIN_KICK = 4; // m/s hacia atrás con que la rueda que patina tira el humo
const LIFE = [1.6, 2.6]; // cuánto dura cada bocanada (s)
const SIZE = [0.8, 3.8]; // diámetro al salir y al final (m)
const DRAG = 2.6; // cuánto frena en el aire (1/s)
const RISE = 1.0; // cuánto sube (m/s)
const WIND = [1.2, 0.5]; // hacia dónde la corre el viento (m/s, en el mapa)
const MAX = 900; // bocanadas a la vez, como mucho
const NO_SMOKE = new Set(['grass', 'gravel']); // ahí la goma no frota contra nada duro: no humea (car.wheels)

export class Smoke {
  constructor() {
    this.puffs = [];
    this.debt = new Map(); // por auto y rueda: la fracción de bocanada que quedó pendiente del cuadro anterior
    this.seed = 1;
  }

  rand() {
    this.seed = (Math.imul(this.seed, 1103515245) + 12345) >>> 0;
    return (this.seed >>> 8) / 16777216;
  }

  // cars: [{ car, z }] (z: el piso debajo del auto, en celdas); M: metros por celda
  update(dt, cars, M) {
    for (const { car, z } of cars) {
      const v = Math.abs(car.speed);
      const fx = Math.cos(car.angle), fy = Math.sin(car.angle), lx = -fy, ly = fx;
      const turn = Math.sign(car.omega || 0); // hacia dónde dobla: las ruedas de ese lado (y > 0 si dobla a la izquierda) van más livianas
      const debts = this.debt.get(car) ?? [0, 0, 0, 0]; // por rueda: la fracción de bocanada pendiente
      this.debt.set(car, debts);
      for (let axle = 0; axle < 2; axle++) {
        const locked = car.locked?.[axle] && v >= MIN_SPEED, spinning = axle === 1 && car.wheelspin && !locked;
        if (!locked && !spinning) continue;
        const [ax, ay] = WHEELS[axle];
        for (const side of [-1, 1]) {
          const id = axle * 2 + (side > 0 ? 1 : 0); // el mismo orden que car.wheels (WHEELS de car.js)
          if (NO_SMOKE.has(car.wheels?.[id])) continue;
          const share = turn === 0 ? 1 : side === turn ? 1.5 : 0.5;
          debts[id] += (locked ? v * PER_M * Math.min(1, (v - MIN_SPEED) / 10) : SPIN_RATE) * dt * share;
          while (debts[id] >= 1) {
            debts[id] -= 1;
            const back = this.rand() * v * dt; // repartidas a lo largo de lo que avanzó en el cuadro
            const wx = car.x + (fx * (ax - back) + lx * ay * side) / M, wy = car.y + (fy * (ax - back) + ly * ay * side) / M;
            // se lleva algo de la velocidad del auto; la que patina además lo tira para atrás
            const k = 0.25 + this.rand() * 0.15, kick = spinning ? -SPIN_KICK * (0.6 + this.rand() * 0.8) : 0;
            this.puffs.push({
              x: wx, y: wy, z: z + 0.15 / M,
              vx: (fx * (car.speed * k + kick) + (this.rand() - 0.5) * 1.5) / M,
              vy: (fy * (car.speed * k + kick) + (this.rand() - 0.5) * 1.5) / M,
              vz: (RISE * (0.6 + this.rand() * 0.8)) / M,
              age: 0, life: LIFE[0] + this.rand() * (LIFE[1] - LIFE[0]),
              size: (SIZE[0] + this.rand() * 0.3) / M, grow: (SIZE[1] - SIZE[0]) / M,
              spin: this.rand() * Math.PI * 2, shade: 0.85 + this.rand() * 0.15,
            });
          }
        }
      }
    }
    // en el aire: frenan, suben y el viento las corre
    const drag = Math.exp(-DRAG * dt);
    for (const p of this.puffs) {
      p.age += dt;
      p.vx = p.vx * drag + (WIND[0] / M) * (1 - drag);
      p.vy = p.vy * drag + (WIND[1] / M) * (1 - drag);
      p.vz *= Math.exp(-0.6 * dt);
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
    }
    this.puffs = this.puffs.filter((p) => p.age < p.life);
    if (this.puffs.length > MAX) this.puffs.splice(0, this.puffs.length - MAX);
  }

  clear() {
    this.puffs = [];
    this.debt.clear();
  }
}

// cuánto se ve una bocanada (0..1) y su tamaño (celdas), según la edad: aparece rápido, crece y se va apagando
export function puffLook(p) {
  const t = p.age / p.life;
  const alpha = Math.min(1, p.age / 0.06) * (1 - t) * (1 - t) * 0.85;
  const size = p.size + p.grow * (1 - (1 - t) * (1 - t));
  return { alpha, size };
}
