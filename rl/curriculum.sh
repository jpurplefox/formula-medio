#!/bin/sh
# Entrena desde cero la red del juego con el currículo en manada (rl/CURRICULO.md): desde la fase 2 todos los autos
# de cada carrera son la misma red, que aprende (rl/herd.js). Cuatro habilidades, cada una con su medida: tiempo de
# vuelta (pace), toques (contact: cada contacto que empieza, no cada roce), largada (launch: primera vuelta contra la
# lanzada) y persecución (chase: el tiempo del par). Cada fase premia una y las demás son presupuestos que se
# ajustan solos para no empeorar lo que dejó la fase anterior (Budgets, rl/train.py).
#
#   1      dar una vuelta, sola
#   2      con rivales: mantener el tiempo de vuelta tocándose menos (sin buscar cero toques)
#   3      largada: mejorar la primera vuelta contra la lanzada, sin perder vuelta ni toques
#   4      persecución a una vuelta, de a pares (el de adelante con menos motor): el tiempo del par y la pasada limpia
#   5–8    una habilidad cada una (vuelta, toques, largada, persecución); las otras, no peor que en la fase anterior
#   9      integración: tiempo de vuelta, sin empeorar las otras tres
# Los daños reales se prenden desde la fase 5: en las 1–4 se aprende a manejar en grupo sin que cada toque rompa el
# auto (con daños desde la fase 1, en la v14 los toques que la fase 2 dejaba de margen destrozaban alerones en la
# largada y el resto de la carrera se corría con autos rotos). Se mide siempre con daños reales, como en el juego,
# así las fases se comparan entre sí.
#
# Siempre se deja margen para mejorar: las fases 1–4 se cortan a la mitad (--stop-at), con la tasa de aprendizaje
# todavía alta (una fase que llega a su mejor número después sólo lo empeora), y la fase 2 no mata los toques. Cada
# fase parte del modelo final de la anterior y se exporta a models/$NOMBRE/faseN.json. Apenas termina una fase se
# mide en segundo plano mientras entrena la siguiente (en manada, sola y en la carrera tipo juego) y queda en
# rl/runs/$NOMBRE-tabla.log; al final, la última y la del juego con daños. No pisa la red del juego: si una nueva es
# mejor, se cambia a mano CURRENT_NET en src/main.js.
#
#   sh rl/curriculum.sh [primera fase]      (por defecto 1)
#   NOMBRE=v9 sh rl/curriculum.sh           (carpeta de los modelos y prefijo de rl/runs; por defecto "nueva")
#
# Hace falta rl/.venv (README, "IA por refuerzo"); los circuitos de F1 salen de tracks/*.layout.json. El currículo
# anterior, con rivales de la IA de siempre (rl/race.js), está en el historial de git (commit 47f1b3f).
set -e
cd "$(dirname "$0")/.."
PY=rl/.venv/bin/python
FROM=${1:-1}
N=${NOMBRE:-nueva}
OUT=models/$N
RUNS=rl/runs
TABLE=$RUNS/$N-tabla.log
ACTUAL=models/v14/fase16.json  # la del juego
mkdir -p "$OUT" $RUNS

# 22 autos por carrera, como en el juego, una carrera por proceso (176 agentes en total), autos de -15 % a +20 %
HERD="--herd --agents 22 --envs 1 --spread 0.15,0.2 --eval-damage real"
DAMAGE="--damage real"
# la misma mezcla de escenarios en todas las fases con rivales: lo que cambia entre fases es qué se premia, no qué
# se practica (con mezclas distintas, la 2 y la 3 nunca practicaban la persecución y nada frenaba que empeorara)
ALL="--mix solo:10,grid:40,rolling:30,chase:20"

