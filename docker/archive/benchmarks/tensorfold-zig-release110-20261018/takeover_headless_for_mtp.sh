set -euo pipefail
run_dir="$HOME/docker/benchmarks/tensorfold-zig-release110-20261018"
previous="$HOME/docker/benchmarks/tensorfold-zig-cache-tuning-20261018"
models="$HOME/docker/models"
old="$models/qwen38-flash-next-tensorfold-vontra-mlx-4bit-mtp-int8-ssd-vision-128gb.yml"
exec > "$run_dir/mtp-takeover.log" 2>&1
# Preserve both complete sixteen-user code trials before ending the uncompetitive variant.
for attempt in $(seq 1 120);do
 if python3 - "$previous/zig110fp8graph2-main/code16-trial1.json" <<'PY_CHECK'
import json,sys
try:
 s=json.load(open(sys.argv[1]))['summary'];assert s['requests']==s['successes']==s['full_output_requests']==16
except (FileNotFoundError,json.JSONDecodeError,AssertionError):sys.exit(1)
PY_CHECK
 then break;fi
 sleep 2
done
restore=1
cleanup() {
 result=$?;trap - EXIT
 if [ "$restore" = 1 ];then set +e;docker stop qwen38_flash_next_tensorfold_110_cuda;docker compose -f "$old" start;fi
 exit "$result"
}
trap cleanup EXIT
trap 'exit 143' TERM INT
pid=$(pgrep -f "^bash $run_dir/run_fp8_trial.sh$" || true)
if [ -n "$pid" ];then
 kill -TERM "$pid"
 # Stop only the benchmark client owned by this controller, so its EXIT rollback can run.
 for child in $(pgrep -P "$pid" || true);do
  if [ "$(ps -p "$child" -o comm= | xargs)" = python3 ];then kill -TERM "$child" || true;fi
 done
 for attempt in $(seq 1 60);do
  if ! kill -0 "$pid" 2>/dev/null;then break;fi
  sleep 1
 done
fi
bash "$run_dir/clear_orphan_python_build_lock.sh"
cat > "$run_dir/fp8-headless-stopped.json" <<'JSON'
{"reason":"All cold comparison and QA requests passed, but headless decode remains below Python. Stopped after both warm code16 trials to prioritize batched MTP. Remaining interactive cohorts and capacity were intentionally skipped; this is not a failed or passed full-capacity result.","promoted":false}
JSON
# The next controller installs its own rollback before acknowledging this handoff.
touch "$run_dir/mtp-takeover-ready"
for attempt in $(seq 1 300);do
 if [ -f "$run_dir/mtp-takeover-accepted" ];then restore=0;exit 0;fi
 sleep 2
done
