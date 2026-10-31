#!/usr/bin/env bash
# On 2226: prompt fill speed alone, the part of the 74k cold round outside the reply tail. One cold 74k prompt, then four
# at once (cold_one.py, one-token replies, prompts no request shares), on the best build at each prompt chunk size
# (CHUNKS, default 2048 4096 8192) and on Python. Results: resident/summary.txt. Leaves the best build running.
set -uo pipefail
H=~/docker/benchmarks/tensorfold-zig-117-20261027
D=$H/resident
S=$D/summary.txt
C=qwen38_flash_next_tensorfold_best_cuda
PY=qwen38_flash_next_python_lowload
echo "# $(date -Is) cold-prefill chunks ${CHUNKS:-2048 4096 8192} python ${PYTHON:-1}" >> "$S"

fill() { # label url seed
  python3 $H/cold_one.py $2 $3 8000 > /dev/null 2>&1 # warm
  echo "$1 one: $(python3 $H/cold_one.py $2 $(($3 + 1)) 2>&1 | tail -1)" | tee -a "$S"
  local t=$(date +%s.%N)
  for k in 0 1 2 3; do python3 $H/cold_one.py $2 $(($3 + 10 + k)) > $D/cold-prefill-$k.out 2>&1 & done
  wait
  echo "$1 four: wall $(python3 -c "import time; print(round(time.time() - $t, 1))") s, each: $(tail -qn1 $D/cold-prefill-[0-3].out | awk '{print $6}' | xargs)" | tee -a "$S"
}

seed=$(( $(date +%s) % 100000 * 100 ))
for c in ${CHUNKS:-2048 4096 8192}; do
  docker stop $PY > /dev/null 2>&1
  env TENSORFOLD_PREFILL_CHUNK=$c TF_FLASHNEXT_LIVE_CHUNK=$c bash $H/up-117.sh | tail -1 || exit 1
  fill "zig chunk $c" http://127.0.0.1:8007 $((seed + c))
  docker logs $C > $D/cold-prefill-zig-$c.log 2>&1
  grep -i -E "panic|segfault|CudaFailed|error" $D/cold-prefill-zig-$c.log | grep -v "^info" | sort | uniq -c | sort -rn | head -5 | cut -c1-200 | sed "s/^/# /" | tee -a "$S"
done
if [ "${PYTHON:-1}" = 1 ]; then
  docker stop $C > /dev/null 2>&1
  IETI_RUN=cold-prefill docker compose -f ~/docker/models/qwen38-flash-next-python-typical-original-test-128gb.yml up -d --force-recreate 2>&1 | tail -1
  start=$(date +%s)
  until curl -sf http://127.0.0.1:8009/health > /dev/null; do
    [ $(( $(date +%s) - start )) -gt 1800 ] && { echo "python not ready" | tee -a "$S"; exit 1; }
    sleep 10
  done
  fill python http://127.0.0.1:8009 $((seed + 50000))
  docker stop $PY > /dev/null 2>&1
fi
bash $H/up-117.sh | tail -1
echo cold-prefill-done | tee -a "$S"
