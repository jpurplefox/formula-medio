// Menu music: "Gran Premio", an original cinematic-style theme, synthesized with Web Audio.
// D minor, 140 bpm, a 16-bar loop:
// - bars 1–4, introduction: strings in a "galloping" ostinato over D, timpani and a pad that grows;
// - bars 5–12, theme: the melody in the brass, with taikos and a cymbal on entry;
// - bars 13–16, ending: brass hits, a growing snare roll and a rising cymbal to start over.
// Everything goes through a hall reverb (an impulse response made of decaying noise).
// Notes are scheduled slightly before they sound, with the audio clock, checking every 25 ms.

const BPM = 140;
const STEP = 60 / BPM / 4; // a sixteenth note (s)
const BAR = 16; // sixteenth notes per bar
const LOOKAHEAD = 0.12;
const LEVEL = 0.7; // output volume: the theme peaks at ~1.3, this leaves headroom

const midi = (m) => 440 * 2 ** ((m - 69) / 12);

// chords (root in the low octave and chord notes), bar by bar
const DM = { root: 38, tones: [62, 65, 69] };
const BB = { root: 34, tones: [62, 65, 70] };
const F = { root: 41, tones: [60, 65, 69] };
const C = { root: 36, tones: [60, 64, 67] };
const GM = { root: 43, tones: [62, 67, 70] };
const A = { root: 45, tones: [61, 64, 69] };
const SONG = [
  DM,
  DM,
  BB,
  C, // introduction
  DM,
  BB,
  F,
  C,
  DM,
  BB,
  GM,
  A, // theme
  GM,
  BB,
  C,
  A, // ending
];
const INTRO = 4,
  THEME = 12;

// brass melody in the theme, per bar: [note, sixteenth it starts on, duration in sixteenths]
const MELODY = [
  [
    [69, 0, 6],
    [67, 6, 2],
    [69, 8, 4],
    [74, 12, 4],
  ],
  [
    [72, 0, 8],
    [70, 8, 4],
    [69, 12, 4],
  ],
  [
    [69, 0, 6],
    [65, 6, 2],
    [67, 8, 4],
    [69, 12, 4],
  ],
  [
    [72, 0, 12],
    [67, 12, 4],
  ],
  [
    [69, 0, 6],
    [67, 6, 2],
    [69, 8, 4],
    [74, 12, 4],
  ],
  [
    [77, 0, 8],
    [74, 8, 4],
    [72, 12, 4],
  ],
  [
    [74, 0, 6],
    [72, 6, 2],
    [70, 8, 4],
    [69, 12, 4],
  ],
  [[73, 0, 16]],
];
// gallop rhythm: an eighth and two sixteenths (1 = plays); and which arpeggio note each sixteenth plays
const GALLOP = [1, 0, 1, 1, 1, 0, 1, 1, 1, 0, 1, 1, 1, 0, 1, 1];
const GALLOP_NOTE = [0, 0, 0, 0, 1, 1, 0, 0, 2, 2, 0, 0, 1, 1, 0, 0];
// brass hits in the ending (sixteenths of the bar)
const STABS = [0, 6, 12];

export class MenuMusic {
  constructor(ctx, out) {
    this.ctx = ctx;
    this.out = ctx.createGain();
    this.out.gain.value = 0;
    this.out.connect(out);
    // reverb: a hall of about 2.5 s
    this.reverb = ctx.createConvolver();
    this.reverb.buffer = this.hall(2.5);
    const wet = ctx.createGain();
    wet.gain.value = 0.45;
    this.reverb.connect(wet).connect(this.out);
    this.noise = ctx.createBuffer(1, ctx.sampleRate * 4, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    this.timer = null;
  }

  // impulse response of a hall: stereo noise that decays gradually
  hall(seconds) {
    const rate = this.ctx.sampleRate,
      n = Math.round(rate * seconds);
    const b = this.ctx.createBuffer(2, n, rate);
    for (let c = 0; c < 2; c++) {
      const d = b.getChannelData(c);
      for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n) ** 3;
    }
    return b;
  }

