"""Trains the AI with PPO.

Training in phases (rl/CURRICULUM.md). Phase 1, alone on track with slightly different cars:
    rl/.venv/bin/python rl/train.py --steps 60_000_000 --name fase1
Phases 2 to 4, in scenarios with other cars, each one starting from the previous one (the exact commands are in
rl/CURRICULUM.md):
    rl/.venv/bin/python rl/train.py --race --envs 4 --mix pack:45,start:30,solo:25 --steps 30_000_000 --name fase2 \
        --resume rl/runs/fase1/model.zip --fresh-opponents --critic-warmup 3_000_000 --lr 1e-4

    rl/.venv/bin/tensorboard --logdir rl/runs        (to see the curves)

Saves the model every so often in rl/runs/<name>/ (and model.zip at the end). With --resume it continues from a model.
"""

import argparse
import json
import os
import subprocess
import time
from collections import defaultdict, deque
from pathlib import Path

import numpy as np
import torch
from stable_baselines3 import PPO
from stable_baselines3.common.callbacks import BaseCallback, CheckpointCallback
from stable_baselines3.common.vec_env import VecNormalize

from racing_env import TRACKS, RacingVecEnv

ROOT = Path(__file__).resolve().parent.parent


def opponent_columns() -> list[tuple[int, int]]:
    """Where the opponents' values are in the observation (src/drivers/sensors.js), as (start, count): their
    positions and speeds (wheels, limits and damage come after them, so they are not the last ones) and, at the end,
    their pedals and steering."""
    code = ("import('./src/drivers/sensors.js').then((m) => console.log(m.OPPONENT_START, m.OPPONENT_SIZE, "
            "m.OPPONENT_INPUT_START, m.OPPONENT_INPUT_SIZE))")
    out = subprocess.run(["node", "--input-type=module", "-e", code], cwd=ROOT, capture_output=True, text=True, check=True)
    a, b, c, d = map(int, out.stdout.split())
    return [(a, b), (c, d)]


NEW_ACTION_STD = 0.5  # how much the new outputs explore at the start (the old ones keep what they had)


def widen(old: PPO, env) -> PPO:
    """The same model for a longer observation (new values at the end, like the opponents' pedals) or with more
    outputs (the rpm on the grid): the weights that receive the new values and those of the new outputs start at
    zero, so it drives exactly the same until it learns to use them; the new outputs explore with NEW_ACTION_STD.
    Used to continue from phase 1 without training it again."""
    new = PPO(type(old.policy), env, n_steps=old.n_steps, batch_size=old.batch_size, n_epochs=old.n_epochs,
              learning_rate=old.learning_rate, gamma=old.gamma, gae_lambda=old.gae_lambda, clip_range=old.clip_range,
              ent_coef=old.ent_coef, target_kl=old.target_kl, policy_kwargs=old.policy_kwargs,
              tensorboard_log=old.tensorboard_log, device="cpu", verbose=1)
    state = new.policy.state_dict()
    with torch.no_grad():
        for key, value in old.policy.state_dict().items():
            target = state[key]
            if target.shape == value.shape:
                target.copy_(value)
                continue
            # the first layer (more columns) or the output layer (more rows): old values in place, new ones at zero
            target.zero_()
            if key == "log_std":
                target.fill_(float(np.log(NEW_ACTION_STD)))
            target[tuple(slice(0, n) for n in value.shape)].copy_(value)
    new.policy.load_state_dict(state)
    new.num_timesteps = old.num_timesteps
    print(f"Model widened: {old.observation_space.shape[0]} → {env.observation_space.shape[0]} values, "
          f"{old.action_space.shape[0]} → {env.action_space.shape[0]} outputs")
    return new


RUNS = Path(__file__).resolve().parent / "runs"


