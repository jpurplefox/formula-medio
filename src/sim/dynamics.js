// What the car can do given the setup and the track's air: how much each axle grips, how hard it brakes, how hard
// the engine pushes and how much the air slows it, at each speed. It is a small physical model (that of a lap
// simulator): aerodynamic downforce and drag grow with air density and with v², the tyre grips according to the load
// on it (a little less per kilo each time) and the engine gives a power, so it pushes less the faster the car goes.
// The car's numbers (cars/*.json) were fitted to real laps (tools/calibrate.js).
//
// Setup (tune), as the team chooses it for each track:
//   front, rear  front and rear wing, from 1 (nearly flat, Monza) to 10 (all the downforce, Monaco). The rear gives
//                more downforce but also much more drag; the front, front downforce with almost no drag.
//                The weight of each decides the balance in fast corners.
//   brake        brake bias, from -5 (more rearward) to 5 (more forward); 0 is the factory setting (see brakeBias)
//   balance      mechanical balance (anti-roll bars, springs), from -5 (more rear grip) to 5 (more front grip):
//                decides the balance in slow corners, where downforce barely matters. It is the roll stiffness
//                distribution: in a corner the weight moves to the outside wheels, and the stiffer axle takes more
//                of that transfer; since the tyre grips less and less per kilo, the axle that transfers most is the
//                one that grips least. Balance forward = soft front bar (transfers to the rear).
// With little front grip the car doesn't turn as much as the steering asks (understeer); with little rear grip, the
// rear steps out (oversteer); balanced is fastest.

import { damagedAero, NO_DAMAGE, powerLoss } from './damage.js';

export const GRAVITY = 9.8;
export const SEA_AIR = 1.225; // kg/m³: air density at sea level (15 °C)
const AIR_SCALE = 8500; // m: every this many meters higher, the air is e times less dense
const TURBO = 0.2; // the turbo makes up for almost all the missing air: with 20 % less air, 4 % less power

export const CG_HEIGHT = 0.25; // m: height of the center of gravity
export const TRACK_WIDTH = 1.6; // m: track width (wheel to wheel on the same axle)
export const WHEELBASE = 3.35; // m, between the axles (as in carmodel.js)
// Weight transfer when braking or accelerating: fraction of the total load that moves from one axle to the other
// with an acceleration a (m/s², + forward) and that load (m/s²: the weight plus downforce, per kilo). Positive:
// forward (braking)
const MAX_SHIFT = 0.3;
export const weightShift = (a, load) =>
  Math.max(-MAX_SHIFT, Math.min(MAX_SHIFT, (-a * CG_HEIGHT) / (WHEELBASE * load)));
// the brakes split the braking between the axles in proportion to the load each one has at that moment, shifted
// this much forward: that way the fronts lock first (the car goes straight) and not the rears (a spin)
// (fwd: BRAKE_BIAS_FWD plus what the setup says, BRAKE_BIAS_STEP per point: further forward the car brakes more
// stably but locks the fronts earlier and brakes less; further rearward it brakes harder and rotates on entry, until
// the rears lock)
export const BRAKE_BIAS_FWD = 0.08,
  BRAKE_BIAS_STEP = 0.012,
  BRAKE_TUNE_MAX = 5;
export const brakeBias = (capF, capR, fwd = BRAKE_BIAS_FWD) =>
  Math.min(0.85, Math.max(0.15, capF / (capF + capR) + fwd));
// what counts as braking and accelerating "flat out" for the racing line: this fraction of the most the tyres can take
const BRAKE_NOMINAL = 0.93;
const TRACTION_NOMINAL = 0.92;
const CLEAN_AIR = Object.freeze([1, 1]); // downforce on each axle relative to that in clean air
export const DEFAULT_TUNE = Object.freeze({ front: 5, rear: 5, balance: 0, brake: 0 });
export const WING_MIN = 1,
  WING_MAX = 10,
  BALANCE_MAX = 5;

// air density (kg/m³) at an altitude above sea level (m)
export const airDensity = (altitude = 0) => SEA_AIR * Math.exp(-altitude / AIR_SCALE);

// The tyre sideways: what fraction of its grip it gives depending on how much it slides. x is the slip angle (the
// angle between where the tyre points and where it goes) over the peak slip angle. Up to the peak the force grows
// (almost linearly at first); past the peak, it falls gradually to slide (the tyre dragging sideways grips less than
// at the peak). That is why asking for more steering than possible doesn't turn more: the car runs wide (understeer)
// or the rear lets go (oversteer).
export function tyreCurve(x, slide = 0.75) {
  const a = Math.abs(x),
    peak = (2 * a) / (1 + a * a);
  return Math.sign(x) * (a <= 1 ? peak : slide + (1 - slide) * peak);
}

