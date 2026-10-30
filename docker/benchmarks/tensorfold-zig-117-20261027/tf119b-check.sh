#!/usr/bin/env bash
# On 2226: tf119 with the prompt y16 fix (variants/tf119b). Short prompts through the 64-127 row band against the experts
# tile threshold at 64 (the correct bits), then exactness, reuse, short replies, the 74k probe and the agent load.
# Results: resident/summary.txt and resident/sweep-b-*.json. Leaves the build running.
set -uo pipefail
H=~/docker/benchmarks/tensorfold-zig-117-20261027
D=$H/resident
S=$D/summary.txt
C=qwen38_flash_next_tensorfold_best_cuda
U=http://127.0.0.1:8007
echo "# $(date -Is) tf119b-check" >> "$S"
VARIANT=tf119b bash $H/up-117.sh | tail -1
python3 $H/short_sweep.py $U 10 140 2 0.1 $D/sweep-b-t01.json 2>&1 | tail -1 | cut -c1-200 | tee -a "$S"
python3 $H/short_sweep.py $U 40 140 2 0 $D/sweep-b-t0.json 2>&1 | tail -1 | cut -c1-200 | tee -a "$S"
python3 - <<PY | tee -a "$S"
import json
L = lambda n: json.load(open(f"$D/sweep-{n}.json"))
for a, b in (("b-t01", "e64-t01"), ("b-t0", "e64-t0")):
    x, y = L(a), L(b); k = sorted(set(x) & set(y), key=int); d = [i for i in k if x[i] != y[i]]
    print(a, "vs", b, "same", len(k) - len(d), "of", len(k), "differ at words", d)
PY
python3 $H/cold_many.py $U 8100 4 74000 8 2>&1 | tee -a "$S"
STAGES="exact reuse" RVAR=tf119b bash $H/resident-check.sh
env TF_EXTRA_ENV="TF_LANES_PHASES=1" VARIANT=tf119b bash $H/up-117.sh | tail -1
python3 $H/decode_load.py $U 16 800 > /dev/null 2>&1
r1=$(python3 $H/decode_load.py $U 16 800 2>&1 | tail -1); r2=$(python3 $H/decode_load.py $U 16 800 2>&1 | tail -1)
docker logs $C > $D/tf119b-short.log 2>&1
echo "tf119b short: $r1 / $r2" | tee -a "$S"
python3 $H/reply_profile.py $D/tf119b-short.log | grep ' 16 streams' | tee -a "$S"
STAGES="capacity agent" RVAR=tf119b CLABEL=phases RENV="TF_LANES_PHASES=1" bash $H/resident-check.sh
VARIANT=tf119b bash $H/up-117.sh | tail -1
echo tf119b-check-done | tee -a "$S"
