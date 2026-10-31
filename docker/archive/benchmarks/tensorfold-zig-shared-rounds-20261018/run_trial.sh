set -euo pipefail
run_dir="$HOME/docker/benchmarks/tensorfold-zig-shared-rounds-20261018"
models="$HOME/docker/models"
old="$models/qwen38-flash-next-tensorfold-vontra-mlx-4bit-mtp-int8-ssd-vision-128gb.yml"
candidate="$models/qwen38-flash-next-tensorfold-110-shared-recurrent-mlx-4bit-128gb.yml"
container=qwen38_flash_next_tensorfold_110_cuda
exec > "$run_dir/trial-controller.log" 2>&1
cd "$run_dir"
test -s native-sha256.txt
test -s gpu-recurrent-contracts.json
if docker ps --format '{{.Names}}' | grep -q '^ieti-shared-rounds-build$'; then
  echo 'Build still active; refusing timed benchmarks.'
  exit 2
fi
restore=0
cleanup() {
  result=$?
  trap - EXIT
  if [ "$restore" = 1 ]; then
    set +e
    docker logs "$container" > "$run_dir/native-final.log" 2>&1
    docker stop "$container"
    docker compose -f "$old" start
  fi
  printf '%s\n' "$result" > "$run_dir/controller-exit-code"
  exit "$result"
}
trap cleanup EXIT
trap 'exit 143' TERM INT
# A fresh same-host baseline, with the build and its GPU checks already finished.
python3 probe.py --base http://localhost:8000 --out python-2226 > python-2226.log 2>&1
restore=1
docker compose -f "$old" stop
export TENSORFOLD_BIND_PORT=8007 TENSORFOLD_STREAMS=16 TENSORFOLD_CONTEXT=75000
export TENSORFOLD_PROMPT_CACHE_GIB=0 TENSORFOLD_VISION_ENABLED=0 TENSORFOLD_RESERVE_GIB=10
export TENSORFOLD_DRAFTS_ENABLED=1 TENSORFOLD_DRAFT_DEPTH=6 TENSORFOLD_PREFILL_CHUNK=1536
export TENSORFOLD_DECODE_GRAPH=0 TENSORFOLD_BATCH_VERIFY=1 TENSORFOLD_BATCH_DRAFT=1
for variant in recurrent-off recurrent-on; do
  export TENSORFOLD_BATCH_GDN=0
  if [ "$variant" = recurrent-on ]; then export TENSORFOLD_BATCH_GDN=1; fi
  docker compose -f "$candidate" config > "$variant-compose.yml"
  docker compose -f "$candidate" up -d
  ready=0
  for attempt in $(seq 1 240); do
    if curl --max-time 3 -fsS http://localhost:8007/health >/dev/null 2>&1; then ready=1;break;fi
    if [ "$(docker inspect "$container" --format '{{.State.Running}}')" != true ]; then break;fi
    available=$(awk '/MemAvailable:/ {print $2}' /proc/meminfo)
    if [ "$available" -lt 6291456 ]; then echo 'Memory guard during load';exit 3;fi
    sleep 5
  done
  docker logs "$container" > "$variant-admission.log" 2>&1
  test "$ready" = 1
  docker inspect "$container" --format '{{json .State}}' > "$variant-state.json"
  docker inspect "$container" --format '{{json .HostConfig.DeviceRequests}}' > "$variant-gpu.json"
  reference="$HOME/docker/benchmarks/tensorfold-zig-release110-20261018/mlx-fp8-batched-mtp-v3"
  options=()
  if [ "$variant" = recurrent-on ]; then
    reference="$run_dir/recurrent-off"
    options+=(--quality --capacity)
  fi
  python3 probe.py --native --out "$variant" --reference "$reference" "${options[@]}" > "$variant-probe.log" 2>&1
  docker logs "$container" > "$variant-after-probe.log" 2>&1
  if [ "$variant" = recurrent-on ]; then
    grep -q 'shared recurrent batching active, owners=' "$variant-after-probe.log"
  fi
  docker stop "$container"
done
touch trial-complete
