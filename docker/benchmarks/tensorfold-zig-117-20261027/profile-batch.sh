#!/usr/bin/env bash
# On 2226: a cold ~74k prompt alone on resident4, per chunk (TF_FLASHNEXT_PROFILE=1) then per kernel (=3).
set -uo pipefail
H=~/docker/benchmarks/tensorfold-zig-117-20261027
D=$H/resident
S=$D/summary.txt
C=qwen38_flash_next_tensorfold_best_cuda
for p in 1 3; do
  echo "== profile $p $(date -Is)" | tee -a $S
  env TF_PROMPT_CACHE_RESIDENT_GIB=2 TF_EXTRA_ENV="TF_PROMPT_CACHE_RESIDENT_GIB=2 TF_FILL_AGING_ROUNDS=1000000 TF_FLASHNEXT_PROFILE=$p" TENSORFOLD_PROMPT_CACHE_GIB=24 VARIANT=resident4 bash $H/up-117.sh | tail -1
  python3 $H/cold_one.py http://127.0.0.1:8007 $((9100 + p)) 2>&1 | tail -1 | tee -a $S
  docker logs $C > $D/profile-$p.log 2>&1
done
echo profile-done | tee -a $S
