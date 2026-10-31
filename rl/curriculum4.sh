#!/bin/sh
# Cuarto intento (rl/CURRICULO.md): parte de la fase 4 del tercero (la más limpia) y en vez de premiar pasadas pide
# mantener el ritmo. Modelos en models/v4/ (~1,5 h).
#
#   sh rl/curriculum4.sh [primera fase]      (5 o 6)
set -e
cd "$(dirname "$0")/.."
PY=rl/.venv/bin/python
FROM=${1:-5}
mkdir -p models/v4
# autos de -15 % a +20 %: para poder subir la dificultad en el juego dándoles más agarre
CARS="--spread 0.15,0.2"
# ritmo siempre (salvo amontonado), sin premio por pasar, toques más caros amontonado (largadas)
REWARDS="--rewards progress:1,pass:0,paceFloor:1,paceAlways:1,crowd:2.5"
# presupuesto alcanzable: 80 % de los toques provocados de la fase 7
BUDGET="--contact-budget 0.8"

if [ "$FROM" -le 5 ]; then
  # la red de la fase 4 del tercer intento, con las entradas del auto en la escala nueva (rl/rescale_setup.py)
  [ -f rl/runs/v3fase4/model_s.zip ] || $PY rl/rescale_setup.py 4 rl/runs/v3fase4/model.zip rl/runs/v3fase4/model_s.zip
  # ritmo sin chocar: persecuciones de un auto claramente peor (la desventaja se achica en la fase), carreras y repaso
  $PY rl/train.py --name v4fase5 --race --envs 4 --mix race:35,chase:25,start:15,pack:15,solo:10 $CARS $REWARDS $BUDGET \
    --opponents models/fase7.json,models/v3/fase4.json --steps 35000000 \
    --resume rl/runs/v3fase4/model_s.zip --contact-scale 2 --critic-warmup 2000000 --lr 1e-4 > rl/runs/v4fase5.log 2>&1
  $PY rl/export.py rl/runs/v4fase5/model.zip models/v4/fase5.json rivales
fi
if [ "$FROM" -le 6 ]; then
  # integrar: carreras completas con más rivales que son redes, como en el juego
  $PY rl/train.py --name v4fase6 --race --envs 4 --mix race:55,start:15,pack:10,chase:10,solo:10 $CARS $REWARDS $BUDGET \
    --opponents models/fase7.json,models/v3/fase4.json,models/v4/fase5.json --steps 30000000 \
    --resume rl/runs/v4fase5/model.zip --critic-warmup 1000000 --lr 5e-5 > rl/runs/v4fase6.log 2>&1
  $PY rl/export.py rl/runs/v4fase6/model.zip models/v4/fase6.json rivales
fi
