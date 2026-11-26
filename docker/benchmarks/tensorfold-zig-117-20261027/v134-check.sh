#!/usr/bin/env bash
# On 2226: plain TensorFold 1.3.4 (variants/v134, empty patch) against tf124 (our patch on 1.2.4), both at bf16 KV and a
# 40k window: plain 1.3.4 has no 8-bit KV for Flash Next, and 16 bf16 streams only fit at about 40k.
# Per build: 16 short replies (decode_load.py, three runs, the first a warm-up), six sane replies near 36k tokens,
# the capacity probe near 38k tokens (cold round and two return turns) and the 16-user agent load.
# v134 runs with TENSORFOLD_PREFILL_SHARE blank, so 1.3.3's default decode share for long prompts (#3486) is on;
# the profile's other settings (chunk 4096, READOUT_ROWS 128, LANE_PARTS 0) are the same for both builds.
# Then tf124 goes back to production on 0.0.0.0:8000 with restart unless-stopped.
# Results: resident/summary.txt and resident/capacity-<label>-38000/.
set -uo pipefail
H=~/docker/benchmarks/tensorfold-zig-117-20261027
D=$H/resident
S=$D/summary.txt
U=http://127.0.0.1:8007
mkdir -p "$D"
echo "# $(date -Is) v134-check (bf16, 40k)" >> "$S"

run() { # build label env
  local B=$1 L=$2 R=$3
  echo "## $L ($B) $R" | tee -a "$S"
  env TENSORFOLD_KV_CACHE=bf16 TENSORFOLD_CONTEXT=40000 TF_EXTRA_ENV="$R" VARIANT=$B bash $H/up-117.sh | tail -1 | tee -a "$S"
  python3 $H/decode_load.py $U 16 800 > /dev/null 2>&1
  local r1 r2
  r1=$(python3 $H/decode_load.py $U 16 800 2>&1 | tail -1); r2=$(python3 $H/decode_load.py $U 16 800 2>&1 | tail -1)
  echo "$L short: $r1 / $r2" | tee -a "$S"
  python3 $H/sane_replies.py $U $(( $(date +%s) % 100000 * 100 )) 6 36000 37 0.1 2>&1 | cut -c1-190 | tee -a "$S"
  TENSORFOLD_KV_CACHE=bf16 TENSORFOLD_CONTEXT=40000 TOKENS=38000 STAGES="capacity agent" RVAR=$B CLABEL=$L RENV="$R" \
    bash $H/resident-check.sh
  docker logs qwen38_flash_next_tensorfold_best_cuda 2>&1 | grep -i -E "panic|segfault|CudaFailed|out of memory|ILLEGAL|UnexpectedTensor|round failed" \
    | sort | uniq -c | head -5 | sed "s/^/# $L log: /" | tee -a "$S"
}

run tf124 tf124-b40k "TF_FLASHNEXT_READOUT_ROWS=128 TF_FLASHNEXT_LANE_PARTS=0 TF_FLASHNEXT_KEEP_INPASS=0"
run v134 v134-b40k "TENSORFOLD_PREFILL_SHARE="

echo "## restoring tf124 on 0.0.0.0:8000" | tee -a "$S"
TENSORFOLD_BIND_ADDRESS=0.0.0.0 TENSORFOLD_BIND_PORT=8000 TENSORFOLD_RESTART=unless-stopped VARIANT=tf124 bash $H/up-117.sh | tail -1 | tee -a "$S"
echo v134-check-done | tee -a "$S"
