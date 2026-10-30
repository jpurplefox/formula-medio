"""Exporta la red de un modelo entrenado a JSON, para correrla en JavaScript (src/policy.js).

    rl/.venv/bin/python rl/export.py rl/runs/etapa1/model.zip models/etapa1.json
    rl/.venv/bin/python rl/export.py rl/runs/etapa2/model.zip models/etapa2.json rivales

Con "rivales" el archivo indica que la red aprendió a mirar a los demás autos (etapa 2).

Sólo hace falta la parte que decide (la "política"): capas lineales con tanh en el medio. De la salida se usa
el promedio (sin el ruido que se agrega al entrenar).
"""

import base64
import json
import sys
from pathlib import Path

import torch
from stable_baselines3 import PPO


def b64(t):
    return base64.b64encode(t.detach().numpy().astype("<f4").tobytes()).decode()


def layers(seq):
    return [m for m in seq if isinstance(m, torch.nn.Linear)]


def main(src: str, dst: str, mode: str = ""):
    policy = PPO.load(src, device="cpu").policy
    linear = layers(policy.mlp_extractor.policy_net) + [policy.action_net]
    acts = [type(m).__name__ for m in policy.mlp_extractor.policy_net if not isinstance(m, torch.nn.Linear)]
    assert all(a == "Tanh" for a in acts), acts
    data = {
        "obs_size": linear[0].in_features,
        "opponents": mode == "rivales",
        # pesos en float32 little-endian, en base64 (w: una fila por neurona de salida)
        "layers": [
            {"in": m.in_features, "out": m.out_features, "w": b64(m.weight), "b": b64(m.bias)}
            for m in linear
        ],
    }
    Path(dst).parent.mkdir(parents=True, exist_ok=True)
    Path(dst).write_text(json.dumps(data, separators=(",", ":")))
    print(f"{dst}: {len(linear)} capas, {Path(dst).stat().st_size // 1024} KB")


if __name__ == "__main__":
    main(*sys.argv[1:4])
