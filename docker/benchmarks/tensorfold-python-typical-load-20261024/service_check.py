#!/usr/bin/env python3
"""Read-only service fingerprint; stdout contains no commands or environment secrets."""
import argparse,datetime,hashlib,json,subprocess,urllib.request

def main():
    p=argparse.ArgumentParser();p.add_argument('--container',default='qwen38_flash_next_cuda_vram128_tensorfold_mlx_4bit_mtp_int8_ssd_vision');p.add_argument('--port',type=int,default=8000);a=p.parse_args()
    def raw(field):return subprocess.check_output(['docker','inspect',a.container,'--format','{{json '+field+'}}'])
    state=json.loads(raw('.State'));result={'checked_utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'running':state['Running'],'started_at':state['StartedAt'],'host_oom_killed':state['OOMKilled'],'docker_health':state.get('Health',{}).get('Status'),'image':json.loads(raw('.Image')),'Cmd_sha256':hashlib.sha256(raw('.Config.Cmd')).hexdigest(),'Entrypoint_sha256':hashlib.sha256(raw('.Config.Entrypoint')).hexdigest(),'hash_encoding':'Docker inspect formatted JSON stdout including trailing newline'}
    with urllib.request.urlopen(f'http://127.0.0.1:{a.port}/health',timeout=10) as response:result['health']=json.load(response)
    script='''import hashlib,importlib.metadata,json,pathlib
root=next(pathlib.Path('/opt/tensorfold-venv/lib').glob('python*/site-packages/tensorfold'))
print(json.dumps({'tensorfold':importlib.metadata.version('tensorfold'),'source_sha256':{n:hashlib.sha256((root/n).read_bytes()).hexdigest() for n in ['families/qwen4_exp/cuda/engine.py','families/qwen4_exp/cuda/forward.py']}}))'''
    result['installed']=json.loads(subprocess.check_output(['docker','exec',a.container,'/opt/tensorfold-venv/bin/python','-B','-c',script]))
    print(json.dumps(result,indent=2))

if __name__=='__main__':main()
