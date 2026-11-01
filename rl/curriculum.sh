#!/bin/sh
# Entrena desde cero la receta de la red del juego (rl/CURRICULO.md): las fases 1–4 del tercer intento, las 5–6
# del cuarto y una 7 contra rivales más rápidos. Cada fase parte del modelo final de la anterior y se exporta a
# models/$NOMBRE/faseN.json; al final mide las dos últimas contra la elegida en la carrera tipo juego. No pisa la red
# del juego: si una nueva es mejor, se cambia a mano CURRENT_NET en src/main.js (~3 h en una Mac M4 Pro).
#
#   sh rl/curriculum.sh [primera fase]      (por defecto 1; por ejemplo 7 para rehacer sólo la última)
#   NOMBRE=v6 sh rl/curriculum.sh           (carpeta de los modelos y prefijo de rl/runs; por defecto "nueva")
#
# Hace falta rl/.venv (README, "IA por refuerzo"); los circuitos de F1 salen de tracks/*.layout.json.
set -e
cd "$(dirname "$0")/.."
PY=rl/.venv/bin/python
FROM=${1:-1}
N=${NOMBRE:-nueva}
OUT=models/$N
ACTUAL=models/v5/fase7.json
mkdir -p "$OUT" rl/runs

# castigo por toque provocado ajustado solo: la mitad de los toques que provoca la fase 7 (fases 2–4), el 80 %
# (5–6); la referencia por escenario está en ContactBudget (rl/train.py)
STRICT="--contact-budget 0.5"
BUDGET="--contact-budget 0.8"
# sin premio por pasar y con piso de ritmo: limpio pero sin quedarse
CLEAN="--rewards progress:0.7,pass:0,paceFloor:1"
# ritmo siempre (amontonado, un piso más bajo: meterse en fila cuesta tiempo), toques más caros amontonado (largadas)
PACE="--rewards progress:1,pass:0,paceFloor:1,paceAlways:1,paceCrowd:0.6,crowd:2.5"
# autos de -15 % a +20 %: para poder subir la dificultad en el juego dándoles más agarre
CARS="--spread 0.15,0.2"

run() { # fase, opciones de train.py
  fase=$1; shift
  echo "$(date +%H:%M) $N $fase"
  $PY rl/train.py --name "$N$fase" "$@" > "rl/runs/$N$fase.log" 2>&1
  $PY rl/export.py "rl/runs/$N$fase/model.zip" "$OUT/$fase.json" rivales
}

if [ "$FROM" -le 1 ]; then
  # manejar dentro de la pista: pasto y muro más caros, sin sobre-optimizar la vuelta
  echo "$(date +%H:%M) $N fase1"
  $PY rl/train.py --steps 40000000 --name "${N}fase1" --rewards grass:3,wall:2 > "rl/runs/${N}fase1.log" 2>&1
  $PY rl/export.py "rl/runs/${N}fase1/model.zip" "$OUT/fase1.json"
fi
if [ "$FROM" -le 2 ]; then
  # no chocar en grupo: pelotón llegando a una curva y largadas; los pesos de los rivales arrancan en cero
  run fase2 --race --envs 4 --mix solo:30,pack:40,start:30 --steps 30000000 $CLEAN $STRICT \
    --resume "rl/runs/${N}fase1/model.zip" --fresh-opponents --critic-warmup 3000000 --lr 1e-4
fi
if [ "$FROM" -le 3 ]; then
  # no chocar en carrera: carreras con autos distintos y rivales que son redes
  run fase3 --race --envs 4 --mix race:35,start:20,pack:20,chase:10,solo:15 --race-spread 0.05 $CLEAN $STRICT \
    --opponents "models/fase7.json,$OUT/fase2.json" --steps 30000000 \
    --resume "rl/runs/${N}fase2/model.zip" --critic-warmup 1000000 --lr 1e-4
fi
if [ "$FROM" -le 4 ]; then
  # velocidad sin chocar: el avance vuelve a pesar entero, con el mismo presupuesto de toques
  run fase4 --race --envs 4 --mix race:40,solo:20,start:15,pack:15,chase:10 --race-spread 0.05 \
    --rewards progress:1,pass:0,paceFloor:1 $STRICT \
    --opponents "models/fase7.json,$OUT/fase2.json,$OUT/fase3.json" --steps 30000000 \
    --resume "rl/runs/${N}fase3/model.zip" --critic-warmup 2000000 --lr 5e-5
fi
if [ "$FROM" -le 5 ]; then
  # ritmo sin chocar: persecuciones de un auto peor (la desventaja se achica en la fase), carreras y repaso
  run fase5 --race --envs 4 --mix race:35,chase:25,start:15,pack:15,solo:10 $CARS $PACE $BUDGET \
    --opponents "models/fase7.json,$OUT/fase4.json" --steps 35000000 \
    --resume "rl/runs/${N}fase4/model.zip" --contact-scale 2 --critic-warmup 2000000 --lr 1e-4
fi
if [ "$FROM" -le 6 ]; then
  # integrar: carreras completas con rivales que son redes, como en el juego
  run fase6 --race --envs 4 --mix race:55,start:15,pack:10,chase:10,solo:10 $CARS $PACE $BUDGET \
    --opponents "models/fase7.json,$OUT/fase4.json,$OUT/fase5.json" --steps 30000000 \
    --resume "rl/runs/${N}fase5/model.zip" --critic-warmup 1000000 --lr 5e-5
fi
if [ "$FROM" -le 7 ]; then
  # ritmo contra rivales más rápidos: entre ellos sólo mejora hasta el ritmo del de adelante. Rivales con 8 % más de
  # agarre y potencia (la IA de siempre, de 1 a 1,1 de ritmo) y, como redes, la de la fase 6 y la más rápida que hubo
  run fase7 --race --envs 4 --mix race:60,start:15,chase:10,pack:5,solo:10 $CARS $PACE $BUDGET --rivals-boost 0.08 \
    --opponents "models/fase7.json,$OUT/fase6.json" --steps 20000000 \
    --resume "rl/runs/${N}fase6/model.zip" --critic-warmup 1000000 --lr 3e-5
fi

# las nuevas contra la del juego, en la carrera tipo juego (toques, pasto y ritmo)
for m in "$ACTUAL" "$OUT/fase6.json" "$OUT/fase7.json"; do
  echo "$m"; JUEGO=1 node rl/race_eval.js "$m" 2>&1 | tail -1
done
