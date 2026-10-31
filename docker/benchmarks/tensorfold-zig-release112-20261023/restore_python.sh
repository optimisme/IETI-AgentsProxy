#!/usr/bin/env bash
set -euo pipefail
cd "$HOME/docker/benchmarks/tensorfold-zig-release112-20261023"
trap 'printf "%s\n" "$?" > restore-exit-code' EXIT
for i in $(seq 1 180);do
 [ ! -f final11-exit-code ] || break
 sleep 5
done
test "$(cat final11-exit-code)" = 0
# Tests finished; restore the existing service rather than promote the experiment.
docker stop --timeout 60 qwen38_flash_next_tensorfold_112_cuda
docker start qwen38_flash_next_cuda_vram128_tensorfold_mlx_4bit_mtp_int8_ssd_vision
ready=0
for i in $(seq 1 240);do
 if curl -fsS --max-time 3 http://127.0.0.1:8000/health > restored-python-health.json 2>/dev/null;then ready=1;break;fi
 if [ "$(docker inspect qwen38_flash_next_cuda_vram128_tensorfold_mlx_4bit_mtp_int8_ssd_vision --format '{{.State.Running}}')" != true ];then break;fi
 sleep 5
done
test "$ready" = 1
curl -fsS http://127.0.0.1:8000/v1/models > restored-python-models.json
docker inspect qwen38_flash_next_cuda_vram128_tensorfold_mlx_4bit_mtp_int8_ssd_vision --format '{{json .State}}' > restored-python-state.json