# una fase en manada (rl/herd_eval.js), sola y en la carrera tipo juego, en una línea de la tabla
measure() { # nombre, modelo
  herd=$(DANOS=real node rl/herd_eval.js "$2" 2>&1 | grep -v '^$' | sed 's/^  [^ ]* *//' | paste -sd' ' -)
  solo=$(node rl/eval.js "$2" | tail -1)
  game=$(JUEGO=1 DANOS=real node rl/race_eval.js "$2" 2>&1 | tail -2 | paste -sd' ' -)
  echo "$1 | manada: $herd | sola: $solo | juego: $game" >> "$TABLE"
}
run() { # fase, opciones de train.py
  fase=$1; shift
  echo "$(date +%H:%M) $N $fase"
  $PY rl/train.py --name "$N$fase" "$@" > "$RUNS/$N$fase.log" 2>&1
  $PY rl/export.py "$RUNS/$N$fase/model.zip" "$OUT/$fase.json" rivales
  echo "  medidas: $(tr -d ' \n' < "$RUNS/$N$fase/medidas.json" 2>/dev/null) · escalas: $(tr -d ' \n' < "$RUNS/$N$fase/escalas.json" 2>/dev/null)"
  measure "$fase" "$OUT/$fase.json" &
}
prev() { echo "$RUNS/$N$1/model.zip"; }
# el medidas.json de la fase anterior a $1: el objetivo de los presupuestos
before() { echo "$RUNS/${N}fase$(($1 - 1))/medidas.json"; }

if [ "$FROM" -le 1 ]; then
  # manejar dentro de la pista: pasto y muro más caros. Se corta a los 15 M de 40 M: una vuelta razonable con margen
  # (terminada del todo quedaba tan cerrada en su forma de manejar que con rivales no aprendía a no chocar)
  echo "$(date +%H:%M) $N fase1"
  $PY rl/train.py --steps 40000000 --stop-at 15000000 --name "${N}fase1" --rewards grass:3,wall:2 > "$RUNS/${N}fase1.log" 2>&1
  $PY rl/export.py "$RUNS/${N}fase1/model.zip" "$OUT/fase1.json"
  measure fase1 "$OUT/fase1.json" &
fi
if [ "$FROM" -le 2 ]; then
  # rivales: los toques cuestan algo más que su peso normal (v8, con 1, casi no bajaban) pero sin buscar cero; las
  # otras tres, lo de la fase 1 al arrancar, son presupuesto. Los pesos de los rivales arrancan en cero
  run fase2 $HERD $ALL --objective contact --objective-weight 1.5 \
    --steps 20000000 --stop-at 10000000 --resume "$(prev fase1)" --fresh-opponents --critic-warmup 2000000 --lr 1e-4
fi
if [ "$FROM" -le 3 ]; then
  # largada: premia la primera vuelta contra la lanzada; las otras tres, no peor que en la 2
  run fase3 $HERD $ALL --objective launch --targets "$(before 3)" \
    --steps 20000000 --stop-at 10000000 --resume "$(prev fase2)" --critic-warmup 1000000 --lr 1e-4
fi
if [ "$FROM" -le 4 ]; then
  # sobrepaso: premia la pasada limpia; las otras tres, no peor que en la 3
  run fase4 $HERD $ALL --objective chase --targets "$(before 4)" \
    --steps 30000000 --stop-at 15000000 --resume "$(prev fase3)" --critic-warmup 1000000 --lr 1e-4
fi
# 5–8: una habilidad cada una (con peso 3, por debajo del techo de los presupuestos); las otras tres, no peor que en
# la fase anterior
F=5
for objective in pace contact launch chase; do
  # en la 5 se prenden los daños: lo medido al entrenar sin ellos no sirve de objetivo y se calibra de nuevo
  again=""
  [ $F = 5 ] && again="--recalibrate"
  if [ "$FROM" -le $F ]; then
    run fase$F $HERD $ALL $DAMAGE $again --objective $objective --targets "$(before $F)" \
      --steps 12000000 --resume "$(prev fase$((F - 1)))" --critic-warmup 1000000 --lr 5e-5
  fi
  F=$((F + 1))
done
if [ "$FROM" -le 9 ]; then
  # integración: tiempo de vuelta; toques, largada y sobrepaso, no peor que en la fase 8
  run fase9 $HERD $ALL $DAMAGE --objective pace --targets "$(before 9)" \
    --steps 20000000 --resume "$(prev fase8)" --critic-warmup 1000000 --lr 3e-5
fi

# las mediciones de cada fase terminan en segundo plano; con daños, la última y la del juego (en paralelo)
for m in "$ACTUAL" "$OUT/fase9.json"; do
  for d in reduced real; do
    (r=$(JUEGO=1 DANOS=$d node rl/race_eval.js "$m" 2>&1 | tail -2 | paste -sd' ' -); echo "$m · daños $d: $r" >> "$TABLE") &
  done
done
wait
cat "$TABLE"
