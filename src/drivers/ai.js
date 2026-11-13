// Rivals: each one is a car with the same physics as the player's, driven by an autopilot.
// The driver follows the racing line ("chasing" a point a bit further ahead on it) and accelerates or brakes
// to reach the speed the racing line sets at each point, multiplied by its pace.
// If it catches another car, it moves out to the side where there is room to pass; if there is none, it stays behind.

import { lineFrame, pointAt } from '../sim/lineframe.js';
import { halfWidthAt } from '../sim/track.js';

const LOOK_BASE = 6; // minimum distance to the point the steering chases (m)
const LOOK_TIME = 0.35; // plus the distance covered in this time (s)
const BRAKE_LOOK = 0.12; // looks at the target speed a bit further ahead, to brake in time (s)
const MARGIN = 1.3; // minimum distance to the track edge (m)
const PASS_GAP = 3.5; // lateral gap with which it passes another car (m)
const CAR_WIDTH = 2.8; // if two cars are closer than this sideways, one blocks the other (m)
const SEE_AHEAD = 30; // how far ahead it looks for cars (m)
const SHIFT_RATE = 3.5; // how fast it moves sideways to pass (m/s)
const ALONGSIDE = 6; // closer than this (along the track) two cars are side by side (m)
const YIELD_AHEAD = 2.5; // if the car alongside is further ahead than this, the one behind yields (m)
const FOLLOW_GAP = 8; // distance at which it stays behind a car it can't pass (m)
const FOLLOW_K = 0.8; // for each extra meter of distance, it may go this much faster than the car ahead (m/s)
const STUCK_TIME = 1.5; // if it is almost still for this long, it is put back on the track (s)
const SLOW_CORNER = 45; // corners where the racing line asks for less than this (m/s)...
const SLOW_PACE = 0.975; // ...are taken at most at this fraction of their speed
// accelerating and turning at once, the rear has to do both: on the exit of a slow corner, where the engine is
// stronger than the tyres, it doses the throttle by how much it is turning (at most down to EXIT_THROTTLE); in fast
// corners the engine can't make the rear spin and it goes flat out
const EXIT_THROTTLE = 0.35;
const THROTTLE_USE = 0.9; // and on a straight, up to this fraction of what the rear tyres can take
// and it corrects the steering by how much the car rotates more or less than it wants (countersteers if the rear
// steps out)
const YAW_FIX = 0.8;
const BRAKE_FULL = 2; // m/s
const CHORD_MAX = 1; // m: the most the corner-cutting correction can be
const BRAKE_USE = 0.93; // fraction of what the tyres can take that it uses for braking
const MAX_YAW = 1.6; // same as in car.js: maximum yaw rate at low speed (rad/s)

// Puts a stuck car back on the track, on the racing line and a bit further ahead (u: position in cells)
export function rescue(track, line, car, u) {
  const spot = pointAt(lineFrame(track), u + 4 / track.meters, line.offset[u | 0]);
  Object.assign(car, { x: spot.x, y: spot.y, angle: spot.angle, speed: 0, steer: 0, slip: 0, omega: 0 });
}

export class Driver {
  // pace: fraction of the racing line speed at which it drives (0..1); seed varies its small errors
  constructor(pace, seed) {
    this.pace = pace;
    this.phase = seed * 2.39;
    this.shift = 0; // how far it moved off the racing line to pass someone (m)
    this.stuck = 0;
    this.time = 0;
    this.curv = 0; // curvature it has been following (1/m, smoothed; + to the right)
  }