  start() {
    const t = this.ctx.currentTime;
    this.out.gain.cancelScheduledValues(t);
    this.out.gain.setValueAtTime(this.out.gain.value, t);
    this.out.gain.linearRampToValueAtTime(LEVEL, t + 0.8);
    if (this.timer) return;
    this.step = 0;
    this.next = t + 0.1;
    this.timer = setInterval(() => this.schedule(), 25);
  }

  stop() {
    if (!this.timer) return;
    const t = this.ctx.currentTime;
    this.out.gain.cancelScheduledValues(t);
    this.out.gain.setValueAtTime(this.out.gain.value, t);
    this.out.gain.linearRampToValueAtTime(0, t + 0.8);
    clearInterval(this.timer);
    this.timer = null;
  }

  schedule() {
    while (this.next < this.ctx.currentTime + LOOKAHEAD) {
      this.play(this.step, this.next);
      this.next += STEP;
      this.step = (this.step + 1) % (SONG.length * BAR);
    }
  }

  // everything that sounds in one sixteenth note
  play(step, t) {
    const bar = Math.floor(step / BAR),
      s = step % BAR;
    const chord = SONG[bar];
    const intro = bar < INTRO,
      theme = bar >= INTRO && bar < THEME,
      finale = bar >= THEME;

    // strings: the gallop, over the root (and in the ending, an octave higher)
    if (GALLOP[s]) {
      const tones = [chord.root + 24, chord.root + 31, chord.root + 36];
      const accent = s % 4 === 0 ? 1 : 0.7;
      this.strings(midi(tones[GALLOP_NOTE[s]] + (finale ? 12 : 0)), t, accent * (intro ? 0.05 + 0.012 * bar : 0.08));
    }
    if (s === 0) {
      // long bass and choir pad throughout the bar
      this.bass(midi(chord.root), t, STEP * BAR);
      if (!intro || bar >= 2) this.choir(chord.tones.map(midi), t, STEP * BAR, intro ? 0.02 : 0.035);
      // timpani on the first beat
      this.timpani(midi(chord.root + 12), t, intro ? 0.45 : 0.6);
      // cymbal when the theme and the ending come in
      if (bar === INTRO || bar === THEME) this.crash(t);
    }
    if (intro && bar === INTRO - 1 && s === 8) this.swell(t, STEP * 8); // rising cymbal toward the theme
    if (theme) {
      if (s === 0 || s === 8) this.taiko(t, s === 0 ? 0.55 : 0.4);
      for (const [note, start, len] of MELODY[bar - INTRO]) {
        if (start === s) this.brass(midi(note), t, STEP * len, 0.11);
      }
      if (s === 12 && bar % 2 === 1) this.taiko(t, 0.3);
    }
    if (finale) {
      if (STABS.includes(s)) this.brassChord(chord.tones.map(midi), t, STEP * 2.5);
      // snare roll that grows through the ending
      const k = (bar - THEME + s / BAR) / (SONG.length - THEME);
      if (s % 2 === 0 || bar === SONG.length - 1) this.snare(t, 0.04 + k * 0.2);
      if (bar === SONG.length - 1 && s === 0) this.swell(t, STEP * BAR);
    }
  }

  // gain with envelope: rises over `attack`, holds in `hold` until `length` and fades in `release`
  envelope(t, peak, attack, length, release, hold = 0.8) {
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(peak, t + attack);
    g.gain.linearRampToValueAtTime(peak * hold, t + Math.max(attack, length));
    g.gain.exponentialRampToValueAtTime(0.0001, t + Math.max(attack, length) + release);
    return g;
  }

  // sawtooth oscillators slightly detuned from each other, through a filter, to the output and to the reverb
  saws(freqs, detunes, t, dur, gain, filter, reverb = 1) {
    for (const f of freqs) {
      for (const detune of detunes) {
        const o = this.ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = f;
        o.detune.value = detune;
        o.connect(filter);
        o.start(t);
        o.stop(t + dur);
      }
    }
    filter.connect(gain).connect(this.out);
    if (reverb) gain.connect(this.reverb);
  }

