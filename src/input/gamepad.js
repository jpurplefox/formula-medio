// The gamepad, with the Gamepad API and the standard mapping (Xbox and PlayStation ones): the right trigger
// accelerates and the left one brakes, the left stick steers, and all three are progressive. The buttons do the same
// as a key: RB/R1 shifts up (X), LB/L1 shifts down (Z), Y/△ changes the camera (C), X/□ the racing line (G),
// Back/Share restarts (R), the d-pad picks the car in the replay and Start is 'Start' (the caller decides: open the
// menu or start).
const STICK_DEAD = 0.08; // stick dead zone: near the center it doesn't steer
const STEER_CURVE = 1.5; // the stick steers less at first, for fine corrections at high speed
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

// The browser only exposes a gamepad once a button is pressed with the page open. If there are several, it uses the
// first one with the standard mapping. Those without it (some generic ones, or depending on the browser) usually
// report the triggers as axes that rest at -1: the first brakes and the second accelerates.
export class Gamepad {
  throttle = 0;
  brake = 0;
  steer = 0;
  id = null;
  pressed = [];
  rest = new Map(); // id → axis values the first time it was seen (at rest)

  // onButton(names): a button just pressed, with the name of the key that does the same;
  // onChange(id): a gamepad was connected or disconnected (id null)
  constructor({ onButton, onChange }) {
    Object.assign(this, { onButton, onChange });
  }

  // called every frame: reads the triggers, the stick and the buttons
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