class RaceStats(BaseCallback):
    """Logs to TensorBoard the lap times of each track and how the episodes end."""

    def __init__(self):
        super().__init__()
        self.laps = defaultdict(lambda: deque(maxlen=50))
        self.ends = deque(maxlen=500)
        self.dist = deque(maxlen=500)
        self.scenarios = defaultdict(lambda: deque(maxlen=200))  # scenario → episodes
        self.start = time.time()

    def _on_step(self) -> bool:
        for info in self.locals["infos"]:
            ep = info.get("episode")
            if ep:
                if "end" in ep:  # in races it never ends early: the car is rescued (see rl/race.js)
                    self.ends.append(ep["end"])
                self.dist.append(ep["dist"])
                if "scenario" in ep:
                    self.scenarios[ep["scenario"]].append(ep)
        env = self.training_env.venv  # under VecNormalize
        for track, lap in env.laps:
            self.laps[track].append(lap)
        env.laps.clear()
        return True

    def _on_rollout_end(self):
        for track, laps in self.laps.items():
            if laps:
                self.logger.record(f"lap/{track}", float(np.mean(laps)))
                self.logger.record(f"lap_best/{track}", float(np.min(laps)))
        if self.ends:
            for kind in ("grass", "stuck", "back", "retired", "time"):
                self.logger.record(f"end/{kind}", self.ends.count(kind) / len(self.ends))
            self.logger.record("episode/meters", float(np.mean(self.dist)))
        for name, eps in self.scenarios.items():
            for key in ("passes", "passed", "hits", "faults", "slow", "danger", "weaves", "rescues", "retired", "lag", "launchCost", "r"):
                self.logger.record(f"{name}/{key}", float(np.mean([e.get(key, 0) for e in eps])))
            self.logger.record(f"{name}/meters", float(np.mean([e["dist"] for e in eps])))
        self.logger.record("time/steps_per_second", self.num_timesteps / (time.time() - self.start))


class StopAt(BaseCallback):
    """Stops training after `steps` steps, with the learning rate decreasing as if it were going to last all of
    --steps: the network is left halfway, still learning hard (phase 1, so it doesn't settle on a single way of
    driving before seeing opponents)."""

    def __init__(self, steps: int):
        super().__init__()
        self.steps = steps

    def _on_training_start(self):
        self.start = self.num_timesteps  # when continuing a model, steps count from where it left off

    def _on_step(self) -> bool:
        return self.num_timesteps - self.start < self.steps


class CriticWarmup(BaseCallback):
    """When the reward changes (from stage 1 to stage 2), the critic misjudges how much each situation is worth and
    those errors break the part that drives. During the first `steps` steps only the critic learns."""

    def __init__(self, steps: int):
        super().__init__()
        self.steps = steps
        self.frozen = []

    def _on_training_start(self):
        p = self.model.policy
        self.frozen = [*p.mlp_extractor.policy_net.parameters(), *p.action_net.parameters(), p.log_std]
        for t in self.frozen:
            t.requires_grad_(False)
        self.start = self.num_timesteps

    def _on_step(self) -> bool:
        if self.frozen and self.num_timesteps - self.start >= self.steps:
            for t in self.frozen:
                t.requires_grad_(True)
            self.frozen = []
            print(f"Critic calibrated: from {self.num_timesteps} steps on, the part that drives learns too")
        return True


