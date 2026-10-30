#!/usr/bin/env bash
# On 2226: one stage of settings A/B on the 1.1.6 build tf116-20261026c (16-user agent run, Python's prompts py16-u16, fresh server
# each run). Args: stage name, then configs "label:VAR=val,VAR=val" (label "base": profile defaults); the list is
# run twice in order (alternated). Extra fixed env for every config: FIXED="VAR=val ...".
set -uo pipefail
stage=${1:?stage}; shift
H=~/docker/benchmarks/tensorfold-zig-116-mixed-20261026
P=~/docker/benchmarks/tensorfold-zig-114-parity-20261024
H116=~/docker/benchmarks/tensorfold-zig-116-mixed-20261026
C=qwen38_flash_next_tensorfold_best_cuda
O=$H/settings-$stage; mkdir -p $O
summary() {
  python3 -c "import sys,json
for l in sys.stdin:
    try: s=json.loads(l); print('$1', 'tok/s', round(s['output_tok_s'],1), 'wall', round(s['wall_s'],1), 'ttft0', round(s['ttft_first_p50'],2), 'ttftN50', round(s['ttft_later_p50'],2), 'ttftN95', round(s['ttft_later_p95'],2), 'decode50', round(s['decode_tok_s_p50'],1), 'errors', s['errors'], 'minfree', round(s['min_available_gib'],1), flush=True)
    except Exception: print(l.strip()[:300], flush=True)"
}
for pass in a b; do
  for cfg in "$@"; do
    label=${cfg%%:*}; vars=${cfg#*:}; [ "$vars" = "$cfg" ] && vars=""
    env ${FIXED:-} ${vars//,/ } bash $H116/up-116c.sh | tail -1 || exit 1
    docker logs $C 2>&1 | grep -m1 "CONFIDENCE="
    rm -rf "$O/agent-$label-$pass"
    (cd $P && python3 agent.py --url http://127.0.0.1:8007 --users 16 --tag py16-u16 --out "$O/agent-$label-$pass") 2>&1 | summary "$stage $label-$pass"
  done
done
echo stage-done
