"""Entrena la IA con PPO (etapa 1: sola en pista, aprendiendo a dar la vuelta lo más rápido posible).

    rl/.venv/bin/python rl/train.py --steps 20_000_000 --name etapa1
    rl/.venv/bin/tensorboard --logdir rl/runs        (para ver las curvas)

Guarda cada tanto el modelo en rl/runs/<nombre>/ (y al terminar, model.zip). Con --resume sigue desde un modelo.
"""

import argparse
import time
from collections import defaultdict, deque
from pathlib import Path

import numpy as np
import torch
from stable_baselines3 import PPO
from stable_baselines3.common.callbacks import BaseCallback, CheckpointCallback
from stable_baselines3.common.vec_env import VecNormalize

from racing_env import TRACKS, RacingVecEnv

RUNS = Path(__file__).resolve().parent / "runs"


class RaceStats(BaseCallback):
    """Anota en TensorBoard los tiempos de vuelta de cada circuito y cómo terminan los episodios."""

    def __init__(self):
        super().__init__()
        self.laps = defaultdict(lambda: deque(maxlen=50))
        self.ends = deque(maxlen=500)
        self.dist = deque(maxlen=500)
        self.start = time.time()

    def _on_step(self) -> bool:
        for info in self.locals["infos"]:
            ep = info.get("episode")
            if ep:
                self.ends.append(ep["end"])
                self.dist.append(ep["dist"])
        env = self.training_env.venv  # debajo de VecNormalize
        for track, lap in env.laps:
            self.laps[track].append(lap)
        env.laps.clear()
        return True

    def _on_rollout_end(self):
        for track, laps in self.laps.items():
            if laps:
                self.logger.record(f"vuelta/{track}", float(np.mean(laps)))
                self.logger.record(f"vuelta_mejor/{track}", float(np.min(laps)))
        if self.ends:
            for kind in ("grass", "stuck", "back", "time"):
                self.logger.record(f"fin/{kind}", self.ends.count(kind) / len(self.ends))
            self.logger.record("episodio/metros", float(np.mean(self.dist)))
        self.logger.record("tiempo/pasos_por_segundo", self.num_timesteps / (time.time() - self.start))


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--steps", type=int, default=20_000_000)
    p.add_argument("--name", default="etapa1")
    p.add_argument("--tracks", default=",".join(TRACKS))
    p.add_argument("--workers", type=int, default=8)
    p.add_argument("--envs", type=int, default=16, help="entornos por proceso")
    p.add_argument("--resume", help="modelo .zip desde donde seguir")
    p.add_argument("--seed", type=int, default=0)
    args = p.parse_args()

    torch.set_num_threads(4)  # el resto de los núcleos quedan para los procesos de Node
    out = RUNS / args.name
    out.mkdir(parents=True, exist_ok=True)
    env = RacingVecEnv(args.workers, args.envs, args.tracks.split(","), args.seed)
    # recompensas escaladas para que el crítico (la red que estima el valor) no se desajuste; las observaciones
    # no se tocan, así la red se usa igual en el juego
    env = VecNormalize(env, norm_obs=False, norm_reward=True, gamma=0.995)

    if args.resume:
        model = PPO.load(args.resume, env=env, device="cpu")
    else:
        model = PPO(
            "MlpPolicy",
            env,
            n_steps=256,  # × 128 entornos = 32.768 pasos por actualización
            batch_size=4096,
            n_epochs=5,
            learning_rate=lambda left: 3e-4 * left,  # baja de a poco hasta 0: el final no se desarma
            gamma=0.995,  # a 20 decisiones por segundo, mira unos 10 s hacia adelante
            gae_lambda=0.95,
            clip_range=0.2,
            ent_coef=0.0,
            target_kl=0.03,
            policy_kwargs=dict(net_arch=dict(pi=[256, 256], vf=[256, 256]), log_std_init=-0.5),
            tensorboard_log=str(RUNS),
            seed=args.seed,
            device="cpu",
            verbose=1,
        )

    callbacks = [RaceStats(), CheckpointCallback(5_000_000 // env.num_envs, str(out), name_prefix="modelo")]
    try:
        model.learn(args.steps, callback=callbacks, tb_log_name=args.name, reset_num_timesteps=not args.resume)
    finally:
        model.save(out / "model.zip")
        env.close()


if __name__ == "__main__":
    main()
