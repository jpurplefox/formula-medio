# The rivals

The rivals drive with a neural network trained with reinforcement learning, the one named by `GAME_NET` in
`src/drivers/policy.js`. The classic AI (below) is the hand-written driver from before the network: it is only used if
the network fails to load or with `?ai=classic`, and as a reference for training and measuring. Both use the racing
line.

## The racing line

`src/sim/racingline.js` computes the line corner by corner when the track loads, the way drivers take it: arrive
from the outside, touch the apex (the tightest point) on the inside and exit wide again (in esses, from apex to
apex), with a final smoothing pass that removes zigzags. Then it computes the maximum speed at each point from the
car's limits (`src/sim/lapsim.js`): what the grip can hold in the corner, how much it has to brake before it and how
much the engine accelerates after it. How it looks in the game: [render.md](render.md#the-racing-line).

## The network, trained with reinforcement learning (`rl/`)

A neural network learns to drive by itself, with the same physics as the game, in stages:

1. **Alone on track** (time trial): it learns to lap as fast as possible on the 8 tracks.
2. **Against other cars** (`rl/race.js`): races of 4 learning cars (the same network, against itself) and 0 to 6
   rivals with the classic AI at varied paces; they start on a grid, in single file or spread around the track.
   Besides the meters, contacts between cars are penalized (much more for the car that hits the one ahead).

**What it sees** (`src/drivers/sensors.js`, 98 numbers; networks trained before per-wheel grip use the first 94):
its car (speed, slip, yaw rate, steering, pedals, gear, rpm, grip of each axle, slipstream, how much better or worse
than average it is, and tyre wear), its position on the track, how much the track turns at 20, 40… 450 m (what a
driver knows by heart), 19 rays that measure the distance to the track edge from -90° to +90°, the 6 nearest rivals
(position, relative speed and where they point; zero in stage 1) and the grip of each wheel depending on what it is
on (so it knows which side went onto the grass).

**What it decides**: steering and pedal (from full brake to full throttle), 20 times per second, progressive.

**What rewards it** (`rl/env.js`): the meters it advances along the centerline; it is penalized for grass, hits
against the wall and standing still or going backwards. Each episode starts at a random point of a random track.

### How it is trained

Python with PyTorch and stable-baselines3 (PPO algorithm) passes the actions to several Node processes
(`rl/worker.js`) that simulate 128 cars at once; on an M4 Pro Mac it runs at about 30,000 steps per second.

```bash
python3 -m venv rl/.venv && rl/.venv/bin/pip install torch stable-baselines3 gymnasium tensorboard
```

1. The F1 tracks are built in Node from `tracks/*.layout.json`. Only the ones that come from an image need to be
   exported first (the part that needs the browser): with `serve.py` running, open
   `http://localhost:8123/rl/bake.html` (it saves the masks in `rl/tracks/`).
2. Train: `rl/.venv/bin/python rl/train.py --steps 30000000 --name etapa1` (the curves, with
   `rl/.venv/bin/tensorboard --logdir rl/runs`).
3. Export the network to JSON: `rl/.venv/bin/python rl/export.py rl/runs/etapa1/model.zip models/etapa1.json`.
4. Measure it against the classic AI: `node rl/eval.js models/etapa1.json`.
5. Watch it in the game: `http://localhost:8123/?ai=models/etapa1.json` (the rivals drive with that network).

To keep training from falling apart (PPO is unstable), the learning rate decreases gradually to 0, each update uses
32,768 steps and the rewards are normalized; it is still worth measuring the checkpoints with `rl/eval.js` and
keeping the best one. Each episode starts at any point of the lap, sometimes stopped or sideways and with wheels off
the track, so it also learns to start and to get back on the track.

To measure in a race: `node rl/race_eval.js models/v22/fase18.json` (22 cars, half with the network and half with the
classic AI; with `CARS=8` in front, 8 cars): average position, contacts and grass.

### History

**Stage 1** (`models/etapa1.json`, 60 million steps, ~35 minutes): completes the laps on the 8 tracks, on average
7 % faster than the classic AI at its best pace (from 1 % at Monza to 15 % at the Red Bull Ring; at Interlagos, 66.2 s
against 70.4 s).

**Stage 2** (`models/etapa2.json`, 35 million more steps):

```bash
rl/.venv/bin/python rl/train.py --race --envs 4 --steps 40000000 --name etapa2 --resume rl/runs/etapa1c/model.zip \
    --fresh-opponents --critic-warmup 3000000 --lr 1e-4
```

Three things were needed so that stage 2 would not undo what had been learned:

- `--fresh-opponents`: the weights that receive the rivals' data were never trained in stage 1 (they were always
  zero) and were left random; set to zero, the network starts out driving exactly the same.
