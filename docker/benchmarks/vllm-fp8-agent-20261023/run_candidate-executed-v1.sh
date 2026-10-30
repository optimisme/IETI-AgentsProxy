#!/usr/bin/env bash
set -euo pipefail
cd "$HOME/docker"
campaign="$PWD/benchmarks/vllm-fp8-agent-20261023"
profile=models/qwen38-flash-next-vllm-032-nvfp4-fp8-agent-128gb.yml
python_container=qwen38_flash_next_cuda_vram128_tensorfold_mlx_4bit_mtp_int8_ssd_vision
candidate=qwen38_flash_next_vllm032_fp8_agent
# Preparation is CPU-only; keep the existing runtime serving until it finishes.
prepared=0
for i in $(seq 1 360); do
  if [ "$(docker inspect ieti_vllm032_checkpoint_prepare --format '{{.State.Running}}')" != true ]; then
    test "$(docker inspect ieti_vllm032_checkpoint_prepare --format '{{.State.ExitCode}}')" = 0
    prepared=1
    break
  fi
  sleep 5
done
test "$prepared" = 1
docker logs ieti_vllm032_checkpoint_prepare > "$campaign/checkpoint-prepare.log" 2>&1
restore() {
  code=$?
  trap - EXIT
  docker logs --tail 5000 "$candidate" > "$campaign/candidate-last.log" 2>&1 || true
  docker stop --timeout 60 "$candidate" > /dev/null 2>&1 || true
  docker start "$python_container" > /dev/null
  restored=0
  for i in $(seq 1 240); do
    if curl -fsS --max-time 3 http://127.0.0.1:8000/health > "$campaign/restored-python-health.json" 2>/dev/null; then restored=1; break; fi
    sleep 5
  done
  docker inspect "$python_container" --format '{{json .State}}' > "$campaign/restored-python-state.json"
  printf '%s\n' "$code" > "$campaign/candidate-exit-code"
  printf '%s\n' "$restored" > "$campaign/python-restored"
  exit "$code"
}
trap restore EXIT
docker inspect "$python_container" --format '{{json .State}}' > "$campaign/python-state-before.json"
curl -fsS http://127.0.0.1:8000/health > "$campaign/python-health-before.json"
python3 - "$campaign/python-health-before.json" <<'PY'
import json,sys
assert json.load(open(sys.argv[1])).get('requests_running',0)==0, 'Candidate host is serving an active request'
PY
docker stop --timeout 60 "$python_container"
run_variant() {
  label=$1
  export VLLM_TEST_CHUNK=$2 VLLM_TEST_MTP=$3
  mkdir -p "$campaign/$label"
  docker compose -f "$profile" config > "$campaign/$label/compose.yml"
  docker compose -f "$profile" up -d --force-recreate
  ready=0
  for i in $(seq 1 600); do
    if curl -fsS --max-time 3 http://127.0.0.1:8007/health > /dev/null 2>&1; then ready=1; break; fi
    if [ "$(docker inspect "$candidate" --format '{{.State.Running}}')" != true ]; then break; fi
    sleep 5
  done
  docker logs "$candidate" > "$campaign/$label/startup.log" 2>&1
  if [ "$ready" != 1 ]; then printf '%s\n' startup-failed > "$campaign/$label/result"; return 1; fi
  curl -fsS http://127.0.0.1:8007/v1/models > "$campaign/$label/models.json"
  curl -fsS http://127.0.0.1:8007/metrics > "$campaign/$label/metrics-before.txt"
  for mode in smoke short cold quality agents; do
    python3 "$campaign/probe.py" "$mode" --base http://127.0.0.1:8007 --out "$campaign/$label" --tag "$label" --trials 4
  done
  python3 "$campaign/../tensorfold-zig-release112-20261023/jpeg_probe.py" http://127.0.0.1:8007 "$campaign/$label" "$candidate"
  docker logs "$candidate" > "$campaign/$label/runtime.log" 2>&1
  curl -fsS http://127.0.0.1:8007/metrics > "$campaign/$label/metrics-after.txt"
  docker stop --timeout 60 "$candidate"
}
run_variant c2048-mtp3 2048 3
run_variant c8192-mtp3 8192 3
# All full-window requests use independent prompts; returning turns append to them.
export VLLM_TEST_CHUNK=2048 VLLM_TEST_MTP=3
docker compose -f "$profile" up -d --force-recreate
ready=0
for i in $(seq 1 600); do
  if curl -fsS --max-time 3 http://127.0.0.1:8007/health >/dev/null 2>&1; then ready=1; break; fi
  if [ "$(docker inspect "$candidate" --format '{{.State.Running}}')" != true ]; then break; fi
  sleep 5
done
test "$ready" = 1
mkdir -p "$campaign/capacity"
docker logs "$candidate" > "$campaign/capacity/startup.log" 2>&1
if ! python3 - "$campaign/capacity/startup.log" "$campaign/capacity/admission.json" <<'PY'
import json,re,sys
s=open(sys.argv[1]).read()
m=re.findall(r'Maximum concurrency for [\d,]+ tokens per request: ([\d.]+)x',s)
value=float(m[-1]) if m else None
d={'configured_streams':16,'context_limit':75000,'reported_max_full_context_concurrency':value,
   'full_context_test_admitted':value is not None and value>=16,
   'note':'Queued completions do not qualify sixteen simultaneously resident full contexts.'}
open(sys.argv[2],'w').write(json.dumps(d,indent=2)+'\n')
sys.exit(0 if d['full_context_test_admitted'] else 1)
PY
then
  printf '%s\n' 'Full-window test skipped: engine has not established capacity for 16 full contexts.'
  exit 0
fi
python3 "$campaign/probe.py" capacity --base http://127.0.0.1:8007 --out "$campaign/capacity" --tag c2048-mtp3-full
docker logs "$candidate" > "$campaign/capacity/runtime.log" 2>&1
