#!/usr/bin/env bash
# On 2226: prompt chunk sweep on Zig (int8, 16 slots, 75k, elastic cache), per-block profile of a lone 16k prompt.
set -uo pipefail
cd ~/docker/benchmarks/tensorfold-zig-114-parity-20261024
for chunk in ${CHUNKS:-1536 2048 3072 4096}; do
  echo "== chunk $chunk"
  TF_FLASHNEXT_PROFILE=2 TENSORFOLD_PREFILL_CHUNK=$chunk TENSORFOLD_KV_CACHE=fp8 TENSORFOLD_CONTEXT=75000 TF_PROMPT_CACHE_ELASTIC=1 TENSORFOLD_PROMPT_CACHE_GIB=12 TENSORFOLD_STREAMS=16 bash up-parity.sh | tail -1 || { echo "refused"; continue; }
  docker logs qwen38_flash_next_tensorfold_114_ple_cuda 2>&1 | grep "streams at once" | cut -c1-220
  QUICK=1 python3 prefill.py http://127.0.0.1:8007 zig$chunk
  docker logs qwen38_flash_next_tensorfold_114_ple_cuda > chunk-$chunk.log 2>&1
done
