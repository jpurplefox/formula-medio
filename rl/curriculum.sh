#!/bin/sh
# Entrena el currículum completo (rl/CURRICULO.md): cada fase parte del modelo final de la anterior y al terminar
# se exporta a models/faseN.json. Las redes de las fases anteriores manejan parte de los rivales en la fase 4.
#
#   sh rl/curriculum.sh [primera fase]      (por defecto 1; por ejemplo 3 para rehacer desde la fase 3)
set -e
cd "$(dirname "$0")/.."
PY=rl/.venv/bin/python
FROM=${1:-1}

if [ "$FROM" -le 1 ]; then
  $PY rl/train.py --steps 60000000 --name fase1 > rl/runs/fase1.log 2>&1
  $PY rl/export.py rl/runs/fase1/model.zip models/fase1.json
fi
if [ "$FROM" -le 2 ]; then
  # no chocar: pelotón llegando a una curva y largadas; los pesos de los rivales arrancan en cero
  $PY rl/train.py --race --envs 4 --mix solo:25,pack:45,start:30 --steps 30000000 --name fase2 \
    --resume rl/runs/fase1/model.zip --fresh-opponents --critic-warmup 3000000 --lr 1e-4 > rl/runs/fase2.log 2>&1
  $PY rl/export.py rl/runs/fase2/model.zip models/fase2.json rivales
fi
if [ "$FROM" -le 3 ]; then
  # pasar: persecuciones de un rival más lento, en recta y antes de una curva, con repaso de la fase 2
  $PY rl/train.py --race --envs 4 --mix solo:15,pack:20,start:20,chase:45 --steps 30000000 --name fase3 \
    --resume rl/runs/fase2/model.zip --critic-warmup 2000000 --lr 1e-4 > rl/runs/fase3.log 2>&1
  $PY rl/export.py rl/runs/fase3/model.zip models/fase3.json rivales
fi
if [ "$FROM" -le 4 ]; then
  # consolidar: carreras completas con autos más distintos y versiones anteriores de rivales, más repaso
  $PY rl/train.py --race --envs 4 --mix race:55,solo:10,pack:10,start:10,chase:15 --race-spread 0.05 \
    --opponents models/fase1.json,models/fase2.json,models/fase3.json --steps 40000000 --name fase4 \
    --resume rl/runs/fase3/model.zip --critic-warmup 2000000 --lr 5e-5 > rl/runs/fase4.log 2>&1
  $PY rl/export.py rl/runs/fase4/model.zip models/fase4.json rivales
fi
if [ "$FROM" -le 5 ]; then
  # limpieza: toques de costado y largadas; parte de la fase 4 con más peso en largadas y pelotón
  $PY rl/train.py --race --envs 4 --mix race:45,start:20,pack:15,chase:10,solo:10 --race-spread 0.05 \
    --opponents models/fase1.json,models/fase2.json,models/fase3.json,models/fase4.json --steps 30000000 --name fase5 \
    --resume rl/runs/fase4/model.zip --critic-warmup 2000000 --lr 5e-5 > rl/runs/fase5.log 2>&1
  $PY rl/export.py rl/runs/fase5/model.zip models/fase5.json rivales
fi
if [ "$FROM" -le 6 ]; then
  # más limpieza: ve el peligro de atrás antes (1 s) y provocar un toque cuesta más; más carreras con la IA de siempre
  $PY rl/train.py --race --envs 4 --mix race:50,start:20,pack:15,chase:5,solo:10 --race-spread 0.05 \
    --opponents models/fase1.json,models/fase3.json,models/fase4.json,models/fase5.json --steps 30000000 --name fase6 \
    --resume rl/runs/fase5/model.zip --critic-warmup 2000000 --lr 5e-5 > rl/runs/fase6.log 2>&1
  $PY rl/export.py rl/runs/fase6/model.zip models/fase6.json rivales
fi
if [ "$FROM" -le 7 ]; then
  # el peligro de costado también a 1 s: con menos, al frenar antes por el de adelante esquivaba hacia el de al lado
  $PY rl/train.py --race --envs 4 --mix race:50,start:20,pack:15,chase:5,solo:10 --race-spread 0.05 \
    --opponents models/fase1.json,models/fase4.json,models/fase5.json,models/fase6.json --steps 30000000 --name fase7 \
    --resume rl/runs/fase6/model.zip --critic-warmup 2000000 --lr 5e-5 > rl/runs/fase7.log 2>&1
  $PY rl/export.py rl/runs/fase7/model.zip models/fase7.json rivales
fi
