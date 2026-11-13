// El jugador como piloto: maneja con lo que pide en el teclado o el joystick (main.js lo lee en cada cuadro y lo pone
// en input). Como la red que ve el semáforo, maneja su largada: en la grilla el acelerador sube las vueltas y, con
// las luces apagadas, larga cuando acelera (race/race.js).
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
