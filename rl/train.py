"""Entrena la IA con PPO.

Entrenamiento por fases (rl/CURRICULO.md). Fase 1, sola en pista con autos algo distintos:
    rl/.venv/bin/python rl/train.py --steps 60_000_000 --name fase1
Fases 2 a 4, en escenarios con otros autos, cada una partiendo de la anterior (los comandos exactos están en
rl/CURRICULO.md):
    rl/.venv/bin/python rl/train.py --race --envs 4 --mix pack:45,start:30,solo:25 --steps 30_000_000 --name fase2 \
        --resume rl/runs/fase1/model.zip --fresh-opponents --critic-warmup 3_000_000 --lr 1e-4

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

OPPONENTS = 6  # como en src/sensors.js: los últimos 6 × 7 valores de la observación son los rivales

RUNS = Path(__file__).resolve().parent / "runs"


class RaceStats(BaseCallback):
    """Anota en TensorBoard los tiempos de vuelta de cada circuito y cómo terminan los episodios."""

    def __init__(self):
        super().__init__()
        self.laps = defaultdict(lambda: deque(maxlen=50))
        self.ends = deque(maxlen=500)
        self.dist = deque(maxlen=500)
        self.scenarios = defaultdict(lambda: deque(maxlen=200))  # escenario → episodios
        self.start = time.time()

    def _on_step(self) -> bool:
        for info in self.locals["infos"]:
            ep = info.get("episode")
            if ep:
                if "end" in ep:  # en las carreras no termina nunca antes: se rescata (ver rl/race.js)
                    self.ends.append(ep["end"])
                self.dist.append(ep["dist"])
                if "scenario" in ep:
                    self.scenarios[ep["scenario"]].append(ep)
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
        for name, eps in self.scenarios.items():
            for key in ("passes", "passed", "hits", "faults", "slow", "danger", "weaves", "rescues", "r"):
                self.logger.record(f"{name}/{key}", float(np.mean([e.get(key, 0) for e in eps])))
            self.logger.record(f"{name}/metros", float(np.mean([e["dist"] for e in eps])))
        self.logger.record("tiempo/pasos_por_segundo", self.num_timesteps / (time.time() - self.start))


class CriticWarmup(BaseCallback):
    """Al cambiar la recompensa (de la etapa 1 a la 2), el crítico estima mal cuánto vale cada situación y esos
    errores desarman la parte que maneja. Durante los primeros `steps` pasos sólo aprende el crítico."""

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
            print(f"Crítico calibrado: desde {self.num_timesteps} pasos aprende también la parte que maneja")
        return True


class ContactBudget(BaseCallback):
    """Presupuesto de toques: el castigo por toque provocado (pegarle al de adelante o apretar al de al lado) se
    multiplica por `scale`, que se ajusta solo después de cada actualización. El presupuesto es una fracción
    (`budget`) de lo que provoca la fase 7 en cada escenario (cada uno tiene su nivel: en una largada se toca más).
    Si en los últimos episodios la red provocó más toques que el presupuesto, sube; si provocó menos, baja de a poco. Así, cuando otra parte del premio
    empuja a ir más rápido, no puede comprarse con toques. La escala se guarda en el directorio de la corrida
    (contacto.txt) para que la fase siguiente arranque desde ahí."""

    # toques provocados por km de models/fase7.json en cada escenario (rl/scenario_eval.js)
    REFERENCE = {"pack": 0.76, "start": 3.87, "chase": 0.68, "race": 0.87}
    RATE = 0.05  # cuánto se mueve por actualización (en escala logarítmica)
    LOW, HIGH = 0.5, 5.0

    def __init__(self, budget: float, scale: float, out: Path):
        super().__init__()
        self.budget, self.scale, self.out = budget, scale, out
        self.faults = deque(maxlen=1000)  # (toques provocados, toques permitidos) de episodios con otros autos

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
        ratio = sum(f for f, _ in self.faults) / allowed  # 1: justo en el presupuesto
        # más lento para bajar que para subir: que no afloje apenas mejora
        step = self.RATE * np.clip(ratio - 1, -0.5, 1)
        self.scale = float(np.clip(self.scale * np.exp(step), self.LOW, self.HIGH))
        self.training_env.venv.set(contactScale=self.scale)
        self.out.joinpath("contacto.txt").write_text(f"{self.scale}\n")
        self.logger.record("contacto/presupuesto_usado", ratio)
        self.logger.record("contacto/escala", self.scale)


class PhaseProgress(BaseCallback):
    """Le avisa a las carreras cuánto lleva la fase (de 0 a 1): con eso se achica la desventaja del rival en las
    persecuciones (rl/race.js)."""

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
        self.logger.record("fase/avance", progress)


def spread(text: str):
    """0.05 (±5 %) o 0.15,0.2 (de -15 % a +20 %)"""
    parts = [float(x) for x in text.split(",")]
    return parts[0] if len(parts) == 1 else parts


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--steps", type=int, default=20_000_000)
    p.add_argument("--name", default="etapa1")
    p.add_argument("--tracks", default=",".join(TRACKS))
    p.add_argument("--workers", type=int, default=8)
    p.add_argument("--envs", type=int, default=16, help="entornos (o carreras, en la etapa 2) por proceso")
    p.add_argument("--race", action="store_true", help="fases 2 a 4: escenarios con varios autos")
    p.add_argument("--agents", type=int, default=4, help="autos que aprenden en cada carrera")
    p.add_argument("--mix", default="race:1", help="peso de cada escenario (rl/race.js), en pasos: pack:45,start:30,solo:25")
    p.add_argument("--opponents", default="", help="redes (separadas por coma) que manejan parte de los rivales")
    p.add_argument("--spread", type=spread, default=0.02,
                   help="variación de los autos: 0.05 (±5 %%) o 0.15,0.2 (de -15 %% a +20 %%)")
    p.add_argument("--race-spread", type=spread, help="variación de los autos en carrera completa (por defecto, --spread)")
    p.add_argument("--critic-warmup", type=int, default=0,
                   help="pasos al principio en los que sólo aprende el crítico (al cambiar la recompensa)")
    p.add_argument("--lr", type=float, help="tasa de aprendizaje inicial (baja de a poco hasta 0)")
    p.add_argument("--fresh-opponents", action="store_true",
                   help="pone en cero los pesos que reciben los datos de los rivales (al pasar de la etapa 1 a la 2)")
    p.add_argument("--resume", help="modelo .zip desde donde seguir")
    p.add_argument("--rewards", default="",
                   help="escala de partes del premio, p. ej. progress:0.7,pass:0,paceFloor:1 (carreras) o grass:3,wall:2 (sola)")
    p.add_argument("--contact-scale", type=float,
                   help="escala inicial del castigo por toque provocado (por defecto, con la que terminó la fase anterior)")
    p.add_argument("--contact-budget", type=float,
                   help="toques provocados permitidos, como fracción de los de la fase 7 (0.5: la mitad); ver ContactBudget")
    p.add_argument("--rivals-boost", type=float, default=0,
                   help="rivales más rápidos: esta fracción más de agarre y potencia (p. ej. 0.08), y la IA de siempre a más ritmo")
    p.add_argument("--seed", type=int, default=0)
    args = p.parse_args()

    torch.set_num_threads(4)  # el resto de los núcleos quedan para los procesos de Node
    out = RUNS / args.name
    out.mkdir(parents=True, exist_ok=True)
    config = dict(spread=args.spread)
    if args.rewards:
        config["rewards"] = {k: float(w) for k, w in (part.split(":") for part in args.rewards.split(","))}
    if args.race:
        mix = {k: float(w) for k, w in (part.split(":") for part in args.mix.split(","))}
        opponents = [f for f in args.opponents.split(",") if f]
        config |= dict(agents=args.agents, mix=mix, opponents=opponents, raceSpread=args.race_spread or args.spread,
                       boost=args.rivals_boost)
    env = RacingVecEnv(args.workers, args.envs, args.tracks.split(","), args.seed,
                       mode="race" if args.race else "solo", config=config)
    # recompensas escaladas para que el crítico (la red que estima el valor) no se desajuste; las observaciones
    # no se tocan, así la red se usa igual en el juego
    env = VecNormalize(env, norm_obs=False, norm_reward=True, gamma=0.995)

    if args.resume:
        model = PPO.load(args.resume, env=env, device="cpu")
        if args.fresh_opponents:
            # En la etapa 1 los datos de los rivales siempre fueron cero: esos pesos de la primera capa nunca se
            # entrenaron y siguen al azar. En cero, la red arranca manejando igual que en la etapa 1 y aprende
            # de a poco a usar a los rivales (si no, el ruido le desarma lo aprendido)
            n = OPPONENTS * 7
            with torch.no_grad():
                for net in (model.policy.mlp_extractor.policy_net, model.policy.mlp_extractor.value_net):
                    net[0].weight[:, -n:] = 0
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
            # el crítico más grande que la política: estimar cuánto premio viene con varios autos cerca es lo más
            # difícil; la política no puede ser enorme porque en el juego corre 21 veces, 20 veces por segundo
            policy_kwargs=dict(net_arch=dict(pi=[384, 384], vf=[512, 512]), log_std_init=-0.5),
            tensorboard_log=str(RUNS),
            seed=args.seed,
            device="cpu",
            verbose=1,
        )

    if args.lr:
        # stable-baselines3 mide el progreso sobre el total (fases anteriores incluidas): al seguir un modelo, `left`
        # arranca en la parte que falta de ese total. Se reescala para que esta fase vaya de lr a 0
        start = model.num_timesteps if args.resume else 0
        share = args.steps / (start + args.steps)
        model.learning_rate = lambda left, lr=args.lr: lr * min(1, left / share)
        model._setup_lr_schedule()
        model.target_kl = 0.015  # pasos más cortos: que no se desarme lo aprendido

    callbacks = [RaceStats(), CheckpointCallback(5_000_000 // env.num_envs, str(out), name_prefix="modelo")]
    if args.critic_warmup:
        callbacks.append(CriticWarmup(args.critic_warmup))
    if args.race:
        callbacks.append(PhaseProgress(args.steps))
    if args.contact_budget:
        # arranca desde la escala con que terminó la fase anterior, si la hay
        prev = Path(args.resume).parent / "contacto.txt" if args.resume else None
        scale = float(prev.read_text()) if prev and prev.exists() else 1.0
        if args.contact_scale:
            scale = args.contact_scale
        callbacks.append(ContactBudget(args.contact_budget, scale, out))
    try:
        model.learn(args.steps, callback=callbacks, tb_log_name=args.name, reset_num_timesteps=not args.resume)
    finally:
        model.save(out / "model.zip")
        env.close()


if __name__ == "__main__":
    main()
