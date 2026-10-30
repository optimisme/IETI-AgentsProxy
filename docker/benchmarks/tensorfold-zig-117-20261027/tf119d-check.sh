#!/usr/bin/env bash
# On 2226: tf119 with lone prompt chunks on Python's prompt GEMM (variants/tf119d). Exactness, the 64-127 row
# band, reuse, short replies, the 74k probe and the agent load. Results: resident/summary.txt. Leaves the build running.
set -uo pipefail
H=~/docker/benchmarks/tensorfold-zig-117-20261027
D=$H/resident
S=$D/summary.txt
C=qwen38_flash_next_tensorfold_best_cuda
U=http://127.0.0.1:8007
echo "# $(date -Is) tf119d-check" >> "$S"
STAGES="quick exact band reuse" RVAR=tf119d bash $H/resident-check.sh
env TF_EXTRA_ENV="TF_LANES_PHASES=1" VARIANT=tf119d bash $H/up-117.sh | tail -1
python3 $H/decode_load.py $U 16 800 > /dev/null 2>&1
r1=$(python3 $H/decode_load.py $U 16 800 2>&1 | tail -1); r2=$(python3 $H/decode_load.py $U 16 800 2>&1 | tail -1)
docker logs $C > $D/tf119d-short.log 2>&1
echo "tf119d short: $r1 / $r2" | tee -a "$S"
python3 $H/reply_profile.py $D/tf119d-short.log | grep ' 16 streams' | tee -a "$S"
STAGES="capacity agent" RVAR=tf119d CLABEL=phases RENV="TF_LANES_PHASES=1" bash $H/resident-check.sh
VARIANT=tf119d bash $H/up-117.sh | tail -1
python3 $H/sane_replies.py $U $(( $(date +%s) % 100000 * 100 )) 6 74000 37 0.1 2>&1 | cut -c1-190 | tee -a "$S"
python3 $H/sane_replies.py $U $(( $(date +%s) % 100000 * 100 + 50 )) 6 74000 37 0 2>&1 | cut -c1-190 | tee -a "$S"
echo tf119d-check-done | tee -a "$S"
