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
    """Dónde están los valores de los rivales en la observación (src/drivers/sensors.js), como (comienzo, cuántos): sus
    posiciones y velocidades (después vienen ruedas, límites y daños, así que no son los últimos) y, al final, sus
    pedales y volante."""
    code = ("import('./src/drivers/sensors.js').then((m) => console.log(m.OPPONENT_START, m.OPPONENT_SIZE, "
            "m.OPPONENT_INPUT_START, m.OPPONENT_INPUT_SIZE))")
    out = subprocess.run(["node", "--input-type=module", "-e", code], cwd=ROOT, capture_output=True, text=True, check=True)
    a, b, c, d = map(int, out.stdout.split())
    return [(a, b), (c, d)]


NEW_ACTION_STD = 0.5  # cuánto exploran las salidas nuevas al arrancar (las viejas, lo que ya tenían)


def widen(old: PPO, env) -> PPO:
    """El mismo modelo para una observación más larga (valores nuevos al final, como los pedales de los rivales) o
    con más salidas (las rpm en la grilla): los pesos que reciben los valores nuevos y los de las salidas nuevas
    arrancan en cero, así maneja exactamente igual hasta que aprenda a usarlos; las salidas nuevas exploran con
    NEW_ACTION_STD. Sirve para seguir desde la fase 1 sin volver a entrenarla."""
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
            # la primera capa (más columnas) o la de salida (más filas): lo viejo en su lugar, lo nuevo en cero
            target.zero_()
            if key == "log_std":
                target.fill_(float(np.log(NEW_ACTION_STD)))
            target[tuple(slice(0, n) for n in value.shape)].copy_(value)
    new.policy.load_state_dict(state)
    new.num_timesteps = old.num_timesteps
    print(f"Modelo ensanchado: {old.observation_space.shape[0]} → {env.observation_space.shape[0]} valores, "
          f"{old.action_space.shape[0]} → {env.action_space.shape[0]} salidas")
    return new


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
            for kind in ("grass", "stuck", "back", "retired", "time"):
                self.logger.record(f"fin/{kind}", self.ends.count(kind) / len(self.ends))
            self.logger.record("episodio/metros", float(np.mean(self.dist)))
        for name, eps in self.scenarios.items():
            for key in ("passes", "passed", "hits", "faults", "slow", "danger", "weaves", "rescues", "retired", "lag", "launchCost", "r"):
                self.logger.record(f"{name}/{key}", float(np.mean([e.get(key, 0) for e in eps])))
            self.logger.record(f"{name}/metros", float(np.mean([e["dist"] for e in eps])))
        self.logger.record("tiempo/pasos_por_segundo", self.num_timesteps / (time.time() - self.start))


