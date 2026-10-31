set -euo pipefail
run_dir="$HOME/docker/benchmarks/tensorfold-zig-release110-20261018"
models="$HOME/docker/models"
old="$models/qwen38-flash-next-tensorfold-vontra-mlx-4bit-mtp-int8-ssd-vision-128gb.yml"
new="$models/qwen38-flash-next-tensorfold-110-tuned-mlx-4bit-128gb.yml"
container=qwen38_flash_next_tensorfold_110_cuda
exec > "$run_dir/graph-v2-trial-pipeline.log" 2>&1
while docker ps --filter name=ieti-native110-build --format '{{.Names}}' | grep -q .;do sleep 5;done
test -s "$run_dir/graph-v2-native-sha256.txt"
cleanup() {
 result=$?;trap - EXIT;set +e
 docker logs "$container" > "$run_dir/graph-v2-trial-final.log" 2>&1
 docker stop "$container"
 docker compose -f "$old" start
 exit "$result"
}
trap cleanup EXIT
trap 'exit 143' TERM INT
docker compose -f "$old" stop
export TENSORFOLD_BIND_PORT=8007 TENSORFOLD_STREAMS=16 TENSORFOLD_CONTEXT=75000
export TENSORFOLD_PROMPT_CACHE_GIB=0 TENSORFOLD_VISION_ENABLED=0 TENSORFOLD_RESERVE_GIB=6
export TENSORFOLD_DRAFTS_ENABLED=0 TENSORFOLD_PREFILL_CHUNK=768 TENSORFOLD_DECODE_GRAPH=1
cd "$run_dir"
docker compose -f "$new" config > mlx-built-plain-graph1-v2-compose.yml
docker compose -f "$new" up -d
ready=0
for attempt in $(seq 1 200);do
 if curl --max-time 3 -fsS http://localhost:8007/health >/dev/null 2>&1;then ready=1;break;fi
 if [ "$(docker inspect "$container" --format '{{.State.Running}}')" != true ];then break;fi
 available=$(awk '/MemAvailable:/ {print $2}' /proc/meminfo)
 if [ "$available" -lt 6291456 ];then echo 'Host memory guard during load';exit 3;fi
 sleep 5
done
docker logs "$container" > mlx-built-plain-graph1-v2-admission.log 2>&1
[ "$ready" = 1 ]
python3 alternative_probe.py --out mlx-built-plain-graph1-v2 > mlx-built-plain-graph1-v2-probe.log 2>&1
docker logs "$container" > mlx-built-plain-graph1-v2-after-probe.log 2>&1
touch graph-trials-v2-complete
