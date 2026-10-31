"""Entornos del juego para stable-baselines3: varios procesos de Node (rl/worker.js), cada uno con varios autos.

Cada proceso corre en un núcleo; Python les manda las acciones a todos a la vez y después junta las respuestas.
"""

import json
import subprocess
from pathlib import Path

import numpy as np
from gymnasium import spaces
from stable_baselines3.common.vec_env.base_vec_env import VecEnv

ROOT = Path(__file__).resolve().parent.parent
TRACKS = ["interlagos", "monza", "albertpark", "barcelona", "montreal", "spa", "silverstone", "redbullring"]


class Worker:
    """mode "solo": envs autos sueltos (fase 1); "race": envs carreras con varios autos que aprenden (fases 2 a 4).
    config: opciones de RaceEnv / RaceSim (rl/env.js, rl/race.js), por ejemplo spread, agents, opponents, mix."""

    def __init__(self, envs: int, tracks: list[str], seed: int, mode: str = "solo", config: dict | None = None):
        args = [mode, str(envs), ",".join(tracks), str(seed), json.dumps(config or {})]
        self.proc = subprocess.Popen(
            ["node", str(ROOT / "rl" / "worker.js"), *args],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            cwd=ROOT,
        )
        hello = json.loads(self.proc.stdout.readline())
        self.obs_size = hello["obs_size"]
        self.n = hello["envs"]  # agentes en total

    def _read(self, count: int) -> np.ndarray:
        data = self.proc.stdout.read(count * 4)
        if len(data) != count * 4:
            raise RuntimeError("El proceso de Node se cortó")
        return np.frombuffer(data, dtype=np.float32)

    def send_reset(self):
        self.proc.stdin.write(b"\x01")
        self.proc.stdin.flush()

    def read_reset(self) -> np.ndarray:
        return self._read(self.n * self.obs_size).reshape(self.n, self.obs_size)

    def set(self, settings: dict):
        data = json.dumps(settings).encode()
        self.proc.stdin.write(b"\x02" + len(data).to_bytes(4, "little") + data)
        self.proc.stdin.flush()

    def send_step(self, actions: np.ndarray):
        self.proc.stdin.write(b"\x00" + np.asarray(actions, dtype=np.float32).tobytes())
        self.proc.stdin.flush()

    def read_step(self):
        n, k = self.n, self.obs_size
        block = self._read(n * (k + 3))
        obs = block[: n * k].reshape(n, k)
        rewards = block[n * k : n * (k + 1)]
        dones = block[n * (k + 1) : n * (k + 2)] > 0.5
        truncated = block[n * (k + 2) :] > 0.5
        events = json.loads(self.proc.stdout.readline())
        return obs, rewards, dones, truncated, events

    def close(self):
        self.proc.stdin.close()
        self.proc.wait(timeout=5)


class RacingVecEnv(VecEnv):
    def __init__(self, workers: int = 8, envs_per_worker: int = 16, tracks: list[str] = TRACKS, seed: int = 0, **mode):
        self.workers = [Worker(envs_per_worker, tracks, seed * 100 + w, **mode) for w in range(workers)]
        obs_size = self.workers[0].obs_size
        observation_space = spaces.Box(-3.0, 3.0, shape=(obs_size,), dtype=np.float32)
        action_space = spaces.Box(-1.0, 1.0, shape=(2,), dtype=np.float32)
        self.per = self.workers[0].n
        super().__init__(workers * self.per, observation_space, action_space)
        self._actions = None
        self.laps: list[tuple[str, float]] = []  # vueltas completas desde la última vez que se leyeron

    def reset(self):
        for w in self.workers:
            w.send_reset()
        return np.concatenate([w.read_reset() for w in self.workers])

    def step_async(self, actions):
        self._actions = np.clip(actions, -1, 1)

    def step_wait(self):
        for i, w in enumerate(self.workers):
            w.send_step(self._actions[i * self.per : (i + 1) * self.per])
        parts = [w.read_step() for w in self.workers]
        obs = np.concatenate([p[0] for p in parts]).copy()
        rewards = np.concatenate([p[1] for p in parts]).astype(np.float32)
        dones = np.concatenate([p[2] for p in parts])
        truncated = np.concatenate([p[3] for p in parts])
        infos = [{} for _ in range(self.num_envs)]
        for i, p in enumerate(parts):
            for k, ev in p[4]:
                info = infos[i * self.per + k]
                if "lap" in ev:
                    self.laps.append(tuple(ev["lap"]))
                if "episode" in ev:
                    info["episode"] = ev["episode"]
                    info["terminal_observation"] = np.asarray(ev["terminal"], dtype=np.float32)
        for j in range(self.num_envs):
            if dones[j]:
                infos[j]["TimeLimit.truncated"] = bool(truncated[j])
        return obs, rewards, dones, infos

    def set(self, **settings):
        """Ajustes de todas las carreras (rl/race.js): contactScale multiplica el castigo por toque provocado
        (presupuesto de toques, rl/train.py); progress es cuánto lleva la fase, de 0 a 1."""
        for w in self.workers:
            w.set(settings)

    def close(self):
        for w in self.workers:
            w.close()

    # lo que stable-baselines3 pide a todo VecEnv y acá no hace falta
    def get_attr(self, attr_name, indices=None):
        return [None] * self.num_envs

    def set_attr(self, attr_name, value, indices=None):
        pass

    def env_method(self, method_name, *args, indices=None, **kwargs):
        return [None] * self.num_envs

    def env_is_wrapped(self, wrapper_class, indices=None):
        return [False] * self.num_envs

    def seed(self, seed=None):
        return [None] * self.num_envs
