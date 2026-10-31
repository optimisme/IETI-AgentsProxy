set -euo pipefail
run_dir="$HOME/docker/benchmarks/tensorfold-zig-cache-tuning-20261018"
old="$HOME/docker/models/qwen38-flash-next-tensorfold-vontra-mlx-4bit-mtp-int8-ssd-vision-128gb.yml"
new="$HOME/docker/models/qwen38-flash-next-tensorfold-zig-tuned-int4-mtp-fp8-vision-128gb.yml"
container=qwen38_flash_next_cuda_vram128_tensorfold_zig_tuned_int4_mtp_fp8_vision
exec > "$run_dir/stable-replay-pipeline.log" 2>&1
restore_needed=1
cleanup() {
 result=$?; trap - EXIT
 if [ "$restore_needed" = 1 ]; then
  set +e
  docker logs "$container" > "$run_dir/zigstable16b-final.log" 2>&1
  docker compose -f "$new" stop
  docker compose -f "$old" start
 fi
 exit "$result"
}
trap cleanup EXIT
trap 'exit 143' TERM INT
while [ ! -f "$run_dir/awaiting-stable-decision" ]; do sleep 5; done
touch "$run_dir/continue-stable-testing"
sleep 6
docker compose -f "$old" stop
docker compose -f "$new" stop
export TENSORFOLD_CACHE_BRANCH_LRU=1 TENSORFOLD_CACHE_STABLE_HISTORY=1 TENSORFOLD_PROMPT_CACHE_GIB=16
export TENSORFOLD_CACHE_MIN_PROMPT=1024 TENSORFOLD_CACHE_HISTORY_GAP=256 TENSORFOLD_CACHE_TIMINGS=0
export TENSORFOLD_BIND_PORT=8007 TENSORFOLD_SYSTEM_CACHE=0 TENSORFOLD_RING_CACHE=0 TENSORFOLD_RESERVE_GIB=10
docker compose -f "$new" up -d
ready=0
for attempt in $(seq 1 240); do
 if curl --max-time 3 -fsS http://localhost:8007/health >/dev/null 2>&1; then ready=1; break; fi
 if [ "$(docker inspect "$container" --format '{{.State.Running}}')" != true ]; then break; fi
 sleep 5
done
[ "$ready" = 1 ]
docker logs "$container" > "$run_dir/zigstable16b-startup.log" 2>&1
cd "$run_dir"
python3 production_smoke.py --base http://127.0.0.1:8007 --out zigstable16b-api-preflight > zigstable16b-api-preflight.log 2>&1
python3 benchmark.py bench --base http://127.0.0.1:8007 --out zigstable16b-main --fixtures fixtures.json > zigstable16b-main.log 2>&1
python3 cache_probe.py --base http://127.0.0.1:8007 --out zigstable16b-probe --tag A > zigstable16b-probe.log 2>&1
python3 agent_probe.py --base http://127.0.0.1:8007 --out zigstable16b-agent > zigstable16b-agent.log 2>&1
docker logs "$container" > "$run_dir/zigstable16b-full.log" 2>&1
python3 - <<'PY_CHECK'
import json,pathlib
for folder in ('zigstable16b-main','zigstable16b-probe','zigstable16b-agent'):
 for p in pathlib.Path(folder).glob('*.json'):
  j=json.load(open(p))
  if 'summary' in j:
   s=j['summary'];assert s['successes']==s['requests']==s['full_output_requests'],s
s=json.load(open('zigstable16b-main/smoke.json'))
assert s['tool']['passed'] and s['vision']['passed'],s
print('All GPU requests and smoke checks passed.')
PY_CHECK
touch "$run_dir/awaiting-stable-replay-decision"
for attempt in $(seq 1 180); do
 if [ -f "$run_dir/finish-stable-replay-and-restore" ]; then exit 0; fi
 if [ -f "$run_dir/continue-stable-replay-testing" ]; then restore_needed=0; exit 0; fi
 if [ -f "$run_dir/run-stable-replay-capacity" ]; then
  python3 benchmark.py capacity --base http://127.0.0.1:8007 --out zigstable16b-main --fixtures fixtures.json > zigstable16b-capacity.log 2>&1
  docker logs "$container" > "$run_dir/zigstable16b-after-capacity.log" 2>&1
  touch "$run_dir/stable-replay-capacity-complete"
  break
 fi
 sleep 5
done
if [ -f "$run_dir/stable-replay-capacity-complete" ]; then
 for attempt in $(seq 1 180); do
  if [ -f "$run_dir/finish-stable-replay-and-restore" ]; then exit 0; fi
  if [ -f "$run_dir/continue-stable-replay-testing" ]; then restore_needed=0; exit 0; fi
  sleep 5
 done
fi
echo 'Decision timeout: restoring Python.'
