#!/usr/bin/env bash
set -euo pipefail
cd "$HOME/docker/benchmarks/tensorfold-zig-release112-20261023"
trap 'printf "%s\n" "$?" > baseline-exit-code' EXIT
python3 probe.py compatibility --base http://127.0.0.1:8000 --out python-2225
python3 probe.py quality --base http://127.0.0.1:8000 --out python-2225
python3 probe.py capacity --base http://127.0.0.1:8000 --out python-2225
docker inspect qwen38_flash_next_cuda_vram128_tensorfold_mlx_4bit_mtp_int8_ssd_vision --format '{{.State.StartedAt}}' > python-start-after.txt
curl -fsS http://127.0.0.1:8000/health > python-health-after.json
