// Sonido de los motores, sintetizado con Web Audio (sin archivos de sonido).
// Cada auto tiene su "voz". Un V6 de 4 tiempos hace 3 explosiones por vuelta del cigüeñal, así que el tono de
// las explosiones es rpm / 20 Hz (200 Hz en ralentí, 600 Hz a 12.000 rpm). La voz se arma con:
// - el tono de las explosiones, con muchos armónicos (una onda a medida, con más cuerpo en los armónicos bajos);
// - el giro del cigüeñal (un tercio del tono) y medio tono, que aparecen porque ninguna explosión es igual a otra;
// - aspereza: ruido que "late" al ritmo de las explosiones (el escape);
// - irregularidad: el tono tiembla apenas, como en un motor de verdad;
// - el turbo: un soplido agudo que crece con las rpm;
// todo saturado apenas, con dos resonancias del escape y un filtro que se abre con las rpm y el acelerador.
// Encima, sonidos sueltos: el cambio de marcha (un corte de una fracción de segundo con un golpe seco al subir,
// y un acelerón con explosiones al bajar), las explosiones al soltar el acelerador a muchas vueltas, y el
// tartamudeo del corte de rpm.
// Los autos se escuchan desde la cámara: más bajo cuanto más lejos, a la izquierda o a la derecha según dónde
// estén, más apagados si están detrás, y con efecto Doppler (más agudo cuando se acercan, más grave cuando se alejan).

import { MenuMusic } from './music.js';

const SOUND_SPEED = 343; // m/s
const NEAR = 20; // a esta distancia (m) un auto suena a la mitad de volumen
const MAX_VOICES = 8; // motores que suenan a la vez: los más cercanos (los lejanos casi no se oyen y cada voz cuesta)
const MASTER = 0.5;
const LIMITER_RPM = 11700; // a partir de acá, a fondo, se escucha el corte
const POP_RPM = 8000; // al soltar el acelerador por encima de esto, el escape petardea
const POP_TIME = 0.35; // durante cuánto (s)
const THROTTLE_TIME = 0.15; // lo que tarda el sonido en pasar de acelerando a retención (s)
const BLIP_GAP = 0.2; // entre dos rebajes seguidos (frenando) no se repite el acelerón (s)

function softClip(amount) {
  const n = 1024,
    curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(amount * x) / Math.tanh(amount);
  }
  return curve;
}

function noiseBuffer(ctx, seconds) {
  const b = ctx.createBuffer(1, Math.round(ctx.sampleRate * seconds), ctx.sampleRate);
  const d = b.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return b;
}

// Onda del tono de las explosiones: armónicos que bajan de a poco, con más cuerpo alrededor del 3º-5º
function engineWave(ctx) {
  const n = 40,
    real = new Float32Array(n),
    imag = new Float32Array(n);
  for (let k = 1; k < n; k++) imag[k] = (1 / k ** 0.85) * (1 + 0.7 * Math.exp(-((k - 4) ** 2) / 5));
  return ctx.createPeriodicWave(real, imag);
}

// Recursos compartidos por todas las voces
class Kit {
  constructor(ctx) {
    this.ctx = ctx;
    this.noise = noiseBuffer(ctx, 2);
    this.burst = noiseBuffer(ctx, 0.25);
    this.wave = engineWave(ctx);
    this.drive = softClip(2.2);
  }
}

