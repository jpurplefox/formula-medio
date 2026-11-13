// Car physics, in real units: speed is in m/s and accelerations in m/s².
// Position is in map cells; track.meters says how many meters one cell is.
// What the car can do (grip of each axle, braking, engine thrust, air drag) comes from dynamics.js, with the
// numbers from cars/*.json, the setup (wings and balance) and the track's air.
// This file holds what happens at each instant: pedals, gears, weight transfer, the rear stepping out, hits, grass
// and damage (damage.js: what breaks in the crashes from collision.js).

import { edgeInfo, sampleField, stationAt } from './track.js';
import { RubberMap } from './rubber.js';
import { collideWalls } from './collision.js';
import {
  brakeBias,
  carLimits,
  CG_HEIGHT,
  DEFAULT_TUNE,
  GRAVITY,
  SEA_AIR,
  TRACK_WIDTH,
  tyreCurve,
  weightShift,
  WHEELBASE,
} from './dynamics.js';
import { applyHit, deflate, NO_DAMAGE, steerPull, wheelDrag as damageDrag, wheelGrip as damageGrip } from './damage.js';

// Default car, in case none is loaded (such as cars/f1-2025.json)
export const DEFAULT_PROFILE = {
  maxRpm: 11985,
  upshiftRpm: 10845,
  downshiftRpm: 10522,
  gearKmhPerRpm: [0.00954, 0.01137, 0.01354, 0.01613, 0.01896, 0.02184, 0.02501, 0.02828],
  mass: 810,
  frontShare: 0.445,
  mu: 1.9,
  loadExp: 0.85,
  brakeMu: 1.1,
  tractionMu: 1.15,
  rollRange: 0.3,
  power: 620400,
  engineBrake: 2.6,
  rolling: 0.15,
  aero: { clMin: 4.85, clMax: 7.032, frontWing: 0.4, ldFront: 8, ldRear: 2.278, cdBody: 1.058 },
};

// Surfaces (surfaceAt in track.js says which one is under each wheel):
//   grip      fraction of that wheel's grip
//   drag      how much that wheel brakes (m/s², above DRAG_FROM); if one side brakes more, the car pulls that way
//   maxSpeed  with both rear wheels on it, the engine no longer pushes beyond this speed (m/s)
//   rough     how much it shakes (the steering wheel and the camera)
//   out       off the track (everything beyond the edge and the kerb)
//   slide     (optional) how much more grip the wheel loses with the car sideways (at SLIDE_FULL m/s of sliding)
//   wear      (optional) how many times faster the tyres wear there
export const SURFACES = {
  road: { grip: 1, drag: 0, maxSpeed: Infinity, rough: 0, out: false },
  // the kerb: smooth paint with steps, a bit less grip than asphalt, and much less sideways (the kerb's
  // rattle is separate: car.onKerb)
  kerb: { grip: 0.9, drag: 0.5, maxSpeed: Infinity, rough: 0, out: false, slide: 0.3 },
  // the green strip behind the kerb: already off the track; abrasive, less grip, and it eats the tyres
  green: { grip: 0.8, drag: 2, maxSpeed: Infinity, rough: 0.3, out: true, slide: 0.2, wear: 4 },
  // the sausage kerb: the car jumps (and can break the floor, see SAUSAGE_HIT), almost no grip and lots of braking
  sausage: { grip: 0.4, drag: 10, maxSpeed: Infinity, rough: 1.2, out: true, slide: 0.3 },
  // with all four: 20 m/s² of braking, and it tops out at ~90 km/h
  grass: { grip: 0.6, drag: 5, maxSpeed: 25, rough: 1, out: true },
  // gravel: barely lets the car turn and brakes much more than grass (with all four, 32 m/s²); the engine barely
  // gets it out
  gravel: { grip: 0.4, drag: 8, maxSpeed: 12, rough: 1.4, out: true },
  // paved runoff: like the track, a bit dirtier
  asphalt: { grip: 0.92, drag: 0, maxSpeed: Infinity, rough: 0, out: true },
};
const SLIDE_FULL = 4; // m/s of sideways sliding at which a surface loses all its `slide`
// riding over a sausage kerb: a hit to the floor of this intensity (m/s, like the crashes in damage.js) per m/s of
// speed: from ~28 m/s (100 km/h) it starts to break, at 160 km/h it takes 20 % of the floor and at 250 km/h, half.
// And the car jumps and jerks to the other side
const SAUSAGE_HIT = 0.25;
const SAUSAGE_KICK = 0.012; // rad/s of yaw per m/s of speed, away from the sausage kerb
const SAUSAGE_KICK_MAX = 0.5; // rad/s
const DRAG_FROM = 15; // m/s
const SURFACE_RATE = 5; // 1/s: when the surface changes, the wheel's grip and drag change in ~0.2 s
// where each wheel touches down, in m from the car's center (forward, to the right), as in carmodel.js:
// front left, front right, rear left, rear right
const WHEELS = [
  [1.65, -0.8],
  [1.65, 0.8],
  [-1.7, -0.79],
  [-1.7, 0.79],
];
const REVERSE_MAX = 8;
const REVERSE_ACCEL = 5;
const MAX_YAW = 1.6; // rad/s: maximum yaw rate at low speed
const MAX_WHEEL_ANGLE = 0.35; // rad: the most the front wheels turn, at walking pace
const MIN_WHEEL_ANGLE = 0.05; // rad: even flat out you can see them turn a little
// The wake: behind another car the air arrives slowed and turbulent. There is less drag (slipstream: more top speed
// on the straight) but also less downforce (dirty air), above all at the front: in fast corners the car following
// closely understeers, and under braking its wheels lock earlier.
const DRAFT_DIST = 120; // m: how far it is felt (falls off with the square: at 20 m 70 % remains; at 45 m, 40 %)
const DRAFT_WIDTH = 2.5; // m sideways: the width of the wake
const DRAFT_DRAG = 0.35; // fraction of air drag saved right behind the car ahead
// and the downforce on each axle lost right behind the car ahead; it falls off much faster with distance than the
// slipstream (the wake to the power DIRTY_FADE): at 10 m ~30 % of the downforce is lost (33 % front, 26 % rear), at
// 20 m ~15 % and at 40 m ~3 %. This is what was published for F1 cars from 2023 on (over 30 % following closely; the
// goal of the 2022 rules was 18 % at 10 m and 4 % at 20 m, and earlier cars lost 45 % and 35 %)
const DIRTY_FRONT = 0.6,
  DIRTY_REAR = 0.48,
  DIRTY_FADE = 3.5;
