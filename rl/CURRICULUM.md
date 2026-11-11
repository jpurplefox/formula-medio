# Plan: bigger network and curriculum training

Plan for the reinforcement learning AI round that came after stage 2, with five curriculum attempts. The game
network from this plan was `models/v5/fase7.json` (fifth attempt); today it is the one named by `GAME_NET` in
`src/drivers/policy.js`, trained in a herd (`rl/curriculum.sh`). The networks from here are no longer in `models/`:
they are in the git history (commit e9ff553).

## 1. Bigger network (cheap experiment, first)

- Today: policy and critic of 256×256.
- Try a somewhat bigger policy (384×384 or 3×256) and a bigger critic (512×512): the critic is the one that
  struggles most to estimate the reward with several cars around.
- A model can't be continued with a different size: retrain stage 1 (35–60 min) and compare lap times with
  `rl/eval.js` against `models/etapa1.json`. Alternative: widen the existing network with the new neurons at zero
  (as we did with the rival sensors).
- It costs nothing in the game: 21 cars deciding 20 times per second is still little computation.

## 1b. Different cars and tyre wear (before retraining stage 1)

Since stage 1 is retrained anyway with the big network, the new inputs go in from the start.

- **Per-car variation** (*domain randomization*): power, top speed (drag), grip, brakes and wear rate, subtle (±2 %
  in phases 1–3, up to ±5 % in phase 4). Optional: some noise in the steering or a reaction delay.
- **Physical tyre wear**: today it is only visual (`tyres()` in `src/main.js`). It becomes part of `Car`: it wears
  more with sliding and grip usage, and grip drops with wear.
- **New network inputs** (in the own-car group, before the rivals): relative power, grip, top speed, brakes and wear
  rate, plus the current tyre wear. A driver knows their car; this way it can squeeze a good one instead of driving
  "average".
- Not needed for the rival: it already sees its relative speed.
- **In the game, difficulty comes from here**: same network, rivals with somewhat worse cars and more noise on Easy,
  equal cars and no noise on Expert.

## 2. Curriculum

| Phase | What it learns | Approximate mix |
|---|---|---|
| 1 | Drive alone | 100 % clean track (what we already have) |
| 2 | Don't crash | 25 % clean track, 45 % pack / corner together, 30 % starts with many cars |
| 3 | Overtake | 15 % clean track, 20 % pack, 20 % starts, 45 % chases |
| 4 | Consolidate | 50–60 % full races + review of all scenarios, low LR (~5e-5) |

### General rules

- **Mix, don't replace**: each phase reviews the previous ones to avoid catastrophic forgetting.
- **Short episodes** (10–20 s) in the scenarios: many more attempts per hour at the rare situations.
- **Warm up the critic** (`--critic-warmup`) every time the reward changes.
- **The reward depends only on things the network sees**: with more than 2 rivals nearby there is no reward for
  overtaking and contact weighs more; the network works out "I'm in a pack" by itself and prioritizes safety.

### Phase 2: don't crash

- Scenarios with 1–2 rivals arriving at a corner together (side by side, before the braking point).
- Slipstream chases and starts with many cars until past the first corner.
- **Penalize danger, not closeness**: penalty for time to collision < 0.5 s and for contact (more for the one who
  rams from behind). Don't reward "keeping X meters", because later it has to be unlearned to overtake.
- Slipstream: don't penalize it; if it is rewarded, only for the gain it gives (speed or meters), never for being
  there.

### Phase 3: overtake

- The car ahead is the classic AI with pace 0.85–0.95 (less grip and top speed, drives normally; doesn't brake
  suddenly).
- On a straight: small difference (~0.95) and the slipstream does the rest. In a corner: more difference and start
  close.
- Later, rivals that defend (close the inside).
- An overtake is rewarded only if it holds for 2–3 s / 50 m, with no contact in the preceding window and no
  shortcuts over the grass.
- Always 1–2 rivals nearby; if there are more, the safety rule applies.

### Phase 4: consolidate

- Full races with the same reward as the scenarios (if it changes, warm up the critic).
- Varied rivals: classic AI at different paces, copies of the network and earlier versions from each phase (prevents
  it from learning things that only work against itself).
- If something gets worse (for example contacts at the start), raise the weight of that scenario in the review.
- With different cars, overtakes (better car) and defenses (worse car) appear by themselves.
- Defense: small penalty for being overtaken, penalty for changing direction more than once with someone close
  behind (the "one move" rule) and contact as always (the one who rams pays more).