class ContactBudget(BaseCallback):
    """Contact budget: the penalty for a caused contact (hitting the car ahead or squeezing the car alongside) is
    multiplied by `scale`, which adjusts itself after each update. The budget is a fraction (`budget`) of what phase 7
    causes in each scenario (each one has its own level: there are more contacts at a start). If in the latest
    episodes the network caused more contacts than the budget, it goes up; if it caused fewer, it goes down slowly.
    That way, when another part of the reward pushes to go faster, it can't be bought with contacts. The scale is
    saved in the run directory (contacto.txt) so the next phase starts from there. With `keep`, it never goes below
    the scale it started with: a network already cleaner than the reference doesn't loosen up for having improved
    (otherwise, with the penalty getting cheaper and cheaper, contacts slowly come back)."""

    # caused contacts per km of models/fase7.json in each scenario (rl/scenario_eval.js)
    REFERENCE = {"pack": 0.76, "start": 3.87, "chase": 0.68, "race": 0.87}
    RATE = 0.05  # how much it moves per update (on a log scale)
    LOW, HIGH = 0.5, 5.0

    def __init__(self, budget: float, scale: float, out: Path, keep: bool = False):
        super().__init__()
        self.budget, self.scale, self.out = budget, scale, out
        self.low = scale if keep else self.LOW
        self.faults = deque(maxlen=1000)  # (caused contacts, allowed contacts) of episodes with other cars

    def _on_training_start(self):
        self.training_env.venv.set(contactScale=self.scale)

    def _on_step(self) -> bool:
        for info in self.locals["infos"]:
            ep = info.get("episode")
            if ep and ep.get("scenario") in self.REFERENCE:
                allowed = self.budget * self.REFERENCE[ep["scenario"]] * max(0.0, ep["dist"]) / 1000
                self.faults.append((ep.get("faults", 0), allowed))
        return True

    def _on_rollout_end(self):
        allowed = sum(a for _, a in self.faults)
        if allowed < 1:
            return
        ratio = sum(f for f, _ in self.faults) / allowed  # 1: exactly on budget
        # slower to go down than up: so it doesn't loosen up as soon as it improves
        step = self.RATE * np.clip(ratio - 1, -0.5, 1)
        self.scale = float(np.clip(self.scale * np.exp(step), self.low, self.HIGH))
        self.training_env.venv.set(contactScale=self.scale)
        self.out.joinpath("contacto.txt").write_text(f"{self.scale}\n")
        self.logger.record("contact/budget_used", ratio)
        self.logger.record("contact/scale", self.scale)


