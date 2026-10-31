#!/usr/bin/env bash
set -euo pipefail
cd "$HOME/docker/benchmarks/tensorfold-zig-release112-20261023"
profile="$HOME/docker/models/qwen38-flash-next-tensorfold-112-mlx-4bit-vision-128gb.yml"
trap 'printf "%s\n" "$?" > candidate11-exit-code' EXIT
export TENSORFOLD_STREAMS=11 TENSORFOLD_CONTEXT=75000 TENSORFOLD_PROMPT_CACHE_GIB=0 TENSORFOLD_VISION_ENABLED=1
export TENSORFOLD_PREFILL_CHUNK=1536 TENSORFOLD_RESERVE_GIB=10
docker compose -f "$profile" config > stock-vision11-compose.yml
docker compose -f "$profile" up -d
ready=0
for i in $(seq 1 240);do
 if curl -fsS --max-time 3 http://127.0.0.1:8007/health > stock-vision11-health.json 2>/dev/null;then ready=1;break;fi
 if [ "$(docker inspect qwen38_flash_next_tensorfold_112_cuda --format '{{.State.Running}}')" != true ];then break;fi
 sleep 5
done
docker logs qwen38_flash_next_tensorfold_112_cuda > stock-vision11-admission.log 2>&1
test "$ready" = 1
python3 probe.py verify --out stock-vision11 --container qwen38_flash_next_tensorfold_112_cuda
python3 probe.py compatibility --out stock-vision11
python3 probe.py performance --out stock-vision11 --counts 1,11
python3 probe.py quality --out stock-vision11
python3 probe.py capacity --out stock-vision11 --capacity-count 11
docker logs qwen38_flash_next_tensorfold_112_cuda > stock-vision11-final.log 2>&1
curl -fsS http://127.0.0.1:8007/health > stock-vision11-health-after.json
