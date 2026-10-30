#!/usr/bin/env python3
"""Fixed GPU API comparison; imports the frozen campaign workload and monitor."""
import argparse,base64,concurrent.futures,hashlib,json,struct,subprocess,sys,time,zlib
from pathlib import Path
ROOT=Path(__file__).resolve().parent.parent
sys.path.insert(0,str(ROOT/'tensorfold-zig-cache-tuning-20261018'))
from benchmark import api,body,cohort,request,memory
p=argparse.ArgumentParser()
p.add_argument('mode',choices=['performance','compatibility','quality','capacity','verify'])
p.add_argument('--base',default='http://127.0.0.1:8007');p.add_argument('--out',required=True)
p.add_argument('--counts',default='1,11');p.add_argument('--capacity-count',type=int,default=11);p.add_argument('--trials',type=int,default=3);p.add_argument('--container');a=p.parse_args();out=Path(a.out);out.mkdir(parents=True,exist_ok=True)
fixtures=ROOT/'tensorfold-zig-cache-tuning-20261018/fixtures.json'
model=api(a.base,'/v1/models')['data'][0]['id']
def save(name,data): (out/(name+'.json')).write_text(json.dumps(data,indent=2)+'\n')
save('metadata-'+a.mode,{'utc':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'health':api(a.base,'/health'),'memory':memory(),'model':model,'fixtures_sha256':hashlib.sha256(fixtures.read_bytes()).hexdigest(),'script_sha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest()})
if a.mode=='verify':
 assert a.container
 code="""import hashlib,json,pathlib
f=[]
for d in pathlib.Path('/proc').iterdir():
 if not d.name.isdigit():continue
 try:v=d.joinpath('cmdline').read_bytes().rstrip(b'\\0').split(b'\\0')
 except (OSError,PermissionError):continue
 if v and v[0].endswith(b'/tensorfold-native'):f.append({'argv':[x.decode() for x in v],'sha256':hashlib.sha256(d.joinpath('exe').read_bytes()).hexdigest()})
print(json.dumps(f))
"""
 proc=json.loads(subprocess.check_output(['docker','exec',a.container,'python3','-c',code],text=True));assert len(proc)==1,proc
 assert not any(x.startswith(('--slide','--learn','--recall','--compact-memory','--record')) for x in proc[0]['argv'][1:]),proc
 mounts=json.loads(subprocess.check_output(['docker','inspect',a.container,'--format','{{json .Mounts}}'],text=True))
 assert any(m['Destination']=='/root/.cache/huggingface' and not m['RW'] for m in mounts)
 import urllib.request,urllib.error
 checks={}
 for route,data in [('/v1/recall',None),('/v1/imprint/resume',{'messages':[]})]:
  req=urllib.request.Request(a.base+route,data=None if data is None else json.dumps(data).encode(),headers={'Content-Type':'application/json'})
  try:
   with urllib.request.urlopen(req,timeout=10) as r: status=r.status;msg=r.read().decode()
  except urllib.error.HTTPError as e: status=e.code;msg=e.read().decode()
  assert status==404,(status,msg);checks[route]={'status':status,'body':msg}
 save('runtime-provenance',proc[0]);save('memory-off',{'passed':True,'endpoints':checks,'checkpoint_read_only':True})
elif a.mode=='performance':
 f=json.loads(fixtures.read_text())
 for trial in range(a.trials):
  for n in map(int,a.counts.split(',')):
   prompts=[body(model,[{'role':'user','content':f'Trial {trial}, code, cohort {n}, user {i}.\nWrite a Python LRU cache with type hints, docstrings and extensive unit tests.'}]) for i in range(n)]
   cohort(a.base,f'code{n}-trial{trial}',prompts,out)
 for size in ('16000','65000'):
  cohort(a.base,'cold-'+size,[body(model,[{'role':'user','content':'Cold isolated workload '+size+'\n'+f[size]}],128)],out)
elif a.mode=='quality':
 subprocess.run([sys.executable,str(ROOT/'tensorfold-zig-release110-20261018/quality_probe.py'),'--base',a.base,'--out',str(out)],check=True)
elif a.mode=='capacity':
 f=json.loads(fixtures.read_text())
 payloads=[body(model,[{'role':'user','content':f'Independent full-window request {i}.\n'+f['74000']}],256) for i in range(a.capacity_count)]
 cohort(a.base,f'capacity{a.capacity_count}-near75k',payloads,out)
else:
 results={}
 tool={'type':'function','function':{'name':'record_number','description':'Record an integer','parameters':{'type':'object','properties':{'value':{'type':'integer'}},'required':['value']}}}
 for label,choice in [('auto','auto'),('required','required'),('named',{'type':'function','function':{'name':'record_number'}})]:
  b=body(model,[{'role':'user','content':'Call record_number with value 42.'}],128);b.update(ignore_eos=False,tools=[tool],tool_choice=choice)
  r=request(a.base,b);calls={}
  for delta in r.get('tool_calls',[]):
   c=calls.setdefault(delta.get('index',0),{'name':'','arguments':''});fn=delta.get('function',{});c['name']+=fn.get('name','');c['arguments']+=fn.get('arguments','')
  try:r['passed']=r['error'] is None and any(c['name']=='record_number' and json.loads(c['arguments'])=={'value':42} for c in calls.values())
  except ValueError:r['passed']=False
  results['tool-'+label]=r
 b=body(model,[{'role':'user','content':'Return a JSON object with the integer value 42.'}],64)
 b.update(ignore_eos=False,response_format={'type':'json_schema','json_schema':{'name':'record','strict':True,'schema':{'type':'object','properties':{'value':{'type':'integer'}},'required':['value'],'additionalProperties':False}}})
 r=request(a.base,b)
 try:r['passed']=r['error'] is None and json.loads(r['content'])=={'value':42}
 except ValueError:r['passed']=False
 results['json-schema']=r
 def chunk(k,d):return struct.pack('>I',len(d))+k+d+struct.pack('>I',zlib.crc32(k+d)&0xffffffff)
 for color,rgb in [('red',b'\xff\0\0'),('green',b'\0\xff\0'),('blue',b'\0\0\xff')]:
  png=b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',64,64,8,2,0,0,0))+chunk(b'IDAT',zlib.compress((b'\0'+rgb*64)*64))+chunk(b'IEND',b'')
  b=body(model,[{'role':'user','content':[{'type':'text','text':'What is the dominant color? Answer one word.'},{'type':'image_url','image_url':{'url':'data:image/png;base64,'+base64.b64encode(png).decode()}}]}],64);b['ignore_eos']=False
  r=request(a.base,b);r['passed']=r['error'] is None and color in r['content'].lower();results['image-'+color]=r
 save('compatibility',results);print(json.dumps({k:v['passed'] for k,v in results.items()}),flush=True)
save('completed-'+a.mode,{'complete':True})