  lowpass(t, from, to, time) {
    const f = this.ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.Q.value = 0.7;
    f.frequency.setValueAtTime(from, t);
    if (to !== from) f.frequency.exponentialRampToValueAtTime(to, t + time);
    return f;
  }

  strings(f, t, peak) {
    this.saws(
      [f],
      [-6, 6],
      t,
      STEP * 1.2,
      this.envelope(t, peak, 0.006, STEP * 0.5, STEP * 0.6, 0.5),
      this.lowpass(t, 2400, 2400),
    );
  }

  bass(f, t, dur) {
    this.saws(
      [f, f * 2],
      [-4, 4],
      t,
      dur + 0.3,
      this.envelope(t, 0.07, 0.05, dur - 0.05, 0.25),
      this.lowpass(t, 420, 420),
      0,
    );
  }

  // brass: three saws and the octave below, with a filter that opens on the note attack
  brass(f, t, dur, peak) {
    this.saws(
      [f, f / 2],
      [-9, 0, 9],
      t,
      dur + 0.3,
      this.envelope(t, peak, 0.05, dur - 0.04, 0.22, 0.85),
      this.lowpass(t, 500, 2600, 0.18),
    );
  }

  brassChord(freqs, t, dur) {
    this.saws(
      freqs.map((f) => f / 2),
      [-8, 8],
      t,
      dur + 0.3,
      this.envelope(t, 0.07, 0.015, dur * 0.4, 0.25, 0.6),
      this.lowpass(t, 900, 3200, 0.06),
    );
  }

  // choir: sines and triangles with a slow vibrato
  choir(freqs, t, dur, peak) {
    const g = this.envelope(t, peak, dur * 0.35, dur - 0.2, 0.5, 1);
    const lfo = this.ctx.createOscillator();
    lfo.frequency.value = 5;
    const depth = this.ctx.createGain();
    depth.gain.value = 6;
    lfo.connect(depth);
    lfo.start(t);
    lfo.stop(t + dur + 0.6);
    for (const f of freqs) {
      for (const type of ['sine', 'triangle']) {
        const o = this.ctx.createOscillator();
        o.type = type;
        o.frequency.value = f;
        depth.connect(o.detune);
        o.connect(g);
        o.start(t);
        o.stop(t + dur + 0.6);
      }
    }
    g.connect(this.out);
    g.connect(this.reverb);
  }

  // hit with a falling pitch (timpani, taiko)
  drum(t, from, to, peak, decay) {
    const o = this.ctx.createOscillator();
    o.frequency.setValueAtTime(from, t);
    o.frequency.exponentialRampToValueAtTime(to, t + decay * 0.5);
    const g = this.envelope(t, peak, 0.004, 0.01, decay, 1);
    o.connect(g).connect(this.out);
    g.connect(this.reverb);
    o.start(t);
    o.stop(t + decay + 0.1);
  }

  noiseHit(t, type, freq, peak, attack, decay) {
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    const g = this.envelope(t, peak, attack, attack, decay, 1);
    src.connect(f).connect(g).connect(this.out);
    g.connect(this.reverb);
    src.start(t, Math.random(), attack + decay + 0.1);
  }

  timpani(f, t, peak) {
    this.drum(t, f * 1.05, f, peak, 0.9);
    this.noiseHit(t, 'lowpass', 300, peak * 0.3, 0.003, 0.15);
  }

  taiko(t, peak) {
    this.drum(t, 110, 48, peak, 0.45);
    this.noiseHit(t, 'bandpass', 600, peak * 0.25, 0.002, 0.08);
  }

  snare(t, peak) {
    this.noiseHit(t, 'bandpass', 2200, peak, 0.002, 0.1);
  }

  crash(t) {
    this.noiseHit(t, 'highpass', 5000, 0.12, 0.005, 1.8);
  }

  // reverse cymbal: grows until the end of `dur`
  swell(t, dur) {
    this.noiseHit(t, 'highpass', 4500, 0.1, dur, 0.15);
  }
}
