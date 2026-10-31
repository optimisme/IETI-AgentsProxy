#!/usr/bin/env bash
# On 2226: (re)start the Zig profile from the parity build volume; extra env passes through (e.g. TF_LANES_PHASES=1).
set -euo pipefail
cd ~/docker
export TENSORFOLD_NATIVE_VOLUME=ieti-native114-parity-build
export TENSORFOLD_NATIVE_PATCH_SHA256=$(sha256sum benchmarks/tensorfold-zig-114-parity-20261024/parity.patch | cut -d' ' -f1)
docker compose -f models/qwen38-flash-next-tensorfold-114-ple-batch-mlx-4bit-vision-128gb.yml up -d --force-recreate 2>&1 | tail -1
for i in $(seq 1 120); do
  curl -sf localhost:8007/health >/dev/null && { echo "ready after $((i*5))s"; exit 0; }
  docker inspect -f '{{.State.Running}}' qwen38_flash_next_tensorfold_114_ple_cuda | grep -q true || { docker logs --tail 30 qwen38_flash_next_tensorfold_114_ple_cuda; exit 1; }
  sleep 5
done
exit 1
