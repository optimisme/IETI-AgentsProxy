#!/usr/bin/env bash
# On 2226: a cold 74k prompt alone, block by block: Python's prompt passes (pyprof, IETI_BLOCK_TIMES=1) against the best
# build's chunks (TF_FLASHNEXT_PROFILE=2). Each block synchronized on both. Logs: resident/fillprof-{python,zig}.log.
# Leaves the best build running.
set -uo pipefail
H=~/docker/benchmarks/tensorfold-zig-117-20261027
D=$H/resident
S=$D/summary.txt
C=qwen38_flash_next_tensorfold_best_cuda
PY=qwen38_flash_next_python_lowload
echo "# $(date -Is) fillprof" >> "$S"
docker stop $C > /dev/null 2>&1
IETI_RUN=fillprof IETI_BLOCK_TIMES=1 docker compose -f ~/docker/models/qwen38-flash-next-python-roundprof-test-128gb.yml up -d --force-recreate 2>&1 | tail -1
start=$(date +%s)
until curl -sf http://127.0.0.1:8009/health > /dev/null; do
  [ $(( $(date +%s) - start )) -gt 1800 ] && { echo "python not ready" | tee -a "$S"; exit 1; }
  sleep 10
done
python3 $H/cold_one.py http://127.0.0.1:8009 $(( $(date +%s) % 100000 * 100 )) 2>&1 | tail -1 | sed 's/^/python /' | tee -a "$S"
docker logs $PY > $D/fillprof-python.log 2>&1
docker stop $PY > /dev/null 2>&1
env TF_EXTRA_ENV="TF_FLASHNEXT_PROFILE=2" bash $H/up-117.sh | tail -1
python3 $H/cold_one.py http://127.0.0.1:8007 $(( $(date +%s) % 100000 * 100 + 7 )) 2>&1 | tail -1 | sed 's/^/zig /' | tee -a "$S"
docker logs $C > $D/fillprof-zig.log 2>&1
bash $H/up-117.sh | tail -1
echo fillprof-done | tee -a "$S"
