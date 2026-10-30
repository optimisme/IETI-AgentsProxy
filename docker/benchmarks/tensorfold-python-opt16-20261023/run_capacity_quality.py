#!/usr/bin/env python3
"""Unchanged three timed near75k cases, then a separate long-prefix fork/ID check."""
import argparse,array,hashlib,json,re,sys
from pathlib import Path
import run_suite as bench

def main():
    p=argparse.ArgumentParser();p.add_argument('--base',default='http://127.0.0.1:8009');p.add_argument('--out',required=True);p.add_argument('--suite',default='capacity');a=p.parse_args()
    out=Path(a.out);out.mkdir(parents=True,exist_ok=True)
    (out/'quality-wrapper.json').write_text(json.dumps({'sha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),'note':'Calls unchanged run_suite.main for all three timed stages; only adds functional checks afterward.'},indent=2)+'\n')
    bench.main()
    fixture=bench.ROOT.parent/'tensorfold-zig-cache-tuning-20261018/fixtures.json';data=json.loads(fixture.read_text());model=bench.base.api(a.base,'/v1/models')['data'][0]['id'];payloads=[];bounds=[]
    for i in range(16):
        history=[{'role':'user','content':f'tuned16-full independent agent {i}.\n'+data['74000']},
                 {'role':'assistant','content':'Ready.'},
                 {'role':'user','content':'In the FIRST LINE of the first user message, what integer follows the exact words "independent agent"? Ignore the benchmark prefix "tuned16-full". Return only that integer.'}]
        payload=bench.base.body(model,history,32);payload['ignore_eos']=False
        tokens=bench.base.api(a.base,'/tokenize',payload);assert tokens['count']+32<=75000
        ids=array.array('i',tokens['tokens'])
        if sys.byteorder!='little':ids.byteswap()
        bench.TOKEN_HASHES[bench.digest(payload)]=hashlib.sha256(ids.tobytes()).hexdigest()
        bounds.append({'user':i,'input_tokens':tokens['count'],'max_tokens':32});payloads.append(payload)
    (out/'agent-recall16-token-bounds.json').write_text(json.dumps(bounds,indent=2)+'\n')
    results=bench.base.cohort(a.base,'agent-recall16',payloads,out);checks=[]
    for i,r in enumerate(results):
        numbers=re.findall(r'\b\d+\b',r['content'])
        checks.append({'user':i,'expected':i,'passed':r['error'] is None and len(numbers)==1 and int(numbers[0])==i,'content':r['content'],'usage':r['usage']})
    path=out/'agent-recall16.json';raw=json.loads(path.read_text());raw['validation_kind']='functional_agent_recall';raw['checks']=checks;path.write_text(json.dumps(raw,indent=2)+'\n')
    (out/'agent-recall16-checks.json').write_text(json.dumps({'passed':sum(c['passed'] for c in checks),'requests':16,'checks':checks,'note':'Explicit agent-ID question and a fork from the original long input. Identical across configurations; separate from all timed-stage percentages.'},indent=2)+'\n')
    print(json.dumps({'functional_agent_recall':sum(c['passed'] for c in checks),'total':16}),flush=True)
    (out/'completed').write_text('Three timed near75k stages complete; separate ID/fork check executed.\n')

if __name__=='__main__':main()
