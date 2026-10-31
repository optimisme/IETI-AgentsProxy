#!/usr/bin/env bash
# On 2225: serve the best Zig build in production, replacing Python: public port 8000, restarted after a reboot.
# Python is only stopped, so its volumes stay; if Zig does not come up, Python is started again.
# Back to Python by hand: docker stop qwen38_flash_next_tensorfold_best_cuda; docker start $PY
set -uo pipefail
PY=qwen38_flash_next_cuda_vram128_tensorfold_mlx_4bit_mtp_int8_ssd_vision
docker stop -t 60 $PY > /dev/null
if ! TENSORFOLD_BIND_ADDRESS=0.0.0.0 TENSORFOLD_BIND_PORT=8000 TENSORFOLD_RESTART=unless-stopped bash ~/docker/benchmarks/tensorfold-zig-117-20261027/up-117.sh; then
  echo "zig did not come up, back to python"
  docker stop qwen38_flash_next_tensorfold_best_cuda > /dev/null 2>&1
  docker start $PY > /dev/null
  exit 1
fi
