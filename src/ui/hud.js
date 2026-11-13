// El tablero en pantalla: velocidad y marcha, las luces de cambio, vueltas y tiempos, la tabla de posiciones, los
// resultados, los daños y las gomas de tu auto, el semáforo de largada, el minimapa y los mensajes (flash). Lee el
// estado del juego (main.js) y de la carrera (race/race.js); no cambia nada.
import { TEMP_HIGH, TEMP_LOW } from '../sim/car.js';
import { damaged } from '../sim/damage.js';
import { T } from '../sim/track.js';

export const SHIFT_LIGHTS = 15;
const FLASH_TIME = 2.5; // s que queda un mensaje

// Daños de tu auto: aparece sólo si hay algo roto. El auto visto desde arriba (la trompa para arriba), cada pieza
// de su color según cuánto está rota, y abajo la lista.
const DAMAGE_PARTS = [
  // pieza, índice, rectángulo en m (x adelante de 2,8 a -2,8; y a la derecha de -1 a 1), nombre
  ['frontWing', 0, [2.25, 2.8, -0.95, 0], 'Alerón del. izq.'],
  ['frontWing', 1, [2.25, 2.8, 0, 0.95], 'Alerón del. der.'],
  ['suspension', 0, [1.3, 2.0, -1.0, -0.6], 'Susp. del. izq.'],
  ['suspension', 1, [1.3, 2.0, 0.6, 1.0], 'Susp. del. der.'],
  ['sidepod', 0, [-1.3, 1.0, -0.8, -0.3], 'Pontón izq.'],
  ['sidepod', 1, [-1.3, 1.0, 0.3, 0.8], 'Pontón der.'],
  ['suspension', 2, [-2.05, -1.35, -1.0, -0.6], 'Susp. tras. izq.'],
  ['suspension', 3, [-2.05, -1.35, 0.6, 1.0], 'Susp. tras. der.'],
  ['rearWing', 0, [-2.8, -2.3, -0.5, 0], 'Alerón tras. izq.'],
  ['rearWing', 1, [-2.8, -2.3, 0, 0.5], 'Alerón tras. der.'],
];

const WHEEL_NAMES = ['del. izq.', 'del. der.', 'tras. izq.', 'tras. der.'];

const damageColor = (x) => (x <= 0 ? '#3a4150' : x < 0.34 ? '#ffd400' : x < 0.67 ? '#ff8a00' : '#ff3b30');

// Las gomas del panel: el color de cada una es su temperatura (azul fría, verde en su punto, de amarilla a roja
// pasada), con los °C; la barrita, la goma que le queda; un borde blanco, que está bloqueada o patinando
const TYRE_COLD = 50,
  TYRE_HOT = 40; // °C por debajo y por encima de la ventana hasta el azul y el rojo plenos

export class Hud {
  damageClock = 0;

  tyresClock = 0;

  towerClock = 0;

  flashTimer = 0;

  minimapBase = null;

  // $: busca un elemento de la página por id; ctx: el canvas 2D de encima del juego (volante y semáforo); scale: la
  // escala de los dibujos 2D; ghostStep: cada cuánto se grabó el fantasma (s)
  constructor($, { ctx, scale, ghostStep }) {
    Object.assign(this, { ctx, scale, ghostStep });
    for (const id of [
      'speed',
      'gear',
      'rpm',
      'mode',
      'lights',
      'help',
      'damage',
      'tyres',
      'lap',
      'pos',
      'results',
      'replay',
      'tower',
      'stage',
      'time',
      'last',
      'best',
      'msg',
    ])
      this[id] = $(id);
    for (let i = 0; i < SHIFT_LIGHTS; i++) this.lights.appendChild(document.createElement('i'));
    this.minimap = $('minimap');
    this.mctx = this.minimap.getContext('2d');
  }

  // los mensajes se van solos
  tick(dt) {
    this.flashTimer -= dt;
  }

