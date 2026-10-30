#!/usr/bin/env bash
# On 2226: start the 1.1.6 build tf116-20261026c (2026-10-26, the best before 1.1.7: TensorFold 1.1.6 + our Flash-Next patch + the mixed
# decode-and-prompt pass, native fcfaa3e0…; 106.4 and 107.2 tok/s on the 16-user agent run) from its own volume.
# The 1.1.4 build tf114-20261026b stays in ieti-native114-tf20261026b.
set -euo pipefail
cd ~/docker
docker stop qwen38_flash_next_tensorfold_114_ple_cuda qwen38_27b_tensorfold_116_cuda > /dev/null 2>&1 || true
export TENSORFOLD_NATIVE_VOLUME=ieti-native116-tf20261026c
export TENSORFOLD_NATIVE_PATCH_SHA256=$(sha256sum benchmarks/tensorfold-zig-116-mixed-20261026/tf116-20261026c/fn.patch | cut -d" " -f1)
export TF_FLASHNEXT_MIXED=${TF_FLASHNEXT_MIXED:-1}
export TENSORFOLD_PREFILL_CHUNK=${TENSORFOLD_PREFILL_CHUNK:-4096} TENSORFOLD_KV_CACHE=${TENSORFOLD_KV_CACHE:-fp8} \
  TENSORFOLD_CONTEXT=${TENSORFOLD_CONTEXT:-75000} TENSORFOLD_STREAMS=${TENSORFOLD_STREAMS:-16} \
  TF_PROMPT_CACHE_ELASTIC=${TF_PROMPT_CACHE_ELASTIC:-1} TENSORFOLD_PROMPT_CACHE_GIB=${TENSORFOLD_PROMPT_CACHE_GIB:-12}
docker compose -f models/qwen38-flash-next-tensorfold-117-mlx-4bit-vision-128gb-best.yml up -d --force-recreate 2>&1 | tail -1
for i in $(seq 1 120); do
  curl -sf localhost:8007/health >/dev/null && { echo "ready after $((i*5))s"; exit 0; }
  docker inspect -f "{{.State.Running}}" qwen38_flash_next_tensorfold_best_cuda | grep -q true || { docker logs --tail 30 qwen38_flash_next_tensorfold_best_cuda; exit 1; }
  sleep 5
done
exit 1
