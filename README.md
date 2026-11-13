# Fórmula ½

A racing game for the browser with an "old-school" render engine (one ray per screen column). The F1 tracks are built
from the **real layout**, taken from telemetry (shape, lap length and elevation), the car has physics calibrated
against real laps, and the rivals drive with a neural network trained with reinforcement learning.

## Play

```bash
python3 serve.py
```

Open http://localhost:8123. A local server is needed because the game reads the image pixels. `serve.py` tells the
browser not to cache, so every reload uses the latest version.

Published on AWS (S3 + CloudFront) on every push to `main`: see [docs/deployment.md](docs/deployment.md).

### The menu

Before the start there is a **menu** (it remembers what you chose last). The main screen shows the mode, the chosen
**car** (the 3D model with its livery) and the **track** (its layout); clicking each one opens its own screen to
change it (with ← → or the arrow keys; the car can be rotated by dragging it). The **setup** and the **options**
(difficulty, rivals, laps, camera, damage, assists and sound) are on separate screens; Enter or Esc go back to the
main one.

- **Mode:** **Race** ("Carrera"; the default: you and one car from each rival team; with the full grid, 22 cars;
  with a standings table and a replay at the end) or **Time trial** ("Contrarreloj"; alone on track, unlimited laps
  and a semi-transparent **ghost** that repeats your best lap, so you can see where you gain or lose time). There is
  no ghost in a race.
- **Team:** Hierrari, Merchoedes, Red Toro, McLarrón, Austin Martini, Allpain, Willyams, Audiós, Haash, AlfaTorito or
  Cadillaque, each with its colors (bodywork, livery details and helmet) and its two drivers, made up from the 2026
  grid, with their numbers (Jorge Rústico and Kimi Antojo at Merchoedes, Carlos Le Clic and Luis Jamónton at
  Hierrari, Max Verstapón, Lando Nórdico, Franco Colapuntos…; `src/race/teams.js`). As in F1, the camera on top (the
  "T") is black on each team's first car and yellow on the second. When you choose the car you also choose which of
  the two drivers you are. The teams doing best in the championship (`STANDINGS` in `src/race/teams.js`, currently
  Merchoedes first) usually start ahead (with some randomness, as in qualifying) and have the best cars within the
  chosen difficulty. The table shows each driver's three-letter code, and the results screen shows the name.
- **Difficulty:** Easy, Normal, Hard or Expert ("Fácil", "Normal", "Difícil", "Experto"). With the trained network
  (the default) it changes the rivals' grip and power: on Easy, from 0.9 times yours (the best team) to 0.85 (the
  worst); on Expert, from 1.1 to 1.06. With the classic AI, it changes their pace (at Interlagos, from laps of
  ~75–80 s on Easy to ~69–70 s on Expert).
- **Track:** Interlagos, Monza, Albert Park, Barcelona, Montreal, Spa, Silverstone or Red Bull Ring, all with real
  elevation; and **laps** (1, 3, 5 or 10).
- **Rivals:** 1, 3, 7, 10 (the default: the first driver of each of the other teams) or 21 (the full grid: both cars
  of each of the other teams and your teammate). With fewer, they are picked spread across the championship, so
  there are still fast and slow cars; with just one, it is a one-on-one against the best team's car. Difficulty,
  laps and rivals only apply to races.
- **Setup:** wings, mechanical balance and brake bias, per track (what each one does:
  [docs/physics.md](docs/physics.md#setup)).
- **Gearbox:** automatic or manual. It is chosen here and stays fixed during the race.
- **Damage:** off, reduced or real ([docs/physics.md](docs/physics.md#damage)).
- **Sound:** on or off, and the master, engine and menu music volumes. It always starts off (turn it on with N or
  from the menu); the volumes are remembered.

### The race

**Start:** the start lights work like in F1: 5 red lights come on, one per second, and after a random wait (0.4 to
2.6 s) they all go out. While the lights are on, the throttle revs the engine without moving the car. When they go
out, the start depends on the rpm at that moment: between **9,500 and 10,500** it is perfect; with too few revs the
engine bogs down, and near the rev limiter the tyres spin (in both cases less acceleration reaches the ground for the
first second and a half). If you were not on the throttle, you start when you press it (with the engine at low
revs). The shift lights on the steering wheel and on the panel show the rpm. The rivals also rev up, each in its own
way, and react with their own timing.

You start last on the grid. On the left, below the times, is the **standings table** with each car's gap (in
seconds) to the car ahead: every car records when it passed each point of the track, and the gap is how long ago the
car ahead passed where the car behind is now (if it was lapped, it says "+1 V"). The panel shows your position, the
tyres (temperature and wear) and, if something broke, a diagram of the car with the damage. At the end the result
appears and, a few seconds later, the **replay** of the race, with several cameras.

### Controls

| | Keyboard | Gamepad |
|---|---|---|
| Throttle | I / ↑ / W | right trigger |
| Brake and reverse | K / ↓ / S | left trigger |
| Steer | J L / ← → / A D | left stick |
| Shift up / down (manual gearbox) | O or X / U or Z | RB/R1 / LB/L1 |
| Cockpit or outside view | C | Y/△ |
| Show the racing line | G | X/□ |
| Sound | N | |
| Restart the race | R | Back/Share |
| Start / back to the menu | Enter / Esc | Start |
| In the replay: camera, car followed | C, ← → (or J L) | Y/△, d-pad |

Keys are recognized both by letter and by position, so they work with any keyboard layout. With the keyboard the
pedals are all or nothing, but the throttle takes 1/3 s to open (like a foot), so flooring it mid-corner does not
suddenly kick the rear out. With a gamepad (Xbox, PlayStation or any with the standard mapping) all three are
**progressive**; the stick has a dead zone and steers less near the center, for fine corrections at high speed.

Each race starts with the camera you chose in Options (cockpit if you chose none). The racing line changes color with
your speed: **green** you can accelerate, **yellow** hold or lift, **red** you have to brake.

In the URL: `?ai=classic` makes the rivals drive with the classic AI (the hand-written driver from before the
network), `?ai=models/….json` with another network, `?cpu` draws without WebGL and `?test` enables keys that break
parts of the car (see [docs/physics.md](docs/physics.md#damage)).

## How it works

- [docs/tracks.md](docs/tracks.md): from layout to map, real layouts from F1 telemetry and how to add a track.
- [docs/physics.md](docs/physics.md): the car model (aerodynamics, tyres, balance, lockups, temperature), wake,
  collisions, damage, setup and the calibration against real laps.
- [docs/ai.md](docs/ai.md): the racing line, the network trained with reinforcement learning that drives the rivals
  (how it is trained and its history) and the classic AI, the hand-written driver from before.
- [docs/render.md](docs/render.md): Voxel Space, the 3D car models, WebGL and CPU, and the replay.
- [docs/sound.md](docs/sound.md): the engines and the music, synthesized.

## Working on the code

```bash
npm install
npm test          # tests in test/, under a second
npm run lint      # ESLint (errors and layers), Prettier and types
npm run regress   # fixed-seed races compared bit for bit (~1 min)
```

How it is organized (layers, ports, what goes where) and how it is checked:
[docs/architecture.md](docs/architecture.md).
