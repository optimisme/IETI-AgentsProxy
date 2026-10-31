#!/usr/bin/env bash
set -euo pipefail
cd "$HOME/docker"
campaign="$PWD/benchmarks/tensorfold-python-capacity16-20261023"
profile=models/qwen38-flash-next-python-capacity16-private-test-128gb.yml
normal=qwen38_flash_next_cuda_vram128_tensorfold_mlx_4bit_mtp_int8_ssd_vision
test_container=qwen38_flash_next_python_capacity16_test
mkdir -p "$campaign/isolated"
# The interrupted shared-port attempt owns its own recovery. Wait for it.
for i in $(seq 1 240); do
  if [ -f "$campaign/controller-result.json" ];then break;fi
  sleep 5
done
python3 - "$campaign/controller-result.json" <<'PY'
import json,sys
assert json.load(open(sys.argv[1]))['healthy_after_test']
PY
restore() {
  code=$?
  trap - EXIT
  docker logs --tail 12000 "$test_container" > "$campaign/isolated/final-runtime.log" 2>&1 || true
  docker stop --timeout 20 "$test_container" >/dev/null 2>&1 || true
  docker start "$normal" >/dev/null
  healthy=0
  for i in $(seq 1 240); do
    if curl -fsS --max-time 3 http://127.0.0.1:8000/health > "$campaign/isolated/restored-health.json" 2>/dev/null;then healthy=1;break;fi
    sleep 5
  done
  docker inspect "$normal" --format '{{json .State}}' > "$campaign/isolated/restored-state.json"
  printf '%s\n' "$healthy" > "$campaign/isolated/python-restored"
  printf '%s\n' "$code" > "$campaign/isolated/exit-code"
  exit "$code"
}
trap restore EXIT
docker inspect "$normal" --format '{{json .State}}' > "$campaign/isolated/normal-state-before.json"
idle=0
for i in $(seq 1 120);do
  curl -fsS --max-time 3 http://127.0.0.1:8000/health > "$campaign/isolated/normal-health-before.json"
  if python3 - "$campaign/isolated/normal-health-before.json" <<'PY'
import json,sys
sys.exit(0 if json.load(open(sys.argv[1])).get('requests_running',0)==0 else 1)
PY
  then idle=1;break;fi
  sleep 2
done
test "$idle" = 1
docker stop --timeout 60 "$normal"
docker compose -f "$profile" config --quiet
docker compose -f "$profile" up -d --force-recreate
ready=0
for i in $(seq 1 600);do
  if curl -fsS --max-time 3 http://127.0.0.1:8009/health >/dev/null 2>&1;then ready=1;break;fi
  if [ "$(docker inspect "$test_container" --format '{{.State.Running}}')" != true ];then break;fi
  sleep 5
done
docker logs "$test_container" > "$campaign/isolated/startup.log" 2>&1
test "$ready" = 1
python3 -u "$campaign/supervise.py" --container "$test_container" --base http://127.0.0.1:8009 \
  --out isolated/python --evidence isolated --always-restore \
  --recover-container "$normal" --recover-base http://127.0.0.1:8000
