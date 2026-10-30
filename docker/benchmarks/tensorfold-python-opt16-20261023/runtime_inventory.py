#!/usr/bin/env python3
"""Capture reproducibility metadata without reading or exporting credentials."""
import hashlib,json,subprocess,sys,time
from pathlib import Path
ROOT=Path(__file__).resolve().parent
NAME='qwen38_flash_next_python_opt16'
run=sys.argv[1]
assert run.replace('-','').replace('_','').isalnum()
path=ROOT/'results'/run/'runtime-inventory.json'
assert not path.exists(),'Preserve original runtime inventory'

def inspect(field):
 return subprocess.check_output(['docker','inspect',NAME,'--format','{{json '+field+'}}'])

ident=json.loads(inspect('.Id'))
env=dict(x.split('=',1) for x in json.loads(inspect('.Config.Env')))
assert env['IETI_RUN']==run
allowed={'IETI_RUN','IETI_CANDIDATE','TENSORFOLD_PROMPT_SNAPSHOTS','TENSORFOLD_SSD_BATCH_GATHER','TENSORFOLD_MEMORY_RESERVE_GIB','CONTEXT_LENGTH','PARALLEL_STREAMS','MODEL_ID','MODEL_REVISION','TENSORFOLD_PREFILL_ROWS','TF_FLASH_STAGE_AHEAD'}
source='''import hashlib,importlib.metadata,json,pathlib,sys
root=next(pathlib.Path('/opt/tensorfold-venv/lib').glob('python*/site-packages/tensorfold'))
files=list((root/'families/qwen4_exp/cuda').glob('*.py'))+[root/'cuda/memory_gate.py',root/'cuda/capacity.py',root/'cuda/scheduler.py',root/'cuda/markers.py']
print(json.dumps({'python':sys.version,'packages':{p.metadata['Name']:p.version for p in importlib.metadata.distributions()},'source_sha256':{str(p.relative_to(root)):hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(files)}}))'''
data=json.loads(subprocess.check_output(['docker','exec',NAME,'/opt/tensorfold-venv/bin/python','-c',source]))
assert json.loads(inspect('.Id'))==ident,'Container changed while inventory was being captured'
data.update(epoch=time.time(),container_id=ident,image=json.loads(inspect('.Image')),selected_environment={k:v for k,v in env.items() if k in allowed},Cmd_sha256=hashlib.sha256(inspect('.Config.Cmd')).hexdigest(),Entrypoint_sha256=hashlib.sha256(inspect('.Config.Entrypoint')).hexdigest(),command_hash_encoding='Docker inspect formatted JSON stdout including trailing newline')
with path.open('x') as f:f.write(json.dumps(data,indent=2)+'\n')
print(json.dumps({'run':run,'source_files':len(data['source_sha256']),'packages':len(data['packages'])}))

# Retain the legacy field, but separately capture canonical first-path versions.
if not (ROOT/"results"/run/"resolved-inventory.json").exists():
 subprocess.run([sys.executable,str(ROOT/"resolved_inventory.py"),run],check=True)