- `--critic-warmup`: with the new reward the critic (the part that estimates how much it will earn) is off, and its
  errors break the part that drives; for the first 3 million steps only the critic learns.
- `--lr 1e-4` and shorter steps (`target_kl` 0.015).

A reward for overtaking and for defending taught it to zigzag and to dive in even when there was contact: it is not
used for now.

Compared with stage 1, in 22-car races it has 18 % fewer contacts and 26 % less time on the grass, with the same pace
(average position 6.9 against 7.2); with 8 cars, 29 % fewer contacts.

**Curriculum** (`models/fase1.json` to `models/fase7.json`): a bigger network (policy 384×384, critic 512×512), cars
with slightly different power, grip and brakes and tyres that wear, and phases that teach one thing at a time (drive
alone, don't crash, overtake, full races) followed by three more phases dedicated to clean driving. Phase 7 had 44 %
fewer contacts than phase 1. Two more attempts (`models/v3/`, `models/v4/`) put clean driving before speed, and the
fifth (`models/v5/`, with per-wheel grip and grass that slows the car) added pace at the starts and a phase against
faster rivals: `models/v5/fase7.json` was the game network, with 36 % fewer contacts than v4, a third of the grass
and slightly faster (in the game the rivals have less grip and power). Details, results and what went wrong along the
way: `rl/CURRICULUM.md`.

Then came herd training (22 cars with the network, from v8 on; recipe in `rl/curriculum.sh`, ~5.5 h:
`NAME=v23 sh rl/curriculum.sh`). The game network today is the one named by `GAME_NET` in `src/drivers/policy.js`.
Only that one is kept in `models/`: the networks from the stages and the earlier attempts (`models/etapa1.json`,
`models/fase1.json` to `fase7.json`, `models/v3/` to `models/v21/`) are in the git history, in commit e9ff553.

## The classic AI

It is the hand-written autopilot that drove the rivals before the network. Today it is kept for when the network
fails to load (or with `?ai=classic`), and as a yardstick: the training runs and measurements in `rl/` use it as a
rival or as a reference (when they say "against the classic AI"). Each rival (`src/drivers/ai.js`) is a car with the
same physics as yours:

- **Steering:** it chases a point on the racing line a few meters ahead (*pure pursuit*) and turns just enough to
  reach it, within what the grip allows.
- **Pedals:** it accelerates or brakes to go at the speed the racing line gives at that point, multiplied by its
  pace (`pace`, depending on the difficulty: `DIFFICULTIES` in `src/race/teams.js`; at Interlagos, from laps of
  ~75–80 s on Easy to ~69–70 s on Expert), with small variations in pace and line. Its racing line is the same one
  you see, but braking closer to the limit (93 % instead of 85 %), and in slow corners they don't go above 0.975 of
  that speed, because faster they run wide and go off.
- **Traffic:** if it catches another car, it moves toward the side where it already is (or where there is more room)
  to overtake; side by side, each one stays on its side (and if both don't fit, the one slightly behind lifts); if
  there is no room to overtake, it stays behind keeping its distance.
- **Side by side:** if the other car is more than half a nose ahead and is not being overtaken, it yields and
  slots in behind.
- If a rival gets stuck, it goes back to the track onto the racing line.
