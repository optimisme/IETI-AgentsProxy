#!/usr/bin/env python3
"""Four matched timed rounds, then a separately labeled per-user recall probe."""
import argparse,array,hashlib,json,re,sys
from pathlib import Path
import run_sustained as workload
import run_suite as bench


def main():
    p=argparse.ArgumentParser();p.add_argument('--base',default='http://127.0.0.1:8009');p.add_argument('--out',required=True);p.add_argument('--suite',default='sustained');a=p.parse_args()
    out=Path(a.out);out.mkdir(parents=True,exist_ok=True)
    (out/'wrapper.json').write_text(json.dumps({'script':'run_sustained_quality.py','sha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest()},indent=2)+'\n')
    workload.main()
    fixture=json.loads((out/'prepared-inputs.json').read_text());histories=workload.messages(fixture,3)
    previous=json.loads((out/'sustained-return3-16.json').read_text())['requests']
    model=bench.base.api(a.base,'/v1/models')['data'][0]['id'];payloads=[];bounds=[]
    for i,(history,r) in enumerate(zip(histories,previous)):
        history.extend([{'role':'assistant','content':r['content']},{'role':'user','content':'Return only the project number named in the first line of the first user message.'}])
        payload=bench.base.body(model,history,32);payload['ignore_eos']=False
        tokenized=bench.base.api(a.base,'/tokenize',payload)
        assert tokenized['count']+32<=75000,(i,tokenized['count'])
        values=array.array('i',tokenized['tokens'])
        if sys.byteorder!='little':values.byteswap()
        bench.TOKEN_HASHES[bench.digest(payload)]=hashlib.sha256(values.tobytes()).hexdigest()
        bounds.append({'user':i,'input_tokens':tokenized['count'],'max_tokens':32})
        payloads.append(payload)
    (out/'project-recall16-token-bounds.json').write_text(json.dumps(bounds,indent=2)+'\n')
    results=bench.base.cohort(a.base,'project-recall16',payloads,out)
    checks=[]
    for i,r in enumerate(results):
        numbers=re.findall(r'\b\d+\b',r['content'])
        checks.append({'user':i,'expected_project':i,'content':r['content'],'passed':r['error'] is None and len(numbers)==1 and int(numbers[0])==i,'usage':r['usage']})
    path=out/'project-recall16.json';raw=json.loads(path.read_text());raw['validation_kind']='functional_recall';raw['checks']=checks;path.write_text(json.dumps(raw,indent=2)+'\n')
    (out/'project-recall16-checks.json').write_text(json.dumps({'passed':sum(c['passed'] for c in checks),'requests':16,'checks':checks,'note':'A separate functional probe using each run actual fourth answer; not part of matched performance percentages. Compare baseline model ability before attributing misses to the policy.'},indent=2)+'\n')
    print(json.dumps({'functional_project_recall':sum(c['passed'] for c in checks),'total':16}),flush=True)
    (out/'completed').write_text('Four timed rounds complete; separate recall probe executed.\n')

if __name__=='__main__':main()