class Budgets(BaseCallback):
    """Budgets for herd races (rl/herd.js). There is a single measure, in every scenario: the time with penalty (for
    running side by side with another car, for contacts and for driving on the grass) against the racing line's
    time starting the same way. The reward of each scenario (progress minus the penalty, as time) is multiplied by
    its scale. The scenarios the phase rewards (`objective`: a group from GROUPS) get a fixed weight; in the others
    any increase of their time over the previous phase is penalized: their scale goes up as soon as it gets worse
    (the tolerance only covers measurement noise) and goes down slowly if it improves, never below its normal weight.

    It is measured in two ways, and the worse one counts: in the training episodes (with the noise added for
    exploration) and in fixed races without that noise, the way the network drives in the game (rl/herd_eval.js, in
    the background: as soon as one measurement ends another starts with the network of that moment). With only the
    first one, in v11 the lap on the grid got worse from 1.020 to 1.072 when driving as in the game and the budget
    did not notice.

    The target of each scenario is what the previous phase left (`targets`: its medidas.json and, next to it,
    fijas.json, the noise-free measurement of its final network). If it is missing (or was measured differently: the
    phases from before this measure), it is calibrated at the start: in training, with what the network does while
    only the critic learns (`calibrate` steps); without noise, with the first measurement, which is the previous
    phase's network. The scales start from those of the previous phase (escalas.json), without going over the
    ceiling; at the end medidas.json and fijas.json are left."""

    SCENARIOS = ("solo", "grid", "rolling", "flying", "chase", "start")
    # which scenarios each phase rewards; all: integration, all with the same weight
    GROUPS = {"launch": ("grid", "flying", "start"), "pace": ("solo", "rolling"), "chase": ("chase",), "all": SCENARIOS}
    TOLERANCE, UNIT = 0.005, 0.01  # only measurement noise (0.5 % of the time); how much an error of 1 is
    RATE = 0.1  # how much the scale moves per update (on a log scale)
    # the ceiling, above the objective's weight (3): otherwise the phase could buy its objective with everything else
    # (v13 phase 6: contacts with weight 4 and ceiling 3)
    LOW, HIGH = 1.0, 4.0
    MIN_SAMPLES = 30
    FIXED_RACES = 8  # races per scenario in each noise-free measurement: one per track (~4 min)

    def __init__(self, out: Path, objective: str, weight: float, targets: dict, fixed_targets: dict, scales: dict,
                 calibrate: int, damage: str = "off", agents: int = 16):
        super().__init__()
        self.damage, self.agents = damage, agents  # the noise-free measurement, with the phase's damage and cars
        self.out, self.calibrate = out, calibrate
        rewarded = self.GROUPS[objective] if objective else ()
        self.budgets = [sc for sc in self.SCENARIOS if sc not in rewarded]  # the ones that can't get worse
        self.targets = {sc: v for sc, v in targets.items() if sc in self.budgets}
        self.fixed_targets = {sc: v for sc, v in fixed_targets.items() if sc in self.budgets}
        self.scales = {sc: float(np.clip(scales.get(sc, 1.0), self.LOW, self.HIGH)) for sc in self.SCENARIOS}
        for sc in rewarded:
            self.scales[sc] = weight
        self.values = defaultdict(lambda: deque(maxlen=300))  # scenario → times of the latest episodes
        self.fixed = None  # the latest noise-free measurement
        self.job = None  # the measurement in progress

    def _on_training_start(self):
        self.start = self.num_timesteps
        self.training_env.venv.set(scales=self.scales)
        self.measure_fixed()

    def _on_step(self) -> bool:
        for info in self.locals["infos"]:
            ep = info.get("episode")
            if ep and ep.get("time") is not None:
                self.values[ep["scenario"]].append(ep["time"])
        return True

    def measure(self, sc: str):
        xs = self.values[sc]
        return float(np.mean(xs)) if len(xs) >= self.MIN_SAMPLES else None

    def measure_fixed(self, wait: bool = False):
        """Starts a noise-free measurement with the current network (or, with wait, runs it and returns it)."""
        from export import export

        net = self.out / "medicion.json"
        export(self.model.policy, str(net))
        env = {**os.environ, "JSON": "1", "RACES": str(self.FIXED_RACES), "DAMAGE": self.damage, "AGENTS": str(self.agents)}
        self.job = subprocess.Popen(["node", "rl/herd_eval.js", str(net)], cwd=ROOT, env=env, stdout=subprocess.PIPE, text=True)
        if wait:
            return self.collect(block=True)

    def collect(self, block: bool = False):
        if not self.job or (not block and self.job.poll() is None):
            return None
        out, _ = self.job.communicate()
        self.job = None
        try:
            return json.loads(out.strip().splitlines()[-1])
        except (ValueError, IndexError):
            return None

    def error(self, value: float, target: float) -> float:
        return float(np.clip((value - target - self.TOLERANCE) / self.UNIT, -0.5, 1))  # slower to go down than up

    def _on_rollout_end(self):
        calibrating = self.num_timesteps - self.start < self.calibrate
        fresh = self.collect()
        if fresh:
            self.fixed = fresh.get("time", {})
            for sc, v in self.fixed.items():
                if v == v:  # not NaN
                    self.logger.record(f"fixed/{sc}", v)
                    if sc in self.budgets and sc not in self.fixed_targets:
                        self.fixed_targets[sc] = v  # the first one: the previous phase's network
                        print(f"Noise-free target in {sc}: {v:.3f}")
            self.measure_fixed()
        measures = {}
        for sc in self.SCENARIOS:
            v = self.measure(sc)
            if v is not None:
                measures[sc] = v
                self.logger.record(f"measure/{sc}", v)
            if sc not in self.budgets:
                continue
            errors = []
            if v is not None:
                target = self.targets.get(sc)
                if target is None:
                    # no target: take what the network does at the start (when the critic finishes calibrating)
                    if not calibrating:
                        self.targets[sc] = v
                        print(f"Target in {sc} calibrated: {v:.3f}")
                else:
                    self.logger.record(f"target/{sc}", target)
                    errors.append(self.error(v, target))
            fv, ft = (self.fixed or {}).get(sc), self.fixed_targets.get(sc)
            if fv is not None and ft is not None and fv == fv and ft == ft:
                errors.append(self.error(fv, ft))
            if errors and not calibrating:
                self.scales[sc] = float(np.clip(self.scales[sc] * np.exp(self.RATE * max(errors)), self.LOW, self.HIGH))
        for sc, x in self.scales.items():
            self.logger.record(f"scale/{sc}", x)
        self.training_env.venv.set(scales=self.scales)
        self.out.joinpath("escalas.json").write_text(json.dumps(self.scales, indent=2) + "\n")
        self.out.joinpath("medidas.json").write_text(json.dumps({"time": measures}, indent=2) + "\n")

    def _on_training_end(self):
        # the noise-free measurement of the final network: the target of the next phase
        if self.job:
            self.job.kill()
            self.job = None
        fixed = self.measure_fixed(wait=True)
        if fixed:
            self.out.joinpath("fijas.json").write_text(json.dumps(fixed, indent=2) + "\n")


