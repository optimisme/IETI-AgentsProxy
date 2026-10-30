#!/usr/bin/env python3
"""Read-only pre-benchmark check of the user's disabled persistent-memory policy."""
import argparse,json,subprocess,urllib.request,urllib.error
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--base',default='http://127.0.0.1:8007');p.add_argument('--out',required=True);a=p.parse_args()
container='qwen38_flash_next_tensorfold_110_cuda'
probe="""import json,pathlib
found=[]
for d in pathlib.Path('/proc').iterdir():
 if not d.name.isdigit():continue
 try:v=d.joinpath('cmdline').read_bytes().rstrip(b'\\0').split(b'\\0')
 except (OSError,PermissionError):continue
 if v and v[0].endswith(b'/tensorfold-native'):found.append([s.decode() for s in v])
print(json.dumps(found))
"""
processes=json.loads(subprocess.check_output(['docker','exec',container,'python3','-c',probe],text=True))
assert len(processes)==1,processes
argv=processes[0]
for flag in argv[1:]:
 assert not flag.startswith(('--learn','--recall','--slide','--compact-memory','--record')),('Persistent-memory flag enabled',flag)
mounts=json.loads(subprocess.check_output(['docker','inspect',container,'--format','{{json .Mounts}}'],text=True))
assert any(m['Destination']=='/root/.cache/huggingface' and not m['RW'] for m in mounts),'Checkpoint must be read-only'
checks={}
for route,data,expected in [('/v1/recall',None,'Recall is off'),('/v1/imprint/resume',{'messages':[]},'saved conversations are off')]:
 req=urllib.request.Request(a.base+route,data=None if data is None else json.dumps(data).encode(),headers={'Content-Type':'application/json'})
 try:
  with urllib.request.urlopen(req,timeout=10) as r:status=r.status;message=r.read().decode()
 except urllib.error.HTTPError as e:status=e.code;message=e.read().decode()
 assert status==404 and expected in message,(route,status,message)
 checks[route]={'status':status,'response':json.loads(message)}
result={'passed':True,'persistent_learning_flags_present':False,'checkpoint_read_only':True,'endpoints':checks,'note':'KV and explicitly budgeted RAM prefix caches are separate from persistent memory.'}
Path(a.out).write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps(result),flush=True)