// Downforce also changes with how the car is moving: under braking the nose drops and the floor loads the front more
// and the rear less (PITCH_AERO per g of braking; accelerating, the other way round), and sideways the air does not
// enter the floor or the wings straight (past YAW_AERO_FREE rad of car sideslip, YAW_AERO per rad, up to YAW_AERO_MAX)
const PITCH_AERO = 0.008,
  PITCH_MAX = 0.05;
const YAW_AERO = 1,
  YAW_AERO_FREE = 0.1,
  YAW_AERO_MAX = 0.5;
// fuel: every kilo has weight (dynamics.js); the engine flat out burns the 100 kg/h from the rules
const FUEL_FLOW = 100 / 3600; // kg/s
export const FUEL_PER_KM = 0.37; // kg: what is loaded per km of race
// Lateral tyre forces (bicycle model: each axle as a single wheel). The car has forward speed (speed), sideways
// speed (slip) and yaw rate (omega); each axle pushes sideways according to its slip angle (tyreCurve in
// dynamics.js), up to its grip (dynamics.js plus weight transfer, the surface and what it spends on braking or
// driving). The force of each axle turns the car according to its distance from the center of gravity.
const PEAK_SLIP = 0.08; // rad (~4.6°): slip angle at which the tyre gives all its grip
const SLIDE = 0.75; // sliding sideways, the tyre grips this fraction of its peak grip
const SLIP_SPEED = 5; // m/s: below this the slip angle is measured as if at this speed (standing still has no angle)
const YAW_K2 = 1.25; // m²: yaw moment of inertia per kilo (~1000 kg·m² for 810 kg)
const SUBSTEPS = 4; // tyre steps per game step (the tyre responds faster than 1/60 s)
const SETTLE = 0.5; // in one step, a tyre pushes no more than this fraction of what would fully stop its sliding
// the rear grips sideways this much more than dynamics.js says: that way a balanced car, past the limit, pushes
// wide at the front (understeers) instead of letting the rear go, like real cars with their factory setup. With a
// setup heavily loaded at the front (balance or front wing) the rear still lets go: that is what should happen
const REAR_MARGIN = 1.15;
// with full steering lock, on top of the angle that turns the car, the wheels add this fraction of PEAK_SLIP: how
// much more the front has to slip than the rear (which, with REAR_MARGIN, grips more with less slip)
const LOCK_SLIP = 0.45;
// Traction control (an aid, above all for the keyboard, which accelerates all or nothing): the engine pushes no more
// than the rear wheels can push while still holding the corner. tc is the fraction of the rear friction circle that
// can be used between turning and pushing (0 = no control); if the rear is already sliding, it cuts almost everything
export const TRACTION_CONTROL = { off: 0, low: 0.97, high: 0.85 };
// the aids the game's rivals always race with (and the network is trained with): ABS and low traction control
export const RIVAL_AIDS = Object.freeze({ abs: true, tc: TRACTION_CONTROL.low });
// ABS (an aid, above all for the keyboard, which brakes all or nothing): if more braking is asked than the tyres
// can take, it releases brake down to ABS_USE of that limit: the wheels don't lock and some grip is left to turn
const ABS_USE = 0.95;
const TC_FLOOR = 0.1; // even with the rear at the limit, it allows this fraction of traction (so as not to get stuck)
const WHEEL_SIDE = 0.8; // m: sideways distance from each wheel to the center (for the pull of one wheel on the grass)
// weight transfer: under braking the weight moves forward and under acceleration, rearward; each axle grips
// according to its load and what it has left after braking or driving (friction circle). In a corner without pedals
// it gives what dynamics.js says; braking hard the rear goes light and steps out, and so does full throttle in a slow
// corner. (the height of the center of gravity, the brake bias and the tyre's longitudinal grip are in dynamics.js)
const TRANSFER_RATE = 20; // 1/s: the weight takes a moment to shift (the suspension slows it)
// Lockups and wheelspin: if an axle is asked to brake or push more than it grips at that moment, its wheels lock (or
// spin): dragging, they brake or push only LONG_SLIDE of what they gripped, barely hold sideways (SLIDING_SIDE: with
// the fronts locked the car goes straight; with the rears, the rear steps out) and they heat up and wear a lot (a
// flat spot). They grip again when the demand drops below LONG_RELEASE of the grip
const LONG_SLIDE = 0.75,
  SLIDING_SIDE = 0.15,
  LONG_RELEASE = 0.9;
// Tyre temperature (°C, one per wheel). They heat up with sliding (turning, braking, driving, and a lot when locked
// or spinning) and with rolling under load; the air and the asphalt cool them, more at higher speed. They give full
// grip between TEMP_LOW and TEMP_HIGH; colder (the start: they come out of the blankets at TYRE_START) or hotter
// (sliding too much), less. Overheated tyres also wear faster.
export const TYRE_START = 80,
  TEMP_LOW = 85,
  TEMP_HIGH = 105;
const TRACK_TEMP = 35;
const COLD_LOSS = 0.14,
  COLD_SPAN = 50; // COLD_SPAN degrees below TEMP_LOW it grips COLD_LOSS less
const HOT_LOSS = 0.2,
  HOT_SPAN = 40;
const HEAT = 0.17; // °C per m²/s³ of sliding on an axle (force per kilo of car × sliding speed)
const HEAT_SPEED = 30; // m/s: faster, the tyre spends less time on the ground and keeps less of that heat
const ROLL_HEAT = 0.015; // °C per meter rolled with the load of the car at rest
const COOL = 0.004,
  COOL_SPEED = 0.0009; // 1/s and 1/m: cooling toward TRACK_TEMP
const LONG_SLIP = 0.02; // braking or driving without locking, the tyre slides this fraction of the speed
const SPIN_SPEED = 6; // extra m/s of spin for a wheel that lost traction
const HOT_WEAR = 2; // a tyre HOT_SPAN degrees over wears this much more
const LOCK_WEAR = 25; // and a locked one, this many times more (the flat spot)
const tempGrip = (t) =>
  1 -
  (t < TEMP_LOW
    ? COLD_LOSS * Math.min(1, (TEMP_LOW - t) / COLD_SPAN) ** 1.5
    : t > TEMP_HIGH
      ? HOT_LOSS * Math.min(1, (t - TEMP_HIGH) / HOT_SPAN) ** 1.5
      : 0);
