#!/usr/bin/env bash
set -euo pipefail
cd "$HOME/docker/benchmarks/vllm-fp8-agent-20261023"
trap 'printf "%s\n" "$?" > baseline-exit-code' EXIT
container=qwen38_flash_next_cuda_vram128_tensorfold_mlx_4bit_mtp_int8_ssd_vision
docker inspect "$container" --format '{{.State.StartedAt}}' > baseline-start-before.txt
for label in c2048-mtp3 c8192-mtp3; do
  for mode in smoke short quality agents; do
    python3 probe.py "$mode" --base http://127.0.0.1:8000 --out "python-$label" --tag "$label"
  done
done
docker inspect "$container" --format '{{.State.StartedAt}}' > baseline-start-after.txt
cmp baseline-start-before.txt baseline-start-after.txt
