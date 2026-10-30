#!/usr/bin/env python3
"""Fixed requests shared with Python baseline, on the real native CUDA server."""
import argparse,base64,json,sys,subprocess,time
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parent.parent/'tensorfold-zig-cache-tuning-20261018'))
from benchmark import api,body,cohort,request
p=argparse.ArgumentParser();p.add_argument('--out',required=True);p.add_argument('--vision',type=int,default=0);a=p.parse_args()
# Source compilation may overlap startup, never a timed inference cohort.
for attempt in range(240):
 if not subprocess.check_output(['docker','ps','--filter','name=ieti-native110-build','--format','{{.Names}}'],text=True).strip(): break
 time.sleep(5)
else: raise RuntimeError('Compilation still running; timing refused')
base='http://127.0.0.1:8007';out=Path(a.out);out.mkdir(exist_ok=True)
subprocess.run([sys.executable,str(Path(__file__).resolve().parent/'verify_memory_off.py'),'--base',base,'--out',str(out/'memory-off.json')],check=True)
model=api(base,'/v1/models')['data'][0]['id']
(out/'health.json').write_text(json.dumps(api(base,'/health'),indent=2)+'\n')
def checked_cohort(name,payloads):
 report=cohort(base,name,payloads,out)
 s=report['summary'];assert s['successes']==s['requests']==s['full_output_requests'],s
 if out.name.startswith('mlx-fp8-batched-mtp'):
  teacher=json.loads((out.parent/'mlx-fp8-graph1-cold'/(name+'.json')).read_text())
  for x,y in zip(teacher['requests'],report['requests']):
   assert x['request_sha256']==y['request_sha256'],name
   assert x['engine']['token_sha256']==y['engine']['token_sha256'],('MTP teacher mismatch',name)
 return report
for trial in range(2):
 for count in (1,16):
  question='Write a Python LRU cache with type hints, docstrings and extensive unit tests.'
  prompts=[body(model,[{'role':'user','content':f'Trial {trial}, code, cohort {count}, user {i}.\n'+question}]) for i in range(count)]
  checked_cohort(f'code{count}-trial{trial}',prompts)
data=json.loads((Path(__file__).resolve().parent.parent/'tensorfold-zig-cache-tuning-20261018/fixtures.json').read_text())
checked_cohort('cold-16000',[body(model,[{'role':'user','content':'Cold isolated workload 16000\n'+data['16000']}],128)])
for f in out.glob('*.json'):
 j=json.loads(f.read_text())
 if 'summary' in j and not f.name.startswith('quality'):
  s=j['summary'];assert s['successes']==s['requests']==s['full_output_requests'],s
# Observe automatic tool use separately from the known unsupported forced choice.
tool=body(model,[{'role':'user','content':'Call record_number with value 42.'}],128)
tool['ignore_eos']=False
tool['tools']=[{'type':'function','function':{'name':'record_number','description':'Record an integer','parameters':{'type':'object','properties':{'value':{'type':'integer'}},'required':['value']}}}]
tool['tool_choice']='auto'
r=request(base,tool)
(out/'auto-tool.json').write_text(json.dumps(r,indent=2)+'\n')
calls={}
for delta in r.get('tool_calls',[]):
 fn=delta.get('function',{}); index=delta.get('index',0)
 c=calls.setdefault(index,{'name':'','arguments':''})
 c['name']+=fn.get('name','');c['arguments']+=fn.get('arguments','')
assert r['error'] is None and any(c['name']=='record_number' and json.loads(c['arguments'])=={'value':42} for c in calls.values()),r
assert not r.get('reasoning'),r
# A graph may only change scheduling, never the generated token sequence.
if out.name in ('mlx-built-plain-graph1','mlx-built-plain-graph1-v2') or out.name.startswith('mlx-fp8-batched-mtp'):
 total=0
 for f in out.glob('*.json'):
  j=json.loads(f.read_text())
  if 'summary' not in j or f.name.startswith('quality'):continue
  teacher='mlx-fp8-graph1-cold' if out.name.startswith('mlx-fp8-batched-mtp') else 'mlx-built-plain-graph0'
  ref=json.loads((out.parent/teacher/f.name).read_text())
  for a,b in zip(ref['requests'],j['requests']):
   assert a['request_sha256']==b['request_sha256'],f.name
   assert a['engine']['token_sha256']==b['engine']['token_sha256'],f.name
   assert (a['content'],a['reasoning'])==(b['content'],b['reasoning']),f.name
   total+=1
 (out/'graph-equivalence.json').write_text(json.dumps({'requests':total,'all_token_hashes_equal':True},indent=2)+'\n')
 assert total==35,total
if out.name in ('mlx-built-plain-graph1','mlx-built-plain-graph1-v2','mlx-fp8-graph1-cold') or out.name.startswith(('mlx-fp8-batched-mtp','fp4-headless','fp4-fp8-batched-mtp')):
 subprocess.run([sys.executable,str(Path(__file__).resolve().parent/'quality_probe.py'),'--out',str(out)],check=True)
 if out.name=='mlx-fp8-graph1-cold' or out.name.startswith('mlx-fp8-batched-mtp'):
  teacher='mlx-fp8-graph1-cold' if out.name.startswith('mlx-fp8-batched-mtp') else 'mlx-built-plain-graph1-v2'
  reference=json.loads((out.parent/teacher/'quality-result.json').read_text())
  candidate=json.loads((out/'quality-result.json').read_text())
  assert len(reference['cases'])==len(candidate['cases'])==16
  for r,c in zip(reference['cases'],candidate['cases']):
   assert r['request_sha256']==c['request_sha256']
   assert not r['passed'] or c['passed'],('FP8 retrieval regression',r,c)
if out.name in ('mlx-fp8-batched-mtp-v3','fp4-fp8-batched-mtp-v3'):
 logs=subprocess.check_output(['docker','logs','qwen38_flash_next_tensorfold_110_cuda'],stderr=subprocess.STDOUT,text=True)
 assert 'grouped MTP verification active, owners=' in logs,'Grouped verification was not exercised'
 assert 'grouped MTP draft head active, owners=' in logs,'Grouped head was not exercised'
 (out/'batch-path-exercised.json').write_text(json.dumps({'verification':True,'draft_head':True},indent=2)+'\n')
print('Completed GPU comparison and automatic tool validation.',flush=True)
