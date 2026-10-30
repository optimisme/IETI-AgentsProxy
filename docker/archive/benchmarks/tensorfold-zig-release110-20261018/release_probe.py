#!/usr/bin/env python3
"""GPU release triage, identical frozen requests from the prior campaign."""
import json,sys,subprocess,time
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parent.parent/'tensorfold-zig-cache-tuning-20261018'))
from benchmark import api,body,cohort,smoke
# A separate source build may overlap model loading, never timing measurements.
for attempt in range(120):
 active=subprocess.check_output(['docker','ps','--filter','name=ieti-zig-cache-build-v4','--format','{{.Names}}'],text=True).strip()
 if not active: break
 time.sleep(5)
else: raise RuntimeError('Candidate compilation still active; refusing a noisy performance run')
base='http://127.0.0.1:8007'
out=Path('upstream110');out.mkdir(exist_ok=True)
model=api(base,'/v1/models')['data'][0]['id']
(out/'health.json').write_text(json.dumps(api(base,'/health'),indent=2)+'\n')
smoke(base,model,out)
for trial in range(2):
 for count in (1,16):
  question='Write a Python LRU cache with type hints, docstrings and extensive unit tests.'
  prompts=[body(model,[{'role':'user','content':f'Trial {trial}, code, cohort {count}, user {i}.\n'+question}]) for i in range(count)]
  cohort(base,f'code{count}-trial{trial}',prompts,out)
f=Path(__file__).resolve().parent.parent/'tensorfold-zig-cache-tuning-20261018/fixtures.json'
data=json.loads(f.read_text())
cohort(base,'cold-16000',[body(model,[{'role':'user','content':'Cold isolated workload 16000\n'+data['16000']}],128)],out)
for p in out.glob('*.json'):
 j=json.loads(p.read_text())
 if 'summary' in j:
  s=j['summary'];assert s['successes']==s['requests']==s['full_output_requests'],s
