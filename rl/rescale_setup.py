"""Rescales the input weights for the car variation (engine, top speed, grip, brakes) when the way they are
normalized in src/drivers/sensors.js (SETUP_SPREAD) changes. If the input is divided by a number `factor` times larger,
the weights that receive it are multiplied by `factor`: the network drives exactly the same.

    rl/.venv/bin/python rl/rescale_setup.py 4 models/fase7.json models/v3/*.json      (in place)
    rl/.venv/bin/python rl/rescale_setup.py 4 rl/runs/v3fase4/model.zip rl/runs/v3fase4/model_s.zip

It went from 0.05 to 0.2 (factor 4). Only for networks with those inputs (94 inputs); older ones are left as they are.
"""

import base64
import json
import sys
from pathlib import Path

import numpy as np
import torch

SETUP_START, COLUMNS = 12, 4  # in src/drivers/sensors.js: after the car's 12 values; engine, top speed, grip, brakes
OBS_SIZE = 94


def rescale_json(path: Path, factor: float):
    data = json.loads(path.read_text())
    if data["obs_size"] != OBS_SIZE:
        print(f"{path}: {data['obs_size']} inputs, left unchanged")
        return
    first = data["layers"][0]
    w = np.frombuffer(base64.b64decode(first["w"]), dtype="<f4").reshape(first["out"], first["in"]).copy()
    w[:, SETUP_START : SETUP_START + COLUMNS] *= factor
    first["w"] = base64.b64encode(w.astype("<f4").tobytes()).decode()
    path.write_text(json.dumps(data, separators=(",", ":")))
    print(f"{path}: rescaled")


def rescale_zip(src: str, dst: str, factor: float):
    from stable_baselines3 import PPO

    model = PPO.load(src, device="cpu")
    with torch.no_grad():
        for net in (model.policy.mlp_extractor.policy_net, model.policy.mlp_extractor.value_net):
            net[0].weight[:, SETUP_START : SETUP_START + COLUMNS] *= factor
    model.save(dst)
    print(f"{dst}: rescaled")


if __name__ == "__main__":
    factor, *files = sys.argv[1:]
    if files[0].endswith(".zip"):
        rescale_zip(files[0], files[1], float(factor))
    else:
        for f in files:
            rescale_json(Path(f), float(factor))