### Don't confuse a better car with better driving

- **The critic sees the car**: with the own-car inputs it predicts more reward for a better car, and PPO learns from
  the advantage (actual reward minus expected). A good car doesn't inflate what is learned; only doing better than
  that car allowed counts.
- **The reward is per step, not per result**: progress, clean overtakes, contact, danger. There is no reward for
  final position, which is what depends most on the car.
- **Optional**: progress measured against that car's theoretical pace, so the reward scale doesn't depend on the car.
- **Evaluation with fixed conditions**: all checkpoints run the same races (same seed, same cars) and each one drives
  each car once, rotating; or all cars equal.

## What came out of the first attempt (and what was changed)

- **Phase 1, good**: the big network with different cars and tyres that wear does the same laps as stage 1 and, in
  a 22-car race, does better than stage 2 (average position 7.1 against 7.3) with half the grass.
- **Phases 2–4, bad in full races**: in the scenarios everything improved (contacts in the pack 2.5 → 1.1 per km,
  zigzags 1.25 → 0.16), but in a 22-car race it dropped to average position 14 and got stuck at the first corner.
  It learned that braking is "safe":
  - The danger penalty (up to 2 per second) weighed more than what advancing through a corner gives (~0.6 per
    second): with someone close it paid to lift.
  - Standing still for 6 s ended the episode with a small penalty: in a pile-up, where contacts and danger were
    coming, quitting there was cheaper than getting out. It never learned to get unstuck.
- **Changes**: danger penalty cut to a third (at most 0.6 per second); stuck, on the grass or going backwards no
  longer ends the episode: it is rescued with a penalty of 4 and also pays 1 per second standing still; the
  per-scenario measurement shows meters covered and rescues (a timid network crashes little but advances less); the
  network is also rescued automatically in the game and in `rl/race_eval.js`, like the classic AI.
- **Second attempt**: it no longer gets stuck (average position in 22 cars 14.2 → 9.5) and it is the cleanest: in 8
  cars half the contacts of phase 1 (33 against 56), less zigzag and fewer contacts at starts and in the pack. But it
  still finishes behind phase 1 in a 22-car race (9.5 against 7.1): it overtakes less (0.24 overtakes per race
  against 0.45) and loses places in the pack at the start. The solo lap is almost the same (0.939 against 0.928).

## Phases 5–7: clean driving

Priority: don't crash. Measuring what kind of contact each one was, most were **side** contacts, and the penalty
treated them as if it had been hit (25 %): squeezing the car alongside was cheap. Each phase starts from the previous
one (30 M steps, LR 5e-5, more weight on starts and the pack).

- **Phase 5**: in a side contact the one who moved onto the other pays in full; danger also looks at the car
  alongside (if it moves onto it and would touch it in less than 0.6 s).
- **Phase 6**: danger ahead is checked at 1 s (before 0.6) and causing a contact costs 6 (before 4). It rammed less,
  but it swerved to the side and side contacts went up again.
- **Phase 7**: side danger also at 1 s.

Contacts per race (contact frames of the cars with the network; average of the races with equal cars and with
different cars rotating), grass and average position against the classic AI on Hard:

| Network | Contacts, 22 cars | Contacts, 8 cars | Grass, 22 cars | Position, 22 cars |
|---|---|---|---|---|
| phase 1 | 447 | 67 | 59 s | 7.4 |
| phase 4 | 382 | 50 | 59 s | 9.6 |
| phase 5 | 299 | 39 | 59 s | 10.4 |
| phase 6 | 318 | 33 | 47 s | 10.2 |
| **phase 7** | **249** | **38** | **41 s** | 9.7 |

- Phase 7 has **44 % fewer contacts than phase 1** and the lowest time on the grass. Side contacts between networks
  dropped from 1031 to 206; what remains is almost all with the classic AI, which didn't learn to look after itself.
