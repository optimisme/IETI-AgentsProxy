#!/usr/bin/env bash
# Retry the measured MTP-off configuration with enough unified-memory headroom.
set -euo pipefail
cd "$HOME/docker"
campaign="$PWD/benchmarks/vllm-fp8-agent-20261023"
profile=models/qwen38-flash-next-vllm-032-nvfp4-fp8-agent-128gb.yml
candidate=qwen38_flash_next_vllm032_fp8_agent
python_container=qwen38_flash_next_cuda_vram128_tensorfold_mlx_4bit_mtp_int8_ssd_vision
for i in $(seq 1 240); do
  if [ -f "$campaign/adaptive-exit-code" ];then break;fi
  sleep 5
done
test -f "$campaign/adaptive-exit-code"
test "$(cat "$campaign/python-restored")" = 1
# Preserve the rejected allocation and the reason before recreating its container.
mkdir -p "$campaign/c8192-mtp0-prefix32-gmu086"
docker logs "$candidate" > "$campaign/c8192-mtp0-prefix32-gmu086/startup.log" 2>&1
docker inspect "$candidate" --format '{{json .State}}' > "$campaign/c8192-mtp0-prefix32-gmu086/state.json"
restore() {
  code=$?
  trap - EXIT
  docker logs --tail 6000 "$candidate" > "$campaign/tuned-last.log" 2>&1 || true
  docker stop --timeout 60 "$candidate" >/dev/null 2>&1 || true
  docker start "$python_container" >/dev/null
  restored=0
  for i in $(seq 1 240);do
    if curl -fsS --max-time 3 http://127.0.0.1:8000/health > "$campaign/tuned-restored-python-health.json" 2>/dev/null;then restored=1;break;fi
    sleep 5
  done
  docker inspect "$python_container" --format '{{json .State}}' > "$campaign/tuned-restored-python-state.json"
  printf '%s\n' "$restored" > "$campaign/tuned-python-restored"
  printf '%s\n' "$code" > "$campaign/tuned-exit-code"
  exit "$code"
}
trap restore EXIT
curl -fsS http://127.0.0.1:8000/health > "$campaign/tuned-python-health-before.json"
python3 - "$campaign/tuned-python-health-before.json" <<'PY'
import json,sys
assert json.load(open(sys.argv[1])).get('requests_running',0)==0
PY
docker stop --timeout 60 "$python_container"
export VLLM_TEST_CHUNK=8192 VLLM_TEST_MTP=0 VLLM_TEST_GMU=0.82
export VLLM_TEST_PREFIX=32 VLLM_TEST_NO_DROP=1 VLLM_TEST_SHARED_PREFIX=1
label=c8192-mtp0-prefix32-gmu082
mkdir -p "$campaign/$label"
docker compose -f "$profile" config > "$campaign/$label/compose.yml"
docker compose -f "$profile" up -d --force-recreate
ready=0
for i in $(seq 1 600);do
  if curl -fsS --max-time 3 http://127.0.0.1:8007/health >/dev/null 2>&1;then ready=1;break;fi
  if [ "$(docker inspect "$candidate" --format '{{.State.Running}}')" != true ];then break;fi
  sleep 5
done
docker logs "$candidate" > "$campaign/$label/startup.log" 2>&1
test "$ready" = 1
curl -fsS http://127.0.0.1:8007/v1/models > "$campaign/$label/models.json"
curl -fsS http://127.0.0.1:8007/metrics > "$campaign/$label/metrics-before.txt"
for mode in smoke short cold quality agents;do
  python3 "$campaign/probe.py" "$mode" --base http://127.0.0.1:8007 --out "$campaign/$label" --tag c8192-mtp3 --trials 4
done
python3 "$campaign/../tensorfold-zig-release112-20261023/jpeg_probe.py" http://127.0.0.1:8007 "$campaign/$label" "$candidate"
docker logs "$candidate" > "$campaign/$label/runtime.log" 2>&1
curl -fsS http://127.0.0.1:8007/metrics > "$campaign/$label/metrics-after.txt"
mkdir -p "$campaign/capacity-tuned-gmu082"
if python3 - "$campaign/$label/startup.log" "$campaign/capacity-tuned-gmu082/admission.json" <<'PY'
import json,re,sys
s=open(sys.argv[1]).read();m=re.findall(r'Maximum concurrency for [\d,]+ tokens per request: ([\d.]+)x',s)
value=float(m[-1]) if m else None
d={'configured_streams':16,'context_limit':75000,'reported_max_full_context_concurrency':value,
   'full_context_test_admitted':value is not None and value>=16,
   'note':'Actual output overlap, token bounds, cache hits and preemptions are checked separately.'}
open(sys.argv[2],'w').write(json.dumps(d,indent=2)+'\n')
sys.exit(0 if d['full_context_test_admitted'] else 1)
PY
then
  python3 "$campaign/probe.py" capacity --base http://127.0.0.1:8007 --out "$campaign/capacity-tuned-gmu082" --tag tuned16-full
  docker logs "$candidate" > "$campaign/capacity-tuned-gmu082/runtime.log" 2>&1
fi
