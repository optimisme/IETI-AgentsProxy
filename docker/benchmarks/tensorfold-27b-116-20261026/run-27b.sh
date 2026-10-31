#!/usr/bin/env bash
# On 2226: Qwen3.8-27B on TensorFold 1.1.6 + our patch, 16-user agent runs with the live chunk cap on (2048) and off
# (4096, upstream's cut), alternated twice; each run on a fresh server with the same tag (same prompts, cold cache).
# Afterwards the best Flash-Next Zig build (up-117.sh) is started again.
set -uo pipefail
HERE=~/docker/benchmarks/tensorfold-27b-116-20261026
AGENT=~/docker/benchmarks/tensorfold-zig-114-parity-20261024
PROFILE=~/docker/models/qwen38-27b-tensorfold-116-q27-mlx-4bit-128gb.yml
NAME=qwen38_27b_tensorfold_116_cuda
export TENSORFOLD_NATIVE_PATCH_SHA256=$(sha256sum $HERE/q27.patch | cut -d" " -f1)
summary() {
  python3 -c "import sys,json
for l in sys.stdin:
    try: s=json.loads(l); print('$1', 'users', s['users'], 'tok/s', round(s['output_tok_s'],1), 'turns/min', round(s['turns_per_min'],1), 'wall', round(s['wall_s'],1), 'ttft0', round(s['ttft_first_p50'],2), 'ttft0max', round(s['ttft_first_max'],2), 'ttftN50', round(s['ttft_later_p50'],2), 'ttftN95', round(s['ttft_later_p95'],2), 'decode50', round(s['decode_tok_s_p50'],1), 'prompt', round(s['prompt_tokens_mean']), s['prompt_tokens_max'], 'cached', s['cached_tokens_sum'], 'errors', s['errors'], 'minfree', round(s['min_available_gib'],1), flush=True)
    except Exception: print(l.strip()[:300], flush=True)"
}
up() {  # label, then env assignments
  local label=$1; shift
  env "$@" TF_LANES_PHASES=1 docker compose -f $PROFILE up -d --force-recreate > /dev/null 2>&1
  for i in $(seq 1 180); do
    curl -sf localhost:8010/health > /dev/null && { echo "$label ready after $((i*5))s"; docker logs $NAME 2>&1 | grep -m3 -E "streams at once|build=|tensorfold"; return 0; }
    docker inspect -f "{{.State.Running}}" $NAME 2>/dev/null | grep -q true || { echo "$label exited"; docker logs --tail 40 $NAME; return 1; }
    sleep 5
  done
  echo "$label not ready"; return 1
}
run() {  # label
  rm -rf "$AGENT/q27-$1"
  (cd $AGENT && python3 agent.py --url http://127.0.0.1:8010 --users 16 --tag q27-u16 --out "q27-$1") 2>&1 | summary "$1"
  docker logs $NAME > "$HERE/$1.log" 2>&1
  grep -c "^phases: fill" "$HERE/$1.log" | sed "s/^/$1 fill cuts: /"
}
docker stop qwen38_flash_next_tensorfold_114_ple_cuda > /dev/null 2>&1
for pass in a b; do
  up cap2048-$pass TF_QWEN_LIVE_CHUNK=2048 && run cap2048-$pass
  up cap4096-$pass TF_QWEN_LIVE_CHUNK=4096 && run cap4096-$pass
done
docker stop $NAME > /dev/null 2>&1
bash ~/docker/benchmarks/tensorfold-zig-117-20261027/up-117.sh | tail -1
echo all-done
