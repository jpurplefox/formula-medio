// Vista desde la cabina: el auto (trompa, ruedas, halo, espejos, volante) es el mismo modelo 3D que se ve desde
// afuera, dibujado por el renderer desde los ojos del piloto. Acá se dibuja la pantalla del volante (la marcha, la
// velocidad y las luces de cambio) en un canvas chico que el renderer pone sobre el volante 3D (m.screen).

const W = 256,
  H = 144;

export class Cockpit {
  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = W;
    this.canvas.height = H;
    this.ctx = this.canvas.getContext('2d');
  }

  // dibuja la pantalla para este auto y la devuelve
  screen(car) {
    const g = this.ctx;
    g.fillStyle = '#05070a';
    g.fillRect(0, 0, W, H);
    // luces de cambio: verdes, rojas y azules a medida que suben las rpm
    const lit = Math.round(((car.rpm - 9000) / (car.profile.maxRpm * 0.97 - 9000)) * 15);
    for (let i = 0; i < 15; i++) {
      g.fillStyle = i < lit ? (i < 5 ? '#2bd14a' : i < 10 ? '#ff2a2a' : '#3a8bff') : '#1c1f26';
      g.fillRect(12 + i * 15.5, 8, 11, 12);
    }
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    // la marcha, grande, y la velocidad al costado
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
