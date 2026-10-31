#!/usr/bin/env bash
# On 2226: the five cohorts twice on Zig (profile defaults, no tracing) and twice on Python, each from a fresh restart.
set -uo pipefail
cd ~/docker/benchmarks/tensorfold-zig-114-parity-20261024
cases=short-n1-case0,short-n8-case0,short-n8-case1,prose-n8-case0,prose-n8-case1
summary() {
  python3 -c "import sys,json
for l in sys.stdin:
    try: s=json.loads(l); print('$1', s['name'], round(s['output_tok_s'],1), 'ttft50', round(s['ttft_p50_s'],3), flush=True)
    except Exception: print(l.strip()[:200], flush=True)"
}
for run in 1 2; do
  docker stop qwen38_flash_next_python_lowload > /dev/null 2>&1
  bash up-parity.sh | tail -1 || exit 1
  rm -rf "confirm-zig-$run"
  python3 bench.py --out "confirm-zig-$run" --cases "$cases" 2>&1 | summary "zig-$run"
done
docker stop qwen38_flash_next_tensorfold_114_ple_cuda > /dev/null 2>&1
for run in 1 2; do
  IETI_RUN=parity-20261025-confirm-$run docker compose -f ~/docker/models/qwen38-flash-next-python-typical-original-test-128gb.yml up -d --force-recreate > /dev/null 2>&1
  start=$(date +%s)
  until curl -sf http://127.0.0.1:8009/health > /dev/null; do
    if [ $(( $(date +%s) - start )) -gt 1800 ]; then echo "python not ready after 1800s"; exit 1; fi
    sleep 10
  done
  echo "python ready after $(( $(date +%s) - start ))s"
  rm -rf "confirm-py-$run"
  python3 bench.py --url http://127.0.0.1:8009 --out "confirm-py-$run" --cases "$cases" 2>&1 | summary "py-$run"
done
