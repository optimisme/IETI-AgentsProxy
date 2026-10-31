set -euo pipefail
run_dir="$HOME/docker/benchmarks/tensorfold-zig-cache-tuning-20261018"
old="$HOME/docker/models/qwen38-flash-next-tensorfold-vontra-mlx-4bit-mtp-int8-ssd-vision-128gb.yml"
new="$HOME/docker/models/qwen38-flash-next-tensorfold-zig-tuned-int4-mtp-fp8-vision-128gb.yml"
container=qwen38_flash_next_cuda_vram128_tensorfold_zig_tuned_int4_mtp_fp8_vision
exec > "$run_dir/stable8-pipeline.log" 2>&1
restore_needed=1
cleanup() {
 result=$?; trap - EXIT
 if [ "$restore_needed" = 1 ]; then
  set +e
  docker logs "$container" > "$run_dir/zigstable8g512-final.log" 2>&1
  docker compose -f "$new" stop
  docker compose -f "$old" start
 fi
 exit "$result"
}
trap cleanup EXIT
trap 'exit 143' TERM INT
while [ ! -f "$run_dir/stable-replay-capacity-complete" ]; do sleep 5; done
touch "$run_dir/continue-stable-replay-testing"
sleep 6
docker compose -f "$old" stop
docker compose -f "$new" stop
export TENSORFOLD_CACHE_BRANCH_LRU=1 TENSORFOLD_CACHE_STABLE_HISTORY=1 TENSORFOLD_PROMPT_CACHE_GIB=8
export TENSORFOLD_CACHE_MIN_PROMPT=1024 TENSORFOLD_CACHE_HISTORY_GAP=512 TENSORFOLD_CACHE_TIMINGS=0
export TENSORFOLD_BIND_PORT=8007 TENSORFOLD_SYSTEM_CACHE=0 TENSORFOLD_RING_CACHE=0 TENSORFOLD_RESERVE_GIB=10
docker compose -f "$new" up -d
ready=0
for attempt in $(seq 1 240); do
 if curl --max-time 3 -fsS http://localhost:8007/health >/dev/null 2>&1; then ready=1; break; fi
 if [ "$(docker inspect "$container" --format '{{.State.Running}}')" != true ]; then break; fi
 sleep 5
done
[ "$ready" = 1 ]
docker logs "$container" > "$run_dir/zigstable8g512-startup.log" 2>&1
cd "$run_dir"
python3 production_smoke.py --base http://127.0.0.1:8007 --out zigstable8g512-api-preflight > zigstable8g512-api-preflight.log 2>&1
python3 benchmark.py bench --base http://127.0.0.1:8007 --out zigstable8g512-main --fixtures fixtures.json > zigstable8g512-main.log 2>&1
python3 cache_probe.py --base http://127.0.0.1:8007 --out zigstable8g512-probe --tag A > zigstable8g512-probe.log 2>&1
python3 agent_probe.py --base http://127.0.0.1:8007 --out zigstable8g512-agent > zigstable8g512-agent.log 2>&1
docker logs "$container" > "$run_dir/zigstable8g512-full.log" 2>&1
python3 - <<'PY_CHECK'
import json,pathlib
for folder in ('zigstable8g512-main','zigstable8g512-probe','zigstable8g512-agent'):
 for p in pathlib.Path(folder).glob('*.json'):
  j=json.load(open(p))
  if 'summary' in j:
   s=j['summary'];assert s['successes']==s['requests']==s['full_output_requests'],s
s=json.load(open('zigstable8g512-main/smoke.json'))
assert s['tool']['passed'] and s['vision']['passed'],s
print('All GPU requests and smoke checks passed.')
PY_CHECK
touch "$run_dir/awaiting-stable8-decision"
for attempt in $(seq 1 180); do
 if [ -f "$run_dir/finish-stable8-and-restore" ]; then exit 0; fi
 if [ -f "$run_dir/continue-stable8-testing" ]; then restore_needed=0; exit 0; fi
 if [ -f "$run_dir/run-stable8-capacity" ]; then
  python3 benchmark.py capacity --base http://127.0.0.1:8007 --out zigstable8g512-main --fixtures fixtures.json > zigstable8g512-capacity.log 2>&1
  docker logs "$container" > "$run_dir/zigstable8g512-after-capacity.log" 2>&1
  python3 - <<'PY_CAPACITY'
import json
s=json.load(open('zigstable8g512-main/capacity16-near75k.json'))['summary']
assert s['requests']==s['successes']==s['full_output_requests']==16,s
assert s['external_requests']==0 and s['oom_kills']==0,s
PY_CAPACITY
  touch "$run_dir/stable8-capacity-complete"
  break
 fi
 sleep 5
done
if [ -f "$run_dir/stable8-capacity-complete" ]; then
 for attempt in $(seq 1 180); do
  if [ -f "$run_dir/finish-stable8-and-restore" ]; then exit 0; fi
  if [ -f "$run_dir/continue-stable8-testing" ]; then restore_needed=0; exit 0; fi
  sleep 5
 done
fi
echo 'Decision timeout: restoring Python.'
