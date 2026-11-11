"""Reescala los pesos de entrada de la variación del auto (motor, punta, agarre, frenos) cuando cambia cómo se
normalizan en src/drivers/sensors.js (SETUP_SPREAD). Si la entrada se divide por un número `factor` veces más grande, los
pesos que la reciben se multiplican por `factor`: la red maneja exactamente igual.

    rl/.venv/bin/python rl/rescale_setup.py 4 models/fase7.json models/v3/*.json      (en el lugar)
    rl/.venv/bin/python rl/rescale_setup.py 4 rl/runs/v3fase4/model.zip rl/runs/v3fase4/model_s.zip

Fue de 0,05 a 0,2 (factor 4). Sólo para redes con esos datos (94 entradas); las anteriores se dejan como están.
"""

import base64
import json
import sys
from pathlib import Path

import numpy as np
import torch

SETUP_START, COLUMNS = 12, 4  # en src/drivers/sensors.js: después de los 12 valores del auto; motor, punta, agarre, frenos
OBS_SIZE = 94


def rescale_json(path: Path, factor: float):
    data = json.loads(path.read_text())
    if data["obs_size"] != OBS_SIZE:
        print(f"{path}: {data['obs_size']} entradas, se deja igual")
        return
    first = data["layers"][0]
    w = np.frombuffer(base64.b64decode(first["w"]), dtype="<f4").reshape(first["out"], first["in"]).copy()
    w[:, SETUP_START : SETUP_START + COLUMNS] *= factor
    first["w"] = base64.b64encode(w.astype("<f4").tobytes()).decode()
    path.write_text(json.dumps(data, separators=(",", ":")))
    print(f"{path}: reescalada")


def rescale_zip(src: str, dst: str, factor: float):
    from stable_baselines3 import PPO

    model = PPO.load(src, device="cpu")
    with torch.no_grad():
        for net in (model.policy.mlp_extractor.policy_net, model.policy.mlp_extractor.value_net):
            net[0].weight[:, SETUP_START : SETUP_START + COLUMNS] *= factor
    model.save(dst)
    print(f"{dst}: reescalada")


if __name__ == "__main__":
    factor, *files = sys.argv[1:]
    if files[0].endswith(".zip"):
        rescale_zip(files[0], files[1], float(factor))
    else:
        for f in files:
            rescale_json(Path(f), float(factor))
