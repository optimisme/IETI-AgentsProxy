#!/usr/bin/env bash
set -euo pipefail
cd "$HOME/docker/benchmarks/tensorfold-zig-release112-20261023"
trap 'printf "%s\n" "$?" > final11-exit-code' EXIT
ready=0
for i in $(seq 1 240);do
 if curl -fsS --max-time 3 http://127.0.0.1:8007/health > codec-restart-health.json 2>/dev/null;then ready=1;break;fi
 if [ "$(docker inspect qwen38_flash_next_tensorfold_112_cuda --format '{{.State.Running}}')" != true ];then break;fi
 sleep 5
done
docker logs qwen38_flash_next_tensorfold_112_cuda > codec-restart-admission.log 2>&1
test "$ready" = 1
cp stock-vision11/jpeg-smoke.json stock-vision11/jpeg-before-restart.json
python3 jpeg_probe.py http://127.0.0.1:8007 stock-vision11 qwen38_flash_next_tensorfold_112_cuda
python3 -c 'import json;assert json.load(open("stock-vision11/jpeg-smoke.json"))["passed"]'
python3 vision_burst.py http://127.0.0.1:8007 stock-vision11
python3 probe.py verify --out stock-vision11 --container qwen38_flash_next_tensorfold_112_cuda
for i in $(seq 1 180);do
 [ ! -f python-clean-selection.json ] || break
 sleep 5
done
python3 -c 'import json;x=json.load(open("python-clean-selection.json"));assert x["complete"] and len(x["cases"])>0'
python3 matched_probe.py candidate --base http://127.0.0.1:8007 --out stock-clean11 --selection python-clean-selection.json
docker compose -f "$HOME/docker/models/qwen38-flash-next-tensorfold-112-mlx-4bit-vision-128gb.yml" config > stock-vision11-final-compose.yml
docker logs qwen38_flash_next_tensorfold_112_cuda > stock-vision11-final.log 2>&1
curl -fsS http://127.0.0.1:8007/health > stock-vision11-health-after.json