class Voice {
  constructor(kit, out) {
    const ctx = kit.ctx;
    this.ctx = ctx;
    this.kit = kit;
    const node = (make, setup) => {
      const n = make.call(ctx);
      setup?.(n);
      return n;
    };
    const gain = (v) =>
      node(ctx.createGain, (g) => {
        g.gain.value = v;
      });

    // cadena: mezcla → saturación → resonancias del escape → filtro → volumen (distancia) → envolvente (cortes) → paneo
    this.mix = gain(1);
    const shaper = node(ctx.createWaveShaper, (s) => {
      s.curve = kit.drive;
      s.oversample = '2x';
    });
    const body1 = node(ctx.createBiquadFilter, (f) => {
      f.type = 'peaking';
      f.frequency.value = 450;
      f.Q.value = 1.2;
      f.gain.value = 6;
    });
    const body2 = node(ctx.createBiquadFilter, (f) => {
      f.type = 'peaking';
      f.frequency.value = 1600;
      f.Q.value = 1.5;
      f.gain.value = 4;
    });
    this.filter = node(ctx.createBiquadFilter, (f) => {
      f.type = 'lowpass';
      f.Q.value = 1.4;
    });
    this.level = gain(0);
    this.env = gain(1);
    this.pan = ctx.createStereoPanner();
    this.mix
      .connect(shaper)
      .connect(body1)
      .connect(body2)
      .connect(this.filter)
      .connect(this.level)
      .connect(this.env)
      .connect(this.pan)
      .connect(out);

    // irregularidad: ruido muy lento que mueve el tono unos pocos cents
    const wobble = node(ctx.createBufferSource, (s) => {
      s.buffer = kit.noise;
      s.loop = true;
    });
    const slow = node(ctx.createBiquadFilter, (f) => {
      f.type = 'lowpass';
      f.frequency.value = 12;
    });
    const depth = gain(25);
    wobble.connect(slow).connect(depth);
    wobble.start(0, Math.random() * 2);

    // osciladores: [oscilador, múltiplo del tono de las explosiones]
    const osc = (setup, mult, level) => {
      const o = ctx.createOscillator();
      setup(o);
      depth.connect(o.detune);
      o.connect(gain(level)).connect(this.mix);
      o.start();
      return [o, mult];
    };
    this.oscs = [
      osc((o) => o.setPeriodicWave(kit.wave), 1, 0.32),
      osc(
        (o) => {
          o.type = 'sine';
        },
        1 / 3,
        0.3,
      ), // el cigüeñal
      osc(
        (o) => {
          o.type = 'triangle';
        },
        0.5,
        0.12,
      ), // medio tono
    ];

    // aspereza: ruido por un pasabanda que sigue al tono, que late con una cuadrada al ritmo de las explosiones
    const rasp = node(ctx.createBufferSource, (s) => {
      s.buffer = kit.noise;
      s.loop = true;
    });
    this.raspBand = node(ctx.createBiquadFilter, (f) => {
      f.type = 'bandpass';
      f.Q.value = 0.9;
    });
    this.raspGain = gain(0);
    const pulse = ctx.createOscillator();
    pulse.type = 'square';
    this.pulse = pulse;
    // el volumen del ruido va de 0 al doble de su valor, al ritmo de las explosiones
    this.pulseDepth = gain(0);
    pulse.connect(this.pulseDepth).connect(this.raspGain.gain);
    rasp.connect(this.raspBand).connect(this.raspGain).connect(this.mix);
    rasp.start(0, Math.random() * 2);
    pulse.start();

    // turbo: soplido agudo, después del filtro (no se apaga con él)
    const turbo = node(ctx.createBufferSource, (s) => {
      s.buffer = kit.noise;
      s.loop = true;
    });
    this.turboBand = node(ctx.createBiquadFilter, (f) => {
      f.type = 'bandpass';
      f.Q.value = 8;
    });
    this.turboGain = gain(0);
    turbo.connect(this.turboBand).connect(this.turboGain).connect(this.level);
    turbo.start(0, Math.random() * 2);

    this.gear = null;
    this.throttle = 0;
    this.smooth = 0; // el acelerador, suavizado: el sonido no cambia de golpe al soltar o al pisar
    this.lastTime = 0;
    this.nextPop = 0;
    this.lastBlip = 0;
  }

  // f: tono (Hz), level: volumen, bright: apertura del filtro (Hz), pan: -1 izquierda … 1 derecha,
  // thr: acelerador (0..1), rpm
  set(f, level, bright, pan, thr, rpm) {
    const t = this.ctx.currentTime,
      k = 0.03; // los cambios se suavizan en ~30 ms
    for (const [o, mult] of this.oscs) o.frequency.setTargetAtTime(f * mult, t, k);
    this.pulse.frequency.setTargetAtTime(f, t, k);
    this.raspBand.frequency.setTargetAtTime(f * 3, t, k);
    const rasp = 0.06 + thr * 0.12;
    this.raspGain.gain.setTargetAtTime(rasp, t, k);
    this.pulseDepth.gain.setTargetAtTime(rasp, t, k);
    this.filter.frequency.setTargetAtTime(bright, t, k);
    this.level.gain.setTargetAtTime(level, t, k);
    this.pan.pan.setTargetAtTime(pan, t, k);
    this.turboBand.frequency.setTargetAtTime(3000 + f * 5, t, k);
    this.turboGain.gain.setTargetAtTime(thr * Math.min(1, Math.max(0, (rpm - 6000) / 5000)) * 0.05, t, k);
  }

