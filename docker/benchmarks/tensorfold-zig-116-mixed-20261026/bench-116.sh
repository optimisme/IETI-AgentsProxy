#!/usr/bin/env bash
# On 2226: 16-user agent runs on the 1.1.6 Flash-Next build, the mixed pass on and off, alternated twice; each on a
# fresh server with Python's tag (py16-u16: the same prompts as its 105.1 tok/s run). Left running: the last setting.
set -uo pipefail
H=~/docker/benchmarks/tensorfold-zig-116-mixed-20261026
P=~/docker/benchmarks/tensorfold-zig-114-parity-20261024
C=qwen38_flash_next_tensorfold_best_cuda
summary() {
  python3 -c "import sys,json
for l in sys.stdin:
    try: s=json.loads(l); print('$1', 'tok/s', round(s['output_tok_s'],1), 'turns/min', round(s['turns_per_min'],1), 'wall', round(s['wall_s'],1), 'ttft0', round(s['ttft_first_p50'],2), 'ttft0max', round(s['ttft_first_max'],2), 'ttftN50', round(s['ttft_later_p50'],2), 'ttftN95', round(s['ttft_later_p95'],2), 'decode50', round(s['decode_tok_s_p50'],1), 'cached', s['cached_tokens_sum'], 'errors', s['errors'], 'minfree', round(s['min_available_gib'],1), flush=True)
    except Exception: print(l.strip()[:300], flush=True)"
}
for pass in a b; do
  for m in ${MODES:-1 0}; do
    label=mix$m-$pass
    TF_FLASHNEXT_MIXED=$m TF_HOST_TRACE=1 bash $H/up-116.sh | tail -1 || exit 1
    rm -rf "$H/agent-$label"
    (cd $P && python3 agent.py --url http://127.0.0.1:8007 --users 16 --tag py16-u16 --out "$H/agent-$label") 2>&1 | summary $label
    docker logs $C > "$H/$label.log" 2>&1
    echo "$label chunks: $(grep -c 'prompt chunk .* mixed' $H/$label.log) mixed, $(grep -c 'prompt chunk .* alone' $H/$label.log) alone"
  done
done
echo all-done
