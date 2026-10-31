set -euo pipefail
run_dir="$HOME/docker/benchmarks/tensorfold-zig-shared-rounds-20261018"
models="$HOME/docker/models"
old="$models/qwen38-flash-next-tensorfold-vontra-mlx-4bit-mtp-int8-ssd-vision-128gb.yml"
candidate="$models/qwen38-flash-next-tensorfold-110-shared-fused-recurrent-mlx-4bit-128gb.yml"
container=qwen38_flash_next_tensorfold_110_cuda
exec > "$run_dir/fused-trial-controller.log" 2>&1
cd "$run_dir"
while [ ! -f controller-exit-code ]; do sleep 5; done
while [ ! -s fused-native-sha256.txt ]; do
  # A failed builder cannot supply a qualification result.
  if [ -f fused-build-exit-code ]; then
    echo 'Fused build ended without its ready artifacts'; exit 2
  fi
  sleep 5
done
while docker ps --format '{{.Names}}' | grep -q '^ieti-shared-fused-build$'; do sleep 2;done
test -s gpu-fused-contracts.json
while [ ! -f fused-version-ready ];do sleep 2;done
restore=0
cleanup() {
  result=$?;trap - EXIT
  if [ "$restore" = 1 ];then
    set +e
    docker logs "$container" > "$run_dir/fused-native-final.log" 2>&1
    docker stop "$container"
    docker compose -f "$old" start
  fi
  printf '%s\n' "$result" > "$run_dir/fused-controller-exit-code"
  exit "$result"
}
trap cleanup EXIT
trap 'exit 143' TERM INT
# Let the previous controller's Python restore finish any extension compilation
# before stopping it, so an interrupted compiler cannot leave a stale JIT lock.
python_ready=0
for attempt in $(seq 1 240);do
  if curl --max-time 3 -fsS http://localhost:8000/health >/dev/null 2>&1;then python_ready=1;break;fi
  sleep 5
done
test "$python_ready" = 1
restore=1
docker compose -f "$old" stop
export TENSORFOLD_BIND_PORT=8007 TENSORFOLD_STREAMS=16 TENSORFOLD_CONTEXT=75000
export TENSORFOLD_PROMPT_CACHE_GIB=0 TENSORFOLD_VISION_ENABLED=0 TENSORFOLD_RESERVE_GIB=10
export TENSORFOLD_DRAFTS_ENABLED=1 TENSORFOLD_DRAFT_DEPTH=6 TENSORFOLD_PREFILL_CHUNK=1536
export TENSORFOLD_DECODE_GRAPH=0 TENSORFOLD_BATCH_VERIFY=1 TENSORFOLD_BATCH_DRAFT=1 TENSORFOLD_BATCH_GDN=2
docker compose -f "$candidate" config > fused-on-compose.yml
docker compose -f "$candidate" up -d
ready=0
for attempt in $(seq 1 240);do
  if curl --max-time 3 -fsS http://localhost:8007/health >/dev/null 2>&1;then ready=1;break;fi
  if [ "$(docker inspect "$container" --format '{{.State.Running}}')" != true ];then break;fi
  available=$(awk '/MemAvailable:/ {print $2}' /proc/meminfo)
  if [ "$available" -lt 6291456 ];then echo 'Memory guard during load';exit 3;fi
  sleep 5
done
docker logs "$container" > fused-on-admission.log 2>&1
test "$ready" = 1
docker inspect "$container" --format '{{json .State}}' > fused-on-state.json
docker inspect "$container" --format '{{json .HostConfig.DeviceRequests}}' > fused-on-gpu.json
reference="$run_dir/recurrent-off"
test -f "$reference/complete"
python3 probe.py --native --out fused-on --reference "$reference" --quality --capacity > fused-on-probe.log 2>&1
docker logs "$container" > fused-on-after-probe.log 2>&1
grep -q 'shared recurrent batching active, owners=.*fused=true' fused-on-after-probe.log
touch fused-trial-complete
