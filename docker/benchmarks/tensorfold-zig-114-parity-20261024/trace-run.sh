#!/usr/bin/env bash
# On 2226: stop the Python test container, start Zig with host tracing, run cohorts ($2, default the prose pair) into $1, save the trace.
set -uo pipefail
cd ~/docker/benchmarks/tensorfold-zig-114-parity-20261024
out=${1:?out dir}
cases=${2:-short-n8-case0,prose-n8-case0,prose-n8-case1}
docker stop qwen38_flash_next_python_lowload > /dev/null 2>&1
TF_HOST_TRACE=1 TF_LANES_PHASES=${PHASES:-0} bash up-parity.sh | tail -1 || exit 1
rm -rf "$out"
python3 bench.py --out "$out" --cases "$cases" 2>&1 \
  | python3 -c "import sys,json
for l in sys.stdin:
    try: s=json.loads(l); print(s['name'], round(s['output_tok_s'],1), 'ttft50', round(s['ttft_p50_s'],3), flush=True)
    except Exception: print(l.strip()[:200], flush=True)"
docker logs qwen38_flash_next_tensorfold_114_ple_cuda > "$out/server.log" 2>&1
echo "trace lines: $(grep -c '^host ' "$out/server.log")"
