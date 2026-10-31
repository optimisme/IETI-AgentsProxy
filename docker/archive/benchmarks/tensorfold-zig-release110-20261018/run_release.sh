set -euo pipefail
run_dir="$HOME/docker/benchmarks/tensorfold-zig-release110-20261018"
new="$HOME/docker/models/qwen38-flash-next-tensorfold-110-mlx-4bit-vision-128gb.yml"
old="$HOME/docker/models/qwen38-flash-next-tensorfold-vontra-mlx-4bit-mtp-int8-ssd-vision-128gb.yml"
container=qwen38_flash_next_tensorfold_110_cuda
exec > "$run_dir/release-pipeline.log" 2>&1
cleanup() {
 result=$?; trap - EXIT
 set +e
 docker logs "$container" > "$run_dir/release-final.log" 2>&1
 docker compose -f "$new" stop
 docker compose -f "$old" start
 exit "$result"
}
trap cleanup EXIT
trap 'exit 143' TERM INT
# Verify the baseline is healthy before the controlled switch.
for i in $(seq 1 100); do
 if curl --max-time 3 -fsS http://localhost:8000/health >/dev/null 2>&1; then break; fi
 sleep 5
done
curl --max-time 3 -fsS http://localhost:8000/health > "$run_dir/before-health.json"
docker compose -f "$old" stop
export TENSORFOLD_BIND_PORT=8007 TENSORFOLD_STREAMS=16 TENSORFOLD_CONTEXT=75000 TENSORFOLD_PROMPT_CACHE_GIB=8
docker compose -f "$new" up -d
ready=0
for i in $(seq 1 240); do
 if curl --max-time 3 -fsS http://localhost:8007/health >/dev/null 2>&1; then ready=1; break; fi
 if [ "$(docker inspect "$container" --format '{{.State.Running}}')" != true ]; then break; fi
 sleep 5
done
docker logs "$container" > "$run_dir/admission16.log" 2>&1
docker inspect "$container" --format '{{json .State}}' > "$run_dir/admission16-state.json"
if [ "$ready" != 1 ]; then
 echo '16-stream admission failed; collecting a four-stream comparison at the same context.'
 export TENSORFOLD_STREAMS=4
 docker compose -f "$new" up -d
 for i in $(seq 1 240); do
  if curl --max-time 3 -fsS http://localhost:8007/health >/dev/null 2>&1; then ready=1; break; fi
  if [ "$(docker inspect "$container" --format '{{.State.Running}}')" != true ]; then break; fi
  sleep 5
 done
fi
[ "$ready" = 1 ]
docker logs "$container" > "$run_dir/ready.log" 2>&1
cd "$run_dir"
python3 release_probe.py > release-probe.log 2>&1
# Always restore the Python runtime; promotion requires the full target workload.
