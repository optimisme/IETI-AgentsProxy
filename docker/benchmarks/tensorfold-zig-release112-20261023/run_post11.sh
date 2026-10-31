#!/usr/bin/env bash
set -euo pipefail
cd "$HOME/docker/benchmarks/tensorfold-zig-release112-20261023"
trap 'printf "%s\n" "$?" > post11-exit-code' EXIT
for i in $(seq 1 720);do
 [ ! -f candidate11-exit-code ] || break
 sleep 5
done
test "$(cat candidate11-exit-code)" = 0
python3 jpeg_probe.py http://127.0.0.1:8007 stock-vision11/codec-before qwen38_flash_next_tensorfold_112_cuda
docker exec -i qwen38_flash_next_tensorfold_112_cuda bash -s < install_codecs.sh > jpeg-codec-install.log 2>&1
python3 jpeg_probe.py http://127.0.0.1:8007 stock-vision11 qwen38_flash_next_tensorfold_112_cuda
python3 vision_burst.py http://127.0.0.1:8007 stock-vision11
python3 probe.py verify --out stock-vision11 --container qwen38_flash_next_tensorfold_112_cuda
docker logs qwen38_flash_next_tensorfold_112_cuda > stock-vision11-final.log 2>&1
curl -fsS http://127.0.0.1:8007/health > stock-vision11-health-after.json
