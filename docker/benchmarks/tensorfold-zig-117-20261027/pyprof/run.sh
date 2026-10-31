#!/usr/bin/env bash
# On 2226: Python's reply rounds timed (pyprof/sitecustomize.py): the 16-stream short reply load, then the 74k probe.
# Results: resident/pyprof-*.log and resident/capacity-python-roundprof-74000/. Restores the Zig best build at the end.
set -uo pipefail
H=~/docker/benchmarks/tensorfold-zig-117-20261027
D=$H/resident
PY=qwen38_flash_next_python_lowload
docker stop qwen38_flash_next_tensorfold_best_cuda > /dev/null 2>&1
IETI_RUN=roundprof docker compose -f ~/docker/models/qwen38-flash-next-python-roundprof-test-128gb.yml up -d --force-recreate 2>&1 | tail -1
for i in $(seq 1 240); do curl -sf localhost:8009/health > /dev/null && break; sleep 5; done
echo "python ready after $((i*5))s"; docker logs $PY 2>&1 | grep -m1 "round times on"
python3 $H/decode_load.py http://127.0.0.1:8009 16 800 > /dev/null
echo "python short: $(python3 $H/decode_load.py http://127.0.0.1:8009 16 800) / $(python3 $H/decode_load.py http://127.0.0.1:8009 16 800)"
docker logs $PY > $D/pyprof-short.log 2>&1
out=$D/capacity-python-roundprof-74000; rm -rf $out
PROBE_CAPACITY_TOKENS=74000 PROBE_MIN_FREE_GIB=3 PROBE=1 python3 -u $H/zig_probe.py capacity --base http://127.0.0.1:8009 --out $out --tag python-roundprof-74000 2>&1 | grep -E "SAFETY|Error|Traceback" | cut -c1-300
docker logs $PY > $D/pyprof-74000.log 2>&1
docker stop $PY > /dev/null
bash $H/up-117.sh | tail -1
echo pyprof-done
