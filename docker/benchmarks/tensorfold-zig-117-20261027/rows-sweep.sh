#!/usr/bin/env bash
# On 2226: reply rounds by row cap and draft confidence (resident8, TF_FLASHNEXT_ROUND_ROWS), 16 short-prompt replies
# each, best profile defaults otherwise. Results: resident/rows.txt and resident/rows-<label>.log (server log).
set -uo pipefail
H=~/docker/benchmarks/tensorfold-zig-117-20261027
D=$H/resident
C=qwen38_flash_next_tensorfold_best_cuda
run() { # label env...
  local label=$1; shift
  env TF_EXTRA_ENV="TF_LANES_PHASES=1 $*" VARIANT=resident8 bash $H/up-117.sh | tail -1
  python3 $H/decode_load.py http://127.0.0.1:8007 16 800 > /dev/null # warm
  local a=$(python3 $H/decode_load.py http://127.0.0.1:8007 16 800)
  local b=$(python3 $H/decode_load.py http://127.0.0.1:8007 16 800)
  docker logs $C > $D/rows-$label.log 2>&1
  echo "$label | $a | $b | $(python3 $H/reply_profile.py $D/rows-$label.log | grep ' 16 streams' | sed 's/  */ /g')" | tee -a $D/rows.txt
}
echo "# $(date -Is) rows sweep" >> $D/rows.txt
for label_env in "r64:" "r32:TF_FLASHNEXT_ROUND_ROWS=32" "r48:TF_FLASHNEXT_ROUND_ROWS=48" "r96:TF_FLASHNEXT_ROUND_ROWS=96" \
    "r128:TF_FLASHNEXT_ROUND_ROWS=128" "c05:TF_FLASHNEXT_CONFIDENCE=0.5" "c07:TF_FLASHNEXT_CONFIDENCE=0.7"; do
  run "${label_env%%:*}" "${label_env#*:}"
done
echo rows-sweep-done