  // un golpe de ruido corto: tipo de filtro y frecuencia, volumen, duración (s) y cuándo (s desde ahora)
  burst(type, freq, vol, dur, delay = 0) {
    const ctx = this.ctx,
      t = ctx.currentTime + delay;
    const src = ctx.createBufferSource();
    src.buffer = this.kit.burst;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = 1.5;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(this.level);
    src.start(t, Math.random() * 0.15, dur + 0.02);
  }

  // explosión del escape: un golpe grave más un chasquido
  pop(vol, delay = 0) {
    this.burst('bandpass', 500 + Math.random() * 500, vol, 0.05, delay);
    this.burst('highpass', 2500, vol * 0.4, 0.02, delay);
  }

  // eventos: cambio de marcha, explosiones al soltar el acelerador y corte de rpm
  // (audible: si el auto está tan lejos que no se oye, sólo se anota el estado)
  events(gear, thr, rpm, audible) {
    const t = this.ctx.currentTime;
    if (!audible) {
      this.gear = gear;
      this.throttle = thr;
      return;
    }
    const env = this.env.gain;
    if (this.gear !== null && gear !== this.gear && gear > 0 && this.gear > 0) {
      env.cancelScheduledValues(t);
      env.setValueAtTime(env.value, t);
      if (gear > this.gear) {
        // subida: el encendido se corta una fracción de segundo y entra la marcha con un golpe seco
        env.linearRampToValueAtTime(0.15, t + 0.012);
        env.linearRampToValueAtTime(1, t + 0.09);
        this.burst('lowpass', 180, 0.5, 0.06);
        this.burst('highpass', 3000, 0.15, 0.02);
      } else if (t - this.lastBlip > BLIP_GAP) {
        // bajada: un acelerón corto para igualar vueltas y, a veces, una explosión suave
        env.linearRampToValueAtTime(1.12, t + 0.04);
        env.linearRampToValueAtTime(1, t + 0.14);
        if (Math.random() < 0.35) this.pop(0.08 + Math.random() * 0.06, 0.04);
        this.lastBlip = t;
      }
    }
    this.gear = gear;
    // al soltar a muchas vueltas, petardeo durante un ratito
    if (this.throttle && !thr && rpm > POP_RPM) this.popUntil = t + POP_TIME;
    if (!thr && t < (this.popUntil || 0) && t > this.nextPop) {
      this.pop(0.06 + Math.random() * 0.08);
      this.nextPop = t + 0.08 + Math.random() * 0.15;
    }
    // corte de rpm: el encendido se corta y vuelve muy rápido
    if (thr && rpm > LIMITER_RPM && t > this.nextPop) {
      env.cancelScheduledValues(t);
      env.setValueAtTime(1, t);
      env.linearRampToValueAtTime(0.35, t + 0.015);
      env.linearRampToValueAtTime(1, t + 0.04);
      this.nextPop = t + 0.055;
    }
    this.throttle = thr;
  }

  mute() {
    this.level.gain.setTargetAtTime(0, this.ctx.currentTime, 0.03);
    this.gear = null;
  }
}