- Chases: the one that overtakes most (0.60 per chase) without being overtaken. Solo lap: 0.942 (phase 1: 0.928).
- The cost: it ends up mid-table against the classic AI (which crashes more and doesn't lift).
- `rl/race_eval.js` now reports how many contacts the network caused (hit the car ahead or squeezed the car
  alongside).

## Third attempt: clean first, speed later

With what was learned, the curriculum is rebuilt from scratch (models in `models/v3/`) and compared with phase 7. The
idea: first learn to drive clean and only then to go fast and overtake.

| Phase | What it learns | Reward | Mix |
|---|---|---|---|
| 1 | Drive inside the track | Advance as always; grass ×3 and wall ×2; fewer steps (don't over-optimize) | alone |
| 2 | Don't crash in a group | Advance ×0.7; no reward for overtaking; strict contact budget; pace floor | pack, starts, alone |
| 3 | Don't crash in a race | Same as 2 | races, starts, pack, follow a slower car, alone |
| 4 | Speed without crashing | Advance ×1, same contact budget | races + review |
| 5 | Overtake safely | Reward for a clean overtake (as before) | chases + review |
| 6 | Integrate | Everything together, low LR, rivals from earlier phases | races + review |

- **Grass more expensive in phase 1** instead of less reward for advancing: to avoid others you need to control the
  car at the limit, and that is learned by going fast. "Clean" alone on track means not going off.
- **Pace floor** (phases 2–6): with a free track ahead (nobody within 40 m in its lane), going below 75 % of the
  racing line's speed is penalized (up to 1 per second). With someone ahead it doesn't apply: following a slower car
  is fine. It is what keeps it from learning again that braking is "safe".
- **Contact budget**: the penalty for a caused contact (hitting the car ahead or squeezing the car alongside) is
  multiplied by a factor that adjusts itself during training. If the network causes more contacts per km than the
  budget, the factor goes up; if it causes fewer, it goes down slowly (between 0.5 and 5). The factor carries over
  from one phase to the next, so raising the reward for advancing in phase 4 can't be bought with contacts.
- **Overtakes** not rewarded until phase 5: in the clean-driving phases following a slower car is the right thing.

### Third attempt results

Contacts per race (average with equal cars and with different cars rotating), caused by the network, grass and
average position against the classic AI on Hard; solo lap with `rl/eval.js` (lower is faster):

| Network | Contacts, 22 cars | Caused, 22 | Contacts, 8 cars | Grass, 22 | Position, 22 | Position, 8 | Solo lap |
|---|---|---|---|---|---|---|---|
| phase 7 (2nd attempt) | 249 | 193 | 38 | 41 s | 9.7 | 3.7 | 0.942 |
| v3 phase 3 (clean) | 182 | 130 | 27 | 183 s | 16.4 | 5.9 | |
| v3 phase 4 (speed) | 159 | 107 | 24 | 108 s | 16.1 | 5.6 | 0.953 |
| v3 phase 5 (overtake) | 195 | 134 | 25 | 70 s | 15.2 | 5.5 | |
| v3 phase 6 (integrate) | 194 | 128 | 23 | 49 s | 14.9 | 5.9 | 0.965 |

- **Cleaner**: phase 6 has 22 % fewer contacts than phase 7 in 22 cars (causes 34 % fewer) and 40 % fewer in 8.
- **But much slower**: it loses about 5 places per race against the classic AI and in 8 cars the 4 networks almost
  always finish behind the 4 AIs. Alone, its lap is 3 % slower than that of its own phase 1 (0.932).
- **Why**: the budget (half the contacts of phase 7) was too strict. The penalty scale hit the cap (5) in phase 2
  and never came down: throughout the curriculum what weighed most was not touching, and with someone ahead the pace
  floor doesn't apply, so in traffic it pays to stay behind. Phase 4 gained almost no pace.
- In phases 3 and 4 the grass in a 22-car race is high: the network goes wide onto the grass to avoid contact.

## Fourth attempt: keep the pace instead of rewarding overtakes

Models in `models/v4/` (~1.5 h). It starts from v3 phase 4 (the one with the fewest contacts) and changes four
things:

- **No reward for overtaking; pace floor always** (except when crowded: more than 3 cars within 30 m). To avoid
  losing pace behind a slower car it has to overtake it; overtaking comes by itself, it isn't rewarded.
- **Chases with the car ahead at a disadvantage**: less grip and power (−20 % at the start of the phase, −8 % at the
  end), so overtaking is possible without forcing it.
- **Conservative starts and pile-ups**: there a caused contact costs ×2.5 and danger is checked further ahead (×1.5).
- **Reachable budget**: 80 % of the caused contacts of phase 7 (not 50 %), with initial scale 2.
- **More different cars**: from −15 % to +20 % (before ±5 %), so the difficulty can be raised in the game by giving
  them more grip. The car inputs are now normalized with ±20 % (`SETUP_SPREAD`); the earlier networks were rescaled
  with `rl/rescale_setup.py` and give exactly the same results.

| Phase | Mix | Rivals | Steps |
|---|---|---|---|
| v4 phase 5 (pace without crashing) | races 35, chases 25, starts 15, pack 15, alone 10 | phase 7, v3 phase 4 | 35 M |
| v4 phase 6 (integrate) | races 55, starts 15, pack 10, chases 10, alone 10 | + v4 phase 5 | 30 M |

The penalty scale ended at 0.9 in phase 5 (within budget) and at 2.9 in phase 6.

### Fourth attempt results

Against the classic AI, same as the previous table:

| Network | Contacts, 22 cars | Caused, 22 | Contacts, 8 cars | Grass, 22 | Position, 22 | Position, 8 | Solo lap |
|---|---|---|---|---|---|---|---|
| phase 7 | 249 | 193 | 38 | 41 s | 9.7 | 3.7 | 0.942 |
| v3 phase 4 | 159 | 107 | 24 | 108 s | 16.1 | 5.6 | 0.953 |
| v3 phase 6 | 194 | 128 | 23 | 49 s | 14.9 | 5.9 | 0.965 |
| v4 phase 5 | 125 | 82 | 20 | 84 s | 16.2 | 5.6 | 0.971 |
| v4 phase 6 | **107** | **68** | **18** | 73 s | 16.3 | 5.8 | 0.969 |

Game-style race (`GAME=1`: 21 cars with the network and one classic AI at the highest Hard pace acting as the
player; the 8 tracks), per network car:

| Network | Contacts | Caused | Grass | Winner's time | Player's finishing position |
|---|---|---|---|---|---|
| phase 7 | 30.9 | 24.7 | 4.2 s | 240.1 s | 11.9 |
| v3 phase 4 | 16.1 | 11.9 | 9.4 s | 251.2 s | 2.6 |
| v3 phase 6 | 14.7 | 11.5 | 3.8 s | 250.4 s | 3.8 |
| v4 phase 5 | 12.5 | 9.2 | 7.3 s | 251.2 s | 2.4 |
| v4 phase 6 | **11.5** | **8.9** | 5.9 s | 247.9 s | 3.4 |

Scenarios (`rl/scenario_eval.js`, caused contacts per km):

| Network | Pack | Start | Chase | Race |
|---|---|---|---|---|
| phase 7 | 0.77 | 4.10 | 0.65 | 0.82 |
| v3 phase 4 | 0.34 | 2.98 | 0.76 | 0.52 |
| v4 phase 5 | 0.62 | 2.17 | 0.72 | 0.39 |
| v4 phase 6 | 0.53 | **1.98** | **0.58** | **0.34** |

- **The cleanest of all**: v4 phase 6 has 57 % fewer contacts than phase 7 in 22 cars (causes 65 % fewer) and 22 %
  fewer than v3 phase 6. In the game-style race, 11.5 contacts per car against 30.9.
- **Starts**: caused contacts drop to half of phase 7's and a third less than v3's.
- **Pace**: in network traffic, the winner is 1 % faster than with v3 and 3 % slower than with phase 7. Alone, the
  lap is 2–3 % slower than phase 7's: in the game it is compensated with more grip.
- **Grass**: still higher than in phase 7; in 22 cars it goes wide to avoid contact.
- Against the classic AI it still loses places: the classic AI is more aggressive and the network gives way.

## Fifth attempt (v5): per-wheel grip and pace at the starts

Models in `models/v5/` (~3 h from scratch with `rl/curriculum.sh`). The game changes: grip is computed per wheel
depending on the surface (the grass slows the car and pulls it outward), the layouts come from telemetry and the
network gets 98 inputs (the grip of each wheel at the end). The recipe adds `paceCrowd` in phases 5–7 (pace floor also
when crowded, so it doesn't line up in single file at the starts) and phase 7, against rivals 8 % faster.

Game-style race (`GAME=1`, Hard as it was then, with the grass rescue described below):

| Network | Contacts per car | Caused | Grass per car | Winner | Player's position |
|---|---|---|---|---|---|
| v4 phase 6 | 10.5 | 8.4 | 9.5 s | 243.2 s | 2.1 |
| v5 phase 3 | 7.3 | 5.9 | — | 243.6 s | 2.4 |
| v5 phase 4 | **4.6** | **3.3** | — | 242.1 s | 3.0 |
| v5 phase 5 | 7.7 | 6.0 | — | 241.3 s | 4.4 |
| v5 phase 6 | 6.7 | 4.9 | 2.9 s | 240.3 s | 4.9 |
| v5 phase 7 | 6.7 | 5.0 | **2.7 s** | **239.8 s** | 6.9 |

- **Phase 1 alone is already faster** than v4 and the classic AI: 1 to 5 s per lap depending on the track.
- **Phases 5–7 trade cleanliness for pace**: phase 4 has the fewest contacts; phase 7 is the fastest (6–8 s per race
  more than v4 with the same car), with the same contacts as phase 6. In the game it is compensated with less grip
  and power for the rivals (`setups` in `src/race/teams.js`, from 0.83 on Easy to 1.02 on Expert).
- **Starts**: phase 6 advances 8 % more than v4 with the same caused contacts; phase 7 has somewhat more contacts
  again.
- **What went wrong: cars lost on the grass.** Measured without changes, v5 spent 23–27 s per car on the grass, but
  not from cutting corners (with just one wheel off it almost never goes): 2 to 6 cars per race spent minutes driving
  around there. In training it is rescued after 6 s on the grass, so it never learned to come back from far away, and
  in the game it was only rescued when standing still (on the grass it drives at ~90 km/h). Now `NeuralDriver`
  (`src/drivers/policy.js`) also rescues it after 6 s on the grass, the same as in training.

## Metrics per phase

- Solo flying lap (`rl/eval.js`): must not get worse.
- Contacts per kilometer in the pack.
- Clean overtakes per 10 chases.
- Position, contacts and grass in a full race (`rl/race_eval.js`, 22 and 8 cars).

## How to run it

`rl/curriculum.sh` trains the game network's recipe from scratch: phases 1–4 of the third attempt, 5–6 of the
fourth, and a phase 7 for pace against faster rivals (~3 h). In phase 7 the rivals have 8 % more grip and power
(`--rivals-boost 0.08`) and the classic AI runs at 1–1.1 pace: among equal networks the pace only improves up to that
of the car ahead, so it needs faster cars ahead. It needs `rl/.venv` and the tracks exported in `rl/tracks/`
(docs/ai.md, "How it is trained").

```bash
NAME=v5 sh rl/curriculum.sh        # models in models/v5/, logs and checkpoints in rl/runs/v5faseN
NAME=v5 sh rl/curriculum.sh 5      # redo from phase 5 (uses rl/runs/v5fase4/model.zip)
```

Each phase starts from the final model of the previous one and is exported to `models/$NAME/faseN.json`. When
continuing a model, each phase's learning rate goes from its initial value (`--lr`) to 0 within that phase. At the
end it measures the new network against the game's in the game-style race; if it is better, `GAME_NET` is changed in
`src/drivers/policy.js`.

To change the recipe, what matters most:
- `--contact-budget` (fraction of phase 7's caused contacts that is allowed) and `--contact-scale`.
- `--rewards`: `progress`, `pass`, `paceFloor`, `paceAlways`, `paceCrowd`, `crowd`, `grass`, `wall` (`rl/race.js`,
  `rl/env.js`). `paceCrowd` (since the fifth attempt of the recipe, 0.6): the pace floor also when crowded, lower, so
  that at the starts falling into single file by lifting costs time and staying side by side pays off.
- `--spread`: how much the cars vary (from −15 % to +20 % today). Going beyond ±20 % requires changing `SETUP_SPREAD`
  in `src/drivers/sensors.js` and rescaling the old networks with `rl/rescale_setup.py`.
- The disadvantage of the car ahead in chases: `CHASE_HANDICAP` in `rl/race.js`.

The scripts of the earlier attempts (the 7-phase `curriculum.sh`, `curriculum3.sh`, `curriculum4.sh`) are in commit
b3253db.

- Network: policy 384×384, critic 512×512.
- Scenarios and rewards: `rl/race.js`. Random car and tyre variation: `randomSetup` and `randomTyres` in `rl/env.js`.
- Wear calibrated with `node rl/wear.js` (a normal lap ≈ 1 with `wearRate = 1 / lap length`).

## How it is measured

```bash
GAME=1 node rl/race_eval.js models/v22/fase18.json                 # game-style race: 21 networks and a "player"
node rl/eval.js models/v22/fase18.json                              # solo flying lap, equal cars
node rl/scenario_eval.js models/a.json models/b.json                # each scenario, same races
SPREAD=0.05 node rl/race_eval.js models/v22/fase18.json             # 22 different cars, with rotation
```