class StopAt(BaseCallback):
    """Corta el entrenamiento a los `steps` pasos, con la tasa de aprendizaje bajando como si fuera a durar todo
    --steps: la red queda a mitad de camino, todavía aprendiendo fuerte (la fase 1, que no se cierre en una sola
    forma de manejar antes de ver rivales)."""

    def __init__(self, steps: int):
        super().__init__()
        self.steps = steps

    def _on_training_start(self):
        self.start = self.num_timesteps  # al seguir un modelo, los pasos cuentan desde donde quedó

    def _on_step(self) -> bool:
        return self.num_timesteps - self.start < self.steps


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
    (contacto.txt) para que la fase siguiente arranque desde ahí. Con `keep`, nunca baja de la escala con que
    arrancó: la red ya más limpia que la referencia no se afloja por haber mejorado (si no, con el castigo cada vez
    más barato, los toques vuelven de a poco)."""

    # toques provocados por km de models/fase7.json en cada escenario (rl/scenario_eval.js)
    REFERENCE = {"pack": 0.76, "start": 3.87, "chase": 0.68, "race": 0.87}
    RATE = 0.05  # cuánto se mueve por actualización (en escala logarítmica)
    LOW, HIGH = 0.5, 5.0

    def __init__(self, budget: float, scale: float, out: Path, keep: bool = False):
        super().__init__()
        self.budget, self.scale, self.out = budget, scale, out
        self.low = scale if keep else self.LOW
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
        self.scale = float(np.clip(self.scale * np.exp(step), self.low, self.HIGH))
        self.training_env.venv.set(contactScale=self.scale)
        self.out.joinpath("contacto.txt").write_text(f"{self.scale}\n")
        self.logger.record("contacto/presupuesto_usado", ratio)
        self.logger.record("contacto/escala", self.scale)


class Budgets(BaseCallback):
    """Presupuestos de las carreras en manada (rl/herd.js). Hay una sola medida, en todos los escenarios: el tiempo con
    castigo (por ir encimado al lado de otro, por tocarse y por pisar el pasto) contra el de la trazada arrancando
    igual. El premio de cada escenario (lo que avanza menos el castigo, como tiempo) se multiplica por su escala. Los
    escenarios que la fase premia (`objective`: un grupo de GROUPS) van con un peso fijo; en los demás se penaliza
    cualquier aumento de su tiempo respecto de la fase anterior: su escala sube en cuanto empeora (la tolerancia sólo
    cubre el ruido de medir) y baja de a poco si mejora, nunca por debajo de su peso normal.

    Se mide de dos maneras, y vale la peor: en los episodios del entrenamiento (con el ruido que se agrega para
    explorar) y en carreras fijas sin ese ruido, como maneja la red en el juego (rl/herd_eval.js, en segundo plano:
    apenas termina una medición arranca otra con la red de ese momento). Sólo con la primera, en la v11 la vuelta en
    la grilla empeoró de 1,020 a 1,072 manejando como en el juego y el presupuesto no se enteró.

    El objetivo de cada escenario es lo que dejó la fase anterior (`targets`: su medidas.json y, al lado, fijas.json,
    la medición sin ruido de su red final). Si falta (o se midió distinto: las fases de antes de esta medida), se
    calibra al arrancar: en el entrenamiento, con lo que hace la red mientras sólo aprende el crítico (`calibrate`
    pasos); sin ruido, con la primera medición, que es la red de la fase anterior. Las escalas arrancan desde las de
    la fase anterior (escalas.json), sin pasar del techo; al final quedan medidas.json y fijas.json."""

    SCENARIOS = ("solo", "grid", "rolling", "flying", "chase", "start")
    # qué escenarios premia cada fase; all: la integración, todos con el mismo peso
    GROUPS = {"launch": ("grid", "flying", "start"), "pace": ("solo", "rolling"), "chase": ("chase",), "all": SCENARIOS}
    TOLERANCE, UNIT = 0.005, 0.01  # sólo el ruido de medir (0,5 % del tiempo); cuánto es un error de 1
    RATE = 0.1  # cuánto se mueve la escala por actualización (en escala logarítmica)
    # el techo, por encima del peso del objetivo (3): si no, la fase podía comprar su objetivo con todo lo demás
    # (v13 fase 6: toques con peso 4 y techo 3)
    LOW, HIGH = 1.0, 4.0
    MIN_SAMPLES = 30
    FIXED_RACES = 8  # carreras por escenario en cada medición sin ruido: una por circuito (~4 min)

    def __init__(self, out: Path, objective: str, weight: float, targets: dict, fixed_targets: dict, scales: dict,
                 calibrate: int, damage: str = "off", agents: int = 16):
        super().__init__()
        self.damage, self.agents = damage, agents  # la medición sin ruido, con los daños y autos de la fase
        self.out, self.calibrate = out, calibrate
        premiados = self.GROUPS[objective] if objective else ()
        self.budgets = [sc for sc in self.SCENARIOS if sc not in premiados]  # los que no pueden empeorar
        self.targets = {sc: v for sc, v in targets.items() if sc in self.budgets}
        self.fixed_targets = {sc: v for sc, v in fixed_targets.items() if sc in self.budgets}
        self.scales = {sc: float(np.clip(scales.get(sc, 1.0), self.LOW, self.HIGH)) for sc in self.SCENARIOS}
        for sc in premiados:
            self.scales[sc] = weight
        self.values = defaultdict(lambda: deque(maxlen=300))  # escenario → tiempos de los últimos episodios
        self.fixed = None  # la última medición sin ruido
        self.job = None  # la medición en curso

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
        """Arranca una medición sin ruido con la red de ahora (o, con wait, la hace y la devuelve)."""
        from export import export

        net = self.out / "medicion.json"
        export(self.model.policy, str(net))
        env = {**os.environ, "JSON": "1", "RACES": str(self.FIXED_RACES), "DANOS": self.damage, "AGENTS": str(self.agents)}
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
        return float(np.clip((value - target - self.TOLERANCE) / self.UNIT, -0.5, 1))  # más lento para bajar que para subir

    def _on_rollout_end(self):
        calibrating = self.num_timesteps - self.start < self.calibrate
        fresh = self.collect()
        if fresh:
            self.fixed = fresh.get("time", {})
            for sc, v in self.fixed.items():
                if v == v:  # no NaN
                    self.logger.record(f"fija/{sc}", v)
                    if sc in self.budgets and sc not in self.fixed_targets:
                        self.fixed_targets[sc] = v  # la primera: la red de la fase anterior
                        print(f"Objetivo sin ruido en {sc}: {v:.3f}")
            self.measure_fixed()
        measures = {}
        for sc in self.SCENARIOS:
            v = self.measure(sc)
            if v is not None:
                measures[sc] = v
                self.logger.record(f"medida/{sc}", v)
            if sc not in self.budgets:
                continue
            errors = []
            if v is not None:
                target = self.targets.get(sc)
                if target is None:
                    # sin objetivo: se toma lo de la red al arrancar (al terminar de calibrar el crítico)
                    if not calibrating:
                        self.targets[sc] = v
                        print(f"Objetivo en {sc} calibrado: {v:.3f}")
                else:
                    self.logger.record(f"objetivo/{sc}", target)
                    errors.append(self.error(v, target))
            fv, ft = (self.fixed or {}).get(sc), self.fixed_targets.get(sc)
            if fv is not None and ft is not None and fv == fv and ft == ft:
                errors.append(self.error(fv, ft))
            if errors and not calibrating:
                self.scales[sc] = float(np.clip(self.scales[sc] * np.exp(self.RATE * max(errors)), self.LOW, self.HIGH))
        for sc, x in self.scales.items():
            self.logger.record(f"escala/{sc}", x)
        self.training_env.venv.set(scales=self.scales)
        self.out.joinpath("escalas.json").write_text(json.dumps(self.scales, indent=2) + "\n")
        self.out.joinpath("medidas.json").write_text(json.dumps({"time": measures}, indent=2) + "\n")

    def _on_training_end(self):
        # la medición sin ruido de la red final: el objetivo de la fase siguiente
        if self.job:
            self.job.kill()
            self.job = None
        fixed = self.measure_fixed(wait=True)
        if fixed:
            self.out.joinpath("fijas.json").write_text(json.dumps(fixed, indent=2) + "\n")


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
    p.add_argument("--race", action="store_true", help="escenarios con varios autos y rivales (rl/race.js)")
    p.add_argument("--herd", action="store_true",
                   help="carreras en manada: todos los autos son agentes (rl/herd.js), con presupuestos (Budgets)")
    p.add_argument("--objective", choices=list(Budgets.GROUPS),
                   help="manada: qué escenarios premia la fase (launch: grid, flying y start; pace: solo y rolling; chase; all)")
    p.add_argument("--objective-weight", type=float, default=3.0, help="manada: peso fijo de esa habilidad")
    p.add_argument("--targets", default="",
                   help="manada: objetivos de los presupuestos: medidas.json de la fase anterior (con varios, separados por coma, lo mejor de ellos)")
    p.add_argument("--eval-damage", choices=["off", "reduced", "real"],
                   help="manada: daños de la medición sin ruido (por defecto, los de la fase). Con los mismos en todas las "
                        "fases, las mediciones se comparan aunque los daños del entrenamiento se prendan a mitad del currículo")
    p.add_argument("--recalibrate", action="store_true",
                   help="manada: los objetivos medidos al entrenar (medidas.json) se calibran de nuevo al arrancar en lugar de "
                        "tomarlos de la fase anterior; los de la medición sin ruido sí se toman (cuando cambian los daños)")
    p.add_argument("--recalibrate-fixed", action="store_true",
                   help="manada: los objetivos sin ruido (fijas.json) también se calibran de nuevo, con la red al arrancar "
                        "(cuando cambia cómo se mide, como al agregar el semáforo y la largada en movimiento)")
    p.add_argument("--calibrate", type=int, default=0,
                   help="manada: pasos al principio para calibrar los objetivos que falten (por defecto, --critic-warmup)")
    p.add_argument("--agents", type=int, default=4, help="autos que aprenden en cada carrera")
    p.add_argument("--mix", default="race:1", help="peso de cada escenario (rl/race.js), en pasos: pack:45,start:30,solo:25")
    p.add_argument("--opponents", default="", help="redes (separadas por coma) que manejan parte de los rivales")
    p.add_argument("--spread", type=spread, default=0.02,
                   help="variación de los autos: 0.05 (±5 %%) o 0.15,0.2 (de -15 %% a +20 %%)")
    p.add_argument("--race-spread", type=spread, help="variación de los autos en carrera completa (por defecto, --spread)")
    p.add_argument("--critic-warmup", type=int, default=0,
                   help="pasos al principio en los que sólo aprende el crítico (al cambiar la recompensa)")
    p.add_argument("--lr", type=float, help="tasa de aprendizaje inicial (baja de a poco hasta 0)")
    p.add_argument("--net", type=lambda s: [int(x) for x in s.split(",")], default=[384, 512],
                   help="neuronas por capa (dos capas) de la política y del crítico: 384,512. Sólo al empezar de cero")
    p.add_argument("--fresh-opponents", action="store_true",
                   help="pone en cero los pesos que reciben los datos de los rivales (al pasar de la etapa 1 a la 2)")
    p.add_argument("--resume", help="modelo .zip desde donde seguir")
    p.add_argument("--rewards", default="",
                   help="escala de partes del premio, p. ej. progress:0.7,pass:0,paceFloor:1 (carreras) o grass:3,wall:2 (sola)")
    p.add_argument("--contact-scale", type=float,
                   help="escala inicial del castigo por toque provocado (por defecto, con la que terminó la fase anterior)")
    p.add_argument("--contact-budget", type=float,
                   help="toques provocados permitidos, como fracción de los de la fase 7 (0.5: la mitad); ver ContactBudget")
    p.add_argument("--contact-keep", action="store_true",
                   help="el castigo por toque no baja de con el que arranca la fase (ver ContactBudget)")
    p.add_argument("--rivals-boost", type=float, default=0,
                   help="rivales más rápidos: esta fracción más de agarre y potencia (p. ej. 0.08), y la IA de siempre a más ritmo")
    p.add_argument("--damage", default="off", choices=["off", "reduced", "real", "mix"],
                   help="daños en las carreras (src/sim/damage.js); mix: cada escenario con uno de los tres al azar")
    p.add_argument("--damaged-starts", type=float, default=0,
                   help="parte de los agentes que arranca con algo roto (con daños prendidos), p. ej. 0.15")
    p.add_argument("--tune-spread", type=int, default=3,
                   help="puntos de alerón y balance al azar alrededor de la puesta del circuito (0: la del circuito y su aire)")
    p.add_argument("--stop-at", type=int,
                   help="corta a estos pasos de la fase, con la tasa de aprendizaje bajando como si durara --steps (ver StopAt)")
    p.add_argument("--seed", type=int, default=0)
    args = p.parse_args()

    torch.set_num_threads(4)  # el resto de los núcleos quedan para los procesos de Node
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
    # recompensas escaladas para que el crítico (la red que estima el valor) no se desajuste; las observaciones
    # no se tocan, así la red se usa igual en el juego
    env = VecNormalize(env, norm_obs=False, norm_reward=True, gamma=0.995)

    if args.resume:
        old = PPO.load(args.resume, device="cpu")
        if old.observation_space.shape != env.observation_space.shape or old.action_space.shape != env.action_space.shape:
            model = widen(old, env)
        else:
            model = PPO.load(args.resume, env=env, device="cpu")
        if args.fresh_opponents:
            # En la etapa 1 los datos de los rivales siempre fueron cero: esos pesos de la primera capa nunca se
            # entrenaron y siguen al azar. En cero, la red arranca manejando igual que en la etapa 1 y aprende
            # de a poco a usar a los rivales (si no, el ruido le desarma lo aprendido)
            with torch.no_grad():
                for net in (model.policy.mlp_extractor.policy_net, model.policy.mlp_extractor.value_net):
                    for start, size in opponent_columns():
                        net[0].weight[:, start : start + size] = 0
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
            policy_kwargs=dict(net_arch=dict(pi=[args.net[0]] * 2, vf=[args.net[1]] * 2), log_std_init=-0.5),
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
    if args.race or args.herd:
        callbacks.append(PhaseProgress(args.steps))
    if args.herd:
        # el mejor tiempo de cada escenario en las fases anteriores (las medidas de antes del tiempo con castigo no
        # tienen "time": esos objetivos se calibran de nuevo)
        def best(files):
            out: dict = {}
            for file in files:
                if not Path(file).exists():
                    continue
                for sc, v in json.loads(Path(file).read_text()).get("time", {}).items():
                    if v == v:  # NaN: no se pudo medir
                        out[sc] = v if sc not in out else min(out[sc], v)
            return out

        files = [f for f in args.targets.split(",") if f]
        targets = {} if args.recalibrate else best(files)
        fixed_targets = {} if args.recalibrate_fixed else best(str(Path(f).parent / "fijas.json") for f in files)
        prev = Path(args.resume).parent / "escalas.json" if args.resume else None
        scales = json.loads(prev.read_text()) if prev and prev.exists() else {}
        if set(scales) != set(Budgets.SCENARIOS):  # de antes de las escalas por escenario: arrancan de 1
            scales = {}
        callbacks.append(Budgets(out, args.objective, args.objective_weight, targets, fixed_targets, scales,
                                 args.calibrate or args.critic_warmup or 2_000_000, damage=args.eval_damage or args.damage, agents=args.agents))
    if args.stop_at:
        callbacks.append(StopAt(args.stop_at))
    if args.contact_budget:
        # arranca desde la escala con que terminó la fase anterior, si la hay
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
