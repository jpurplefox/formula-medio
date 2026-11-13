#!/bin/sh
# Trains the game network from scratch with the herd curriculum (rl/CURRICULUM.md): from phase 2 on, every car in
# each race is the same network, which is learning (rl/herd.js). One measure in every scenario: the time with penalty
# (for running side by side with another car, for contacts and for grass) against the racing line's time starting
# the same way. The skills are groups of scenarios (Budgets.GROUPS in rl/train.py): launch (grid, flying and start),
# pace (solo and rolling), chase (chase, only the car behind) and all (integration). Each phase rewards one group and
# the scenarios outside it are budgets that adjust on their own so they don't get worse than what the previous phase
# left.
#
# This is the recipe of v22 (models/v22/fase18.json, the game network since 2026-11-10), the plan of v14:
#   1       drive a lap, alone (15 M of 40 M)
#   2       every scenario, with opponents (their input weights start at zero), all rewarded
#   3–5     one skill each: launch, pace, chase
#   6       integration (all)
#   7–18    three more cycles: launch, pace, chase (12 M each) and integration (20 M)
# Real damage from phase 1: with damage only from phase 5 (v15) twice as many wings were broken as with damage from
# the start (v14). Measurement always uses real damage, as in the game, so the phases can be compared with each other.
#
# There is always room left to improve: phases 1–5 are cut at the halfway point (--stop-at), with the learning rate
# still high (a phase that reaches its best number afterwards only makes it worse). Each phase starts from the final
# model of the previous one and is exported to models/$NAME/faseN.json. As soon as a phase finishes it is measured in
# the background while the next one trains (in a herd, alone and in the game-like race) and the result goes to
# rl/runs/$NAME-tabla.log; at the end, the last one and the game network with damage. It does not overwrite the game
# network: if a new one is better, change GAME_NET in src/drivers/policy.js by hand. ~5.5 h on an M-series Mac.
#
#   sh rl/curriculum.sh [first phase]      (default 1)
#   NAME=v23 sh rl/curriculum.sh           (models folder and rl/runs prefix; default "nueva")
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
LAST=18
mkdir -p "$OUT" $RUNS

# 22 cars per race, as in the game, one race per process (176 agents in total), cars from -15 % to +20 %, real damage
HERD="--herd --agents 22 --envs 1 --spread 0.15,0.2 --eval-damage real --damage real"
# the same scenario mix in every phase: what changes between phases is what gets rewarded, not what gets practiced
# (with different mixes, some phases never practiced the chase and nothing stopped it from getting worse). The
# exception is start (the launch until the first braking point): 15 while the network learns to start (phases 2 and
# 3), then 5
LEARN="--mix solo:10,grid:20,rolling:20,chase:20,flying:15,start:15"
ALL="--mix solo:10,grid:30,rolling:20,chase:20,flying:15,start:5"

# one phase in a herd (rl/herd_eval.js), alone and in the game-like race, on one line of the table
measure() { # name, model
  herd=$(DAMAGE=real node rl/herd_eval.js "$2" 2>&1 | grep -v '^$' | sed 's/^  [^ ]* *//' | paste -sd' ' -)
  solo=$(node rl/eval.js "$2" | tail -1)
  game=$(GAME=1 DAMAGE=real node rl/race_eval.js "$2" 2>&1 | tail -2 | paste -sd' ' -)
  echo "$1 | herd: $herd | solo: $solo | game: $game" >> "$TABLE"
}
# the run folder of the phase before $1: its model.zip is where it starts, its medidas.json the target of the budgets
prev() { echo "$RUNS/${N}fase$(($1 - 1))"; }
run() { # phase number, train.py options
  phase=fase$1; shift
  echo "$(date +%H:%M) $N $phase"
  $PY rl/train.py --name "$N$phase" "$@" > "$RUNS/$N$phase.log" 2>&1
  $PY rl/export.py "$RUNS/$N$phase/model.zip" "$OUT/$phase.json" rivales
  echo "  measures: $(tr -d ' \n' < "$RUNS/$N$phase/medidas.json" 2>/dev/null) · scales: $(tr -d ' \n' < "$RUNS/$N$phase/escalas.json" 2>/dev/null)"
  measure "$phase" "$OUT/$phase.json" &
}
# one skill (or the integration), from the previous phase and with its measures as the budget targets
skill() { # phase number, objective, steps, lr, mix, [more train.py options]
  f=$1 objective=$2 steps=$3 lr=$4 mix=$5; shift 5
  [ "$FROM" -le "$f" ] || return 0
  run "$f" $HERD $mix --objective "$objective" --targets "$(prev "$f")/medidas.json" --steps "$steps" \
    --resume "$(prev "$f")/model.zip" --critic-warmup 1000000 --lr "$lr" "$@"
}

if [ "$FROM" -le 1 ]; then
  # drive within the track: grass and wall cost more. Cut at 15 M of 40 M: a reasonable lap with room to improve
  # (fully trained, it was so set in its way of driving that with opponents it did not learn to avoid crashing)
  echo "$(date +%H:%M) $N fase1"
  $PY rl/train.py --steps 40000000 --stop-at 15000000 --name "${N}fase1" --rewards grass:3,wall:2 --damage real \
    > "$RUNS/${N}fase1.log" 2>&1
  $PY rl/export.py "$RUNS/${N}fase1/model.zip" "$OUT/fase1.json"
  measure fase1 "$OUT/fase1.json" &
fi
if [ "$FROM" -le 2 ]; then
  # opponents: every scenario rewarded (no budgets yet). The opponent weights start at zero, and the critic gets a
  # longer warm-up because the reward is new
  run 2 $HERD $LEARN --objective all \
    --steps 20000000 --stop-at 10000000 --resume "$(prev 2)/model.zip" --fresh-opponents --critic-warmup 2000000 --lr 1e-4
fi
# 3–5: one skill each, cut at the halfway point; the other scenarios, no worse than in the previous phase
skill 3 launch 20000000 1e-4 "$LEARN" --stop-at 10000000
skill 4 pace 20000000 1e-4 "$ALL" --stop-at 10000000
skill 5 chase 30000000 1e-4 "$ALL" --stop-at 15000000
# 6: integration, everything rewarded with the same weight
skill 6 all 20000000 3e-5 "$ALL"
# 7–18: three more cycles of the three skills and an integration
F=7
for cycle in 1 2 3; do
  for objective in launch pace chase; do
    skill $F $objective 12000000 5e-5 "$ALL"
    F=$((F + 1))
  done
  skill $F all 20000000 3e-5 "$ALL"
  F=$((F + 1))
done

# each phase's measurements finish in the background; with damage, the last one and the game network (in parallel)
for m in "$ACTUAL" "$OUT/fase$LAST.json"; do
  for d in reduced real; do
    (r=$(GAME=1 DAMAGE=$d node rl/race_eval.js "$m" 2>&1 | tail -2 | paste -sd' ' -); echo "$m · damage $d: $r" >> "$TABLE") &
  done
done
wait
cat "$TABLE"
