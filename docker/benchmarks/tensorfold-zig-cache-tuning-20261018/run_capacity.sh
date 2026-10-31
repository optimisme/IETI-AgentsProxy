set -euo pipefail
run_dir="$HOME/docker/benchmarks/tensorfold-zig-cache-tuning-20261018"
old="$HOME/docker/models/qwen38-flash-next-tensorfold-vontra-mlx-4bit-mtp-int8-ssd-vision-128gb.yml"
new="$HOME/docker/models/qwen38-flash-next-tensorfold-zig-tuned-int4-mtp-fp8-vision-128gb.yml"
exec > "$run_dir/capacity-pipeline.log" 2>&1
ready=0
for attempt in $(seq 1 120); do
 if [ -f "$run_dir/zig1024gap256-agent-complete" ]; then ready=1; break; fi
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
touch "$run_dir/continue-gap-testing"
cd "$run_dir"
python3 - <<'PY_CHECK'
import json,pathlib
for p in pathlib.Path('zig1024gap256-agent').glob('*.json'):
 j=json.load(open(p))
 if 'summary' in j:
  s=j['summary'];assert s['successes']==s['requests']==s['full_output_requests'],s
print('Longer tool-history requests completed; starting isolated capacity burst.')
PY_CHECK
python3 benchmark.py capacity --base http://127.0.0.1:8007 --out zig1024gap256-main --fixtures fixtures.json > zig1024gap256-capacity.log 2>&1
docker logs qwen38_flash_next_cuda_vram128_tensorfold_zig_tuned_int4_mtp_fp8_vision > zig1024gap256-after-capacity.log 2>&1
touch "$run_dir/awaiting-capacity-decision"
for attempt in $(seq 1 180); do
 if [ -f "$run_dir/finish-capacity-and-restore" ]; then exit 0; fi
 if [ -f "$run_dir/continue-capacity-testing" ]; then restore_needed=0; exit 0; fi
 sleep 5
done
echo 'Decision timeout: restoring original MLX.'
