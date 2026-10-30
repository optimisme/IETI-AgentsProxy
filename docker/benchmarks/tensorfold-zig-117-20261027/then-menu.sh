#!/usr/bin/env bash
# On 2226: after prod-check.sh ends, menu_check.py on the best Zig build, then on Python's production settings (typical-
# original test profile, loopback 8009), compared. Results: prod-tf119d/menu-*. Leaves the best build running.
set -uo pipefail
H=~/docker/benchmarks/tensorfold-zig-117-20261027
D=${PROD_DIR:-$H/prod-tf119d}
Z=qwen38_flash_next_tensorfold_best_cuda
PY=qwen38_flash_next_python_lowload
while [ "$(ps -eo cmd | grep '[p]rod-check.sh' | grep -vc 'bash -c')" != 0 ]; do sleep 30; done
if [ -n "$(docker ps -q -f name=$Z)" ] && curl -sf localhost:8007/health > /dev/null; then :; else bash $H/up-117.sh | tail -1; fi
python3 -u $H/menu_check.py http://127.0.0.1:8007 $D/menu-zig.json > $D/menu-zig.txt 2>&1
docker logs $Z 2>&1 | grep -i -E "panic|fault|CudaFailed|out of memory" | head -3 >> $D/menu-zig.txt
docker stop $Z > /dev/null 2>&1
IETI_RUN=menu-20261031 docker compose -f ~/docker/models/qwen38-flash-next-python-typical-original-test-128gb.yml up -d --force-recreate 2>&1 | tail -1
start=$(date +%s)
until curl -sf http://127.0.0.1:8009/health > /dev/null; do
  [ $(( $(date +%s) - start )) -gt 1800 ] && { echo "python not ready" >> $D/menu-python.txt; break; }
  sleep 10
done
python3 -u $H/menu_check.py http://127.0.0.1:8009 $D/menu-python.json --against $D/menu-zig.json > $D/menu-python.txt 2>&1
docker stop $PY > /dev/null 2>&1
bash $H/up-117.sh | tail -1
echo menu-done >> $D/summary.txt
