#!/bin/sh
# Trains the game network from scratch with the herd curriculum (rl/CURRICULUM.md): from phase 2 on, every car in
# each race is the same network, which is learning (rl/herd.js). Four skills, each with its own measure: lap time
# (pace), contacts (contact: each contact that starts, not each touch), start (launch: first lap against the flying
# lap) and chase (chase: the time of the pair). Each phase rewards one and the others are budgets that adjust on
# their own so they don't get worse than what the previous phase left (Budgets, rl/train.py).
#
#   1      drive a lap, alone
#   2      with opponents: keep the lap time with fewer contacts (without aiming for zero contacts)
#   3      start: improve the first lap against the flying lap, without losing lap time or contacts
#   4      one-lap chase, in pairs (the car ahead with less engine): the time of the pair and the clean pass
#   5–8    one skill each (lap, contacts, start, chase); the others, no worse than in the previous phase
#   9      integration: lap time, without making the other three worse
# Real damage is turned on from phase 5: in phases 1–4 the network learns to drive in a group without every contact
# breaking the car (with damage from phase 1, in v14 the contacts that phase 2 left as margin wrecked wings at the
# start and the rest of the race was run with broken cars). Measurement always uses real damage, as in the game, so
# the phases can be compared with each other.
#
# There is always room left to improve: phases 1–4 are cut at the halfway point (--stop-at), with the learning rate
# still high (a phase that reaches its best number afterwards only makes it worse), and phase 2 does not kill
# contacts. Each phase starts from the final model of the previous one and is exported to models/$NAME/faseN.json.
# As soon as a phase finishes it is measured in the background while the next one trains (in a herd, alone and in
# the game-like race) and the result goes to rl/runs/$NAME-tabla.log; at the end, the last one and the game network
# with damage. It does not overwrite the game network: if a new one is better, change GAME_NET in
# src/drivers/policy.js by hand.
#
#   sh rl/curriculum.sh [first phase]      (default 1)
#   NAME=v9 sh rl/curriculum.sh           (models folder and rl/runs prefix; default "nueva")
#
# Needs rl/.venv (docs/ai.md, training section); the F1 tracks come from tracks/*.layout.json. The previous
# curriculum, with classic AI opponents (rl/race.js), is in the git history (commit 47f1b3f).
set -e
cd "$(dirname "$0")/.."
PY=rl/.venv/bin/python
FROM=${1:-1}
N=${NAME:-nueva}
OUT=models/$N
RUNS=rl/runs
TABLE=$RUNS/$N-tabla.log
ACTUAL=$(sed -n "s/^export const GAME_NET = '\(.*\)';/\1/p" src/drivers/policy.js)  # the game network
mkdir -p "$OUT" $RUNS

# 22 cars per race, as in the game, one race per process (176 agents in total), cars from -15 % to +20 %
HERD="--herd --agents 22 --envs 1 --spread 0.15,0.2 --eval-damage real"
DAMAGE="--damage real"
# the same scenario mix in every phase with opponents: what changes between phases is what gets rewarded, not what
# gets practiced (with different mixes, phases 2 and 3 never practiced the chase and nothing stopped it from getting
# worse)
ALL="--mix solo:10,grid:40,rolling:30,chase:20"

# one phase in a herd (rl/herd_eval.js), alone and in the game-like race, on one line of the table
measure() { # name, model
  herd=$(DAMAGE=real node rl/herd_eval.js "$2" 2>&1 | grep -v '^$' | sed 's/^  [^ ]* *//' | paste -sd' ' -)
  solo=$(node rl/eval.js "$2" | tail -1)
  game=$(GAME=1 DAMAGE=real node rl/race_eval.js "$2" 2>&1 | tail -2 | paste -sd' ' -)
  echo "$1 | herd: $herd | solo: $solo | game: $game" >> "$TABLE"
}
run() { # phase, train.py options
  phase=$1; shift
  echo "$(date +%H:%M) $N $phase"
  $PY rl/train.py --name "$N$phase" "$@" > "$RUNS/$N$phase.log" 2>&1
  $PY rl/export.py "$RUNS/$N$phase/model.zip" "$OUT/$phase.json" rivales
  echo "  measures: $(tr -d ' \n' < "$RUNS/$N$phase/medidas.json" 2>/dev/null) · scales: $(tr -d ' \n' < "$RUNS/$N$phase/escalas.json" 2>/dev/null)"
  measure "$phase" "$OUT/$phase.json" &
}
prev() { echo "$RUNS/$N$1/model.zip"; }
# the medidas.json of the phase before $1: the target of the budgets
before() { echo "$RUNS/${N}fase$(($1 - 1))/medidas.json"; }

