set -euo pipefail
run_dir="$HOME/docker/benchmarks/tensorfold-zig-release110-20261018"
models="$HOME/docker/models"
old="$models/qwen38-flash-next-tensorfold-vontra-mlx-4bit-mtp-int8-ssd-vision-128gb.yml"
new="$models/qwen38-flash-next-tensorfold-110-fp8-batched-mtp-nvidia-fp4-128gb.yml"
container=qwen38_flash_next_tensorfold_110_cuda
exec > "$run_dir/fp4-batched-after-mtp3-pipeline.log" 2>&1
for attempt in $(seq 1 360);do
 [ ! -f "$run_dir/mtp3-cold-complete" ] || break
 sleep 5
done
test -f "$run_dir/mtp3-cold-complete"
# A competitive MTP candidate keeps the GPU for its next qualification stage.
rate=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["summary"]["aggregate_output_tok_s"])' "$run_dir/mlx-fp8-batched-mtp-v3/code16-trial1.json")
if python3 -c 'import sys;sys.exit(0 if float(sys.argv[1])>=280 else 1)' "$rate";then
 echo 'FP4 deferred: MTP candidate needs its full qualification first.'
 exit 0
fi
restore=1
cleanup() {
 result=$?;trap - EXIT
 if [ "$restore" = 1 ];then
  set +e;docker logs "$container" > "$run_dir/fp4-batched-final.log" 2>&1
  docker stop "$container"
  docker compose -f "$old" start
 fi
 exit "$result"
}
trap cleanup EXIT
trap 'exit 143' TERM INT
touch "$run_dir/mtp3-continue-testing"
for attempt in $(seq 1 180);do
 if ! docker ps --filter name=ieti-native110-build --format '{{.Names}}' | grep -q .;then break;fi
 sleep 5
done
test -s "$run_dir/mtp-head-routed-native-sha256.txt"
docker compose -f "$old" stop
export TENSORFOLD_BIND_PORT=8007 TENSORFOLD_STREAMS=16 TENSORFOLD_CONTEXT=75000
export TENSORFOLD_PROMPT_CACHE_GIB=0 TENSORFOLD_VISION_ENABLED=0 TENSORFOLD_RESERVE_GIB=10
export TENSORFOLD_DRAFTS_ENABLED=1 TENSORFOLD_DRAFT_DEPTH=6 TENSORFOLD_PREFILL_CHUNK=1536 TENSORFOLD_DECODE_GRAPH=0 TENSORFOLD_BATCH_VERIFY=1 TENSORFOLD_BATCH_DRAFT=1
cd "$run_dir"
docker compose -f "$new" config > fp4-fp8-batched-mtp-v3-compose.yml
docker compose -f "$new" up -d
ready=0
for attempt in $(seq 1 200);do
 if curl --max-time 3 -fsS http://localhost:8007/health >/dev/null 2>&1;then ready=1;break;fi
 if [ "$(docker inspect "$container" --format '{{.State.Running}}')" != true ];then break;fi
 available=$(awk '/MemAvailable:/ {print $2}' /proc/meminfo)
 if [ "$available" -lt 6291456 ];then echo 'Host memory guard during load';exit 3;fi
 sleep 5
done
docker logs "$container" > fp4-fp8-batched-mtp-v3-admission.log 2>&1
[ "$ready" = 1 ]
python3 alternative_probe.py --out fp4-fp8-batched-mtp-v3 > fp4-fp8-batched-mtp-v3-probe.log 2>&1
docker logs "$container" > fp4-fp8-batched-mtp-v3-after-probe.log 2>&1
touch fp4-batched-complete
echo 'FP4 trial complete: restoring Python.'
