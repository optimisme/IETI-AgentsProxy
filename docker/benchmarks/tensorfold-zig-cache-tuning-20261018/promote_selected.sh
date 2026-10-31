set -euo pipefail
run_dir="$HOME/docker/benchmarks/tensorfold-zig-cache-tuning-20261018"
old="$HOME/docker/models/qwen38-flash-next-tensorfold-vontra-mlx-4bit-mtp-int8-ssd-vision-128gb.yml"
new="$HOME/docker/models/qwen38-flash-next-tensorfold-zig-tuned-int4-mtp-fp8-vision-128gb.yml"
container=qwen38_flash_next_cuda_vram128_tensorfold_zig_tuned_int4_mtp_fp8_vision
exec > "$run_dir/promotion.log" 2>&1
# Invoke only after reviewing benchmark/capacity results. A required receipt gates it too.
cd "$run_dir"
python3 - <<'PY_CHECK'
import json,pathlib
p=pathlib.Path('zigstable8g512policy0-main/capacity16-near75k.json')
s=json.loads(p.read_text())['summary']
assert s['successes']==s['full_output_requests']==s['requests']==16,s
assert s['external_requests']==0 and s['oom_kills']==0,s
assert s['min_available_gib']>=6 and s['swap_out_pages']<=262144,s
assert json.load(open('selected-candidate.json'))['promote'] is True
PY_CHECK
rollback=1
cleanup() {
 result=$?;trap - EXIT
 if [ "$rollback" = 1 ]; then
  set +e
  docker compose -f "$new" stop
  docker compose -f "$old" start
 fi
 exit "$result"
}
trap cleanup EXIT
trap 'exit 143' TERM INT
touch "$run_dir/continue-stable8policy-testing"
# Give the benchmark controller time to see the transfer marker.
sleep 6
export TENSORFOLD_BIND_PORT=8000 TENSORFOLD_STREAMS=16 TENSORFOLD_CONTEXT=75000 TENSORFOLD_CACHE_MIN_PROMPT=1024 TENSORFOLD_CACHE_HISTORY_GAP=512
export TENSORFOLD_CACHE_BRANCH_LRU=0 TENSORFOLD_CACHE_STABLE_HISTORY=1 TENSORFOLD_PROMPT_CACHE_GIB=8
export TENSORFOLD_CACHE_TIMINGS=0 TENSORFOLD_SYSTEM_CACHE=0 TENSORFOLD_RING_CACHE=0 TENSORFOLD_RESERVE_GIB=10
docker compose -f "$old" stop
docker compose -f "$new" up -d
ready=0
for i in $(seq 1 240); do
 if curl --max-time 3 -fsS http://localhost:8000/health >/dev/null 2>&1; then ready=1;break;fi
 if [ "$(docker inspect "$container" --format '{{.State.Running}}')" != true ]; then break;fi
 sleep 5
done
[ "$ready" = 1 ]
python3 production_smoke.py --base http://127.0.0.1:8000 --out production-smoke
docker logs "$container" > production-startup.log 2>&1
python3 - <<'PY_STATE'
import json,pathlib,subprocess,time
name='qwen38_flash_next_cuda_vram128_tensorfold_zig_tuned_int4_mtp_fp8_vision'
i=json.loads(subprocess.check_output(['docker','inspect',name]))[0]
env={}
for item in i['Config']['Env']:
 key,_,value=item.partition('=')
 if key.startswith(('TF_FLASHNEXT_','TENSORFOLD_','IETI_')) or key in ('MODEL_ID','MODEL_REVISION','PARALLEL_STREAMS','CONTEXT_LENGTH'):env[key]=value
r={'at_utc':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'container':name,'state':i['State'],'ports':i['NetworkSettings']['Ports'],'restart_policy':i['HostConfig']['RestartPolicy'],'gpu_requests':i['HostConfig']['DeviceRequests'],'selected_environment':env,'native_sha256':subprocess.check_output(['docker','exec',name,'sha256sum','/opt/ieti-zig/install/native/bin/tensorfold-native'],text=True)}
pathlib.Path('production-state.json').write_text(json.dumps(r,indent=2)+'\n')
selected=json.load(open('selected-candidate.json'))
assert r['native_sha256'].split()[0]==selected['native_sha256'],r
assert env['CONTEXT_LENGTH']=='75000' and env['PARALLEL_STREAMS']=='16',env
assert env['TF_FLASHNEXT_CACHE_STABLE_HISTORY']=='1' and env['TF_FLASHNEXT_CACHE_BRANCH_LRU']=='0',env
assert env['TENSORFOLD_PROMPT_CACHE_GIB']=='8',env
assert r['restart_policy']['Name']=='unless-stopped',r
assert any(x['Count']==1 and ['gpu'] in x['Capabilities'] for x in r['gpu_requests']),r
assert r['ports']['8000/tcp'][0]['HostPort']=='8000',r

PY_STATE
rollback=0
echo 'Selected GPU Zig profile is healthy and validated on port 8000.'