// the foot doesn't reach full throttle at once: with the keyboard (all or nothing) the throttle takes a moment to
// open, so stepping on it mid-corner doesn't let the rear go in one go (with a gamepad it is barely noticeable: it
// follows the trigger)
const THROTTLE_RISE = 3; // 1/s: from nothing to full in 1/3 s
const BRAKE_RISE = 10; // 1/s
const PEDAL_DROP = 12; // 1/s: releasing is fast
const PARKED = 2; // s stopped after retiring until the car is removed from the track
const IDLE_RPM = 4000;
const LAUNCH_RPM = 8000; // with the clutch slipping, in 1st and 2nd the engine doesn't drop below this
const FULL_POWER_RPM = 9000; // below this the engine delivers less and less
// Start: depending on the rpm when the clutch is released, the car gets away cleanly, bogs down or spins
export const LAUNCH_WINDOW = [9500, 10500]; // rpm of the perfect start
const LAUNCH_TIME = 1.6; // how long the start effect lasts (s)
const REV_RATE = 6500; // how fast the rpm rises per second in neutral, flat out (slower near the rev limiter)
const REV_DROP = 7000; // and how fast it drops off the throttle
const REV_BASE = 8000,
  REV_SPAN = 4000,
  REV_FOLLOW = 40000; // the network on the grid (revBy): revs with nothing asked, what each full output adds or takes
// tyre wear (one per wheel): they wear as the car moves, more the harder their grip is used (turning, braking,
// accelerating, sliding) and more on the ones that work most (the outside ones, the spinning ones); fully worn they
// grip and brake WEAR_GRIP less, and at the end (past WEAR_CLIFF_FROM) they suddenly drop another WEAR_CLIFF
const WEAR_GRIP = 0.08,
  WEAR_CLIFF = 0.06,
  WEAR_CLIFF_FROM = 0.85;
const wearGrip = (w) =>
  1 - WEAR_GRIP * w - WEAR_CLIFF * Math.max(0, (w - WEAR_CLIFF_FROM) / (1 - WEAR_CLIFF_FROM)) ** 2;
const WEAR_BASE = 0.3; // part of the wear that comes just from moving, even straight and smooth
const WEAR_USE = 1.9; // the other part is scaled so that a normal lap averages 1 (measured with rl/wear.js)

// Variation between cars: multipliers on the car (1 = the same). The network receives them as inputs.
//   power     engine thrust
//   topSpeed  top speed (less air drag)
//   grip      lateral grip
//   brakes    braking
//   wear      how fast the tyres wear
export const SETUP_KEYS = ['power', 'topSpeed', 'grip', 'brakes', 'wear'];
export const SAME_SETUP = Object.freeze({ power: 1, topSpeed: 1, grip: 1, brakes: 1, wear: 1 });

// car yaw rate (rad/s) at full steering lock, at speed sp (m/s) and with that lateral grip (m/s²)
function yawRate(sp, grip) {
  return Math.min(MAX_YAW, grip / Math.max(sp, 1)) * Math.min(1, sp / 4);
}

// Front wheel angle at full steering lock (rad): the one that makes the car turn as much as it can (angle ≈
// wheelbase × yaw rate / speed, plus the extra slip of the front). At low speed they turn a lot; flat out, barely.
// This is the aid for driving with the keyboard: the steering goes from 0 to just enough, not from 0 to the full
// steering range. grip: the lateral grip (m/s²) used for the calculation; by default, the undamaged car's on asphalt.
function steerLock(speed, limits, grip) {
  const sp = Math.max(4, Math.abs(speed)); // stopped or nearly, as at walking pace: with full lock
  const a = Math.atan((WHEELBASE * yawRate(sp, grip ?? limits.lateral(sp))) / sp) + LOCK_SLIP * PEAK_SLIP;
  return Math.min(MAX_WHEEL_ANGLE, a);
}

// For the setup, in steady state at speed v (m/s), with the limits from dynamics.js:
// how hard the car turns (m/s²): what the axle with the least grip can take, with the rear margin
export function cornerGrip(limits, v) {
  const [f, r] = limits.axles(v);
  return Math.min(f, r * REAR_MARGIN);
}
// and how much more the rear can hold than the front (0.15 with a balanced car): with little margin, braking in a
// corner or releasing the brake the rear steps out (the weight moves forward); below 0, it oversteers even in steady
// state
export function rearMargin(limits, v) {
  const [f, r] = limits.axles(v);
  return (r * REAR_MARGIN) / f - 1;
}

// Keyboard steering (all or nothing): on a key press, the steering jumps at once to KEY_STEER_START (responds with no
// delay) and from there keeps rising gradually, slower the faster the car goes (at 300 km/h, ~0.4 s to full lock).
// That way a tap corrects without throwing the car inward, as happened going from 0 to full at once; on release it
// returns quickly to center.
// now: its current position (-1..1); want: what the keys ask for (-1, 0 or 1).
const KEY_STEER_START = 0.35;
const KEY_STEER_RISE = 8; // 1/s: stopped, from KEY_STEER_START to full in 0.08 s
const KEY_STEER_SPEED = 25; // m/s: at this speed it rises at half rate (at 300 km/h, at less than a quarter)
const KEY_STEER_RETURN = 10; // 1/s
export function keyboardSteer(now, want, speed, dt) {
  if (want && want * now < KEY_STEER_START) now = want * KEY_STEER_START; // just pressed (or switched side)
  const away = want !== now && (now === 0 || Math.sign(want - now) === Math.sign(now)); // more steering
  const rate = away ? KEY_STEER_RISE / (1 + Math.abs(speed) / KEY_STEER_SPEED) : KEY_STEER_RETURN;
  return now + Math.max(-rate * dt, Math.min(rate * dt, want - now));
}

// Keyboard brake (all or nothing) while turning: as a driver does entering a corner, the more steering, the more it
// releases the brake (up to KEY_TRAIL with full lock), so the tyres have grip left to turn; the brake still has
// priority. It releases and reapplies gradually (KEY_TRAIL_RATE), not abruptly with each steering tap.
// At low speed it releases nothing (maneuvering or in reverse, which also uses the brake).
// now: the brake's current position (0..1); pressed: whether the key is down; steer: the steering (-1..1); speed: m/s.
const KEY_TRAIL = 0.45; // how much brake it releases with full lock (55 % remains)
const KEY_TRAIL_RATE = 3; // 1/s: from full brake to the target in ~0.15 s
const KEY_TRAIL_SPEED = [5, 15]; // m/s: below the first it releases nothing; from the second, everything
export function keyboardBrake(now, pressed, steer, speed, dt) {
  if (!pressed) return 0;
  const [lo, hi] = KEY_TRAIL_SPEED,
    fade = Math.max(0, Math.min(1, (speed - lo) / (hi - lo)));
  const want = 1 - KEY_TRAIL * fade * Math.min(1, Math.abs(steer));
  if (now === 0) return want; // just pressed: brakes at once, with no delay
  return now + Math.max(-KEY_TRAIL_RATE * dt, Math.min(KEY_TRAIL_RATE * dt, want - now));
}