class PhaseProgress(BaseCallback):
    """Tells the races how far along the phase is (from 0 to 1): this shrinks the opponent's handicap in chases
    (rl/race.js)."""

    def __init__(self, steps: int):
        super().__init__()
        self.steps = steps

    def _on_training_start(self):
        self.start = self.num_timesteps
        self.training_env.venv.set(progress=0)

    def _on_step(self) -> bool:
        return True

    def _on_rollout_end(self):
        progress = min(1.0, (self.num_timesteps - self.start) / self.steps)
        self.training_env.venv.set(progress=progress)
        self.logger.record("phase/progress", progress)


def spread(text: str):
    """0.05 (±5 %) or 0.15,0.2 (from -15 % to +20 %)"""
    parts = [float(x) for x in text.split(",")]
    return parts[0] if len(parts) == 1 else parts


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--steps", type=int, default=20_000_000)
    p.add_argument("--name", default="stage1")
    p.add_argument("--tracks", default=",".join(TRACKS))
    p.add_argument("--workers", type=int, default=8)
    p.add_argument("--envs", type=int, default=16, help="environments (or races, in stage 2) per process")
    p.add_argument("--race", action="store_true", help="scenarios with several cars and opponents (rl/race.js)")
    p.add_argument("--herd", action="store_true",
                   help="herd races: every car is an agent (rl/herd.js), with budgets (Budgets)")
    p.add_argument("--objective", choices=list(Budgets.GROUPS),
                   help="herd: which scenarios the phase rewards (launch: grid, flying and start; pace: solo and rolling; chase; all)")
    p.add_argument("--objective-weight", type=float, default=3.0, help="herd: fixed weight of that skill")
    p.add_argument("--targets", default="",
                   help="herd: budget targets: medidas.json of the previous phase (with several, comma-separated, the best of them)")
    p.add_argument("--eval-damage", choices=["off", "reduced", "real"],
                   help="herd: damage for the noise-free measurement (default, the phase's). With the same in every "
                        "phase, measurements can be compared even if training damage is turned on halfway through the curriculum")
    p.add_argument("--recalibrate", action="store_true",
                   help="herd: the targets measured while training (medidas.json) are calibrated again at the start instead of "
                        "taken from the previous phase; the noise-free ones are still taken (when the damage changes)")
    p.add_argument("--recalibrate-fixed", action="store_true",
                   help="herd: the noise-free targets (fijas.json) are also calibrated again, with the network at the start "
                        "(when the way of measuring changes, as when the start lights and the flying start were added)")
    p.add_argument("--calibrate", type=int, default=0,
                   help="herd: steps at the beginning to calibrate missing targets (default, --critic-warmup)")
    p.add_argument("--agents", type=int, default=4, help="learning cars in each race")
    p.add_argument("--mix", default="race:1", help="weight of each scenario (rl/race.js), in steps: pack:45,start:30,solo:25")
    p.add_argument("--opponents", default="", help="networks (comma-separated) that drive some of the opponents")
    p.add_argument("--spread", type=spread, default=0.02,
                   help="car variation: 0.05 (±5 %%) or 0.15,0.2 (from -15 %% to +20 %%)")
    p.add_argument("--race-spread", type=spread, help="car variation in full races (default, --spread)")
    p.add_argument("--critic-warmup", type=int, default=0,
                   help="steps at the beginning in which only the critic learns (when the reward changes)")
    p.add_argument("--lr", type=float, help="initial learning rate (decreases slowly to 0)")
    p.add_argument("--net", type=lambda s: [int(x) for x in s.split(",")], default=[384, 512],
                   help="neurons per layer (two layers) of the policy and the critic: 384,512. Only when starting from scratch")
    p.add_argument("--fresh-opponents", action="store_true",
                   help="sets to zero the weights that receive the opponents' data (when going from stage 1 to stage 2)")
    p.add_argument("--resume", help=".zip model to continue from")
    p.add_argument("--rewards", default="",
                   help="scale of parts of the reward, e.g. progress:0.7,pass:0,paceFloor:1 (races) or grass:3,wall:2 (solo)")
    p.add_argument("--contact-scale", type=float,
                   help="initial scale of the penalty for a caused contact (default, the one the previous phase ended with)")
    p.add_argument("--contact-budget", type=float,
                   help="allowed caused contacts, as a fraction of those of phase 7 (0.5: half); see ContactBudget")
    p.add_argument("--contact-keep", action="store_true",
                   help="the contact penalty does not go below the one the phase starts with (see ContactBudget)")
    p.add_argument("--rivals-boost", type=float, default=0,
                   help="faster opponents: this fraction more grip and power (e.g. 0.08), and the classic AI at a higher pace")
    p.add_argument("--damage", default="off", choices=["off", "reduced", "real", "mix"],
                   help="damage in the races (src/sim/damage.js); mix: each scenario with one of the three at random")
    p.add_argument("--damaged-starts", type=float, default=0,
                   help="share of agents that start with something broken (with damage on), e.g. 0.15")
    p.add_argument("--tune-spread", type=int, default=3,
                   help="random wing and balance points around the track setup (0: the track's setup and its air)")
    p.add_argument("--stop-at", type=int,
                   help="stops after this many steps of the phase, with the learning rate decreasing as if it lasted --steps (see StopAt)")
    p.add_argument("--seed", type=int, default=0)
    args = p.parse_args()

    torch.set_num_threads(4)  # the remaining cores are left for the Node processes
    out = RUNS / args.name
    out.mkdir(parents=True, exist_ok=True)
    config = dict(spread=args.spread, tuneSpread=args.tune_spread, damage=args.damage)
    if args.rewards:
        config["rewards"] = {k: float(w) for k, w in (part.split(":") for part in args.rewards.split(","))}
    if args.herd:
        mix = {k: float(w) for k, w in (part.split(":") for part in args.mix.split(","))}
        config |= dict(agents=args.agents, mix=mix, damage=args.damage)
    elif args.race:
        mix = {k: float(w) for k, w in (part.split(":") for part in args.mix.split(","))}
        opponents = [f for f in args.opponents.split(",") if f]
        config |= dict(agents=args.agents, mix=mix, opponents=opponents, raceSpread=args.race_spread or args.spread,
                       boost=args.rivals_boost, damage=args.damage, damagedStarts=args.damaged_starts)
    env = RacingVecEnv(args.workers, args.envs, args.tracks.split(","), args.seed,
                       mode="herd" if args.herd else "race" if args.race else "solo", config=config)
    # rewards scaled so the critic (the network that estimates the value) doesn't drift; the observations are left
    # untouched, so the network is used the same way in the game
    env = VecNormalize(env, norm_obs=False, norm_reward=True, gamma=0.995)

    if args.resume:
        old = PPO.load(args.resume, device="cpu")
        if old.observation_space.shape != env.observation_space.shape or old.action_space.shape != env.action_space.shape:
            model = widen(old, env)
        else:
            model = PPO.load(args.resume, env=env, device="cpu")
        if args.fresh_opponents:
            # In stage 1 the opponents' data was always zero: those first-layer weights were never trained and are
            # still random. At zero, the network starts driving the same as in stage 1 and slowly learns to use the
            # opponents (otherwise the noise breaks what it learned)
            with torch.no_grad():
                for net in (model.policy.mlp_extractor.policy_net, model.policy.mlp_extractor.value_net):
                    for start, size in opponent_columns():
                        net[0].weight[:, start : start + size] = 0
    else:
        model = PPO(
            "MlpPolicy",
            env,
            n_steps=256,  # × 128 environments = 32,768 steps per update
            batch_size=4096,
            n_epochs=5,
            learning_rate=lambda left: 3e-4 * left,  # decreases slowly to 0: the end doesn't fall apart
            gamma=0.995,  # at 20 decisions per second, it looks about 10 s ahead
            gae_lambda=0.95,
            clip_range=0.2,
            ent_coef=0.0,
            target_kl=0.03,
            # the critic larger than the policy: estimating how much reward is coming with several cars nearby is the
            # hardest part; the policy can't be huge because in the game it runs 21 times, 20 times per second
            policy_kwargs=dict(net_arch=dict(pi=[args.net[0]] * 2, vf=[args.net[1]] * 2), log_std_init=-0.5),
            tensorboard_log=str(RUNS),
            seed=args.seed,
            device="cpu",
            verbose=1,
        )

    if args.lr:
        # stable-baselines3 measures progress over the total (previous phases included): when continuing a model,
        # `left` starts at the remaining part of that total. It is rescaled so this phase goes from lr to 0
        start = model.num_timesteps if args.resume else 0
        share = args.steps / (start + args.steps)
        model.learning_rate = lambda left, lr=args.lr: lr * min(1, left / share)
        model._setup_lr_schedule()
        model.target_kl = 0.015  # shorter steps: so what was learned doesn't fall apart

    callbacks = [RaceStats(), CheckpointCallback(5_000_000 // env.num_envs, str(out), name_prefix="modelo")]
    if args.critic_warmup:
        callbacks.append(CriticWarmup(args.critic_warmup))
    if args.race or args.herd:
        callbacks.append(PhaseProgress(args.steps))
    if args.herd:
        # the best time of each scenario in the previous phases (measurements from before the time with penalty
        # have no "time": those targets are calibrated again)
        def best(files):
            out: dict = {}
            for file in files:
                if not Path(file).exists():
                    continue
                for sc, v in json.loads(Path(file).read_text()).get("time", {}).items():
                    if v == v:  # NaN: could not be measured
                        out[sc] = v if sc not in out else min(out[sc], v)
            return out

        files = [f for f in args.targets.split(",") if f]
        targets = {} if args.recalibrate else best(files)
        fixed_targets = {} if args.recalibrate_fixed else best(str(Path(f).parent / "fijas.json") for f in files)
        prev = Path(args.resume).parent / "escalas.json" if args.resume else None
        scales = json.loads(prev.read_text()) if prev and prev.exists() else {}
        if set(scales) != set(Budgets.SCENARIOS):  # from before per-scenario scales: they start at 1
            scales = {}
        callbacks.append(Budgets(out, args.objective, args.objective_weight, targets, fixed_targets, scales,
                                 args.calibrate or args.critic_warmup or 2_000_000, damage=args.eval_damage or args.damage, agents=args.agents))
    if args.stop_at:
        callbacks.append(StopAt(args.stop_at))
    if args.contact_budget:
        # start from the scale the previous phase ended with, if there is one
        prev = Path(args.resume).parent / "contacto.txt" if args.resume else None
        scale = float(prev.read_text()) if prev and prev.exists() else 1.0
        if args.contact_scale:
            scale = args.contact_scale
        callbacks.append(ContactBudget(args.contact_budget, scale, out, keep=args.contact_keep))
    try:
        model.learn(args.steps, callback=callbacks, tb_log_name=args.name, reset_num_timesteps=not args.resume)
    finally:
        model.save(out / "model.zip")
        env.close()


if __name__ == "__main__":
    main()
