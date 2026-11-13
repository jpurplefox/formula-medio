// El joystick, con la Gamepad API y el mapeo estándar (los de Xbox y PlayStation): el gatillo derecho acelera y el
// izquierdo frena, la palanca izquierda dobla, y los tres son progresivos. Los botones hacen lo mismo que una tecla:
// RB/R1 sube de marcha (X), LB/L1 baja (Z), Y/△ cambia la cámara (C), X/□ la trazada (G), Back/Share reinicia (R),
// la cruceta elige el auto en la repetición y Start es 'Start' (quien lo usa decide: abrir el menú o largar).
const STICK_DEAD = 0.08; // zona muerta de la palanca: cerca del centro no dobla
const STEER_CURVE = 1.5; // la palanca dobla menos al principio, para corregir fino a alta velocidad
const TRIGGER_DEAD = 0.04;
const PAD_KEYS = {
  4: 'KeyZ',
  5: 'KeyX',
  3: 'KeyC',
  2: 'KeyG',
  8: 'KeyR',
  9: 'Start',
  14: 'ArrowLeft',
  15: 'ArrowRight',
};

// El navegador recién muestra un joystick cuando se aprieta un botón con la página abierta. Si hay varios, usa el
// primero con mapeo estándar. Los que no lo tienen (algunos genéricos, o según el navegador) suelen traer los
// gatillos como ejes que en reposo valen -1: el primero frena y el segundo acelera.
export class Gamepad {
  throttle = 0;
  brake = 0;
  steer = 0;
  id = null;
  pressed = [];
  rest = new Map(); // id → valores de los ejes la primera vez que se lo vio (en reposo)

  // onButton(names): un botón recién apretado, con el nombre de la tecla que hace lo mismo;
  // onChange(id): se conectó o desconectó (id null) un joystick
  constructor({ onButton, onChange }) {
    Object.assign(this, { onButton, onChange });
  }

  // se llama en cada cuadro: lee los gatillos, la palanca y los botones
  poll() {
    const pads = [...(navigator.getGamepads?.() ?? [])].filter(Boolean);
    const gp = pads.find((g) => g.mapping === 'standard') ?? pads[0];
    if ((gp?.id ?? null) !== this.id) {
      this.id = gp?.id ?? null;
      this.onChange(this.id);
    }
    if (!gp) {
      Object.assign(this, { throttle: 0, brake: 0, steer: 0 });
      return;
    }
    if (!this.rest.has(gp.id)) this.rest.set(gp.id, [...gp.axes]);
    const value = (i) => gp.buttons[i]?.value ?? 0;
    const dead = (x) => Math.max(0, (x - TRIGGER_DEAD) / (1 - TRIGGER_DEAD));
    let brake = value(6),
      throttle = value(7);
    if (gp.mapping !== 'standard') {
      const triggers = this.rest
        .get(gp.id)
        .map((a, i) => (i >= 2 && a < -0.5 ? i : -1))
        .filter((i) => i >= 0);
      if (triggers.length >= 2) {
        brake = Math.max(brake, (gp.axes[triggers[0]] + 1) / 2);
        throttle = Math.max(throttle, (gp.axes[triggers[1]] + 1) / 2);
      }
    }
    const x = gp.axes[0] ?? 0,
      mag = Math.max(0, (Math.abs(x) - STICK_DEAD) / (1 - STICK_DEAD));
    this.throttle = dead(throttle);
    this.brake = dead(brake);
    this.steer = Math.sign(x) * Math.min(1, mag) ** STEER_CURVE;
    gp.buttons.forEach((b, i) => {
      if (b.pressed && !this.pressed[i] && PAD_KEYS[i]) this.onButton([PAD_KEYS[i]]);
      this.pressed[i] = b.pressed;
    });
  }
}