// Todo el sonido del juego: los motores y la música del menú, cada uno con su volumen, y un volumen general.
// El ruido de las ruedas sobre el costado de la pista, para el auto propio:
// - el piano: "brrrr", ruido grave que late al ritmo con el que las ruedas pasan los escalones (velocidad / largo
//   del escalón), más un zumbido a ese mismo ritmo; cuanto más rápido, más agudo y más fuerte;
// - la franja verde: un siseo áspero, como lija;
// - la salchicha: un golpe seco al subirse.
class Rumble {
  constructor(kit, out) {
    const ctx = (this.ctx = kit.ctx);
    this.kit = kit;
    this.out = out;
    const noise = ctx.createBufferSource();
    noise.buffer = kit.noise;
    noise.loop = true;
    // piano: ruido filtrado grave, con el volumen latiendo (amplitud entre 0,15 y 1)
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = 160;
    band.Q.value = 0.9;
    this.beat = ctx.createGain();
    this.beat.gain.value = 0.58;
    this.lfo = ctx.createOscillator();
    this.lfo.type = 'square';
    this.lfo.frequency.value = 20;
    const depth = ctx.createGain();
    depth.gain.value = 0.42;
    this.lfo.connect(depth).connect(this.beat.gain);
    // y el zumbido de los escalones
    this.tone = ctx.createOscillator();
    this.tone.type = 'sawtooth';
    this.tone.frequency.value = 20;
    const toneLow = ctx.createBiquadFilter();
    toneLow.type = 'lowpass';
    toneLow.frequency.value = 300;
    const toneGain = ctx.createGain();
    toneGain.gain.value = 0.5;
    this.kerbLevel = ctx.createGain();
    this.kerbLevel.gain.value = 0;
    noise.connect(band).connect(this.beat).connect(this.kerbLevel);
    this.tone.connect(toneLow).connect(toneGain).connect(this.beat);
    this.kerbLevel.connect(out);
    this.band = band;
    // verde: ruido más agudo, parejo
    const hiss = ctx.createBiquadFilter();
    hiss.type = 'bandpass';
    hiss.frequency.value = 1400;
    hiss.Q.value = 0.6;
    this.greenLevel = ctx.createGain();
    this.greenLevel.gain.value = 0;
    noise.connect(hiss).connect(this.greenLevel).connect(out);
    noise.start();
    this.lfo.start();
    this.tone.start();
    this.lastJolt = 0;
  }

  set({ kerb = 0, green = 0, speed = 0, ridge = 1.6, jolt = 0 }) {
    const t = this.ctx.currentTime,
      v = Math.abs(speed);
    const rate = Math.max(4, Math.min(80, v / ridge)); // escalones por segundo
    this.lfo.frequency.setTargetAtTime(rate, t, 0.03);
    this.tone.frequency.setTargetAtTime(rate * 2, t, 0.03);
    this.band.frequency.setTargetAtTime(120 + v * 4, t, 0.05);
    const fast = Math.min(1, v / 30);
    this.kerbLevel.gain.setTargetAtTime(kerb * fast * 0.5, t, 0.03);
    this.greenLevel.gain.setTargetAtTime(green * fast * 0.12, t, 0.05);
    // golpe de la salchicha: cuando el salto empieza (jolt sube de golpe)
    if (jolt > this.lastJolt + 0.2) this.thump(jolt);
    this.lastJolt = jolt;
  }

  thump(k) {
    const ctx = this.ctx,
      t = ctx.currentTime;
    const o = ctx.createOscillator(),
      g = ctx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(110, t);
    o.frequency.exponentialRampToValueAtTime(40, t + 0.25);
    g.gain.setValueAtTime(0.9 * k, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
    o.connect(g).connect(this.out);
    o.start(t);
    o.stop(t + 0.32);
    const n = ctx.createBufferSource(),
      ng = ctx.createGain();
    n.buffer = this.kit.burst;
    ng.gain.setValueAtTime(0.5 * k, t);
    ng.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
    n.connect(ng).connect(this.out);
    n.start(t);
  }
}

export class EngineAudio {
  constructor() {
    this.ctx = null;
    this.voices = [];
    this.volumes = { master: 1, engines: 1, music: 1 };
    this.wantMusic = false;
  }

  // volúmenes de 0 a 1
  setVolumes(volumes) {
    Object.assign(this.volumes, volumes);
    if (!this.ctx) return;
    const t = this.ctx.currentTime,
      { master, engines, music } = this.volumes;
    this.master.gain.setTargetAtTime(MASTER * master, t, 0.03);
    this.engines.gain.setTargetAtTime(engines, t, 0.03);
    this.musicBus.gain.setTargetAtTime(music, t, 0.03);
  }

  // música del menú: prender o apagar (se apaga de a poco)
  playMusic(on) {
    this.wantMusic = on;
    if (!this.ctx) return;
    if (on) this.music.start();
    else this.music.stop();
  }

