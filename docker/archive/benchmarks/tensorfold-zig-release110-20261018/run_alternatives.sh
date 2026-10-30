set -euo pipefail
run_dir="$HOME/docker/benchmarks/tensorfold-zig-release110-20261018"
prev="$HOME/docker/benchmarks/tensorfold-zig-cache-tuning-20261018"
models="$HOME/docker/models"
old="$models/qwen38-flash-next-tensorfold-vontra-mlx-4bit-mtp-int8-ssd-vision-128gb.yml"
container=qwen38_flash_next_tensorfold_110_cuda
exec > "$run_dir/alternatives-pipeline.log" 2>&1
cleanup() {
 result=$?; trap - EXIT; set +e
 docker logs "$container" > "$run_dir/alternative-final.log" 2>&1
 docker stop "$container"
 docker compose -f "$old" start
 exit "$result"
}
trap cleanup EXIT
trap 'exit 143' TERM INT
# Transfer responsibility from the completed older-engine controller only after this trap exists.
if [ -f "$prev/awaiting-stable8policy-decision" ]; then
 touch "$prev/continue-stable8policy-testing"
 sleep 6
fi
docker stop qwen38_flash_next_cuda_vram128_tensorfold_zig_tuned_int4_mtp_fp8_vision
docker compose -f "$old" stop
cd "$run_dir"
export TENSORFOLD_BIND_PORT=8007 TENSORFOLD_STREAMS=16 TENSORFOLD_CONTEXT=75000
export TENSORFOLD_PROMPT_CACHE_GIB=0 TENSORFOLD_DRAFT_DEPTH=6
for variant in fp4-d6-r10 mlx-plain-r8 mlx-plain-r6; do
 profile="$models/qwen38-flash-next-tensorfold-110-mlx-4bit-vision-128gb.yml"
 export TENSORFOLD_DRAFTS_ENABLED=0 TENSORFOLD_VISION_ENABLED=0 TENSORFOLD_RESERVE_GIB=8 TENSORFOLD_PREFILL_CHUNK=768
 case "$variant" in
 fp4-*) profile="$models/qwen38-flash-next-tensorfold-110-nvidia-fp4-vision-128gb.yml";export TENSORFOLD_DRAFTS_ENABLED=1 TENSORFOLD_VISION_ENABLED=1 TENSORFOLD_RESERVE_GIB=10 TENSORFOLD_PREFILL_CHUNK=1536;;
 mlx-plain-r6) export TENSORFOLD_RESERVE_GIB=6;;
 esac
 date -u > "$variant-start.txt"
 docker compose -f "$profile" config > "$variant-compose.yml"
 docker compose -f "$profile" up -d
 ready=0
 for attempt in $(seq 1 200); do
  if curl --max-time 3 -fsS http://localhost:8007/health >/dev/null 2>&1; then ready=1;break;fi
  if [ "$(docker inspect "$container" --format '{{.State.Running}}')" != true ]; then break;fi
  available=$(awk '/MemAvailable:/ {print $2}' /proc/meminfo)
  if [ "$available" -lt 6291456 ]; then echo 'Host memory guard fired during load';exit 3;fi
  sleep 5
 done
 docker logs "$container" > "$variant-admission.log" 2>&1
 docker inspect "$container" --format '{{json .State}}' > "$variant-state.json"
 if [ "$ready" = 1 ]; then
  docker inspect "$container" --format '{{json .HostConfig.DeviceRequests}}' > "$variant-gpu-device.json"
  python3 alternative_probe.py --out "$variant" --vision "$TENSORFOLD_VISION_ENABLED" > "$variant-probe.log" 2>&1
  docker logs "$container" > "$variant-after-probe.log" 2>&1
  touch "$variant-probe-complete"
 fi
 docker stop "$container"
done
touch alternatives-complete
