#!/usr/bin/env bash
# Replace the fixed controller without throwing away its already-loaded model.
set -euo pipefail
cd "$HOME/docker"
campaign="$PWD/benchmarks/vllm-fp8-agent-20261023"
profile=models/qwen38-flash-next-vllm-032-nvfp4-fp8-agent-128gb.yml
candidate=qwen38_flash_next_vllm032_fp8_agent
python_container=qwen38_flash_next_cuda_vram128_tensorfold_mlx_4bit_mtp_int8_ssd_vision
previous_controller=${1:?previous controller PID required}
restore() {
  code=$?
  trap - EXIT
  kill -KILL "$previous_controller" 2>/dev/null || true
  docker logs --tail 6000 "$candidate" > "$campaign/candidate-last.log" 2>&1 || true
  docker stop --timeout 60 "$candidate" >/dev/null 2>&1 || true
  docker start "$python_container" >/dev/null
  restored=0
  for i in $(seq 1 240); do
    if curl -fsS --max-time 3 http://127.0.0.1:8000/health > "$campaign/restored-python-health.json" 2>/dev/null; then restored=1;break;fi
    sleep 5
  done
  docker inspect "$python_container" --format '{{json .State}}' > "$campaign/restored-python-state.json"
  printf '%s\n' "$code" > "$campaign/adaptive-exit-code"
  printf '%s\n' "$restored" > "$campaign/python-restored"
  exit "$code"
}
trap restore EXIT
# The old controller is ours, and owns no GPU state. Let any active client finish
# after pausing its parent, so this handover cannot contaminate request timings.
test -r "/proc/$previous_controller/cmdline"
python3 - "$previous_controller" <<'PY'
import pathlib,sys
s=pathlib.Path('/proc/'+sys.argv[1]+'/cmdline').read_bytes()
assert b'run_candidate.sh' in s,s
PY
kill -STOP "$previous_controller"
children=$(pgrep -P "$previous_controller" || true)
for child in $children;do
  for i in $(seq 1 900);do
    kill -0 "$child" 2>/dev/null || break
    sleep 2
  done
  if kill -0 "$child" 2>/dev/null;then exit 1;fi
done
kill -KILL "$previous_controller"
printf '%s\n' 'Fixed controller superseded after stock 2048 run; preserve loaded stock 8192 model, then test finer prefix cache and MTP-off capacity without an extra capacity-only reload.' > "$campaign/controller-handover.txt"
wait_ready() {
  ready=0
  for i in $(seq 1 600);do
    if curl -fsS --max-time 3 http://127.0.0.1:8007/health >/dev/null 2>&1;then ready=1;break;fi
    if [ "$(docker inspect "$candidate" --format '{{.State.Running}}')" != true ];then break;fi
    sleep 5
  done
  test "$ready" = 1
}
measure() {
  label=$1
  mkdir -p "$campaign/$label"
  wait_ready
  docker logs "$candidate" > "$campaign/$label/startup.log" 2>&1
  curl -fsS http://127.0.0.1:8007/metrics > "$campaign/$label/metrics-before.txt"
  for mode in smoke short cold quality agents;do
    # These fixed request tags match the reference despite changed runtime knobs.
    if [ ! -f "$campaign/$label/completed-$mode" ];then
      python3 "$campaign/probe.py" "$mode" --base http://127.0.0.1:8007 --out "$campaign/$label" --tag c8192-mtp3 --trials 4
    fi
  done
  python3 "$campaign/../tensorfold-zig-release112-20261023/jpeg_probe.py" http://127.0.0.1:8007 "$campaign/$label" "$candidate"
  docker logs "$candidate" > "$campaign/$label/runtime.log" 2>&1
  curl -fsS http://127.0.0.1:8007/metrics > "$campaign/$label/metrics-after.txt"
}
measure c8192-mtp3
docker stop --timeout 60 "$candidate"
export VLLM_TEST_CHUNK=8192 VLLM_TEST_MTP=0 VLLM_TEST_GMU=0.86
export VLLM_TEST_PREFIX=32 VLLM_TEST_NO_DROP=1 VLLM_TEST_SHARED_PREFIX=1
label=c8192-mtp0-prefix32-gmu086
mkdir -p "$campaign/$label"
docker compose -f "$profile" config > "$campaign/$label/compose.yml"
docker compose -f "$profile" up -d --force-recreate
measure "$label"
mkdir -p "$campaign/capacity-tuned"
if python3 - "$campaign/$label/startup.log" "$campaign/capacity-tuned/admission.json" <<'PY'
import json,re,sys
s=open(sys.argv[1]).read();m=re.findall(r'Maximum concurrency for [\d,]+ tokens per request: ([\d.]+)x',s)
value=float(m[-1]) if m else None
d={'configured_streams':16,'context_limit':75000,'reported_max_full_context_concurrency':value,
   'full_context_test_admitted':value is not None and value>=16,
   'note':'Actual output overlap, cache hits, token bounds and preemptions are checked separately.'}
open(sys.argv[2],'w').write(json.dumps(d,indent=2)+'\n')
sys.exit(0 if d['full_context_test_admitted'] else 1)
PY
then
  python3 "$campaign/probe.py" capacity --base http://127.0.0.1:8007 --out "$campaign/capacity-tuned" --tag tuned16-full
  docker logs "$candidate" > "$campaign/capacity-tuned/runtime.log" 2>&1
fi
