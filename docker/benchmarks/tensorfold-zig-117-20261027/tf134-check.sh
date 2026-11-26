#!/usr/bin/env bash
# On 2226: tf124's patch ported to TensorFold 1.3.4 (variants/tf134) against tf124, both at fp8 KV, 16 streams, 75k.
# tf134 keeps int8/fp8 KV, the elastic cache, resident states, the fill scheduler, the mixed pass, many prompts, the
# PLE stage/prefetch, recycle buffers and the tile thresholds; it drops our sampled-draw candidates and host draw threads
# (1.2.9's batched draws replace them) and our PLE window gather (1.3.4's TF_FLASHNEXT_GATHER_EARLY=1 replaces it).
# tf134 first: quick, exact, band and reuse (recorded, a changed reply does not stop the run), then for both builds the
# short replies (three runs, the first a warm-up), six sane replies near 74k, the 74k capacity probe and the agent load.
# Then tf124 goes back to production on 0.0.0.0:8000 with restart unless-stopped. Results: resident/summary.txt.
set -uo pipefail
H=~/docker/benchmarks/tensorfold-zig-117-20261027
D=$H/resident
S=$D/summary.txt
U=http://127.0.0.1:8007
BASE="TF_FLASHNEXT_READOUT_ROWS=128 TF_FLASHNEXT_LANE_PARTS=0 TF_FLASHNEXT_KEEP_INPASS=0"
mkdir -p "$D"
echo "# $(date -Is) tf134-check (fp8, 75k)" >> "$S"

perf() { # build label env
  local B=$1 L=$2 R=$3
  echo "## $L ($B) $R" | tee -a "$S"
  env TF_EXTRA_ENV="$R" VARIANT=$B bash $H/up-117.sh | tail -1 | tee -a "$S"
  python3 $H/decode_load.py $U 16 800 > /dev/null 2>&1
  local r1 r2
  r1=$(python3 $H/decode_load.py $U 16 800 2>&1 | tail -1); r2=$(python3 $H/decode_load.py $U 16 800 2>&1 | tail -1)
  echo "$L short: $r1 / $r2" | tee -a "$S"
  python3 $H/sane_replies.py $U $(( $(date +%s) % 100000 * 100 )) 6 74000 37 0.1 2>&1 | cut -c1-190 | tee -a "$S"
  STAGES="capacity agent" RVAR=$B CLABEL=$L RENV="$R" bash $H/resident-check.sh
  docker logs qwen38_flash_next_tensorfold_best_cuda 2>&1 | grep -i -E "panic|segfault|CudaFailed|out of memory|ILLEGAL|UnexpectedTensor|round failed" \
    | sort | uniq -c | head -5 | sed "s/^/# $L log: /" | tee -a "$S"
}

T134="$BASE TF_FLASHNEXT_GATHER_EARLY=1"
STAGES="quick exact band reuse" RVAR=tf134 RENV="$T134" bash $H/resident-check.sh || echo "tf134 correctness stages stopped early" | tee -a "$S"
perf tf134 tf134-f75k "$T134"
perf tf124 tf124-f75k "$BASE"

echo "## restoring tf124 on 0.0.0.0:8000" | tee -a "$S"
TENSORFOLD_BIND_ADDRESS=0.0.0.0 TENSORFOLD_BIND_PORT=8000 TENSORFOLD_RESTART=unless-stopped VARIANT=tf124 bash $H/up-117.sh | tail -1 | tee -a "$S"
echo tf134-check-done | tee -a "$S"
