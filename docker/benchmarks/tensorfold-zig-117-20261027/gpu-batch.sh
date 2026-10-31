#!/usr/bin/env bash
# On 2226, after resident4: the agent run's late turns traced (TF_HOST_TRACE) with 2048- and 4096-row live chunks,
# 16 x 74k with a 22 GiB cache cap, a cold 74k prompt profiled alone per chunk and per kernel, then Python's capacity
# at 45k and 74k for a same-day comparison. Results under resident/ (summary.txt, *-trace, *-c22, profile-*.log).
set -uo pipefail
H=~/docker/benchmarks/tensorfold-zig-117-20261027
D=$H/resident
S=$D/summary.txt
C=qwen38_flash_next_tensorfold_best_cuda
F=TF_FILL_AGING_ROUNDS=1000000
cd $H
RVAR=resident4 RENV="$F TF_HOST_TRACE=1" CLABEL=trace STAGES=agent bash resident-check.sh
RVAR=resident4 RENV="$F TF_HOST_TRACE=1 TF_FLASHNEXT_LIVE_CHUNK=4096" CLABEL=trace4096 STAGES=agent bash resident-check.sh
RVAR=resident4 RENV="$F" CLABEL=fifo-c22 CACHE_GIB=22 STAGES=capacity bash resident-check.sh
for p in 1 3; do
  echo "== profile $p $(date -Is)" | tee -a $S
  env TF_PROMPT_CACHE_RESIDENT_GIB=2 TF_EXTRA_ENV="TF_PROMPT_CACHE_RESIDENT_GIB=2 $F TF_FLASHNEXT_PROFILE=$p" TENSORFOLD_PROMPT_CACHE_GIB=24 VARIANT=resident4 bash $H/up-117.sh | tail -1
  python3 $H/cold_one.py http://127.0.0.1:8007 $((9100 + p)) 2>&1 | tee -a $S
  docker logs $C > $D/profile-$p.log 2>&1
done
CLABEL=paired TOKENS=45000 STAGES=capacity-python bash resident-check.sh
CLABEL=paired TOKENS=74000 STAGES=capacity-python bash resident-check.sh
echo gpu-batch-done | tee -a $S
