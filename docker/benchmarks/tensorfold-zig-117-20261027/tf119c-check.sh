#!/usr/bin/env bash
# On 2226: tf119 with lone prompt chunks on the expert tiles from 64 rows (variants/tf119c). Exactness, the 64-127 row
# band, reuse, short replies, the 74k probe and the agent load. Results: resident/summary.txt. Leaves the build running.
set -uo pipefail
H=~/docker/benchmarks/tensorfold-zig-117-20261027
D=$H/resident
S=$D/summary.txt
C=qwen38_flash_next_tensorfold_best_cuda
U=http://127.0.0.1:8007
echo "# $(date -Is) tf119c-check" >> "$S"
STAGES="quick exact band reuse" RVAR=tf119c bash $H/resident-check.sh
env TF_EXTRA_ENV="TF_LANES_PHASES=1" VARIANT=tf119c bash $H/up-117.sh | tail -1
python3 $H/decode_load.py $U 16 800 > /dev/null 2>&1
r1=$(python3 $H/decode_load.py $U 16 800 2>&1 | tail -1); r2=$(python3 $H/decode_load.py $U 16 800 2>&1 | tail -1)
docker logs $C > $D/tf119c-short.log 2>&1
echo "tf119c short: $r1 / $r2" | tee -a "$S"
python3 $H/reply_profile.py $D/tf119c-short.log | grep ' 16 streams' | tee -a "$S"
STAGES="capacity agent" RVAR=tf119c CLABEL=phases RENV="TF_LANES_PHASES=1" bash $H/resident-check.sh
VARIANT=tf119c bash $H/up-117.sh | tail -1
echo tf119c-check-done | tee -a "$S"
