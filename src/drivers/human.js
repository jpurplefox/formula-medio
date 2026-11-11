// The player as a driver: drives with what they ask for on the keyboard or gamepad (main.js reads it every frame and
// puts it in input). Like the network that sees the start lights, it handles its own start: on the grid the throttle
// raises the revs and, once the lights go out, it starts when it accelerates (race/race.js).
export class HumanDriver {
  seesLights = true;
  input = { throttle: 0, brake: 0, steer: 0 };

  drive() {
    return this.input;
  }

  grid() {
    return this.input;
  }
}