if [ "$FROM" -le 1 ]; then
  # drive within the track: grass and wall cost more. Cut at 15 M of 40 M: a reasonable lap with room to improve
  # (fully trained, it was so set in its way of driving that with opponents it did not learn to avoid crashing)
  echo "$(date +%H:%M) $N fase1"
  $PY rl/train.py --steps 40000000 --stop-at 15000000 --name "${N}fase1" --rewards grass:3,wall:2 > "$RUNS/${N}fase1.log" 2>&1
  $PY rl/export.py "$RUNS/${N}fase1/model.zip" "$OUT/fase1.json"
  measure fase1 "$OUT/fase1.json" &
fi
if [ "$FROM" -le 2 ]; then
  # opponents: contacts cost somewhat more than their normal weight (v8, with 1, they barely went down) but without
  # aiming for zero; the other three, at their phase 1 level at the start, are budgets. The opponent weights start
  # at zero
  run fase2 $HERD $ALL --objective contact --objective-weight 1.5 \
    --steps 20000000 --stop-at 10000000 --resume "$(prev fase1)" --fresh-opponents --critic-warmup 2000000 --lr 1e-4
fi
if [ "$FROM" -le 3 ]; then
  # start: rewards the first lap against the flying lap; the other three, no worse than in phase 2
  run fase3 $HERD $ALL --objective launch --targets "$(before 3)" \
    --steps 20000000 --stop-at 10000000 --resume "$(prev fase2)" --critic-warmup 1000000 --lr 1e-4
fi
if [ "$FROM" -le 4 ]; then
  # overtaking: rewards the clean pass; the other three, no worse than in phase 3
  run fase4 $HERD $ALL --objective chase --targets "$(before 4)" \
    --steps 30000000 --stop-at 15000000 --resume "$(prev fase3)" --critic-warmup 1000000 --lr 1e-4
fi
# 5–8: one skill each (with weight 3, below the budget ceiling); the other three, no worse than in the previous
# phase
F=5
for objective in pace contact launch chase; do
  # damage is turned on in phase 5: what was measured while training without it is no use as a target, so it is
  # calibrated again
  again=""
  [ $F = 5 ] && again="--recalibrate"
  if [ "$FROM" -le $F ]; then
    run fase$F $HERD $ALL $DAMAGE $again --objective $objective --targets "$(before $F)" \
      --steps 12000000 --resume "$(prev fase$((F - 1)))" --critic-warmup 1000000 --lr 5e-5
  fi
  F=$((F + 1))
done
if [ "$FROM" -le 9 ]; then
  # integration: lap time; contacts, start and overtaking, no worse than in phase 8
  run fase9 $HERD $ALL $DAMAGE --objective pace --targets "$(before 9)" \
    --steps 20000000 --resume "$(prev fase8)" --critic-warmup 1000000 --lr 3e-5
fi

# each phase's measurements finish in the background; with damage, the last one and the game network (in parallel)
for m in "$ACTUAL" "$OUT/fase9.json"; do
  for d in reduced real; do
    (r=$(GAME=1 DAMAGE=$d node rl/race_eval.js "$m" 2>&1 | tail -2 | paste -sd' ' -); echo "$m · damage $d: $r" >> "$TABLE") &
  done
done
wait
cat "$TABLE"
