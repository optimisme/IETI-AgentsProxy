#!/usr/bin/env bash
# On 2226: bf16 vs fp8 (int8 rows) quality on the new build, then the agent runs at 16 slots on fp8, then a 75k-window start.
set -uo pipefail
cd ~/docker/benchmarks/tensorfold-zig-114-parity-20261024
summary() {
  python3 -c "import sys,json
for l in sys.stdin:
    try: s=json.loads(l); print('$1', 'users', s['users'], 'tok/s', round(s['output_tok_s'],1), 'turns/min', round(s['turns_per_min'],1), 'ttft0', round(s['ttft_first_p50'],2), 'ttftN50', round(s['ttft_later_p50'],2), 'ttftN95', round(s['ttft_later_p95'],2), 'decode50', round(s['decode_tok_s_p50'],1), 'cached', s['cached_tokens_sum'], 'errors', s['errors'], 'minfree', round(s['min_available_gib'],1), flush=True)
    except Exception: print(l.strip()[:300], flush=True)"
}
up() {  # kv context
  TENSORFOLD_KV_CACHE=$1 TENSORFOLD_CONTEXT=$2 TF_PROMPT_CACHE_ELASTIC=1 TENSORFOLD_PROMPT_CACHE_GIB=12 TENSORFOLD_STREAMS=16 bash up-parity.sh | tail -1 || return 1
  docker logs qwen38_flash_next_tensorfold_114_ple_cuda 2>&1 | grep -m2 "streams at once\|elastic,"
}
docker stop qwen38_flash_next_python_lowload > /dev/null 2>&1
for kv in bf16 fp8; do
  echo "== $kv"
  up $kv 50000 || exit 1
  python3 kv8_check.py http://127.0.0.1:8007 "kvcheck-$kv" 2>&1 | tail -12
  python3 greedy_check.py 2>&1 | grep round
done
python3 - <<'PY'
import json
a=json.load(open('kvcheck-bf16/answers.json')); b=json.load(open('kvcheck-fp8/answers.json'))
for t in a:
    n=next((i for i,(x,y) in enumerate(zip(a[t],b[t])) if x!=y), min(len(a[t]),len(b[t])))
    print(f"same first {n} of {len(a[t])} chars: {t}")
PY
for n in 8 16; do
  rm -rf "agent-kv8-u$n" && python3 agent.py --users "$n" --tag "kv8-u$n" --out "agent-kv8-u$n" 2>&1 | summary kv8
  docker logs qwen38_flash_next_tensorfold_114_ple_cuda 2>&1 | grep "prompt cache: [0-9]" | tail -1
done
echo "== fp8 at a 75k window"
up fp8 75000 || exit 1
rm -rf agent-kv8-75k-u16 && python3 agent.py --users 16 --tag kv8-75k-u16 --out agent-kv8-75k-u16 2>&1 | summary kv8-75k
