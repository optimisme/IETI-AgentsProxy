#!/usr/bin/env bash
set -euo pipefail
cd "$HOME/docker/benchmarks/tensorfold-zig-release112-20261023"
trap 'printf "%s\n" "$?" > baseline11-exit-code' EXIT
# Only benchmark clients are changed. Never stop or reconfigure the reference server.
idle=0
for i in $(seq 1 180);do
 if python3 -c 'import json,urllib.request;d=json.load(urllib.request.urlopen("http://127.0.0.1:8000/health"));exit(int(d.get("requests_running",0)>0))';then idle=1;break;fi
 sleep 5
done
test "$idle" = 1
python3 probe.py performance --base http://127.0.0.1:8000 --out python-2225-streams11 --counts 1,11
python3 probe.py capacity --base http://127.0.0.1:8000 --out python-2225-streams11 --capacity-count 11
docker inspect qwen38_flash_next_cuda_vram128_tensorfold_mlx_4bit_mtp_int8_ssd_vision --format '{{.State.StartedAt}}' > python-start-after.txt
curl -fsS http://127.0.0.1:8000/health > python-health-after.json
