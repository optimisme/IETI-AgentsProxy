#!/usr/bin/env bash
# On 2226: reply-round block times by tile thresholds (TF_TILE_*_ROWS, resident7), 16 short-prompt replies each.
# Results: resident/tiles-<label>.log (server log) and resident/tiles.txt.
set -uo pipefail
H=~/docker/benchmarks/tensorfold-zig-117-20261027
D=$H/resident
C=qwen38_flash_next_tensorfold_best_cuda
BASE="TF_PROMPT_CACHE_RESIDENT_GIB=2 TF_FILL_AGING_ROUNDS=1000000 TF_FLASHNEXT_LIVE_CHUNK=4096 TF_FILL_ROUND_STEPS=8"
run() { # label profile env...
  local label=$1 prof=$2; shift 2
  local env="$BASE TF_FLASHNEXT_PROFILE=$prof TF_LANES_PHASES=1 $*"
  env TF_EXTRA_ENV="$env" TENSORFOLD_PROMPT_CACHE_GIB=24 VARIANT=resident7 bash $H/up-117.sh | tail -1
  python3 $H/decode_load.py http://127.0.0.1:8007 16 800 > /dev/null # warm
  echo "$label $(python3 $H/decode_load.py http://127.0.0.1:8007 16 800)" | tee -a $D/tiles.txt
  docker logs $C > $D/tiles-$label.log 2>&1
}
echo "# $(date -Is) tile sweep" >> $D/tiles.txt
run base-p2 2
run e1-r1e6-p2 2 TF_TILE_EXPERTS_ROWS=1 TF_TILE_READOUT_ROWS=1000000
run e1-r1e6-m1-p2 2 TF_TILE_EXPERTS_ROWS=1 TF_TILE_READOUT_ROWS=1000000 TF_TILE_MATMUL_ROWS=1
run base 0
run e1-r1e6 0 TF_TILE_EXPERTS_ROWS=1 TF_TILE_READOUT_ROWS=1000000
run e1-r1e6-m1 0 TF_TILE_EXPERTS_ROWS=1 TF_TILE_READOUT_ROWS=1000000 TF_TILE_MATMUL_ROWS=1
echo tile-sweep-done