// The front wheel angle for drawing them (even flat out you can see them turn a little)
export function wheelAngle(steer, speed, limits) {
  return steer * Math.max(MIN_WHEEL_ANGLE, steerLock(speed, limits));
}

// The wake of the cars ahead of car (0..1): more the closer and the more aligned.
// meters: meters per track cell.
export function slipstream(car, cars, meters) {
  const fx = Math.cos(car.angle),
    fy = Math.sin(car.angle);
  let best = 0;
  for (const o of cars) {
    if (o === car || o.gone || Math.cos(o.angle - car.angle) < 0.9) continue; // the wake goes where the other car goes
    const dx = (o.x - car.x) * meters,
      dy = (o.y - car.y) * meters;
    const ahead = dx * fx + dy * fy,
      side = Math.abs(-dx * fy + dy * fx);
    if (ahead < 3 || ahead > DRAFT_DIST || side > DRAFT_WIDTH) continue;
    best = Math.max(best, (1 - ahead / DRAFT_DIST) ** 2 * (1 - side / DRAFT_WIDTH));
  }
  return best;
}

// a pedal: true/false from the keyboard or 0..1 from a gamepad
function pedal(x) {
  return Math.max(0, Math.min(1, +x || 0));
}

// The limits of a car with a track's setup and air (for the racing line, before the start)
export const limitsOn = (profile, track) => carLimits(profile, track.tune ?? DEFAULT_TUNE, track.air ?? SEA_AIR);

export class Car {
  constructor(x, y, angle, profile = DEFAULT_PROFILE) {
    this.x = x;
    this.y = y;
    this.angle = angle;
    this.profile = profile;
    this.speed = 0;
    this.steer = 0; // -1..1 smoothed, to animate the car
    this.draft = 0; // the wake of the car ahead, 0..1 (the game computes it with slipstream before each update)
    this.fuel = 0; // kg of fuel on board
    this.fuelFlow = FUEL_FLOW; // kg/s burned flat out (0: burns none)
    this.tyreTemp = [TYRE_START, TYRE_START, TYRE_START, TYRE_START]; // °C, per wheel (see WHEELS)
    this.tyreWear = [0, 0, 0, 0]; // wear of each tyre, 0 (new) to 1 (worn out)
    this.locked = [false, false]; // locked wheels, front and rear
    this.wheelspin = false; // the rears spinning
    this.cornering = 0; // fraction of the rear's lateral grip used in the previous step (for traction control)
    this.traction = 0; // the most the rear wheels can push right now (m/s²)
    this.wheels = ['road', 'road', 'road', 'road']; // what each wheel is on (see WHEELS)
    this.wheelGrip = [1, 1, 1, 1]; // grip and drag of each wheel according to its surface, changing gradually
    this.wheelDrag = [0, 0, 0, 0];
    // fraction of the wheels off the track (grass, gravel or paved runoff; the name dates from when only grass
    // was outside: training and the network use it)
    this.grass = 0;
    this.onGrass = false; // two or more wheels off the track
    this.rough = 0; // how much what the wheels are on shakes (0 on the track; 1 with all four on the grass)
    this.onKerb = false;
    this.onSausage = false; // some wheel on top of a sausage kerb
    this.wheelLift = [0, 0, 0, 0]; // how much each wheel is lifted by the kerb or the sausage kerb (cells)
    this.lift = 0; // and the car: how much it rises (cells), how much it rolls (rad, +: the right side rises) and
    this.liftRoll = 0; // pitches (rad, +: the nose drops), to draw it
    this.liftDive = 0;
    this.jolt = 0; // jolt from the sausage kerb (0..1, decays on its own), for the camera and the sound
    this.bump = 0;
    this.slope = 0;
    this.slip = 0; // sideways speed, to the right (m/s)
    this.omega = 0; // yaw rate (rad/s; positive, to the right)
    this.delta = 0; // front wheel angle (rad)
    this.throttle = 0; // how much throttle is applied, 0..1 (for the sound)
    this.brake = 0; // how much brake is applied, 0..1
    this.aLon = 0; // forward acceleration from the tyres (m/s², smoothed): weight transfer comes from this
    this.launchFactor = 1; // at the start: what fraction of the acceleration reaches the ground
    this.launchTime = 0;
    this.launchRpm = 0;
    this.gear = 1; // 0 = reverse
    this.rpm = IDLE_RPM;
    this.manual = false;
    this.tc = 0; // traction control (TRACTION_CONTROL): 0 = no control
    this.tcCut = false; // whether traction control cut the engine in this step
    this.abs = false; // ABS: the brakes release before a wheel locks
    this.absCut = false; // whether ABS released brake in this step
    this.brakeCap = 0; // the most the tyres can brake right now (m/s²)
    this.pedalLimit = 1; // the brake pedal (0..1) that reaches that limit
    this.setup = SAME_SETUP;
    this.tune = DEFAULT_TUNE; // setup (dynamics.js): the track's, unless the car has its own (ownTune)
    this.ownTune = null;
    this.ownAir = null;
    this.air = SEA_AIR; // air density of the track (kg/m³)
    this.damage = NO_DAMAGE; // what is broken (damage.js)
    /** @type {{ lit: number, since: number, out: boolean } | undefined} */
    this.lights = undefined; // the start lights, on the grid (lights.js; set by whoever starts the race)
    this.damageLevel = 'off'; // whether hits break things: 'off', 'reduced' or 'real'
    this.rubber = null; // the rubber on the track (RubberMap from rubber.js), if any: changes each wheel's grip
    this.wearRate = 0; // wear per meter in normal driving (0 = no wear); the game sets it according to the race
  }

  // tyre wear, 0 (new) to 1 (worn out): the average of the four (setting it sets all four the same)
  get wear() {
    const w = this.tyreWear;
    return (w[0] + w[1] + w[2] + w[3]) / 4;
  }
  set wear(x) {
    this.tyreWear = [x, x, x, x];
  }

  get gears() {
    return this.profile.gearKmhPerRpm.length;
  }

  // What the car can do (dynamics.js) with its setup, its variation, the air and its damage: recomputed when any of
  // them changes (they are replaced, not modified)
  get limits() {
    const c = this._limits,
      fuel = Math.round(this.fuel); // fuel, by the kilo
    if (
      c &&
      c.profile === this.profile &&
      c.setup === this.setup &&
      c.tune === this.tune &&
      c.air === this.air &&
      c.damage === this.damage &&
      c.fuel === fuel
    )
      return c.lim;
    const lim = carLimits(this.profile, this.tune, this.air, this.setup, this.damage, fuel);
    this._limits = {
      profile: this.profile,
      setup: this.setup,
      tune: this.tune,
      air: this.air,
      damage: this.damage,
      fuel,
      lim,
    };
    return lim;
  }