  // el navegador sólo deja arrancar el audio después de una tecla o un click
  start() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      const comp = this.ctx.createDynamicsCompressor();
      comp.threshold.value = -14;
      comp.ratio.value = 4;
      this.master.connect(comp).connect(this.ctx.destination);
      this.engines = this.ctx.createGain();
      this.engines.connect(this.master);
      this.musicBus = this.ctx.createGain();
      this.musicBus.connect(this.master);
      this.music = new MenuMusic(this.ctx, this.musicBus);
      this.kit = new Kit(this.ctx);
      this.rumble = new Rumble(this.kit, this.engines);
      this.setVolumes({});
      if (this.wantMusic) this.music.start();
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }

  // apaga todas las voces de los motores (menú, silencio)
  silence() {
    for (const v of this.voices) v.mute();
    this.rumble?.set({});
  }

  // lo que pisan las ruedas del auto propio: { kerb, green (fracción de ruedas, 0..1), speed (m/s), ridge (m entre
  // escalones del piano), jolt (salto de la salchicha, 0..1) }
  surface(info) {
    if (this.ctx) this.rumble.set(info);
  }

  // silencio total: motores y música
  stopAll() {
    this.silence();
    this.playMusic(false);
  }

  // cars: [{ rpm, throttle (0..1), gear, x, y (m), angle, speed (m/s) }]
  // ear: dónde escucha la cámara { x, y (m), angle, vx, vy (m/s) }; inside: índice del auto en el que va la cámara
  // (cabina), que suena "adentro": fuerte, al centro y sin Doppler
  update(cars, ear, inside = -1) {
    if (!this.ctx) return;
    const rx = -Math.sin(ear.angle),
      ry = Math.cos(ear.angle); // derecha de la cámara
    const fx = Math.cos(ear.angle),
      fy = Math.sin(ear.angle);
    // cada voz sigue a un auto mientras esté entre los más cercanos; si sale, la toma otro (empieza de cero)
    const near = cars
      .map((c, i) => [i === inside ? -1 : Math.hypot(c.x - ear.x, c.y - ear.y), i])
      .sort((a, b) => a[0] - b[0])
      .slice(0, MAX_VOICES)
      .map(([, i]) => i);
    while (this.voices.length < near.length) this.voices.push(new Voice(this.kit, this.engines));
    const taken = new Set(this.voices.map((v) => v.car));
    const free = near.filter((i) => !taken.has(i));
    for (const v of this.voices) {
      if (v.car !== undefined && near.includes(v.car)) continue;
      v.car = free.shift();
      v.gear = null;
      v.throttle = 0;
    }
    this.voices.forEach((v) => {
      const i = v.car,
        c = cars[i];
      if (!c) {
        v.mute();
        return;
      }
      const thr = Math.min(1, +c.throttle || 0); // con joystick, a medias
      // el acelerador suavizado: el timbre y el volumen pasan de a poco entre acelerando y retención
      const now = this.ctx.currentTime;
      v.smooth += (thr - v.smooth) * Math.min(1, (now - v.lastTime) / THROTTLE_TIME);
      v.lastTime = now;
      const s = v.smooth;
      let f = Math.max(150, c.rpm / 20);
      let bright = 1100 + (c.rpm / 12000) * 3500 + s * 2500;
      let level = (0.62 + 0.38 * s) * 0.22;
      let pan = 0;
      if (i !== inside) {
        const dx = c.x - ear.x,
          dy = c.y - ear.y;
        const d = Math.hypot(dx, dy) || 1;
        level /= 1 + (d / NEAR) ** 2;
        pan = Math.max(-0.9, Math.min(0.9, (dx * rx + dy * ry) / d));
        // detrás de la cámara se escucha más apagado; lejos, también (el aire se come los agudos)
        if ((dx * fx + dy * fy) / d < 0) bright *= 0.6;
        bright /= 1 + d / 150;
        // Doppler: velocidad con la que se aleja (positiva) o se acerca (negativa)
        const vx = Math.cos(c.angle) * c.speed - ear.vx,
          vy = Math.sin(c.angle) * c.speed - ear.vy;
        const away = (vx * dx + vy * dy) / d;
        f *= SOUND_SPEED / (SOUND_SPEED + Math.max(-150, Math.min(150, away)));
      } else {
        level *= 1.6;
      }
      if (level < 0.0005) level = 0;
      v.set(f, level, bright, pan, s, c.rpm);
      v.events(c.gear ?? 1, thr, c.rpm, level > 0.002);
    });
  }
}
