set -euo pipefail
run_dir="$HOME/docker/benchmarks/tensorfold-zig-release110-20261018"
previous="$HOME/docker/benchmarks/tensorfold-zig-cache-tuning-20261018"
models="$HOME/docker/models"
old="$models/qwen38-flash-next-tensorfold-vontra-mlx-4bit-mtp-int8-ssd-vision-128gb.yml"
new="$models/qwen38-flash-next-tensorfold-110-fp8-kv-mlx-4bit-128gb.yml"
container=qwen38_flash_next_tensorfold_110_cuda
exec > "$run_dir/fp8-trial-pipeline.log" 2>&1
# Do not take over until the preceding comparison has finished successfully.
ready=0
for attempt in $(seq 1 300);do
 if [ -f "$run_dir/graph-trials-v2-complete" ];then ready=1;break;fi
 if [ "$attempt" -gt 3 ] && ! pgrep -f "^bash $run_dir/run_graph_v2_trial.sh$" >/dev/null;then
  echo 'Graph comparison ended without completion marker; takeover refused.';exit 1
 fi
 sleep 5
done
[ "$ready" = 1 ]
python3 - "$run_dir/fp8-kernel-gpu.json" <<'PY_DEVICE'
import json,sys
j=json.load(open(sys.argv[1]));assert j['all_passed'] and len(j['checks'])==17,j
PY_DEVICE
cleanup() {
 result=$?;trap - EXIT;set +e
 docker logs "$container" > "$run_dir/fp8-trial-final.log" 2>&1
 docker stop "$container"
 docker compose -f "$old" start
 exit "$result"
}
trap cleanup EXIT
trap 'exit 143' TERM INT
sleep 8
docker compose -f "$old" stop
export TENSORFOLD_BIND_PORT=8007 TENSORFOLD_STREAMS=16 TENSORFOLD_CONTEXT=75000
export TENSORFOLD_PROMPT_CACHE_GIB=0 TENSORFOLD_VISION_ENABLED=0 TENSORFOLD_RESERVE_GIB=10
export TENSORFOLD_DRAFTS_ENABLED=0 TENSORFOLD_PREFILL_CHUNK=1536 TENSORFOLD_DECODE_GRAPH=1
start_variant() {
 docker compose -f "$new" config > "$run_dir/$1-compose.yml"
 docker compose -f "$new" up -d
 healthy=0
 for attempt in $(seq 1 200);do
  if curl --max-time 3 -fsS http://localhost:8007/health >/dev/null 2>&1;then healthy=1;break;fi
  if [ "$(docker inspect "$container" --format '{{.State.Running}}')" != true ];then break;fi
  available=$(awk '/MemAvailable:/ {print $2}' /proc/meminfo)
  if [ "$available" -lt 6291456 ];then echo 'Host memory guard during load';exit 3;fi
  sleep 5
 done
 docker logs "$container" > "$run_dir/$1-admission.log" 2>&1
 [ "$healthy" = 1 ]
}
cd "$run_dir"
start_variant mlx-fp8-graph1-cold
python3 alternative_probe.py --out mlx-fp8-graph1-cold > mlx-fp8-graph1-cold-probe.log 2>&1
docker logs "$container" > mlx-fp8-graph1-cold-after-probe.log 2>&1
touch fp8-cold-probe-complete
# Measure the real interactive workload with room recovered for snapshots and images.
export TENSORFOLD_PROMPT_CACHE_GIB=8 TENSORFOLD_VISION_ENABLED=1
start_variant mlx-fp8-graph1-cache8-vision
cd "$previous"
python3 benchmark.py bench --base http://127.0.0.1:8007 --out zig110fp8graph2-main --fixtures fixtures.json > "$run_dir/fp8-main.log" 2>&1
python3 cache_probe.py --base http://127.0.0.1:8007 --out zig110fp8graph2-probe --tag A > "$run_dir/fp8-probe.log" 2>&1
python3 agent_probe.py --base http://127.0.0.1:8007 --out zig110fp8graph2-agent > "$run_dir/fp8-agent.log" 2>&1
python3 - <<'PY_COMPLETE'
import json,pathlib
for folder in ('zig110fp8graph2-main','zig110fp8graph2-probe','zig110fp8graph2-agent'):
 for p in pathlib.Path(folder).glob('*.json'):
  j=json.load(open(p))
  if 'summary' in j:
   s=j['summary'];assert s['successes']==s['requests']==s['full_output_requests'],s
# Forced tool_choice is a recorded upstream limitation. Automatic tools are checked separately.
s=json.load(open('zig110fp8graph2-main/smoke.json'));assert s['vision']['passed'],s
PY_COMPLETE
docker logs "$container" > "$run_dir/fp8-after-interactive.log" 2>&1
touch "$run_dir/fp8-interactive-complete"
python3 benchmark.py capacity --base http://127.0.0.1:8007 --out zig110fp8graph2-main --fixtures fixtures.json > "$run_dir/fp8-capacity.log" 2>&1
python3 - <<'PY_CAPACITY'
import json
s=json.load(open('zig110fp8graph2-main/capacity16-near75k.json'))['summary']
assert s['requests']==s['successes']==s['full_output_requests']==16,s
assert s['external_requests']==0 and s['oom_kills']==0,s
PY_CAPACITY
touch "$run_dir/fp8-capacity-complete"
# No automatic promotion: retain all receipts and restore the working fallback.