  // Decides the pedals and the steering. me/others: { car, st, lat } with st and lat in cells.
  drive(dt, track, line, me, others) {
    const { car } = me;
    const f = lineFrame(track),
      M = track.meters;
    const L = line.offset.length;
    const v = Math.max(0, car.speed);
    this.time += dt;

    // small imperfections: a bit more or less pace and line depending on the moment
    const pace = this.pace * (1 + 0.015 * Math.sin(this.time * 0.37 + this.phase));
    const wobble = 0.25 * Math.sin(this.time * 0.5 + this.phase * 1.7);

    // traffic: between which lateral positions it can drive without touching anyone (lo, hi, in m)
    // and which speed it must not exceed so it doesn't run into the car ahead (cap)
    const u = me.st;
    const half = halfWidthAt(track, u) * M - MARGIN;
    const racing = line.offset[u | 0] * M + wobble; // where the racing line runs here (m sideways)
    const myLat = me.lat * M;
    const lapM = f.length * M;
    let lo = -half,
      hi = half,
      cap = Infinity;
    let aheadAlongside = Infinity; // speed of the car alongside that is slightly ahead
    for (const o of others) {
      let ds = (o.st - u) * M;
      if (ds < -lapM / 2) ds += lapM;
      if (ds > lapM / 2) ds -= lapM;
      if (ds < -ALONGSIDE || ds > SEE_AHEAD) continue;
      const ol = o.lat * M,
        ov = Math.max(0, o.car.speed);
      if (ds < ALONGSIDE) {
        // side by side: each one stays on its side until one passes the other
        if (myLat >= ol) lo = Math.max(lo, ol + PASS_GAP);
        else hi = Math.min(hi, ol - PASS_GAP);
        if (ds > 0) aheadAlongside = Math.min(aheadAlongside, ov);
        // if the other is more than half a nose ahead and it isn't passing it (it isn't faster), it doesn't fight
        // for the place: it lifts and tucks in behind
        if (ds > YIELD_AHEAD && v < ov + 1) cap = Math.min(cap, Math.max(0, ov - 2));
        continue;
      }
      // ahead and in the way: if it catches it, it moves out to pass (on the side it is already on, if there is room)
      if (Math.abs(ol - (racing + this.shift)) > CAR_WIDTH + 0.6) continue;
      if (ov < v + 3) {
        let side = Math.abs(myLat - ol) > 0.8 ? Math.sign(myLat - ol) : half - ol > ol + half ? 1 : -1;
        if ((side > 0 && ol + PASS_GAP > half) || (side < 0 && ol - PASS_GAP < -half)) side = -side;
        if (side > 0 && ol + PASS_GAP <= half) lo = Math.max(lo, ol + PASS_GAP);
        else if (side < 0 && ol - PASS_GAP >= -half) hi = Math.min(hi, ol - PASS_GAP);
      }
      // while it is right ahead, it keeps its distance: the closer, the more similar its speed
      if (Math.abs(ol - myLat) < CAR_WIDTH) cap = Math.min(cap, Math.max(0, ov + FOLLOW_K * (ds - FOLLOW_GAP)));
    }
    // if there is no room to go side by side (lo > hi), the one slightly behind lifts and tucks in behind
    let goal = Math.max(lo, Math.min(hi, racing));
    if (lo > hi) {
      goal = Math.max(-half, Math.min(half, (lo + hi) / 2));
      if (aheadAlongside < Infinity) cap = Math.min(cap, Math.max(0, aheadAlongside - 2));
    }
    const step = SHIFT_RATE * dt;
    this.shift += Math.max(-step, Math.min(step, goal - racing - this.shift));

    // steering: chases a point further ahead on its racing line (pure pursuit)
    const look = (LOOK_BASE + v * LOOK_TIME) / M;
    const ua = (u + look) % L;
    // (aiming at a point further ahead cuts the corner on the inside by as much as the chord departs from the arc:
    // look²·curvature/8; the point is moved out by that same amount, to keep the inside wheels off the grass)
    const chord = Math.max(-CHORD_MAX, Math.min(CHORD_MAX, ((look * M) ** 2 * this.curv) / 8));
    const sideAhead = Math.max(-half, Math.min(half, line.offset[ua | 0] * M + wobble + this.shift - chord)) / M;
    const target = pointAt(f, ua, sideAhead);
    const dx = target.x - car.x,
      dy = target.y - car.y;
    const ca = Math.cos(car.angle),
      sa = Math.sin(car.angle);
    const fwd = dx * ca + dy * sa,
      right = -dx * sa + dy * ca;
    const dist = Math.hypot(dx, dy) * M || 1;
    const curv = (2 * Math.sin(Math.atan2(right, fwd))) / dist; // curvature to reach the point (1/m)
    this.curv += (curv - this.curv) * Math.min(1, dt * 5);
    const grip = car.limits.lateral(v);
    const yawMax = Math.min(MAX_YAW, grip / Math.max(v, 1)) * Math.min(1, v / 4) || 0.01;
    const wantYaw = v * curv;
    const steer = Math.max(-1, Math.min(1, (wantYaw + YAW_FIX * (wantYaw - car.omega)) / yawMax));

    // pedals: the racing line speed a bit further ahead, times its pace
    const ub = (u + (v * BRAKE_LOOK) / M) % L;
    // in slow corners it can't go above SLOW_PACE: any faster it runs wide and goes off
    const lineV = line.speed[ub | 0];
    const wantV = Math.min(lineV * (lineV < SLOW_CORNER ? Math.min(pace, SLOW_PACE) : pace), cap);
    let throttle = v < wantV - 0.3;
    // progressive braking: full if it is BRAKE_FULL m/s too fast (stamping on and off upsets the car)
    // (and without going past the pedal that locks the wheels: at lower speed there is less downforce and less pedal)
    let brake = Math.max(0, Math.min(1, (v - wantV - 0.3) / BRAKE_FULL)) * BRAKE_USE * car.pedalLimit;
    // pulling away, flat out even if the racing line is slow
    if (v < 3 && wantV > 3) {
      throttle = true;
      brake = 0;
    }

    // if it got stuck (against a wall or a car), it goes back to the track on the racing line
    this.stuck = v < 1.5 ? this.stuck + dt : 0;
    if (this.stuck > STUCK_TIME) {
      rescue(track, line, car, u);
      this.stuck = 0;
      this.shift = 0;
    }
    // (need: how many times more the engine pushes at full throttle than the rear tyres can take at that moment: in
    // low gears, several; on the grass, even more)
    const lim = car.limits,
      need =
        (lim.engine(v) + lim.coast(v) - lim.drag(v) - lim.rolling) / Math.max(car.traction || lim.traction(v), 1e-3);
    const room = Math.sqrt(1 - Math.min(1, Math.abs(steer)) ** 2); // what the rear tyres have left to push
    const dose = Math.min(1, (THROTTLE_USE * Math.max(EXIT_THROTTLE, room)) / need);
    return { throttle: throttle ? dose : 0, brake, steer };
  }
}
