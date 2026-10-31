#!/usr/bin/env bash
# On 2226: coding-agent runs on Zig at 16 slots (50k window) with the elastic prompt cache, 8 then 16 users.
set -uo pipefail
cd ~/docker/benchmarks/tensorfold-zig-114-parity-20261024
summary() {
  python3 -c "import sys,json
for l in sys.stdin:
    try: s=json.loads(l); print('$1', 'users', s['users'], 'tok/s', round(s['output_tok_s'],1), 'turns/min', round(s['turns_per_min'],1), 'ttft0', round(s['ttft_first_p50'],2), 'ttftN50', round(s['ttft_later_p50'],2), 'ttftN95', round(s['ttft_later_p95'],2), 'decode50', round(s['decode_tok_s_p50'],1), 'cached', s['cached_tokens_sum'], 'errors', s['errors'], 'minfree', round(s['min_available_gib'],1), flush=True)
    except Exception: print(l.strip()[:300], flush=True)"
}
docker stop qwen38_flash_next_python_lowload > /dev/null 2>&1
TF_PROMPT_CACHE_ELASTIC=1 TENSORFOLD_PROMPT_CACHE_GIB=${CACHE_GIB:-12} TENSORFOLD_STREAMS=16 TENSORFOLD_CONTEXT=50000 bash up-parity.sh | tail -1 || exit 1
docker logs qwen38_flash_next_tensorfold_114_ple_cuda 2>&1 | grep -m2 "streams at once\|elastic"
for n in 8 16; do
  rm -rf "agent-elastic-u$n" && python3 agent.py --users "$n" --tag "elastic-u$n" --out "agent-elastic-u$n" 2>&1 | summary elastic
  docker logs qwen38_flash_next_tensorfold_114_ple_cuda 2>&1 | grep -c "elastic budget" | sed 's/^/eviction notes: /'
  docker logs qwen38_flash_next_tensorfold_114_ple_cuda 2>&1 | grep "prompt cache: [0-9]" | tail -1
done
python3 greedy_check.py 2>&1 | tail -2
