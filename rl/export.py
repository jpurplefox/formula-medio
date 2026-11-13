"""Exports the network of a trained model to JSON, to run it in JavaScript (src/drivers/policy.js).

    rl/.venv/bin/python rl/export.py rl/runs/etapa1/model.zip models/etapa1.json
    rl/.venv/bin/python rl/export.py rl/runs/etapa2/model.zip models/etapa2.json rivales

With "rivales" (opponents) the file states that the network learned to look at the other cars (stage 2).

Only the part that decides (the "policy") is needed: linear layers with tanh in between. From the output, the mean
is used (without the noise added during training).
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
    export(PPO.load(src, device="cpu").policy, dst, mode == "rivales")


def export(policy, dst: str, opponents: bool = True):
    """A model's policy (in memory) to JSON; training also uses it to measure itself."""
    linear = layers(policy.mlp_extractor.policy_net) + [policy.action_net]
    acts = [type(m).__name__ for m in policy.mlp_extractor.policy_net if not isinstance(m, torch.nn.Linear)]
    assert all(a == "Tanh" for a in acts), acts
    data = {
        "obs_size": linear[0].in_features,
        "opponents": opponents,
        # weights as little-endian float32, in base64 (w: one row per output neuron)
        "layers": [
            {"in": m.in_features, "out": m.out_features, "w": b64(m.weight), "b": b64(m.bias)}
            for m in linear
        ],
    }
    Path(dst).parent.mkdir(parents=True, exist_ok=True)
    Path(dst).write_text(json.dumps(data, separators=(",", ":")))
    print(f"{dst}: {len(linear)} layers, {Path(dst).stat().st_size // 1024} KB")


if __name__ == "__main__":
    main(*sys.argv[1:4])
