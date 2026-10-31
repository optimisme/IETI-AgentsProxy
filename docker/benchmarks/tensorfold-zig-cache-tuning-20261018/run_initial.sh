set -euo pipefail
cd "$HOME/docker"
run_dir="$HOME/docker/benchmarks/tensorfold-zig-cache-tuning-20261018"
old="$HOME/docker/models/qwen38-flash-next-tensorfold-vontra-mlx-4bit-mtp-int8-ssd-vision-128gb.yml"
new="$HOME/docker/models/qwen38-flash-next-tensorfold-zig-tuned-int4-mtp-fp8-vision-128gb.yml"
container=qwen38_flash_next_cuda_vram128_tensorfold_zig_tuned_int4_mtp_fp8_vision
exec > "$run_dir/pipeline.log" 2>&1
while [ ! -f "$run_dir/python-baseline.ready" ]; do sleep 5; done
for suffix in hf-cache runtime-cache kernel-cache; do docker volume create "ieti-qwen38-flash-next-tensorfold-zig-tuned-int4-$suffix"; done
docker run --rm --network none --entrypoint /bin/bash \
 -v ieti-qwen38-flash-next-tensorfold-zig-autoround-int4-hf-cache:/oldhf:ro \
 -v ieti-qwen38-flash-next-tensorfold-zig-tuned-int4-hf-cache:/newhf \
 -v ieti-qwen38-flash-next-tensorfold-zig-autoround-int4-runtime-cache:/oldruntime:ro \
 -v ieti-qwen38-flash-next-tensorfold-zig-tuned-int4-runtime-cache:/newruntime \
 -v ieti-qwen38-flash-next-tensorfold-zig-autoround-int4-kernel-cache:/oldkernel:ro \
 -v ieti-qwen38-flash-next-tensorfold-zig-tuned-int4-kernel-cache:/newkernel \
 nvcr.io/nvidia/pytorch:26.07-py3 -lc 'set -e; if [ ! -f /newruntime/seeded ]; then cp -a --reflink=auto /oldhf/. /newhf/; cp -a /oldruntime/. /newruntime/; cp -a /oldkernel/. /newkernel/; touch /newruntime/seeded; fi'
echo 'Caches seeded; building and testing without GPU access while MLX stays online.'
docker run --rm --name ieti-zig-cache-build --network host --memory 10g --memory-swap 10g --cpus 4 --entrypoint /bin/bash \
 --env-file "$run_dir/build.env" \
 -v ieti-qwen38-flash-next-tensorfold-zig-tuned-int4-runtime-cache:/opt/ieti-zig \
 -v ieti-qwen38-flash-next-tensorfold-zig-tuned-int4-kernel-cache:/cache \
 -v "$HOME/docker/tokens.env:/run/secrets/tokens.env:ro" \
 -v "$HOME/docker/patches/tensorfold-zig-flashnext-cache-v1.patch:/run/ieti-cache.patch:ro" \
 -v "$run_dir:/results" \
 nvcr.io/nvidia/pytorch:26.07-py3 /results/build.sh > "$run_dir/build.log" 2>&1
restore_needed=0
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
restore_needed=1
docker compose -f "$old" stop
for threshold in 4096 1024; do
 export TENSORFOLD_CACHE_MIN_PROMPT="$threshold"
 export TENSORFOLD_CACHE_TIMINGS=0
 docker compose -f "$new" up -d
 ready=0
 for attempt in $(seq 1 240); do
  if curl --max-time 3 -fsS http://localhost:8000/health >/dev/null 2>&1; then ready=1; break; fi
  sleep 5
 done
 [ "$ready" = 1 ]
 echo "Variant $threshold ready"
 docker logs "$container" > "$run_dir/zig$threshold-startup.log" 2>&1
 cd "$run_dir"
 python3 benchmark.py bench --out "zig$threshold-main" --fixtures fixtures.json > "zig$threshold-main.log" 2>&1
 python3 cache_probe.py --out "zig$threshold-probe" --tag A > "zig$threshold-probe.log" 2>&1
 docker logs "$container" > "$run_dir/zig$threshold-full.log" 2>&1
 touch "$run_dir/zig$threshold-complete"
 cd "$HOME/docker"
done
echo 'Both thresholds complete; awaiting measured next-step decision (maximum 15 minutes).'
touch "$run_dir/awaiting-decision"
for attempt in $(seq 1 180); do
 if [ -f "$run_dir/finish-and-restore" ]; then exit 0; fi
 if [ -f "$run_dir/continue-testing" ]; then
  # The next runner explicitly takes responsibility for cleanup before sending this marker.
  restore_needed=0
  exit 0
 fi
 sleep 5
done
echo 'Decision timeout: restoring original MLX.'