  drawDamage(g, time) {
    if (time - this.damageClock < 200) return;
    this.damageClock = time;
    const d = g.car.damage,
      show = damaged(d);
    this.damage.classList.toggle('show', show);
    if (!show) return;
    const X = (y) => 30 + y * 20,
      Y = (x) => 60 - x * 20;
    const rect = ([x0, x1, y0, y1], fill, extra = '') =>
      `<rect x="${X(y0)}" y="${Y(x1)}" width="${(y1 - y0) * 20}" height="${(x1 - x0) * 20}" rx="1.5" fill="${fill}"${extra}/>`;
    let svg = rect([1.0, 2.25, -0.25, 0.25], '#3a4150') + rect([-2.3, 1.0, -0.3, 0.3], '#3a4150'); // trompa y chasis
    const lines = [];
    for (const [part, i, box, name] of DAMAGE_PARTS) {
      const x = d[part][i];
      const flat = part === 'suspension' && d.tyre[i] > 0;
      // rota del todo: sólo el contorno, como si faltara; con la goma pinchada, un borde rojo cortado
      const outline = ' fill-opacity="0" stroke="#ff3b30" stroke-width="1.2" stroke-dasharray="2 1.5"';
      svg += rect(
        box,
        damageColor(x),
        x >= 1 ? outline : flat ? ' stroke="#ff3b30" stroke-width="1.5" stroke-dasharray="2 1.5"' : '',
      );
      if (x > 0)
        lines.push(
          `<span style="color:${damageColor(x)}">${name} ${x >= 1 ? '<b>roto</b>' : `${Math.round(x * 100)} %`}</span>`,
        );
    }
    d.tyre.forEach((t, i) => t > 0 && lines.push(`<span style="color:#ff2a2a">Pinchazo ${WHEEL_NAMES[i]}</span>`));
    if (d.retired) lines.push(`<b>Abandono: ${d.retired.toLowerCase()}</b>`);
    const html = `<svg viewBox="0 0 60 120" aria-label="Daños del auto">${svg}</svg><div>${lines.join('<br>')}</div>`;
    if (this.damage.innerHTML !== html) this.damage.innerHTML = html;
  }

  tyreColor(t) {
    const hue =
      t < TEMP_LOW
        ? 130 + 80 * Math.min(1, (TEMP_LOW - t) / TYRE_COLD)
        : t > TEMP_HIGH
          ? 130 * (1 - Math.min(1, (t - TEMP_HIGH) / TYRE_HOT))
          : 130;
    return `hsl(${hue.toFixed(0)} 75% 55%)`;
  }

  drawTyres(car, time) {
    if (time - this.tyresClock < 150) return;
    this.tyresClock = time;
    const cells = this.tyres.children;
    for (let i = 0; i < 4; i++) {
      const c = cells[i],
        t = car.tyreTemp[i],
        left = Math.round((1 - car.tyreWear[i]) * 100);
      const html = `${Math.round(t)}<u style="width:${left}%"></u>`;
      if (c.innerHTML !== html) c.innerHTML = html;
      c.style.background = this.tyreColor(t);
      c.classList.toggle('slide', car.locked[i >> 1] || (i > 1 && car.wheelspin));
    }
  }

  // distancia con el de adelante, como en la TV: segundos o vueltas
  gapText(g, ahead, behind) {
    const gap = g.race.gap(ahead, behind);
    if (!gap) return '';
    return gap.laps ? `+${gap.laps} V` : `+${gap.time.toFixed(1)}`;
  }

  drawTower(g, time) {
    if (time - this.towerClock < 200) return; // 5 veces por segundo alcanza, y se lee mejor
    this.towerClock = time;
    const order = g.race.order();
    const rows = order.map((e, i) => {
      const gap =
        e.out !== undefined
          ? 'AB'
          : i === 0
            ? g.race.finished.some((f) => f.entry === e)
              ? 'Final'
              : 'Líder'
            : this.gapText(g, order[i - 1], e);
      const me = e === g.player ? ' class="me"' : '';
      return `<tr${me}><td>${i + 1}</td><td><i style="background:${e.color}"></i>${e.code}<small>${e.number}</small></td><td>${gap}</td></tr>`;
    });
    const html = `<table>${rows.join('')}</table>`;
    if (this.tower.innerHTML !== html) this.tower.innerHTML = html;
  }

  // tabla de resultados: aparece cuando terminás
  drawResults(g) {
    const show = g.race.finished.some((f) => f.entry === g.player) || g.player.out !== undefined;
    this.results.classList.toggle('show', show);
    if (!show) return;
    const first = g.race.finished[0]?.time;
    const rows = g.race.order().map((e, i) => {
      const f = g.race.finished.find((x) => x.entry === e);
      const gap =
        e.out !== undefined
          ? 'Abandono'
          : !f
            ? 'en pista'
            : i === 0
              ? this.fmt(f.time)
              : `+${(f.time - first).toFixed(3)}`;
      const me = e === g.player ? ' class="me"' : '';
      return `<tr${me}><td>${i + 1}</td><td><i style="background:${e.color}"></i>${e.name}<small>${e.team}</small></td><td>${gap}</td></tr>`;
    });
    const html = `<h3>Resultado</h3><table>${rows.join('')}</table><p>R para correr de nuevo · Esc menú</p>`;
    if (this.results.innerHTML !== html) this.results.innerHTML = html;
  }

