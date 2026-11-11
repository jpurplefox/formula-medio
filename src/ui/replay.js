// Repetición de la carrera: se graba la posición de todos los autos 30 veces por segundo y después se reproduce
// (interpolando entre muestras) con distintas cámaras, como en una transmisión de TV.

import { lineFrame, pointAt } from '../sim/lineframe.js';
import { halfWidthAt, sampleField } from '../sim/track.js';

const REPLAY_STEP = 1 / 30;
const FIELDS = 10; // por auto y por muestra: x, y, angle, steer, speed, slope, dist (metros recorridos), rpm, throttle, gear

export class Recorder {
  constructor(count) {
    this.count = count;
    this.data = [];
    this.clock = 0;
  }

  // se llama en cada paso de la carrera; cars: [{ car, dist }]
  add(dt, cars) {
    this.clock += dt;
    while (this.clock >= REPLAY_STEP) {
      this.clock -= REPLAY_STEP;
      for (const { car: c, dist } of cars)
        this.data.push(c.x, c.y, c.angle, c.steer, c.speed, c.slope, dist, c.rpm, c.throttle, c.gear);
    }
  }

  get duration() {
    return (this.data.length / (FIELDS * this.count) - 1) * REPLAY_STEP;
  }

  // poses de todos los autos en el tiempo t (s desde la largada)
  at(t) {
    const frames = this.data.length / (FIELDS * this.count);
    const u = Math.min(frames - 1.001, Math.max(0, t / REPLAY_STEP));
    const i = Math.floor(u),
      f = u - i;
    const d = this.data;
    const poses = [];
    for (let k = 0; k < this.count; k++) {
      const a = (i * this.count + k) * FIELDS,
        b = a + this.count * FIELDS;
      const lerp = (j) => d[a + j] + (d[b + j] - d[a + j]) * f;
      // el ángulo, por el camino más corto
      let da = d[b + 2] - d[a + 2];
      da -= Math.round(da / (Math.PI * 2)) * Math.PI * 2;
      poses.push({
        x: lerp(0),
        y: lerp(1),
        angle: d[a + 2] + da * f,
        steer: lerp(3),
        speed: lerp(4),
        slope: lerp(5),
        dist: lerp(6),
        rpm: lerp(7),
        throttle: d[a + 8],
        gear: d[a + 9],
      });
    }
    return poses;
  }
}

// Cámaras de TV fijas al costado de la pista: una cada TV_SPACING metros, alternando de lado,
// detrás de los muros y en altura
const TV_SPACING = 230;
const TV_HEIGHT = 12;
const TV_BACK = 2; // metros por detrás del muro
export function tvCameras(track) {
  const f = lineFrame(track),
    M = track.meters;
  const out = [];
  const count = Math.max(4, Math.round((f.length * M) / TV_SPACING));
  for (let k = 0; k < count; k++) {
    const side = (k % 2 ? 1 : -1) * (halfWidthAt(track, (k * f.length) / count) + track.runoff + 0.5 + TV_BACK / M);
    const p = pointAt(f, (k * f.length) / count, side);
    if (p.x < 3 || p.y < 3 || p.x > track.W - 3 || p.y > track.H - 3) continue;
    out.push({ x: p.x, y: p.y });
  }
  return out;
}

export const CAMERA_NAMES = {
  auto: 'Automática',
  tv: 'TV',
  chase: 'Persecución',
  onboard: 'A bordo',
  heli: 'Helicóptero',
  front: 'Frontal',
};
export const CAMERA_MODES = Object.keys(CAMERA_NAMES);
// orden de las tomas del director automático y cuánto dura cada una (s)
const SHOTS = ['tv', 'chase', 'tv', 'heli', 'onboard', 'tv', 'front'];
const SHOT_TIME = 5;

// Elige la cámara y la arma para mirar al auto. state guarda qué cámara de TV se está usando (para no saltar
// de una a otra a cada rato) y la toma actual del director.
export function replayCamera(mode, pose, track, tvCams, state, t, P) {
  if (mode === 'auto') mode = SHOTS[Math.floor(t / SHOT_TIME) % SHOTS.length];
  const M = track.meters;
  const heightAt = (x, y) => sampleField(track.height, track.W, x, y);
  const carZ = heightAt(pose.x, pose.y);
  const ca = Math.cos(pose.angle),
    sa = Math.sin(pose.angle);
  const at = (fwd, up) => ({ x: pose.x + (ca * fwd) / M, y: pose.y + (sa * fwd) / M, up });
  let cam, look; // posición de la cámara y punto al que mira
  let zoom = 1;
  if (mode === 'tv' && tvCams.length) {
    // la cámara más cercana; cambia sólo si otra queda bastante más cerca
    const dist = (c) => Math.hypot(c.x - pose.x, c.y - pose.y);
    let best = state.tv ?? 0;
    tvCams.forEach((c, k) => {
      if (dist(c) < dist(tvCams[best]) * 0.7) best = k;
    });
    state.tv = best;
    const c = tvCams[best];
    cam = { x: c.x, y: c.y, up: TV_HEIGHT };
    look = at(0, 0.6);
    zoom = Math.max(1, Math.min(5, (dist(c) * M) / 22));
  } else if (mode === 'onboard') {
    cam = at(-0.28, 1.13); // arriba de la toma de aire, apenas delante de la T (si no, se ve su borde en el horizonte)
    look = at(30, 0);
  } else if (mode === 'heli') {
    cam = at(-35, 20);
    look = at(4, 0);
  } else if (mode === 'front') {
    cam = at(9, 1.1);
    look = at(0, 0.6);
  } else {
    mode = 'chase';
    cam = at(-8, 2.4);
    look = at(14, 0);
  }
  const ground = heightAt(cam.x, cam.y);
  const z = (mode === 'tv' ? ground : carZ) + cam.up / M;
  const dx = look.x - cam.x,
    dy = look.y - cam.y;
  const angle = Math.atan2(dy, dx);
  // inclinación: el horizonte se corre para que el punto mirado quede en el medio de la pantalla
  const d = Math.max(0.5, Math.hypot(dx, dy));
  const pitch = -((z - (carZ + look.up / M)) * P * zoom) / d;
  return { x: cam.x, y: cam.y, z, ground, angle, pitch, zoom, mode };
}
