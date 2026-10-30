set -euo pipefail
run_dir="$HOME/docker/benchmarks/tensorfold-zig-cache-tuning-20261018"
old="$HOME/docker/models/qwen38-flash-next-tensorfold-vontra-mlx-4bit-mtp-int8-ssd-vision-128gb.yml"
new="$HOME/docker/models/qwen38-flash-next-tensorfold-zig-tuned-int4-mtp-fp8-vision-128gb.yml"
container=qwen38_flash_next_cuda_vram128_tensorfold_zig_tuned_int4_mtp_fp8_vision
exec > "$run_dir/lru-pipeline.log" 2>&1
while [ ! -f "$run_dir/awaiting-cache16-decision" ]; do sleep 5; done
restore_needed=1
cleanup() {
 result=$?; trap - EXIT
 if [ "$restore_needed" = 1 ]; then
  set +e
  docker compose -f "$new" stop
  docker compose -f "$old" start
 fi
 exit "$result"
}
trap cleanup EXIT
trap 'exit 143' TERM INT
touch "$run_dir/continue-cache16-testing"
docker compose -f "$new" stop
docker run --rm --name ieti-zig-cache-build-v3 --network host --memory 10g --memory-swap 10g --cpus 4 --entrypoint /bin/bash \
 --env-file "$run_dir/build-v3.env" \
 -v ieti-qwen38-flash-next-tensorfold-zig-tuned-int4-runtime-cache:/opt/ieti-zig \
 -v ieti-qwen38-flash-next-tensorfold-zig-tuned-int4-kernel-cache:/cache \
 -v "$HOME/docker/tokens.env:/run/secrets/tokens.env:ro" \
 -v "$HOME/docker/patches/tensorfold-zig-flashnext-cache-v3.patch:/run/ieti-cache.patch:ro" \
 -v "$run_dir:/results" \
 nvcr.io/nvidia/pytorch:26.07-py3 /results/build-v3.sh > "$run_dir/build-v3.log" 2>&1
export TENSORFOLD_CACHE_BRANCH_LRU=1 TENSORFOLD_PROMPT_CACHE_GIB=16
export TENSORFOLD_CACHE_MIN_PROMPT=1024 TENSORFOLD_CACHE_HISTORY_GAP=256 TENSORFOLD_CACHE_TIMINGS=0
export TENSORFOLD_BIND_PORT=8007 TENSORFOLD_SYSTEM_CACHE=0 TENSORFOLD_RING_CACHE=0
export TENSORFOLD_RESERVE_GIB=10 TENSORFOLD_PROMPT_CACHE_GIB=16
docker compose -f "$new" up -d
ready=0
for attempt in $(seq 1 240); do
 if curl --max-time 3 -fsS http://localhost:8007/health >/dev/null 2>&1; then ready=1; break; fi
 sleep 5
done
[ "$ready" = 1 ]
echo 'LRU / 16 GiB variant ready on isolated benchmark port.'
docker logs "$container" > "$run_dir/zig1024gap256lru16-startup.log" 2>&1
cd "$run_dir"
python3 benchmark.py bench --base http://127.0.0.1:8007 --out zig1024gap256lru16-main --fixtures fixtures.json > zig1024gap256lru16-main.log 2>&1
python3 cache_probe.py --base http://127.0.0.1:8007 --out zig1024gap256lru16-probe --tag A > zig1024gap256lru16-probe.log 2>&1
python3 agent_probe.py --base http://127.0.0.1:8007 --out zig1024gap256lru16-agent > zig1024gap256lru16-agent.log 2>&1
docker logs "$container" > "$run_dir/zig1024gap256lru16-full.log" 2>&1
python3 - <<'PY_CHECK'
import json,pathlib
for folder in ('zig1024gap256lru16-main','zig1024gap256lru16-probe','zig1024gap256lru16-agent'):
 for p in pathlib.Path(folder).glob('*.json'):
  j=json.load(open(p))
  if 'summary' in j:
   s=j['summary'];assert s['successes']==s['requests']==s['full_output_requests'],s
s=json.load(open('zig1024gap256lru16-main/smoke.json'))
assert s['tool']['passed'] and s['vision']['passed'],s
print('All GPU requests and smoke checks passed.')
PY_CHECK
touch "$run_dir/awaiting-lru-decision"
for attempt in $(seq 1 180); do
 if [ -f "$run_dir/finish-lru-and-restore" ]; then exit 0; fi
 if [ -f "$run_dir/continue-lru-testing" ]; then restore_needed=0; exit 0; fi
 if [ -f "$run_dir/run-lru-capacity" ]; then
  python3 benchmark.py capacity --base http://127.0.0.1:8007 --out zig1024gap256lru16-main --fixtures fixtures.json > zig1024gap256lru16-capacity.log 2>&1
  docker logs "$container" > "$run_dir/zig1024gap256lru16-after-capacity.log" 2>&1
  touch "$run_dir/lru-capacity-complete"
  break
 fi
 sleep 5
done
if [ -f "$run_dir/lru-capacity-complete" ]; then
 for attempt in $(seq 1 180); do
  if [ -f "$run_dir/finish-lru-and-restore" ]; then exit 0; fi
  if [ -f "$run_dir/continue-lru-testing" ]; then restore_needed=0; exit 0; fi
  sleep 5
 done
fi
echo 'Decision timeout: restoring original MLX.'
