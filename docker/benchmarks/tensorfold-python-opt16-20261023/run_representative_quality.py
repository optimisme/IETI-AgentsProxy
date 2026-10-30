#!/usr/bin/env python3
"""Representative timed cases, native tool/image smoke and default-reasoning checks."""
import argparse,hashlib,json,re
from pathlib import Path
import run_suite as bench

def main():
    p=argparse.ArgumentParser();p.add_argument('--base',default='http://127.0.0.1:8009');p.add_argument('--out',required=True);p.add_argument('--suite',default='representative');a=p.parse_args()
    out=Path(a.out);out.mkdir(parents=True,exist_ok=True)
    (out/'wrapper.json').write_text(json.dumps({'script':'run_representative_quality.py','sha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest()},indent=2)+'\n')
    bench.main()
    model=bench.base.api(a.base,'/v1/models')['data'][0]['id'];payloads=[]
    for i in range(16):
        payload=bench.base.body(model,[{'role':'user','content':f'Independent arithmetic check {i}. Compute {i} + 17. Return only the resulting integer.'}],1200)
        payload.pop('chat_template_kwargs');payload['ignore_eos']=False
        payloads.append(payload)
    results=bench.base.cohort(a.base,'default-reasoning16',payloads,out);checks=[]
    for i,r in enumerate(results):
        numbers=re.findall(r'\b\d+\b',r['content'])
        checks.append({'user':i,'expected':i+17,'passed':r['error'] is None and len(numbers)==1 and int(numbers[0])==i+17,'content':r['content'],'reasoning_bytes':len(r['reasoning'].encode()),'usage':r['usage']})
    path=out/'default-reasoning16.json';raw=json.loads(path.read_text());raw['validation_kind']='functional_default_reasoning';raw['checks']=checks;path.write_text(json.dumps(raw,indent=2)+'\n')
    summary=raw['summary'];assert summary['external_requests']==summary['initial_running']==summary['final_running']==summary['oom_kills']==0,summary
    (out/'default-reasoning16-checks.json').write_text(json.dumps({'passed':sum(c['passed'] for c in checks),'requests':16,'checks':checks,'note':'No request override of server thinking/effort/budget; separate functional checks, outside matched timing percentages.'},indent=2)+'\n')
    assert all(c['passed'] for c in checks),checks
    print(json.dumps({'default_reasoning_passed':16,'requests_with_reasoning':sum(c['reasoning_bytes']>0 for c in checks)}),flush=True)
    (out/'completed').write_text('Representative performance, tool/image and default reasoning checks complete.\n')

if __name__=='__main__':main()
