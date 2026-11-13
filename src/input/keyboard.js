// The keyboard: which keys are pressed and what they ask for to drive. Each key is recognized by its position
// (e.code, as on a QWERTY keyboard) and also by the letter it types (e.key), so it works the same with other layouts
// or unusual keyboards.
import { keyboardBrake, keyboardSteer } from '../sim/car.js';

// the names of a key: its position and, if it types a letter, Key + the letter
export function keyNames(e) {
  const names = [e.code];
  if (e.key.length === 1 && /[a-z]/i.test(e.key)) names.push('Key' + e.key.toUpperCase());
  return names;
}

export class Keyboard {
  keys = new Set();
  held = new Map(); // e.code → names it added, to remove them on release
  steer = 0; // the steering, which ramps up gradually (keyboardSteer in car.js)
  brake = 0; // the brake, which eases off a bit while turning (keyboardBrake in car.js)

  // onDown(e, names): every key pressed (including repeats from holding it down: e.repeat)
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

  // What the arrows, WASD or IJKL ask for at speed m/s: { throttle, brake, steer }
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
