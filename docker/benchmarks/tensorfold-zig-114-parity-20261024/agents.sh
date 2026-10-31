#!/usr/bin/env bash
# On 2226, after streams16.sh: closed-loop coding-agent runs (8 then 16 users) on Zig 16 slots (50k window), Python 16 slots, Zig 8 slots.
set -uo pipefail
cd ~/docker/benchmarks/tensorfold-zig-114-parity-20261024
while pgrep -f "streams16.s[h]" > /dev/null; do sleep 20; done
summary() {
  python3 -c "import sys,json
for l in sys.stdin:
    try: s=json.loads(l); print('$1', 'users', s['users'], 'tok/s', round(s['output_tok_s'],1), 'turns/min', round(s['turns_per_min'],1), 'wall', round(s['wall_s'],1), 'ttft0', round(s['ttft_first_p50'],2), 'ttft0max', round(s['ttft_first_max'],2), 'ttftN50', round(s['ttft_later_p50'],2), 'ttftN95', round(s['ttft_later_p95'],2), 'decode50', round(s['decode_tok_s_p50'],1), 'prompt', round(s['prompt_tokens_mean']), s['prompt_tokens_max'], 'cached', s['cached_tokens_sum'], 'errors', s['errors'], 'minfree', round(s['min_available_gib'],1), flush=True)
    except Exception: print(l.strip()[:300], flush=True)"
}
pair() {  # label url
  for n in 8 16; do
    rm -rf "agent-$1-u$n" && python3 agent.py --url "$2" --users "$n" --tag "$1-u$n" --out "agent-$1-u$n" 2>&1 | summary "$1"
  done
}
# 16 bf16 streams do not fit a 75k window (39 GiB needed, 28.5 GiB budget); 50k fits and exceeds these prompts
TENSORFOLD_STREAMS=16 TENSORFOLD_CONTEXT=50000 bash up-parity.sh | tail -1 || exit 1
docker logs qwen38_flash_next_tensorfold_114_ple_cuda 2>&1 | grep -m1 "streams at once"
pair zig16 http://127.0.0.1:8007
docker stop qwen38_flash_next_tensorfold_114_ple_cuda > /dev/null 2>&1
IETI_RUN=parity-20261025-agent docker compose -f ~/docker/models/qwen38-flash-next-python-typical-original-test-128gb.yml up -d --force-recreate > /dev/null 2>&1
start=$(date +%s)
until curl -sf http://127.0.0.1:8009/health > /dev/null; do
  if [ $(( $(date +%s) - start )) -gt 1800 ]; then echo "python not ready after 1800s"; exit 1; fi
  sleep 10
done
echo "python ready after $(( $(date +%s) - start ))s"
pair py16 http://127.0.0.1:8009
docker stop qwen38_flash_next_python_lowload > /dev/null 2>&1
bash up-parity.sh | tail -1 || exit 1
pair zig8 http://127.0.0.1:8007
