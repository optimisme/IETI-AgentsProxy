#!/usr/bin/env bash
# On 2226: stop the Zig test container, start the Python test profile (production settings, loopback 8009), run the cohorts into $1.
set -uo pipefail
cd ~/docker/benchmarks/tensorfold-zig-114-parity-20261024
out=${1:?out dir}
docker stop qwen38_flash_next_tensorfold_114_ple_cuda > /dev/null
IETI_RUN=parity-20261025-python docker compose -f ~/docker/models/qwen38-flash-next-python-typical-original-test-128gb.yml up -d --force-recreate 2>&1 | tail -2
start=$(date +%s)
until curl -sf http://127.0.0.1:8009/health > /dev/null; do
  if [ $(( $(date +%s) - start )) -gt 1800 ]; then echo "not ready after 1800s"; exit 1; fi
  sleep 10
done
echo "ready after $(( $(date +%s) - start ))s"
rm -rf "$out"
python3 bench.py --url http://127.0.0.1:8009 --out "$out" --cases short-n1-case0,short-n8-case0,short-n8-case1,prose-n8-case0,prose-n8-case1 2>&1 \
  | python3 -c "import sys,json
for l in sys.stdin:
    try: s=json.loads(l); print(s['name'], round(s['output_tok_s'],1), 'ttft50', round(s['ttft_p50_s'],3), flush=True)
    except Exception: print(l.strip()[:200], flush=True)"