const wing = (x) => (Math.max(WING_MIN, Math.min(WING_MAX, x)) - WING_MIN) / (WING_MAX - WING_MIN); // 0..1

// The car's limits with that setup, that air, that variation (setup: multipliers from car.js), that damage
// (damage.js) and that fuel on board (kg). Speeds in m/s and accelerations in m/s² (per kilo of car, except axles
// and straight: per kilo on that axle).
// The functions that depend on downforce accept k = [front, rear]: the downforce on each axle relative to that in
// clean air (car.js lowers it behind another car, sideways or depending on pitch).
export function carLimits(car, tune = DEFAULT_TUNE, air = SEA_AIR, setup = {}, damage = NO_DAMAGE, fuel = 0) {
  const { frontShare, mu, loadExp, brakeMu, tractionMu, power, engineBrake, rolling, aero } = car;
  const mass = car.mass + fuel;
  const wf = wing(tune.front),
    wr = wing(tune.rear);
  // coefficients times area (m²): downforce and drag = ½·ρ·C·v². With both wings at minimum the car has clMin of
  // downforce (from the floor and the body) and with both at maximum, clMax; frontWing is the part of that difference
  // that the front wing provides. The body splits its downforce so that with even wings the car is neutral (the
  // downforce is split between the axles like the weight). Each wing costs in drag its downforce over its efficiency
  // (ld): the front one is much more efficient than the rear.
  const span = aero.clMax - aero.clMin,
    wingF = span * aero.frontWing,
    wingR = span - wingF;
  const bodyF = (frontShare * (aero.clMin + span / 2) - wingF / 2) / aero.clMin;
  const cdWingR = (wingR * wr) / aero.ldRear;
  // with damage, each axle carries different downforce on each side: [left, right] (half the axle each)
  const hurt = damagedAero(damage, {
    bodyF: aero.clMin * bodyF,
    bodyR: aero.clMin * (1 - bodyF),
    wingF: wingF * wf,
    wingR: wingR * wr,
    cd: aero.cdBody,
    cdWingF: (wingF * wf) / aero.ldFront,
    cdWingR,
  });
  const cd = hurt.cd / (setup.topSpeed ?? 1) ** 2;
  // mechanical balance: what part of the lateral weight transfer the front axle takes (neutral: like the weight)
  const b = (Math.max(-BALANCE_MAX, Math.min(BALANCE_MAX, tune.balance ?? 0)) / BALANCE_MAX) * (car.rollRange ?? 0.3);
  const rollF = frontShare - b;
  const grip = mu * (setup.grip ?? 1) * GRAVITY;
  const q = (v) => 0.5 * air * v * v; // dynamic pressure
  const W = mass * GRAVITY;
  const P = power * (1 - TURBO * (1 - air / SEA_AIR)) * (setup.power ?? 1) * powerLoss(damage);
  // load on each wheel relative to the car at rest, per axle and side
  const sideLoad = (cl, share, v) => 1 + (cl * q(v)) / ((W * share) / 2);
  // grip of an axle (relative to mu·g): each wheel grips according to its load; `out` is the outside of the corner
  // and shift, the load that moves from the inside wheel to the outside one (relative to that of one wheel with the
  // car at rest; the inside one doesn't drop below zero: it lifts)
  const axle = (cl, k, share, v, out, shift) => {
    const lo = sideLoad(cl[out] * k, share, v),
      li = sideLoad(cl[1 - out] * k, share, v),
      d = Math.min(shift, li);
    return ((lo + d) ** loadExp + (li - d) ** loadExp) / 2;
  };
  // both axles cornering at the limit toward one side: the lateral transfer depends on how hard the car turns, and
  // how hard it turns, on the remaining grip (solved in three iterations)
  const turning = (v, out, k) => {
    let f = 0,
      r = 0,
      ay = 0;
    for (let i = 0; i < 3; i++) {
      const t = (2 * ay * CG_HEIGHT) / (GRAVITY * TRACK_WIDTH);
      f = grip * axle(hurt.front, k[0], frontShare, v, out, (t * rollF) / frontShare);
      r = grip * axle(hurt.rear, k[1], 1 - frontShare, v, out, (t * (1 - rollF)) / (1 - frontShare));
      ay = Math.min(f, r);
    }
    return [f, r];
  };
  const longBrake = brakeMu * (setup.brakes ?? 1);
  const brakeFwd =
    BRAKE_BIAS_FWD + BRAKE_BIAS_STEP * Math.max(-BRAKE_TUNE_MAX, Math.min(BRAKE_TUNE_MAX, tune.brake ?? 0));
  const even = damage === NO_DAMAGE; // undamaged: it doesn't matter which way it turns
  const clF = hurt.front[0] + hurt.front[1],
    clR = hurt.rear[0] + hurt.rear[1];

  const lim = {
    frontShare,
    air,
    mass, // kg, with the fuel
    loadExp,
    // how much more the tyres grip for braking and driving than sideways
    longBrake,
    brakeFwd, // how much further forward than the load the brake bias goes
    longDrive: tractionMu,
    rolling, // m/s²: rolling resistance
    // load on each axle relative to the car at rest (1 = just the weight)
    loads(v, k = CLEAN_AIR) {
      return [1 + (clF * k[0] * q(v)) / (W * frontShare), 1 + (clR * k[1] * q(v)) / (W * (1 - frontShare))];
    },
    // total load in g (the weight plus downforce)
    load(v, k = CLEAN_AIR) {
      return 1 + ((clF * k[0] + clR * k[1]) * q(v)) / W;
    },
    // lateral grip of each axle cornering at the limit, per kilo resting on that axle (m/s²). turn: which way it
    // turns (1 right, -1 left, 0: either; with damage on one side, the worse of the two)
    axles(v, turn = 0, k = CLEAN_AIR) {
      if (turn || even) return turning(v, turn > 0 ? 0 : 1, k);
      const a = turning(v, 0, k),
        c = turning(v, 1, k);
      return [Math.min(a[0], c[0]), Math.min(a[1], c[1])];
    },
    // the same in a straight line (no lateral transfer): what the tyres have for braking or driving
    straight(v, k = CLEAN_AIR) {
      return [
        grip * axle(hurt.front, k[0], frontShare, v, 0, 0),
        grip * axle(hurt.rear, k[1], 1 - frontShare, v, 0, 0),
      ];
    },
    // the most the car can corner in steady state (both axles have to hold their share)
    lateral(v, k = CLEAN_AIR) {
      const [f, r] = lim.axles(v, 0, k);
      return Math.min(f, r);
    },
    // air drag (m/s²)
    drag(v) {
      return (cd * q(v)) / mass;
    },
    // off the pedals: air, rolling resistance and engine braking (with energy recovery)
    coast(v) {
      return lim.drag(v) + rolling + (v > 5 ? engineBrake : 0);
    },
    // the most the tyres brake in a straight line (m/s², without the air): under braking the weight moves forward,
    // and the limit is set by the axle that locks first with the brake bias (brakeBias)
    brakePeak(v, k = CLEAN_AIR) {
      const [f, r] = lim.straight(v, k),
        load = GRAVITY * lim.load(v, k),
        FS = frontShare;
      let a = longBrake * (f * FS + r * (1 - FS));
      for (let i = 0; i < 4; i++) {
        const s = weightShift(-a, load);
        const cF = longBrake * f * FS * ((FS + s) / FS) ** loadExp,
          cR = longBrake * r * (1 - FS) * ((1 - FS - s) / (1 - FS)) ** loadExp;
        const bias = brakeBias(cF, cR, brakeFwd);
        a = Math.min(cF / bias, cR / (1 - bias));
      }
      return a;
    },
    // braking at the limit, with a little margin (m/s², without the air): what the racing line uses
    brake(v, k = CLEAN_AIR) {
      return BRAKE_NOMINAL * lim.brakePeak(v, k);
    },
    // the most the rear wheels can push (m/s² for the whole car): when accelerating the weight moves rearward
    tractionPeak(v, k = CLEAN_AIR) {
      const r = lim.straight(v, k)[1],
        load = GRAVITY * lim.load(v, k),
        FS = frontShare;
      let a = tractionMu * r * (1 - FS);
      for (let i = 0; i < 4; i++)
        a = tractionMu * r * (1 - FS) * ((1 - FS - weightShift(a, load)) / (1 - FS)) ** loadExp;
      return a;
    },
    // what they push accelerating carefully (what the racing line uses)
    traction(v, k = CLEAN_AIR) {
      return TRACTION_NOMINAL * lim.tractionPeak(v, k);
    },
    // what the engine pushes flat out in the right gear (m/s²), regardless of whether the tyres can take it
    engine(v) {
      return P / (mass * Math.max(v, 1));
    },
    // full thrust (m/s²), up to what traction allows
    thrust(v) {
      return Math.min(lim.engine(v), lim.traction(v));
    },
    // net acceleration flat out (m/s²)
    accel(v) {
      return lim.thrust(v) - lim.drag(v) - rolling;
    },
  };
  // top speed: where the engine no longer beats the air
  let lo = 30,
    hi = 140;
  for (let i = 0; i < 40; i++) {
    const v = (lo + hi) / 2;
    if (lim.accel(v) > 0) lo = v;
    else hi = v;
  }
  lim.topSpeed = lo;
  // what the brakes do with the pedal fully pressed (m/s²): what the tyres can take at top speed, with all the
  // downforce. At lower speed there is less downforce and that same force locks them: the pedal has to be eased off
  lim.brakeMax = lim.brakePeak(lo);
  return lim;
}
