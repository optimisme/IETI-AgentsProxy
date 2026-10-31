#!/usr/bin/env bash
# On 2226: Python's cold 74k prompt by kernel step (pyprof, IETI_BLOCK_TIMES=2): resident/pyprof-steps.log and the median
# ms of each step per prompt pass. Leaves the best build running.
set -uo pipefail
H=~/docker/benchmarks/tensorfold-zig-117-20261027
D=$H/resident
S=$D/summary.txt
C=qwen38_flash_next_tensorfold_best_cuda
PY=qwen38_flash_next_python_lowload
echo "# $(date -Is) pyprof-steps" >> "$S"
docker stop $C > /dev/null 2>&1
IETI_RUN=pyprof-steps IETI_BLOCK_TIMES=2 docker compose -f ~/docker/models/qwen38-flash-next-python-roundprof-test-128gb.yml up -d --force-recreate 2>&1 | tail -1
start=$(date +%s)
until curl -sf http://127.0.0.1:8009/health > /dev/null; do
  [ $(( $(date +%s) - start )) -gt 1800 ] && { echo "python not ready" | tee -a "$S"; exit 1; }
  sleep 10
done
python3 $H/cold_one.py http://127.0.0.1:8009 $(( $(date +%s) % 100000 * 100 )) 2>&1 | tail -1 | sed 's/^/python /' | tee -a "$S"
docker logs $PY > $D/pyprof-steps.log 2>&1
docker stop $PY > /dev/null 2>&1
python3 - $D/pyprof-steps.log <<'PY' | tee -a "$S"
import re, sys
from statistics import median
by = {}
for line in open(sys.argv[1], errors='replace'):
    m = re.search(r'pyblocks: rows=(\d+) (.*) ms', line)
    if m and int(m.group(1)) >= 1024:
        for k, v in re.findall(r'(\w+)=([\d.]+)', m.group(2)): by.setdefault(k, []).append(float(v) * 4096 / int(m.group(1)))
n = max(map(len, by.values()), default=0)
print(n, 'passes, median ms per 4096 rows:', ' '.join(f'{k}={median(v):.1f}' for k, v in by.items()))
print('first third:', ' '.join(f'{k}={median(v[:n // 3 or 1]):.0f}' for k, v in by.items() if k in ('attention', 'attn_prep', 'qsa_rows', 'qsa_pool', 'attn_block')))
print('last third:', ' '.join(f'{k}={median(v[-(n // 3 or 1):]):.0f}' for k, v in by.items() if k in ('attention', 'attn_prep', 'qsa_rows', 'qsa_pool', 'attn_block')))
PY
bash $H/up-117.sh | tail -1
echo pyprof-steps-done | tee -a "$S"