  // Engine RPM at a speed (m/s) in a gear
  rpmAt(v, gear) {
    return (Math.abs(v) * 3.6) / this.profile.gearKmhPerRpm[Math.max(1, gear) - 1];
  }

  // Manual shift: +1 up, -1 down. It won't downshift if the engine would over-rev.
  // Returns false if the shift didn't happen for that reason.
  shift(dir) {
    if (!this.manual) return true;
    const next = Math.max(1, Math.min(this.gears, this.gear + dir));
    if (dir < 0 && this.rpmAt(this.speed, next) > this.profile.maxRpm) return false;
    this.gear = next;
    return true;
  }

  // Automatic gearbox: upshifts near the rev limiter and downshifts to keep the engine in its best range,
  // as seen in telemetry (after a downshift, the engine sits at ~downshiftRpm)
  autoShift(throttle) {
    const p = this.profile;
    const up = throttle ? p.maxRpm * 0.97 : p.upshiftRpm;
    if (this.gear < this.gears && this.rpmAt(this.speed, this.gear) > up) this.gear++;
    else if (this.gear > 1 && this.rpmAt(this.speed, this.gear - 1) < p.downshiftRpm) this.gear--;
  }

  // On the grid, with the car stopped (clutch in): the throttle only raises the revs,
  // up to a point that depends on how far it is pressed (0..1; true is full)
  // On the grid with the lights red, as the network does it: up adds and down removes revs (each from -1 to 1,
  // linearly: clipped at zero, with exploration noise the average during training was not what it asked for without
  // noise, and it learned to ask for too much) from REV_BASE, and the engine heads toward them. With both at zero,
  // REV_BASE: that way it explores around a middle rev range (with rising and falling at a rate, the noise of one
  // step canceled out with the next and it always stayed at idle)
  revBy(dt, up, down) {
    const max = this.profile.maxRpm,
      clip = (x) => Math.max(-1, Math.min(1, +x || 0));
    const target = Math.max(IDLE_RPM, Math.min(max, REV_BASE + (REV_SPAN / 2) * (clip(up) - clip(down))));
    // in neutral and without load it follows almost instantly (when it lagged, each step's noise averaged out and
    // every start came out the same: there was nothing to learn from)
    const step = REV_FOLLOW * dt;
    this.rpm = this.rpm < target ? Math.min(target, this.rpm + step) : Math.max(target, this.rpm - step);
  }

  rev(dt, throttle) {
    const max = this.profile.maxRpm,
      thr = pedal(throttle);
    const target = IDLE_RPM + (max - IDLE_RPM) * thr;
    if (this.rpm < target) this.rpm = Math.min(target, this.rpm + REV_RATE * (1 - 0.6 * (this.rpm / max)) * dt);
    else this.rpm = Math.max(target, this.rpm - REV_DROP * dt);
    this.throttle = thr;
  }

  // Releases the clutch: depending on the rpm, how much of the acceleration reaches the ground during the first
  // second and a half.
  // Returns how the start went: 'perfect', 'bog' (bogged down) or 'spin' (wheelspin).
  launch() {
    const rpm = this.rpm,
      [lo, hi] = LAUNCH_WINDOW,
      max = this.profile.maxRpm;
    let factor = 1,
      kind = 'perfect';
    if (rpm < lo) {
      factor = 0.55 + 0.45 * Math.max(0, (rpm - IDLE_RPM) / (lo - IDLE_RPM));
      kind = rpm < lo - 700 ? 'bog' : 'perfect';
    } else if (rpm > hi) {
      factor = 1 - 0.35 * Math.min(1, (rpm - hi) / (max - hi));
      kind = rpm > hi + 400 ? 'spin' : 'perfect';
    }
    this.launchFactor = factor;
    this.launchTime = LAUNCH_TIME;
    this.launchRpm = rpm;
    return kind;
  }

  // The track's air and setup (track.js), or the car's own if it has them (ownAir: to train the network at other
  // altitudes)
  placeOn(track) {
    this.air = this.ownAir ?? track.air ?? SEA_AIR;
    this.tune = this.ownTune ?? track.tune ?? DEFAULT_TUNE;
    return this;
  }