  flash(text) {
    this.msg.textContent = text;
    this.msg.classList.add('show');
    this.flashTimer = FLASH_TIME;
  }

  fmt(t) {
    if (t === null) return '--:--.---';
    const m = Math.floor(t / 60);
    const s = t - m * 60;
    return `${m}:${s.toFixed(3).padStart(6, '0')}`;
  }

  // Semáforo de largada, como el de la F1: cinco columnas con dos luces rojas cada una.
  // Se prenden de a una por segundo y, después de una espera al azar, se apagan todas: ahí se larga.
  drawLights(g) {
    const { lit } = g.race.lights();
    const w = 26,
      gap = 6,
      x0 = 240 - (5 * w + 4 * gap) / 2,
      y0 = 22;
    this.ctx.save();
    this.ctx.scale(this.scale, this.scale);
    this.ctx.fillStyle = 'rgba(10,10,12,0.9)';
    this.ctx.fillRect(x0 - 8, y0 - 6, 5 * w + 4 * gap + 16, 2 * w + 10);
    for (let i = 0; i < 5; i++) {
      const x = x0 + i * (w + gap);
      this.ctx.fillStyle = '#1b1b1f';
      this.ctx.fillRect(x, y0 - 2, w, 2 * w + 2);
      for (let row = 0; row < 2; row++) {
        this.ctx.beginPath();
        this.ctx.arc(x + w / 2, y0 + w / 2 + row * w, w * 0.36, 0, Math.PI * 2);
        this.ctx.fillStyle = i < lit ? '#ff1e1e' : '#3a0d0d';
        if (i < lit) {
          this.ctx.shadowColor = '#ff2a2a';
          this.ctx.shadowBlur = 10;
        }
        this.ctx.fill();
        this.ctx.shadowBlur = 0;
      }
    }
    this.ctx.restore();
  }

  drawMinimapBase(track) {
    const { W, H, tiles } = track;
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const g = c.getContext('2d');
    const img = g.createImageData(W, H);
    const d = new Uint32Array(img.data.buffer);
    for (let i = 0; i < W * H; i++) {
      const t = tiles[i];
      if (t === T.ROAD) d[i] = 0xf0ffffff;
      else if (t === T.WALL) d[i] = 0x50ffffff;
    }
    g.putImageData(img, 0, 0);
    this.minimap.width = 220;
    this.minimap.height = Math.round((220 * H) / W);
    this.minimapBase = c;
  }

  drawMinimap(g) {
    const { W } = g.track;
    const k = this.minimap.width / W;
    this.mctx.clearRect(0, 0, this.minimap.width, this.minimap.height);
    this.mctx.drawImage(this.minimapBase, 0, 0, this.minimap.width, this.minimap.height);
    if (g.trial && g.ghost && g.player.lap.started) {
      const i = Math.min(Math.floor(g.player.lap.time / this.ghostStep), g.ghost.length / 2 - 1) * 2;
      this.dot(g.ghost[i] * k, g.ghost[i + 1] * k, '#3aa0ff');
    }
    for (const e of g.entries) if (e !== g.player && !e.car.gone) this.dot(e.car.x * k, e.car.y * k, e.color, 3);
    this.dot(g.car.x * k, g.car.y * k, g.player.color);
  }

  // minimapa de la repetición: dots = [[x, y, color, destacado]]
  drawMinimapAt(track, dots) {
    const k = this.minimap.width / track.W;
    this.mctx.clearRect(0, 0, this.minimap.width, this.minimap.height);
    this.mctx.drawImage(this.minimapBase, 0, 0, this.minimap.width, this.minimap.height);
    for (const [x, y, color, big] of [...dots].sort((a, b) => a[3] - b[3])) this.dot(x * k, y * k, color, big ? 5 : 3);
  }

  dot(x, y, color, r = 4) {
    this.mctx.beginPath();
    this.mctx.arc(x, y, r, 0, Math.PI * 2);
    this.mctx.fillStyle = color;
    this.mctx.fill();
    this.mctx.strokeStyle = '#000';
    this.mctx.stroke();
  }
}
