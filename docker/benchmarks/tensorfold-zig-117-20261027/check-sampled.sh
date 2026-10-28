#!/usr/bin/env bash
# On 2226: the sampled-draft candidate (variants/sampled) with MiaAI-Lab's paths off, then all on: greedy together vs
# alone, and sampled replies (fixed seeds) drafted vs undrafted, together vs alone, and on vs off (must be identical).
set -uo pipefail
H=~/docker/benchmarks/tensorfold-zig-117-20261027
P=~/docker/benchmarks/tensorfold-zig-114-parity-20261024
ON="TF_FLASHNEXT_SAMPLED_HEADS=1 TF_FLASHNEXT_SAMPLE_CAND=1 TF_FLASHNEXT_HOST_DRAW_THREADS=4"
cd $H
echo "== off"
VARIANT=sampled bash up-117.sh | tail -1 || exit 1
(cd $P && python3 greedy_check.py 2>&1 | tail -2)
python3 sampled_check.py http://127.0.0.1:8007 $H/variants/sampled/sampled-off
echo "== on: $ON"
env $ON TF_EXTRA_ENV="$ON" VARIANT=sampled bash up-117.sh | tail -1 || exit 1
docker logs qwen38_flash_next_tensorfold_best_cuda 2>&1 | grep -m1 "extra env"
(cd $P && python3 greedy_check.py 2>&1 | tail -2)
python3 sampled_check.py http://127.0.0.1:8007 $H/variants/sampled/sampled-on $H/variants/sampled/sampled-off.json
docker logs qwen38_flash_next_tensorfold_best_cuda 2>&1 | grep -i -E "panic|fault|CudaFailed|error" | head -5
echo check-sampled-done
