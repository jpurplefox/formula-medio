// El teclado: qué teclas están apretadas y lo que piden para manejar. Cada tecla se reconoce por su posición (e.code,
// como en un teclado QWERTY) y también por la letra que escribe (e.key), así funciona igual con distribuciones o
// teclados no convencionales.
import { keyboardBrake, keyboardSteer } from '../sim/car.js';

// los nombres de una tecla: su posición y, si escribe una letra, Key + la letra
export function keyNames(e) {
  const names = [e.code];
  if (e.key.length === 1 && /[a-z]/i.test(e.key)) names.push('Key' + e.key.toUpperCase());
  return names;
}

export class Keyboard {
  keys = new Set();
  held = new Map(); // e.code → nombres que agregó, para sacarlos al soltar
  steer = 0; // el volante, que va subiendo de a poco (keyboardSteer en car.js)
  brake = 0; // el freno, que se afloja un poco al doblar (keyboardBrake en car.js)

  // onDown(e, names): cada tecla apretada (también las que se repiten por tenerla apretada: e.repeat)
  constructor(target, onDown) {
    target.addEventListener('keydown', (e) => {
      const names = keyNames(e);
      this.held.set(e.code, names);
      for (const n of names) this.keys.add(n);
      onDown(e, names);
    });
    target.addEventListener('keyup', (e) => {
      for (const n of this.held.get(e.code) ?? keyNames(e)) this.keys.delete(n);
      this.held.delete(e.code);
    });
    target.addEventListener('blur', () => {
      this.keys.clear();
      this.held.clear();
    });
  }

  has(...names) {
    return names.some((n) => this.keys.has(n));
  }

  // Lo que piden las flechas, WASD o IJKL a speed m/s: { throttle, brake, steer }
  read(dt, speed) {
    const left = this.has('ArrowLeft', 'KeyA', 'KeyJ'),
      right = this.has('ArrowRight', 'KeyD', 'KeyL');
    const up = this.has('ArrowUp', 'KeyW', 'KeyI'),
      down = this.has('ArrowDown', 'KeyS', 'KeyK', 'Space');
    this.steer = keyboardSteer(this.steer, (right ? 1 : 0) - (left ? 1 : 0), speed, dt);
    this.brake = keyboardBrake(this.brake, down, this.steer, speed, dt);
    return { throttle: up ? 1 : 0, brake: this.brake, steer: this.steer };
  }
}
