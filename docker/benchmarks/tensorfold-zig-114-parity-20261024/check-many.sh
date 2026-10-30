#!/usr/bin/env bash
# On 2226: restart the parity build with batched prompts on, check greedy outputs, run the cohorts into $1.
set -uo pipefail
cd ~/docker/benchmarks/tensorfold-zig-114-parity-20261024
out=${1:?out dir}
TF_FLASHNEXT_MANY_PROMPTS=1 bash up-parity.sh | tail -1 || exit 1
python3 greedy_check.py 2>&1 | tail -6
rm -rf "$out"
python3 bench.py --out "$out" --cases short-n1-case0,short-n8-case0,short-n8-case1,prose-n8-case0,prose-n8-case1 2>&1 \
  | python3 -c "import sys,json
for l in sys.stdin:
    try: s=json.loads(l); print(s['name'], round(s['output_tok_s'],1), 'ttft50', round(s['ttft_p50_s'],3), flush=True)
    except Exception: print(l.strip()[:200], flush=True)"
logs=$(docker logs qwen38_flash_next_tensorfold_114_ple_cuda 2>&1)
echo "crashes/refusals: $(grep -c 'Segmentation\|panic\|each goes alone' <<<"$logs")"
grep "done chatcmpl" <<<"$logs" | tail -8 | sed 's/.*prompt=/prompt=/;s/sha=.*ttft/ttft/'
