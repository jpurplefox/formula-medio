#!/bin/sh
# Tercer intento del currículum (rl/CURRICULO.md): primero manejar limpio, después velocidad y recién al final pasar.
# Cada fase parte del modelo final de la anterior y se exporta a models/v3/faseN.json (~3,5 h en total).
#
#   sh rl/curriculum3.sh [primera fase]      (por defecto 1; por ejemplo 4 para rehacer desde la fase 4)
set -e
cd "$(dirname "$0")/.."
PY=rl/.venv/bin/python
FROM=${1:-1}
mkdir -p models/v3
# castigo por toque provocado ajustado solo: la mitad de los toques que provoca la fase 7 del segundo intento
BUDGET="--contact-budget 0.5"
# sin premio por pasar y con piso de ritmo: limpio pero sin quedarse
CLEAN="--rewards progress:0.7,pass:0,paceFloor:1"

run() { # nombre, opciones de train.py
  name=$1; shift
  $PY rl/train.py --name v3$name "$@" > rl/runs/v3$name.log 2>&1
  $PY rl/export.py rl/runs/v3$name/model.zip models/v3/$name.json rivales
}

if [ "$FROM" -le 1 ]; then
  # manejar dentro de la pista: pasto y muro más caros, menos pasos que antes (no sobre-optimizar la vuelta)
  $PY rl/train.py --steps 40000000 --name v3fase1 --rewards grass:3,wall:2 > rl/runs/v3fase1.log 2>&1
  $PY rl/export.py rl/runs/v3fase1/model.zip models/v3/fase1.json
fi
if [ "$FROM" -le 2 ]; then
  # no chocar en grupo: pelotón llegando a una curva y largadas; los pesos de los rivales arrancan en cero
  run fase2 --race --envs 4 --mix solo:30,pack:40,start:30 --steps 30000000 $CLEAN $BUDGET \
    --resume rl/runs/v3fase1/model.zip --fresh-opponents --critic-warmup 3000000 --lr 1e-4
fi
if [ "$FROM" -le 3 ]; then
  # no chocar en carrera: carreras con autos más distintos y rivales que son redes; seguir a uno más lento sin pasarlo
  run fase3 --race --envs 4 --mix race:35,start:20,pack:20,chase:10,solo:15 --race-spread 0.05 $CLEAN $BUDGET \
    --opponents models/fase7.json,models/v3/fase2.json --steps 30000000 \
    --resume rl/runs/v3fase2/model.zip --critic-warmup 1000000 --lr 1e-4
fi
if [ "$FROM" -le 4 ]; then
  # velocidad sin chocar: el avance vuelve a pesar entero, con el mismo presupuesto de toques
  run fase4 --race --envs 4 --mix race:40,solo:20,start:15,pack:15,chase:10 --race-spread 0.05 \
    --rewards progress:1,pass:0,paceFloor:1 $BUDGET \
    --opponents models/fase7.json,models/v3/fase2.json,models/v3/fase3.json --steps 30000000 \
    --resume rl/runs/v3fase3/model.zip --critic-warmup 2000000 --lr 5e-5
fi
if [ "$FROM" -le 5 ]; then
  # pasar seguro: premio por pasada limpia (sostenida, sin toques ni pasto, con pocos autos alrededor)
  run fase5 --race --envs 4 --mix chase:40,race:25,start:15,pack:10,solo:10 --race-spread 0.05 \
    --rewards progress:1,pass:1,paceFloor:1 $BUDGET \
    --opponents models/fase7.json,models/v3/fase3.json,models/v3/fase4.json --steps 30000000 \
    --resume rl/runs/v3fase4/model.zip --critic-warmup 2000000 --lr 5e-5
fi
if [ "$FROM" -le 6 ]; then
  # integrar: carreras completas con rivales de todo tipo, más repaso
  run fase6 --race --envs 4 --mix race:55,start:15,pack:10,chase:10,solo:10 --race-spread 0.05 \
    --rewards progress:1,pass:1,paceFloor:1 $BUDGET \
    --opponents models/fase1.json,models/fase7.json,models/v3/fase3.json,models/v3/fase4.json,models/v3/fase5.json \
    --steps 30000000 --resume rl/runs/v3fase5/model.zip --critic-warmup 1000000 --lr 5e-5
fi
