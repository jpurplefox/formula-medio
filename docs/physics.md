# Physics

How the car moves, how it collides and how it breaks. Everything is in `src/sim/` and it is the same for you, for the
rivals and for training the network.

## Scale and car model

Each track has a real scale in meters per cell, computed from the real lap length (from telemetry, or
`lengthMeters`). What the car can do comes from a **physical model calibrated against real laps**
(`src/sim/dynamics.js`, see "Calibration against real laps"): downforce and drag that grow with v² and with air
density (the track's altitude), two wings and a mechanical balance that each player chooses (**setup**), per-axle
grip depending on load, power and traction; and an 8-speed gearbox with RPM, rev limiter and shift lights
(`src/sim/car.js`).

`dynamics.js` is a small model, the kind used in a lap simulator:

- **Aerodynamics:** downforce and drag = ½·ρ·C·v². With the wings at minimum the car has the downforce of the floor
  and the bodywork (`clMin`), and with both at maximum, ~45 % more (`clMax`). Each wing charges its downforce
  divided by its efficiency as drag: the front almost nothing, the rear a lot. The air density ρ comes from the
  track's altitude (`altitude` in `tracks/index.js`): at Interlagos there is ~9 % less air than at sea level.
- **Tyres:** each wheel grips `mu · load^0.85` (each extra kilo grips a bit less), with the downforce split between
  the axles and the weight transfer to the outside wheels in corners. With more grip at the front than at the rear
  the car oversteers; with less, it understeers. Longitudinally they grip a bit more than laterally (`brakeMu`,
  `tractionMu`); the "full" braking and traction the racing line uses are 93 % and 92 % of what they can hold.
- **Engine:** a power figure (it pushes less the faster the car goes); the turbo makes up almost all the air missing
  at altitude. Every kilo of fuel adds to the weight.

## Surface per wheel

Each wheel checks what it is on (asphalt, kerb, grass, gravel or paved runoff; `SURFACES` in `src/sim/car.js` and
`surfaceAt` in `src/sim/track.js`). Each axle grips according to its two wheels (a rear wheel on the grass loses the
rear, a front one takes away steering), each wheel on the grass slows the car and, if one side slows more, the car
pulls to that side; with both rear wheels on the grass the engine can't push beyond ~90 km/h. Gravel slows more and
barely lets the car turn; paved runoff grips almost like the track. For training, all three count as off track
(`car.grass`). Also: collisions and gravity on slopes.

## Another car's wake

Up to 120 m behind and 2.5 m to the side; at 20 m 70 % remains and at 45 m, 40 %. There is less drag
(**slipstream**, up to 35 % right behind it) but also less downforce (**dirty air**, noticeable only up close: at
10 m ~30 % of the downforce is lost, at 20 m ~15 % and at 40 m almost nothing, and more at the front than at the rear;
this is what has been published for F1 cars from 2023 on). On the straight you gain speed; in a fast corner, 10 m
behind another car you turn 19 % less (at 20 m, 10 %) and the car understeers, and braking gets longer. It applies to
you and to the rivals.

Downforce also changes with what the car is doing: under braking it shifts forward (the nose dips) and with the car
sideways it is lost (up to half in a spin). And **fuel** has weight: in a race the car carries just enough for the
laps (0.37 kg per km) and burns it at 100 kg/h at full throttle; with 100 kg the car turns ~6 % less in fast corners.

## Balance

Under braking the weight moves forward and under acceleration, backward (whatever the physics gives: at full
throttle or full braking, 12 to 16 % of the weight, with a brief delay from the suspension), and in corners, to the
outside wheels (the **mechanical balance** in the setup decides which axle takes more of that transfer). Each wheel
grips according to its load, but not proportionally (double the load gives 1.8 times the grip), so the axle that
transfers the most is the one that grips the least. Each axle also splits its grip between braking or pushing and
turning (**friction circle**: √(braking² + turning²) ≤ grip; the engine only pushes through the rear wheels). The
brakes split the braking force like the load on each axle at that moment, shifted forward; how much is the **brake
bias** in the setup.

## Lockups and wheelspin

If an axle is asked to brake or push more than it can grip, its wheels lock (or spin): they brake or push less, hold
almost nothing sideways (with the fronts locked the car goes straight on; with the rears, the rear steps out), and
they overheat and wear (a flat spot). The brake pedal sets the brake force, and at full pressure it is what the tyres
can hold at top speed with full downforce: as the car slows there is less downforce and you have to ease off, or they
lock (and sooner on a kerb, on the grass or in another car's dirty air). With **ABS** (options; on by default, for
the keyboard, which brakes all or nothing) the brakes release by themselves before locking. The engine is stronger
than the tyres up to about 140 km/h: without traction control, at full throttle in low gears the rears spin and you
have to modulate.

## Temperature and wear, wheel by wheel

The tyres heat up from sliding (turning, braking, pushing; a lot when locked or spinning) and from rolling under
load, and the air cools them. They have full grip between 85 and 105 °C; they come out of the blankets at 80 °C (on
the first lap they grip a bit less), on a normal lap they average between 87 and 103 °C, and overheated they lose up
to 20 % and wear faster. The outside tyre in each corner heats up and wears the most. Fully worn they grip 8 % less,
and near the end (past 85 %) they drop another 6 %: driving normally they reach the end of the race at ~80 %, just
before that; whoever abuses them runs out of tyres. The panel, next to the speedometer, shows all four: the color is
the temperature (blue cold, green in the window, yellow to red overheated), the number the °C, the small bar how much
rubber is left, and a white border that it is locked or spinning.

## Understeer and oversteer

The front axle limits how much the car turns (if it isn't enough, the nose runs wide: understeer); if the rear isn't
enough to hold the corner, the rear steps out and the car ends up sideways (oversteer) until you lift or
countersteer. Both axles have to hold the corner: with a light rear (no rear wing, or a very oversteery setup) the car
turns no more than the rear can hold (with a 5 % margin, going sideways) and the rear sliding sideways slows the car.
What the rear spends braking or pushing does not tighten the corner: it opens it. And sideways sliding is only slowed
by what the tyres have left after turning: turning at the limit, the car keeps drifting wide. In a corner with no
pedals it is the same as the measured grip; what changes is braking hard while turning (the rear goes light),
releasing the brake gradually on entry (the nose bites and the car rotates) and flooring it in a slow corner (the
rear steps out). Lateral weight transfer also takes away grip, but that is already included in the measured lateral
grip.

## Setup

In the menu, per track: front and rear wing from 1 to 10 and mechanical balance from -5 to 5 (the anti-roll bars:
which axle takes more of the lateral weight transfer; it is what is left for slow corners, where there is almost no
downforce). And the **brake bias**, from -5 to 5: further forward the car brakes more stably but locks the fronts
sooner and brakes a bit less; further back it brakes more and rotates on corner entry, until the rears lock. Each
track comes with a recommended one, the one the teams use (`tune` in `tracks/index.js`: Monza 1/1, Barcelona 8/8…),
and the rivals use that one; yours is remembered per track. Below the controls the menu says how the car ends up: top
speed, grip in fast corners and whether it understeers or oversteers in slow and fast corners.

## Collisions

`src/sim/collision.js`, with impulses, like a 2D physics engine. Besides its forward speed, each car has a sideways
speed and a spin left by impacts, which the tyres gradually damp (faster the more grip). Between cars, each one is a
set of parts 5.6 × 2 m in total (front wing, nose, the four protruding wheels, sidepods, gearbox and rear wing;
`ZONES` in `src/sim/damage.js`): the collision is detected part against part with the separating axis test, the
contact point is the average of the corners that ended up inside the other part, and the impulse depends on how fast
they approach each other there (with a little bounce and friction). **Wheel against wheel** is different: the tyre
grips much more and the part in contact spins faster than the car, so the faster car drags the slower one and both
twist; and if a front wheel hits a rear wheel from behind, it climbs over it: it loses speed, is left spinning and the
suspension breaks. If you hit someone from behind, they get pushed; if the hit is off-center, the cars spin, and a
hard one sends you into a spin.

Against the walls, the car is three circles along its length: a glancing hit barely slows it and straightens it
against the wall; head-on, it slows down and bounces. Resting against the wall without approaching it, the car slides
without slowing down.

## Damage

`src/sim/damage.js`, in the menu: off, reduced or real. Each hit breaks the part where it lands depending on how hard
it is (from a few m/s of change in speed at the contact point; hits add up), with its side (left or right) for when
they need to be drawn:

- **front wing:** the flaps first, then the whole wing. Its downforce is lost: in slow corners it is barely
  noticeable and in fast ones the nose won't turn;
- **rear wing:** less downforce at the rear (the rear steps out in fast corners) and less drag (more top speed);
- **sidepod and floor:** less downforce and the engine overheats (it produces less power);
- **suspension** of each wheel: bent, that wheel grips less and the car pulls to one side; broken, retirement;
- **puncture** (someone else's wing cutting the tyre, or a hard wheel-to-wheel hit): the tyre deflates in 4 s, grips
  half and slows the car.

With damage on one side only, the car grips differently depending on which way it turns (in a corner the weight goes
to the outside wheels). A car that retires brakes to a stop and after 2 s it is removed from the track; the table
shows "AB". With reduced damage everything breaks half as much and nothing completely, with no punctures or
retirements. When your car has something broken, a diagram seen from above appears on the right, each part in its
color (yellow, orange, red; broken, only the outline).

With `?test` in the URL, the keys **1** to **9** break parts (1–2 front wing left/right, 3–4 rear, 5–6 sidepods,
7 rear left puncture, 8 front right suspension, 9 broken steering) and **0** repairs everything. The thresholds were
tuned with `GAME=1 DAMAGE=real HITS=1 node rl/race_eval.js models/v22/fase18.json` (how many cars break something per
race and how hard the hits on each part are).

## Calibration against real laps

The car's numbers (`cars/f1-2025.json`) were fitted with `tools/calibrate.js` against the 2025 poles on the 8 tracks
(what `tools/layout.py` already downloaded to `tools/.cache/`):

```bash
node tools/calibrate.js          # how the car does as it is (and tools/.out/calibration.html with the charts)
node tools/calibrate.js --fit    # searches for the numbers that fit best and writes them
```

It simulates each lap on the line the network drives and compares it with the real speed along the lap
(`tools/openf1.js`: the 5 best qualifying laps, projected onto the layout), the top speed with the speed traps, and
it also requires each track's setup to be the fastest one there (that is how the cost of the wing is fitted). Things
to know:

- The speed comes from the positions (~4 per second), not from the car's telemetry: the times jitter, so it is
  smoothed and the top speed comes out a few km/h too high (the real one is the speed trap's). Braking can't be
  measured well, so braking and load sensitivity are fixed at reasonable values.
- The game's chicanes (the Monza chicanes, the last one at Montreal) ended up more open than the real ones: there the
  game is faster, which is why the error counts linearly past 15 km/h.
- Grip (`mu`) is capped at 1.9, which gives a slick tyre: without a cap the fit trades downforce for mechanical grip.
  With that cap the car has more downforce (equal to its weight at ~165 km/h) and less grip at low speed.
- Result: top speed from 310 to 355 km/h depending on the track (like the speed traps), ~2.0 g in slow corners, ~5 g
  at 250 km/h and ~6.2 g at 300 km/h, braking up to ~6 g, and simulated laps from -4.3 to +0.7 s off pole (the
  fastest, on the tracks with chicanes).

`node tools/lapcompare.js` plots the real pole against the game network doing a lap (`tools/.out/laps.html`).

The gears and RPM still come from `tools/car_profile.py` (the 15 fastest laps of a race in OpenF1:
`python3 tools/car_profile.py Interlagos 2023 cars/f1-2023.json`), which also measures acceleration, braking and
lateral grip, what the old physics used.
