set -euo pipefail
run_dir="$HOME/docker/benchmarks/tensorfold-zig-cache-tuning-20261018"
old="$HOME/docker/models/qwen38-flash-next-tensorfold-vontra-mlx-4bit-mtp-int8-ssd-vision-128gb.yml"
new="$HOME/docker/models/qwen38-flash-next-tensorfold-zig-tuned-int4-mtp-fp8-vision-128gb.yml"
container=qwen38_flash_next_cuda_vram128_tensorfold_zig_tuned_int4_mtp_fp8_vision
exec > "$run_dir/gap-pipeline.log" 2>&1
while [ ! -f "$run_dir/awaiting-decision" ]; do sleep 5; done
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
touch "$run_dir/continue-testing"
docker compose -f "$new" stop
docker run --rm --name ieti-zig-cache-build-v2 --network host --memory 10g --memory-swap 10g --cpus 4 --entrypoint /bin/bash \
 --env-file "$run_dir/build-v2.env" \
 -v ieti-qwen38-flash-next-tensorfold-zig-tuned-int4-runtime-cache:/opt/ieti-zig \
 -v ieti-qwen38-flash-next-tensorfold-zig-tuned-int4-kernel-cache:/cache \
 -v "$HOME/docker/tokens.env:/run/secrets/tokens.env:ro" \
 -v "$HOME/docker/patches/tensorfold-zig-flashnext-cache-v2.patch:/run/ieti-cache.patch:ro" \
 -v "$run_dir:/results" \
 nvcr.io/nvidia/pytorch:26.07-py3 /results/build-v2.sh > "$run_dir/build-v2.log" 2>&1
export TENSORFOLD_CACHE_MIN_PROMPT=1024 TENSORFOLD_CACHE_HISTORY_GAP=256 TENSORFOLD_CACHE_TIMINGS=0
export TENSORFOLD_BIND_PORT=8007 TENSORFOLD_SYSTEM_CACHE=0 TENSORFOLD_RING_CACHE=0
export TENSORFOLD_RESERVE_GIB=10 TENSORFOLD_PROMPT_CACHE_GIB=8
docker compose -f "$new" up -d
ready=0
for attempt in $(seq 1 240); do
 if curl --max-time 3 -fsS http://localhost:8007/health >/dev/null 2>&1; then ready=1; break; fi
 sleep 5
done
[ "$ready" = 1 ]
echo 'Gap 256 variant ready on isolated benchmark port.'
docker logs "$container" > "$run_dir/zig1024gap256-startup.log" 2>&1
cd "$run_dir"
python3 benchmark.py bench --base http://127.0.0.1:8007 --out zig1024gap256-main --fixtures fixtures.json > zig1024gap256-main.log 2>&1
python3 cache_probe.py --base http://127.0.0.1:8007 --out zig1024gap256-probe --tag A > zig1024gap256-probe.log 2>&1
docker logs "$container" > "$run_dir/zig1024gap256-full.log" 2>&1
python3 - <<'PY_CHECK'
import json,pathlib
for folder in ('zig1024gap256-main','zig1024gap256-probe'):
 for p in pathlib.Path(folder).glob('*.json'):
  j=json.load(open(p))
  if 'summary' in j:
   s=j['summary'];assert s['successes']==s['requests']==s['full_output_requests'],s
s=json.load(open('zig1024gap256-main/smoke.json'))
assert s['tool']['passed'] and s['vision']['passed'],s
print('All GPU requests and smoke checks passed.')
PY_CHECK
touch "$run_dir/awaiting-gap-decision"
for attempt in $(seq 1 180); do
 if [ -f "$run_dir/finish-gap-and-restore" ]; then exit 0; fi
 if [ -f "$run_dir/continue-gap-testing" ]; then restore_needed=0; exit 0; fi
 sleep 5
done
echo 'Decision timeout: restoring original MLX.'
