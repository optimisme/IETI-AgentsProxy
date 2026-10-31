set -euo pipefail
run_dir="$HOME/docker/benchmarks/tensorfold-zig-release110-20261018"
models="$HOME/docker/models"
old="$models/qwen38-flash-next-tensorfold-vontra-mlx-4bit-mtp-int8-ssd-vision-128gb.yml"
container=qwen38_flash_next_tensorfold_110_cuda
exec > "$run_dir/graph-trials-pipeline.log" 2>&1
cleanup() {
 result=$?;trap - EXIT;set +e
 docker logs "$container" > "$run_dir/graph-trials-final.log" 2>&1
 docker stop "$container"
 docker compose -f "$old" start
 exit "$result"
}
trap cleanup EXIT
trap 'exit 143' TERM INT
# Previous controller owns cleanup until it completes and restores its fallback.
while [ ! -f "$run_dir/alternatives-complete" ]; do sleep 5;done
sleep 8
docker compose -f "$old" stop
cd "$run_dir"
export TENSORFOLD_BIND_PORT=8007 TENSORFOLD_STREAMS=16 TENSORFOLD_CONTEXT=75000
export TENSORFOLD_PROMPT_CACHE_GIB=0 TENSORFOLD_VISION_ENABLED=0
for variant in fp4-text-d6-r10 mlx-built-plain-graph0 mlx-built-plain-graph1; do
 profile="$models/qwen38-flash-next-tensorfold-110-tuned-mlx-4bit-128gb.yml"
 export TENSORFOLD_DRAFTS_ENABLED=0 TENSORFOLD_RESERVE_GIB=6 TENSORFOLD_PREFILL_CHUNK=768 TENSORFOLD_DECODE_GRAPH=0
 case "$variant" in
 fp4-*) profile="$models/qwen38-flash-next-tensorfold-110-nvidia-fp4-vision-128gb.yml";export TENSORFOLD_DRAFTS_ENABLED=1 TENSORFOLD_RESERVE_GIB=10 TENSORFOLD_PREFILL_CHUNK=1536;;
 *graph1) export TENSORFOLD_DECODE_GRAPH=1;;
 esac
 if [[ "$variant" = mlx-* ]]; then
  while docker ps --filter name=ieti-native110-build --format '{{.Names}}' | rg -q .; do sleep 5;done
  test -s "$run_dir/graph-native-sha256.txt"
 fi
 docker compose -f "$profile" config > "$variant-compose.yml"
 docker compose -f "$profile" up -d
 ready=0
 for attempt in $(seq 1 200); do
  if curl --max-time 3 -fsS http://localhost:8007/health >/dev/null 2>&1; then ready=1;break;fi
  if [ "$(docker inspect "$container" --format '{{.State.Running}}')" != true ];then break;fi
  available=$(awk '/MemAvailable:/ {print $2}' /proc/meminfo)
  if [ "$available" -lt 6291456 ]; then echo 'Host memory guard during load';exit 3;fi
  sleep 5
 done
 docker logs "$container" > "$variant-admission.log" 2>&1
 docker inspect "$container" --format '{{json .State}}' > "$variant-state.json"
 if [ "$ready" = 1 ]; then
  python3 alternative_probe.py --out "$variant" > "$variant-probe.log" 2>&1
  docker logs "$container" > "$variant-after-probe.log" 2>&1
  touch "$variant-probe-complete"
 fi
 docker stop "$container"
done
touch graph-trials-complete
