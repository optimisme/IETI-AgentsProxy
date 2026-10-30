#!/usr/bin/env bash
# On 2226: (re)start Flash-Next on the 1.1.7 build volume (our patch, the mixed pass); extra env passes through.
# Default: the best build, variants/tf119d (2026-10-30, our work on 1.1.9). VARIANT=name starts another candidate (variants/<name>/, volume
# ieti-native117-<name>-build); VARIANT= (empty) the plain 1.1.7 rebase (tf117-20261027).
# Stops the 1.1.4 PLE build and the 27B experiment first: one model on the GPU at a time.
set -euo pipefail
cd ~/docker
docker stop qwen38_flash_next_tensorfold_114_ple_cuda qwen38_27b_tensorfold_116_cuda > /dev/null 2>&1 || true
V=${VARIANT-tf119d}
export TENSORFOLD_NATIVE_VOLUME=${TENSORFOLD_NATIVE_VOLUME:-ieti-native117-${V:-fn}-build}
export TENSORFOLD_NATIVE_PATCH_SHA256=$(sha256sum benchmarks/tensorfold-zig-117-20261027/${V:+variants/$V/}fn.patch | cut -d" " -f1)
export TENSORFOLD_PREFILL_CHUNK=${TENSORFOLD_PREFILL_CHUNK:-4096} TENSORFOLD_KV_CACHE=${TENSORFOLD_KV_CACHE:-fp8} \
  TENSORFOLD_CONTEXT=${TENSORFOLD_CONTEXT:-75000} TENSORFOLD_STREAMS=${TENSORFOLD_STREAMS:-16} \
  TF_PROMPT_CACHE_ELASTIC=${TF_PROMPT_CACHE_ELASTIC:-1} TENSORFOLD_PROMPT_CACHE_GIB=${TENSORFOLD_PROMPT_CACHE_GIB:-24}
docker compose -f models/qwen38-flash-next-tensorfold-117-mlx-4bit-vision-128gb-best.yml up -d --force-recreate 2>&1 | tail -1
for i in $(seq 1 120); do
  curl -sf localhost:8007/health > /dev/null && { echo "ready after $((i*5))s"; exit 0; }
  docker inspect -f "{{.State.Running}}" qwen38_flash_next_tensorfold_best_cuda | grep -q true || { docker logs --tail 30 qwen38_flash_next_tensorfold_best_cuda; exit 1; }
  sleep 5
done
exit 1
