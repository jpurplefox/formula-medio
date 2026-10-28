// Vista desde la cabina: el auto (trompa, ruedas, halo, espejos) es el mismo modelo 3D que se ve desde afuera,
// dibujado por el renderer desde los ojos del piloto. Acá sólo se dibuja encima el volante, girado según
// la dirección, con la marcha y las luces de cambio. Los tamaños están pensados para 480 píxeles de ancho.

export class Cockpit {
  constructor(w, h) {
    this.w = w;
    this.h = h;
    this.scale = w / 480;
  }

  draw(ctx, car, shakeY) {
    const { w, h, scale } = this;
    ctx.imageSmoothingEnabled = true;
    ctx.save();
    ctx.scale(scale, scale);
    this.drawWheel(ctx, car, w / 2 / scale, h / scale + 8 + shakeY / scale);
    ctx.restore();
  }

  // volante: gira con la dirección; en la pantalla, la marcha y las luces de cambio
  drawWheel(ctx, car, cx, cy) {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(car.steer * 0.6);
    ctx.scale(0.85, 0.85);
    // empuñaduras
    ctx.fillStyle = '#141414';
    ctx.beginPath();
    ctx.roundRect(-112, -92, 46, 96, 16);
    ctx.roundRect(66, -92, 46, 96, 16);
    ctx.fill();
    // cuerpo
    ctx.fillStyle = '#2b2d33';
    ctx.beginPath();
    ctx.roundRect(-84, -86, 168, 74, 12);
    ctx.fill();
    // botones de colores
    const buttons = ['#e23b3b', '#2c9be0', '#f2c230', '#41c46a'];
    buttons.forEach((b, k) => {
      ctx.fillStyle = b;
      ctx.beginPath();
      ctx.arc(-70 + (k % 2) * 140, -40 + Math.floor(k / 2) * 16, 4, 0, Math.PI * 2);
      ctx.fill();
    });
    // luces de cambio
    const p = car.profile;
    const lit = Math.round(((car.rpm - 9000) / (p.maxRpm * 0.97 - 9000)) * 15);
    for (let i = 0; i < 15; i++) {
      ctx.fillStyle = i < lit ? (i < 5 ? '#2bd14a' : i < 10 ? '#ff2a2a' : '#3a8bff') : '#3a3d45';
      ctx.fillRect(-52 + i * 7, -82, 5, 4);
    }
    // pantalla
    ctx.fillStyle = '#05070a';
    ctx.fillRect(-36, -72, 72, 36);
    ctx.fillStyle = '#ffd400';
    ctx.font = 'bold 22px ui-monospace, Menlo, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(car.gear === 0 ? 'R' : String(car.gear), -14, -53);
    ctx.fillStyle = '#e8eaee';
    ctx.font = 'bold 10px ui-monospace, Menlo, monospace';
    ctx.fillText(String(Math.round(Math.abs(car.speed) * 3.6)), 18, -58);
    ctx.fillStyle = '#8b93a1';
    ctx.font = '7px ui-monospace, Menlo, monospace';
    ctx.fillText(car.manual ? 'MAN' : 'AUTO', 18, -46);
    ctx.restore();
  }
}

