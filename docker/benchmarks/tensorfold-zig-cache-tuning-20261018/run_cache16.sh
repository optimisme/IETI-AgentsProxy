set -euo pipefail
run_dir="$HOME/docker/benchmarks/tensorfold-zig-cache-tuning-20261018"
old="$HOME/docker/models/qwen38-flash-next-tensorfold-vontra-mlx-4bit-mtp-int8-ssd-vision-128gb.yml"
new="$HOME/docker/models/qwen38-flash-next-tensorfold-zig-tuned-int4-mtp-fp8-vision-128gb.yml"
container=qwen38_flash_next_cuda_vram128_tensorfold_zig_tuned_int4_mtp_fp8_vision
exec > "$run_dir/cache16-pipeline.log" 2>&1
ready=0
for attempt in $(seq 1 420); do
 if [ -f "$run_dir/python-agent-complete" ]; then ready=1; break; fi
 sleep 5
done
[ "$ready" = 1 ]
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
cd "$run_dir"
python3 - <<'PY_CHECK'
import json,pathlib
for p in pathlib.Path('python-agent').glob('*.json'):
 j=json.load(open(p))
 if 'summary' in j:
  s=j['summary'];assert s['successes']==s['requests']==s['full_output_requests'],s
PY_CHECK
docker compose -f "$old" stop
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
echo '16 GiB retention variant ready; all other serving settings unchanged.'
docker logs "$container" > "$run_dir/zig1024gap256cache16-startup.log" 2>&1
python3 benchmark.py bench --base http://127.0.0.1:8007 --out zig1024gap256cache16-main --fixtures fixtures.json > zig1024gap256cache16-main.log 2>&1
python3 cache_probe.py --base http://127.0.0.1:8007 --out zig1024gap256cache16-probe --tag A > zig1024gap256cache16-probe.log 2>&1
python3 agent_probe.py --base http://127.0.0.1:8007 --out zig1024gap256cache16-agent > zig1024gap256cache16-agent.log 2>&1
docker logs "$container" > "$run_dir/zig1024gap256cache16-full.log" 2>&1
touch "$run_dir/awaiting-cache16-decision"
for attempt in $(seq 1 180); do
 if [ -f "$run_dir/finish-cache16-and-restore" ]; then exit 0; fi
 if [ -f "$run_dir/continue-cache16-testing" ]; then restore_needed=0; exit 0; fi
 if [ -f "$run_dir/run-cache16-capacity" ]; then
  python3 benchmark.py capacity --base http://127.0.0.1:8007 --out zig1024gap256cache16-main --fixtures fixtures.json > zig1024gap256cache16-capacity.log 2>&1
  docker logs "$container" > "$run_dir/zig1024gap256cache16-after-capacity.log" 2>&1
  touch "$run_dir/cache16-capacity-complete"
  break
 fi
 sleep 5
done
if [ ! -f "$run_dir/cache16-capacity-complete" ]; then exit 0; fi
for attempt in $(seq 1 180); do
 if [ -f "$run_dir/finish-cache16-and-restore" ]; then exit 0; fi
 if [ -f "$run_dir/continue-cache16-testing" ]; then restore_needed=0; exit 0; fi
 sleep 5
done
echo 'Decision timeout: restoring original MLX.'