  update(dt, input, track) {
    const p = this.profile,
      M = track.meters;
    this.placeOn(track);
    this.damage = deflate(this.damage, dt);
    // retired: releases everything and slows down gradually until stopped; after PARKED seconds stopped it is
    // removed (gone). Nearly stopped it releases the brake: with the car at rest, the brake is reverse
    if (this.damage.retired) {
      input = { throttle: 0, brake: this.speed > 0.5 ? 0.3 : 0, steer: this.steer * 0.5 };
      this.parked = Math.abs(this.speed) < 0.5 ? (this.parked ?? 0) + dt : 0;
      this.gone = this.parked > PARKED;
    }
    // what each wheel is on, at its position (the kerbs are outside the track limit: riding them is not going on
    // the grass)
    const ca0 = Math.cos(this.angle),
      sa0 = Math.sin(this.angle);
    const at = WHEELS.map(([f, r]) => [this.x + (ca0 * f - sa0 * r) / M, this.y + (sa0 * f + ca0 * r) / M]);
    const under = at.map(([x, y]) => edgeInfo(track, x, y));
    this.wheels = under.map((u) => u.surface);
    const surf = this.wheels.map((w) => SURFACES[w]);
    // the tyre doesn't go from gripping to sliding at once: it eases into what it is on
    const blend = Math.min(1, dt * SURFACE_RATE);
    // sideways, on the kerb and the green strip there is even less grip
    const sliding = Math.min(1, Math.abs(this.slip) / SLIDE_FULL);
    // on the asphalt, the rubber laid by the cars (rubber.js) grips more; off the racing line, somewhat less
    const rubber = (i) => {
      if (!this.rubber || this.wheels[i] !== 'road') return 1;
      const st = stationAt(track, at[i][0], at[i][1]);
      return st < 0 ? 1 : RubberMap.gripAt(this.rubber, st, sampleField(track.lat, track.W, at[i][0], at[i][1]));
    };
    // (a wheel with bent or punctured suspension also grips less, and a punctured one drags)
    surf.forEach((sf, i) => {
      const g = sf.grip * (1 - (sf.slide ?? 0) * sliding) * rubber(i);
      this.wheelGrip[i] += (g * damageGrip(this.damage, i) - this.wheelGrip[i]) * blend;
      this.wheelDrag[i] += (sf.drag + damageDrag(this.damage, i) - this.wheelDrag[i]) * blend;
    });
    const wg = this.wheelGrip;
    this.grass = surf.filter((sf) => sf.out).length / 4;
    this.rough = surf.reduce((a, sf) => a + sf.rough, 0) / 4;
    this.onGrass = this.grass >= 0.5;
    this.onKerb = this.wheels.includes('kerb');
    // how much the kerb and the sausage kerb under each wheel lift the car
    const L = (this.wheelLift = under.map((u) => u.lift));
    this.lift = (L[0] + L[1] + L[2] + L[3]) / 4;
    this.liftRoll = Math.atan((((L[1] + L[3] - (L[0] + L[2])) / 2) * M) / (WHEELS[1][1] - WHEELS[0][1]));
    this.liftDive = Math.atan((((L[2] + L[3] - (L[0] + L[1])) / 2) * M) / (WHEELS[0][0] - WHEELS[2][0]));
    // riding over a sausage kerb: a jump, a jerk to the other side and, when fast, a hit to the floor
    const onSausage = this.wheels.includes('sausage');
    const v0 = Math.abs(this.speed);
    // (once per jump: while the jolt lasts, bouncing on the same sausage kerb doesn't break anything again)
    if (onSausage && !this.onSausage && v0 > 5 && this.jolt < 0.2) {
      this.jolt = Math.min(1, v0 / 40);
      const i = this.wheels.indexOf('sausage');
      this.omega += -Math.sign(WHEELS[i][1]) * Math.min(SAUSAGE_KICK_MAX, v0 * SAUSAGE_KICK);
      this.damage = applyHit(this.damage, 0, 0, v0 * SAUSAGE_HIT, null, this.damageLevel);
    }
    this.onSausage = onSausage;
    this.jolt = Math.max(0, this.jolt - dt * 2.5);

    const v = Math.abs(this.speed);
    // pedals and steering can be partial (gamepad): 0..1 and -1..1; the keyboard sends true/false
    const ease = (now, target, rise) => now + Math.max(-PEDAL_DROP * dt, Math.min(rise * dt, target - now));
    const thr = (this.throttle = ease(this.throttle, pedal(input.throttle), THROTTLE_RISE));
    const brk = (this.brake = ease(this.brake, pedal(input.brake), BRAKE_RISE));
    if (thr && this.gear === 0) this.gear = 1;
    if (this.speed >= 0 && this.gear === 0) this.gear = 1;
    if (!this.manual && this.gear > 0) this.autoShift(thr > 0.5);

    // engine: dynamics.js says how hard it pushes flat out in the right gear; in another gear it delivers less (low
    // revs) or nothing (rev limiter)
    let rpm = this.rpmAt(v, this.gear);
    if (this.gear <= 2 && thr) rpm = Math.max(rpm, LAUNCH_RPM);
    rpm = Math.max(rpm, IDLE_RPM);
    const limiter = rpm >= p.maxRpm;
    const power = limiter ? 0 : Math.min(1, Math.max(0.2, (rpm - 3000) / (FULL_POWER_RPM - 3000)));
    // with wheelspin at the start, the engine stays high in the revs
    if (this.launchTime > 0 && this.launchRpm > LAUNCH_WINDOW[1] && thr)
      rpm = Math.max(rpm, this.launchRpm * (0.9 + 0.1 * (this.launchTime / LAUNCH_TIME)));
    this.launchTime = Math.max(0, this.launchTime - dt);
    this.rpm += (Math.min(rpm, p.maxRpm) - this.rpm) * Math.min(1, dt * 20);

    const lim = this.limits,
      setup = this.setup,
      FS = lim.frontShare;
    // the air: in another car's wake there is less drag and less downforce; sideways, less downforce; under braking,
    // the downforce moves forward
    const beta = v > 10 ? Math.abs(Math.atan2(this.slip, v)) : 0;
    const askew = 1 - Math.min(YAW_AERO_MAX, YAW_AERO * Math.max(0, beta - YAW_AERO_FREE));
    const pitch = Math.max(-PITCH_MAX, Math.min(PITCH_MAX, (-this.aLon / GRAVITY) * PITCH_AERO));
    const lateral = Math.abs(this.omega) * v;
    const dirty = this.draft ** DIRTY_FADE;
    const k = [(1 - DIRTY_FRONT * dirty) * askew * (1 + pitch), (1 - DIRTY_REAR * dirty) * askew * (1 - pitch)];
    const airDrag = lim.drag(v) * (1 - this.draft * DRAFT_DRAG);
    // off the pedals the car is slowed by the air, rolling resistance and engine braking
    const losses = lim.coast(v) - lim.drag(v) + airDrag;

    // The tyres. Grip of each axle (dynamics.js: downforce, wings, balance; with damage on one side, it depends on
    // which way the car turns): cornering at the limit and in a straight line (for braking and driving)
    const side = Math.abs(this.omega) > 0.05 ? Math.sign(this.omega * Math.sign(this.speed || 1)) : 0;
    const [axleF, axleR] = lim.axles(v, side, k);
    const [longF, longR] = lim.straight(v, k);
    const grip = lim.lateral(v); // the whole car's in clean air: what the axle with the least grip can take
    // load on the tyres (per kg): the weight plus the downforce
    const load = GRAVITY * lim.load(v, k);
    // in a corner the outside wheel carries more load (outer: its share of the axle's): its surface, its temperature
    // and its wear weigh more, and it is the one that heats up and wears most. o: the outside (0 left)
    const o = side > 0 ? 0 : 1;
    const outer = side ? 0.5 + 0.5 * Math.min(1, (2 * lateral * CG_HEIGHT) / (TRACK_WIDTH * load)) : 0.5;
    const tyre = (i) => tempGrip(this.tyreTemp[i]) * wearGrip(this.tyreWear[i]);
    const pair = (f, i) => outer * f(i + o) + (1 - outer) * f(i + 1 - o);
    const tyreF = pair(tyre, 0),
      tyreR = pair(tyre, 2);
    const frontSurf = pair((i) => wg[i], 0),
      rearSurf = pair((i) => wg[i], 2);
    // weight transfer: what part moves forward (braking) or rearward (accelerating), and how much each axle grips
    // with that load (each extra kilo grips a little less)
    const shift = weightShift(this.aLon, load);
    const frontLoad = ((FS + shift) / FS) ** lim.loadExp;
    const rearLoad = ((1 - FS - shift) / (1 - FS)) ** lim.loadExp;
    // the most each axle can brake and the rear can push right now (m/s² for the whole car)
    const loadF = longF * FS * frontLoad,
      loadR = longR * (1 - FS) * rearLoad;
    const capF = lim.longBrake * loadF * frontSurf * tyreF,
      capR = lim.longBrake * loadR * rearSurf * tyreR;
    const traction = (this.traction = lim.longDrive * loadR * rearSurf * tyreR);

    let drive = 0,
      braking = 0; // what the tyres push and brake (m/s²), for the balance
    let useF = 0,
      useR = 0; // fraction of each axle's grip spent on braking or driving
    let lockF = false,
      lockR = false,
      spin = false;
    let forceF = 0,
      forceR = 0; // what the fronts brake and what the rears brake or push (m/s²)
    if (this.speed < 0 || (brk && !thr && this.speed <= 0.5)) {
      // reverse: the brake pushes backward; the throttle brakes first
      if (thr) this.speed += lim.accel(v) * thr * dt;
      else if (brk) {
        this.gear = 0;
        this.speed = Math.max(-REVERSE_MAX, this.speed - REVERSE_ACCEL * brk * dt);
      } else this.speed = Math.min(0, this.speed + losses * dt);
    } else {
      // flat out, all the engine's thrust (near top speed the air eats all of it); part throttle, a fraction. The
      // engine is stronger than the tyres until well into 4th: without traction control you have to meter it
      const full = this.speed < Math.max(surf[2].maxSpeed, surf[3].maxSpeed) ? lim.engine(v) * power : 0;
      // when accelerating, the engine doesn't brake: the foot lifts engine braking (with full throttle, all of it)
      drive = thr * (full + lim.coast(v) - lim.drag(v) - lim.rolling);
      // at the start, if it bogged down or spins, less acceleration reaches the ground
      if (this.launchTime > 0) drive = Math.min(drive, this.launchFactor * lim.traction(v, k));
      // traction control cuts what the rear can't push without letting go: of its grip, what it didn't use for
      // turning in the previous step
      const tcCap = Math.max(TC_FLOOR, Math.sqrt(Math.max(0, this.tc ** 2 - this.cornering ** 2))) * traction;
      this.tcCut = this.tc > 0 && drive > tcCap;
      if (this.tcCut) drive = tcCap;
      // braking: the pedal sets the brake force, from nothing to lim.brakeMax (what the tyres can take at top
      // speed), split between the axles. What the tyres can take at each moment (brakeCap) depends on the load (less
      // at lower speed, in another car's dirty air or while the weight hasn't moved forward yet), on the surface and
      // on their condition: asking for more locks them. pedalLimit: the pedal that just reaches that limit
      const bias = brakeBias(loadF, loadR, lim.brakeFwd);
      const extra = lim.drag(v) + lim.rolling - losses;
      this.brakeCap = Math.min(capF / bias, capR / (1 - bias));
      this.pedalLimit = Math.min(1, Math.max(0, this.brakeCap / Math.max(lim.brakeMax + extra, 1e-6)));
      braking = brk * Math.max(0, lim.brakeMax + extra);
      // ABS: releases brake (on both axles) so neither goes past ABS_USE of its grip
      this.absCut = this.abs && braking > ABS_USE * this.brakeCap;
      if (this.absCut) braking = ABS_USE * this.brakeCap;
      let brakeF = braking * bias;
      let rear = drive - (braking - brakeF); // what the rears do: push (+) or brake (-)
      const over = (use, was) => use > 1 || (was && use > LONG_RELEASE);
      useF = brakeF / Math.max(capF, 1e-6);
      lockF = brakeF > 0 && over(useF, this.locked[0]);
      if (lockF) brakeF = LONG_SLIDE * capF;
      if (rear < 0) {
        useR = -rear / Math.max(capR, 1e-6);
        lockR = over(useR, this.locked[1]);
        if (lockR) rear = -LONG_SLIDE * capR;
      } else {
        useR = rear / Math.max(traction, 1e-6);
        spin = rear > 0 && over(useR, this.wheelspin);
        if (spin) rear = LONG_SLIDE * traction;
      }
      forceF = brakeF;
      forceR = Math.abs(rear);
      braking = brakeF + Math.max(0, -rear);
      drive = Math.max(0, rear);
      this.speed = Math.max(0, this.speed + (drive - losses - braking) * dt);
    }
    if (!braking) this.absCut = false;
    this.locked = [lockF, lockR];
    this.wheelspin = spin;
    if (this.fuel > 0) this.fuel = Math.max(0, this.fuel - this.fuelFlow * thr * dt);
    // the weight shifts according to what the tyres push or brake, with a little delay
    this.aLon += (drive - braking - this.aLon) * Math.min(1, dt * TRANSFER_RATE);

    // slope in the direction of travel (smoothed): gravity slows the car uphill and pushes it downhill
    const fx = Math.cos(this.angle),
      fy = Math.sin(this.angle);
    const ahead = sampleField(track.height, track.W, this.x + fx * 1.5, this.y + fy * 1.5);
    const behind = sampleField(track.height, track.W, this.x - fx * 1.5, this.y - fy * 1.5);
    this.slope += ((ahead - behind) / 3 - this.slope) * Math.min(1, dt * 8);
    this.speed -= GRAVITY * this.slope * dt;

    // each wheel drags according to its surface (the grass, a lot); if one side drags more, the car pulls that way
    let drag = 0,
      pull = 0;
    if (Math.abs(this.speed) > DRAG_FROM) {
      this.wheelDrag.forEach((d, i) => {
        drag += d;
        pull += Math.sign(WHEELS[i][1]) * d;
      });
      this.speed -= Math.sign(this.speed) * Math.min(Math.abs(this.speed), drag * dt);
    }

    const sp = Math.abs(this.speed);
    // what each axle grips sideways (m/s² per kilo on the axle): with its load, its surface, the state of its tyres
    // and what it has left after braking or driving (friction circle); locked or spinning, almost nothing
    const left = (use, sliding) => (sliding ? SLIDING_SIDE : Math.sqrt(1 - Math.min(1, use) ** 2));
    const front = axleF * tyreF * frontSurf * frontLoad * left(useF, lockF);
    const rearSteady = axleR * tyreR * rearSurf * rearLoad; // what the rear grips without braking or driving
    const rear = rearSteady * left(useR, lockR || spin);
    this.grip = [front / grip, rear / grip]; // to show or test it: 1 is the steady-state grip

    // steering: with a bent front suspension, the steering pulls to that side
    const target = Math.max(-1, Math.min(1, (+input.steer || 0) + steerPull(this.damage)));
    this.steer += (target - this.steer) * Math.min(1, dt * 10);
    // wheel angle: at full lock, just enough to turn as hard as the axle with the least grip can at this moment
    // (steerLock)
    const delta = (this.delta = this.steer * steerLock(sp, lim, Math.min(front, rear * REAR_MARGIN)));
    const cd = Math.cos(delta),
      sd = Math.sin(delta);
    // what each axle can push sideways (m/s² for the whole car) and its distance from the center of gravity
    const gripF = FS * front,
      gripR = (1 - FS) * rear * REAR_MARGIN;
    const A = WHEELBASE * (1 - FS),
      B = WHEELBASE * FS;
    // a wheel that drags more than the one on the other side (on the grass) turns the car toward that side
    const pullYaw = WHEEL_SIDE * pull * Math.sign(this.speed);
    // lateral force of an axle (m/s² for the whole car): according to its slip angle (sideways speed over the tyre's
    // rolling speed), but no more than what would fully stop that sliding in one step (k: how much the axle's
    // sideways speed changes per m/s² it pushes there, counting the yaw it causes)
    const h = dt / SUBSTEPS;
    const axle = (across, along, most, kk) => {
      const f = -most * tyreCurve(across / (PEAK_SLIP * Math.max(Math.abs(along), SLIP_SPEED)), SLIDE);
      const cap = (SETTLE * Math.abs(across)) / (h * kk);
      return Math.max(-cap, Math.min(cap, f));
    };
    const kF = 1 + (A * A) / YAW_K2,
      kR = 1 + (B * B) / YAW_K2;
    let lastR = 0,
      lastSlipR = 0,
      heatF = 0,
      heatR = 0;
    for (let i = 0; i < SUBSTEPS; i++) {
      // sideways speed of each axle: the car's plus what the yaw adds (the front adds, the rear subtracts);
      // the front one measured along where the wheels point
      const sideF = this.slip + A * this.omega,
        sideR = this.slip - B * this.omega;
      const acrossF = sideF * cd - this.speed * sd;
      const fF = axle(acrossF, this.speed * cd + sideF * sd, gripF, kF);
      const fR = axle(sideR, this.speed, gripR, kR);
      lastR = fR;
      lastSlipR = sideR / (PEAK_SLIP * Math.max(Math.abs(this.speed), SLIP_SPEED));
      // how much they heat up: the lateral force times the speed at which the tyre slides sideways
      heatF += Math.abs(fF * acrossF);
      heatR += Math.abs(fR * sideR);
      // what the tyres push, in the car's frame (the turned fronts also brake a little), and the car's yaw: the
      // velocity rotates the other way in its frame (what was sideways becomes forward and vice versa)
      const ax = -fF * sd,
        ay = fF * cd + fR,
        vx = this.speed;
      this.speed += (ax + this.slip * this.omega) * h;
      this.slip += (ay - vx * this.omega) * h;
      this.omega += ((A * fF * cd - B * fR + pullYaw) / YAW_K2) * h;
      this.angle += this.omega * h;
      const ca = Math.cos(this.angle),
        sa = Math.sin(this.angle);
      this.x += ((ca * this.speed - sa * this.slip) * h) / M;
      this.y += ((sa * this.speed + ca * this.slip) * h) / M;
    }
    // for the next step's traction control: what fraction of the rear's grip (without driving) went into turning;
    // with the rear past its peak (sliding), all of it
    this.cornering =
      Math.abs(lastSlipR) > 1 ? 1 : Math.min(1, Math.abs(lastR) / Math.max((1 - FS) * rearSteady * REAR_MARGIN, 1e-6));

    // temperature: each axle heats up with its sideways sliding (the outside wheel more) and its longitudinal sliding
    // (braking or driving: little if it grips, a lot when locked or spinning), and each wheel with rolling under load
    const slideF = lockF ? v : LONG_SLIP * v,
      slideR = lockR ? v : LONG_SLIP * v + (spin ? SPIN_SPEED : 0);
    const axleLoad = lim.loads(v, k),
      cool = COOL + COOL_SPEED * sp;
    const share = (i) => (i % 2 === o ? outer : 1 - outer);
    const keep = HEAT_SPEED / (HEAT_SPEED + sp);
    const work = [0, 1, 2, 3].map(
      (i) =>
        keep *
        (i < 2
          ? (heatF / SUBSTEPS) * share(i) + (forceF * slideF) / 2
          : (heatR / SUBSTEPS) * share(i) + (forceR * slideR) / 2),
    );
    const temp = this.tyreTemp;
    for (let i = 0; i < 4; i++) {
      temp[i] +=
        (HEAT * work[i] + ROLL_HEAT * sp * axleLoad[i >> 1] * 2 * share(i) - cool * (temp[i] - TRACK_TEMP)) * dt;
    }
    // wear: how hard the grip is used (turning + driving or braking, over what they grip) and the sliding; of the
    // four, the one that works most wears most, as does the one on something abrasive, the overheated one and the
    // locked one
    if (this.wearRate) {
      const whole = (grip * (frontSurf + rearSurf)) / 2;
      const use = (sp * Math.abs(this.omega) + Math.abs(this.aLon)) / whole + Math.abs(this.slip) / 5;
      const base = this.wearRate * setup.wear * (WEAR_BASE + WEAR_USE * (1 - WEAR_BASE) * use) * sp * dt;
      const mean = (work[0] + work[1] + work[2] + work[3]) / 4,
        wear = this.tyreWear;
      for (let i = 0; i < 4; i++) {
        const hot = 1 + HOT_WEAR * Math.max(0, (temp[i] - TEMP_HIGH) / HOT_SPAN);
        const flat = this.locked[i >> 1] ? this.wearRate * LOCK_WEAR * sp * dt : 0;
        wear[i] = Math.min(
          1,
          wear[i] + base * (surf[i].wear ?? 1) * (mean > 1e-6 ? 0.5 + (0.5 * work[i]) / mean : 1) * hot + flat,
        );
      }
    }

    // crashes against the walls
    this.bump = Math.max(0, this.bump - dt * 3);
    collideWalls(this, track);
  }
}

// Does a circle of radius r (in cells) centered at (x, y) touch the wall?
// The wall starts `runoff` cells from the track edge; since sdf is continuous, the wall is smooth.
export function isSolid(track, x, y, r = 0) {
  if (x < 2 || y < 2 || x >= track.W - 2 || y >= track.H - 2) return true;
  return sampleField(track.sdf, track.W, x, y) < -track.runoff + r;
}
