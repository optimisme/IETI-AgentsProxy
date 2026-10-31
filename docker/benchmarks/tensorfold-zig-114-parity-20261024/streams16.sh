#!/usr/bin/env bash
# On 2226, after confirm.sh: 16-user cohorts on Python (16 slots), on Zig at 8 slots, then 8- and 16-user cohorts on Zig at 16.
set -uo pipefail
cd ~/docker/benchmarks/tensorfold-zig-114-parity-20261024
while pgrep -f "confirm.s[h]" > /dev/null; do sleep 20; done
n16=short-n16-case0,prose-n16-case0,prose-n16-case1
n8=short-n8-case0,short-n8-case1,prose-n8-case0,prose-n8-case1
summary() {
  python3 -c "import sys,json
for l in sys.stdin:
    try: s=json.loads(l); print('$1', s['name'], round(s['output_tok_s'],1), 'ttft50', round(s['ttft_p50_s'],3), 'ttft95', round(s['ttft_p95_s'],3), flush=True)
    except Exception: print(l.strip()[:200], flush=True)"
}
if curl -sf http://127.0.0.1:8009/health > /dev/null; then
  rm -rf s16-py && python3 bench.py --url http://127.0.0.1:8009 --out s16-py --cases "$n16" 2>&1 | summary py-16slots
fi
docker stop qwen38_flash_next_python_lowload > /dev/null 2>&1
bash up-parity.sh | tail -1 || exit 1
rm -rf s16-zig8 && python3 bench.py --out s16-zig8 --cases "$n16" 2>&1 | summary zig-8slots
TENSORFOLD_STREAMS=16 bash up-parity.sh | tail -1 || exit 1
docker logs qwen38_flash_next_tensorfold_114_ple_cuda 2>&1 | grep -m1 "streams at once"
rm -rf s16-zig16 && python3 bench.py --out s16-zig16 --cases "$n8,$n16" 2>&1 | summary zig-16slots
python3 greedy_check.py 2>&1 | tail -2
