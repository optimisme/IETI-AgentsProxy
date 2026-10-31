#!/usr/bin/env python3
"""Retry short comparisons only when traffic contaminated the first campaign."""
import argparse,json,sys,time
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parent.parent/'tensorfold-zig-cache-tuning-20261018'))
from benchmark import api,body,cohort
p=argparse.ArgumentParser();p.add_argument('mode',choices=['baseline','candidate']);p.add_argument('--base',required=True);p.add_argument('--out',required=True);p.add_argument('--selection',required=True);a=p.parse_args()
out=Path(a.out);out.mkdir(parents=True,exist_ok=True);sel=Path(a.selection);model=api(a.base,'/v1/models')['data'][0]['id']
def payloads(trial,n):return [body(model,[{'role':'user','content':f'Trial {trial}, code, cohort {n}, user {i}.\nWrite a Python LRU cache with type hints, docstrings and extensive unit tests.'}]) for i in range(n)]
def clean(r):
 s=r['summary']
 return s['successes']==s['full_output_requests']==s['requests'] and all(s.get(k)==0 for k in ['cached_tokens','swap_out_pages','oom_kills','external_requests']) and r['before'].get('requests_running',0)==0 and r['after'].get('requests_running',0)==0
if a.mode=='candidate':
 selection=json.loads(sel.read_text())
 for case in selection['cases']:
  r=cohort(a.base,case['name'],payloads(case['trial'],case['count']),out)
  case['candidate_clean']=clean(r)
 (out/'selection.json').write_text(json.dumps(selection,indent=2)+'\n')
else:
 selection={'reason':'Original short reference cohorts overlapped student traffic; fresh trial IDs prevent exact-prefix reuse.','cases':[]};counts={1:0,11:0};deadline=time.monotonic()+600
 for trial in range(3,15):
  if time.monotonic()>deadline:break
  for n in (11,1):
   if counts[n]>=3:continue
   idle=False
   while time.monotonic()<deadline:
    if api(a.base,'/health').get('requests_running',0)==0:idle=True;break
    time.sleep(2)
   if not idle:break
   name=f'code{n}-trial{trial}';r=cohort(a.base,name,payloads(trial,n),out)
   if clean(r):counts[n]+=1;selection['cases'].append({'name':name,'trial':trial,'count':n})
   selection['clean_counts']=counts;sel.write_text(json.dumps(selection,indent=2)+'\n')
  if all(v>=3 for v in counts.values()):break
 selection['complete']=True;sel.write_text(json.dumps(selection,indent=2)+'\n')
(out/'complete').write_text('Matched requests completed; inspect traffic and memory exclusions.\n')
