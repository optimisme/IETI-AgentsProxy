set -euo pipefail
run_dir="$HOME/docker/benchmarks/tensorfold-zig-cache-tuning-20261018"
ready=0
for attempt in $(seq 1 360); do
 if curl --max-time 2 -fsS http://127.0.0.1:8000/health 2>/dev/null | python3 -c 'import json,sys; j=json.load(sys.stdin); assert j.get("ok") and j.get("backend")=="tensorfold"' >/dev/null 2>&1; then ready=1; break; fi
 sleep 5
done
[ "$ready" = 1 ]
cd "$run_dir"
python3 agent_probe.py --out python-agent > python-agent.log 2>&1
touch python-agent-complete
