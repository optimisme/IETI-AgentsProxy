#!/usr/bin/env bash
# On 2226: the 1.1.9 rebase (variants/tf119) against resident12 (1.1.7). Exactness and reuse, short replies' rounds,
# then the 74k capacity probe on both builds. Results: resident/summary.txt. Leaves the best build (resident12) running.
set -uo pipefail
H=~/docker/benchmarks/tensorfold-zig-117-20261027
D=$H/resident
S=$D/summary.txt
echo "# $(date -Is) tf119-check" >> "$S"
STAGES="exact reuse" RVAR=tf119 bash $H/resident-check.sh
for V in resident12 tf119; do
  echo "== short $V $(date -Is)" | tee -a "$S"
  env TF_EXTRA_ENV="TF_LANES_PHASES=1" VARIANT=$V bash $H/up-117.sh | tail -1
  python3 $H/decode_load.py http://127.0.0.1:8007 16 800 > /dev/null 2>&1
  r1=$(python3 $H/decode_load.py http://127.0.0.1:8007 16 800 2>&1 | tail -1)
  r2=$(python3 $H/decode_load.py http://127.0.0.1:8007 16 800 2>&1 | tail -1)
  docker logs qwen38_flash_next_tensorfold_best_cuda > $D/tf119-short-$V.log 2>&1
  echo "$V: $r1 / $r2" | tee -a "$S"
  python3 $H/reply_profile.py $D/tf119-short-$V.log | grep ' 16 streams' | tee -a "$S"
done
for V in resident12 tf119; do
  STAGES=capacity RVAR=$V CLABEL=phases RENV="TF_LANES_PHASES=1" bash $H/resident-check.sh
  python3 $H/reply_profile.py $D/capacity-$V-phases-74000.log | grep ' 16 streams' | tee -a "$S"
done
VARIANT=resident12 bash $H/up-117.sh | tail -1
echo tf119-check-done | tee -a "$S"
