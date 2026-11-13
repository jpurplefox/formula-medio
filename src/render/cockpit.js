// Cockpit view: the car (nose, wheels, halo, mirrors, steering wheel) is the same 3D model seen from outside,
// drawn by the renderer from the driver's eyes. Here we draw the steering wheel display (gear, speed and shift
// lights) on a small canvas that the renderer places over the 3D steering wheel (m.screen).

const W = 256,
  H = 144;

export class Cockpit {
  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = W;
    this.canvas.height = H;
    this.ctx = this.canvas.getContext('2d');
  }

  // draws the display for this car and returns it
  screen(car) {
    const g = this.ctx;
    g.fillStyle = '#05070a';
    g.fillRect(0, 0, W, H);
    // shift lights: green, red and blue as the rpm rise
    const lit = Math.round(((car.rpm - 9000) / (car.profile.maxRpm * 0.97 - 9000)) * 15);
    for (let i = 0; i < 15; i++) {
      g.fillStyle = i < lit ? (i < 5 ? '#2bd14a' : i < 10 ? '#ff2a2a' : '#3a8bff') : '#1c1f26';
      g.fillRect(12 + i * 15.5, 8, 11, 12);
    }
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    // the gear, large, and the speed beside it
    g.fillStyle = '#ffd400';
    g.font = 'bold 84px ui-monospace, Menlo, monospace';
    g.fillText(car.gear === 0 ? 'R' : String(car.gear), 82, 86);
    g.fillStyle = '#e8eaee';
    g.font = 'bold 40px ui-monospace, Menlo, monospace';
    g.fillText(String(Math.round(Math.abs(car.speed) * 3.6)), 190, 74);
    g.fillStyle = '#8b93a1';
    g.font = '22px ui-monospace, Menlo, monospace';
    g.fillText(car.manual ? 'MAN' : 'AUTO', 190, 112);
    return this.canvas;
  }
}
