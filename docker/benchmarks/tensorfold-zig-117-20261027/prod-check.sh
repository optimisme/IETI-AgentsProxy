#!/usr/bin/env bash
# On 2226: production-readiness checks of the best build before it replaces Python. Stages (STAGES, default all, in order):
#   compare   16-user agent run, 8 turns, temperature 0.1 (the server default): best Zig vs Python's production settings
#             (typical-original test profile, loopback 8009), alternated, PASSES each (default 2)
#   smoke     a forced tool call and an image question (the capacity campaign's probe)
#   quality   needles at 16k, 65k and 74k tokens
#   capacity  16 requests of ~74k tokens and 896 output tokens: cold, then two returning turns
#   soak      back-to-back 16-user agent runs at temperature 0.1 for SOAK_MIN minutes (default 60)
# Results: prod/summary.txt plus each stage's directory under prod/. Leaves the best Zig build running.
set -uo pipefail
H=~/docker/benchmarks/tensorfold-zig-117-20261027
P=~/docker/benchmarks/tensorfold-zig-114-parity-20261024
Z=qwen38_flash_next_tensorfold_best_cuda
PY=qwen38_flash_next_python_lowload
D=$H/prod
S=$D/summary.txt
mkdir -p "$D"
echo "# $(date -Is) prod-check stages ${STAGES:-compare smoke quality capacity soak}" >> "$S"

zig() { docker stop $PY > /dev/null 2>&1; bash $H/up-117.sh | tail -1; }
python_up() {
  docker stop $Z > /dev/null 2>&1
  IETI_RUN=prodcheck-20261028 docker compose -f ~/docker/models/qwen38-flash-next-python-typical-original-test-128gb.yml up -d --force-recreate 2>&1 | tail -1
  local start=$(date +%s)
  until curl -sf http://127.0.0.1:8009/health > /dev/null; do
    [ $(( $(date +%s) - start )) -gt 1800 ] && { echo "python not ready after 1800s"; return 1; }
    sleep 10
  done
  echo "python ready after $(( $(date +%s) - start ))s"
}
agent() { # label url out tag
  (cd $P && python3 agent.py --url "$2" --users 16 --turns 8 --tag "$4" --temperature 0.1 --top-p 0.95 --out "$3") 2>&1 | python3 -c "
import sys, json
for l in sys.stdin:
    try:
        s = json.loads(l)
        print('$1', 'tok/s', round(s['output_tok_s'], 1), 'ttft0', round(s['ttft_first_p50'], 2), 'ttftN50', round(s['ttft_later_p50'], 2),
              'ttftN95', round(s['ttft_later_p95'], 2), 'decode50', round(s['decode_tok_s_p50'], 1), 'wall', round(s['wall_s'], 1),
              'errors', s['errors'], 'prompt_max', s['prompt_tokens_max'], 'minfree', round(s['min_available_gib'], 1), flush=True)
    except Exception:
        print('#', l.strip()[:300], flush=True)" | tee -a "$S"
}
errs() { docker logs "$1" 2>&1 | grep -i -E "panic|fault|CudaFailed|out of memory" | head -3 | sed "s/^/# $1: /" | tee -a "$S"; }

for stage in ${STAGES:-compare smoke quality capacity soak}; do
  echo "== $stage $(date -Is)" | tee -a "$S"
  case $stage in
    compare)
      for pass in $(seq 1 "${PASSES:-2}"); do
        zig || exit 1; rm -rf $D/compare-zig-$pass; agent zig-$pass http://127.0.0.1:8007 $D/compare-zig-$pass py16-u16; errs $Z
        python_up || exit 1; rm -rf $D/compare-python-$pass; agent python-$pass http://127.0.0.1:8009 $D/compare-python-$pass py16-u16; errs $PY
      done
      zig || exit 1 ;;
    smoke|quality|capacity)
      curl -sf localhost:8007/health > /dev/null || zig || exit 1
      rm -rf $D/$stage
      python3 -u $H/zig_probe.py $stage --base http://127.0.0.1:8007 --out $D/$stage --tag zig117best 2>&1 | grep -v "^$" | cut -c1-600 | tee -a "$S"
      errs $Z ;;
    soak)
      zig || exit 1
      end=$(( $(date +%s) + ${SOAK_MIN:-60} * 60 )); run=0
      docker exec $Z true; curl -s localhost:8007/health | python3 -c "import json,sys; print('# soak start memory', json.load(sys.stdin)['memory'])" | tee -a "$S"
      while [ $(date +%s) -lt $end ]; do
        run=$((run + 1)); rm -rf $D/soak-$run
        agent soak-$run http://127.0.0.1:8007 $D/soak-$run soak-$run
        curl -s localhost:8007/health | python3 -c "import json,sys; print('# soak-$run memory', json.load(sys.stdin)['memory'])" | tee -a "$S"
      done
      errs $Z ;;
  esac
done
echo prod-check-done | tee -a "$S"
