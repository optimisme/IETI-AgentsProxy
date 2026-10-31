#!/usr/bin/env python3
"""Cold serial diagnostic of three exact long-context payloads that previously missed."""
import argparse,array,hashlib,json,re,sys
from pathlib import Path
import run_suite as bench
ROOT=Path(__file__).resolve().parent

def main():
    p=argparse.ArgumentParser();p.add_argument('--base',default='http://127.0.0.1:8009');p.add_argument('--out',required=True);p.add_argument('--suite',default='representative');a=p.parse_args();out=Path(a.out)
    source=ROOT/'project-known-misses-payloads.json';data=json.loads(source.read_text());model=bench.base.api(a.base,'/v1/models')['data'][0]['id'];checks=[]
    (out/'project-known-misses-meta.json').write_text(json.dumps({'payload_source_sha256':hashlib.sha256(source.read_bytes()).hexdigest(),'source_run':data['source_run'],'condition':'Cold long prefix, serial one request at a time after representative cases; diagnostic baseline ability, not original16-way cache/accuracy equivalence.'},indent=2)+'\n')
    for case in data['cases']:
        i=case['user'];payload=case['payload'];payload['model']=model;assert bench.digest(payload)==case['request_sha256']
        tokenized=bench.base.api(a.base,'/tokenize',payload);assert tokenized['count']+32<=75000
        values=array.array('i',tokenized['tokens'])
        if sys.byteorder!='little':values.byteswap()
        token_hash=hashlib.sha256(values.tobytes()).hexdigest();assert token_hash==case['token_sha256'];bench.TOKEN_HASHES[bench.digest(payload)]=token_hash
        name=f'project-cold-known-miss{i}';result=bench.base.cohort(a.base,name,[payload],out)[0]
        assert result['usage'].get('prompt_tokens_details',{}).get('cached_tokens',0)<=256,'Diagnostic unexpectedly reused a long prefix'
        numbers=re.findall(r'\b\d+\b',result['content']);check={'user':i,'expected_project':i,'content':result['content'],'passed':result['error'] is None and len(numbers)==1 and int(numbers[0])==i,'usage':result['usage']};checks.append(check)
        path=out/(name+'.json');report=json.loads(path.read_text());report['validation_kind']='diagnostic_project_cold_serial';report['checks']=[check];path.write_text(json.dumps(report,indent=2)+'\n')
    (out/'project-known-misses-checks.json').write_text(json.dumps({'passed':sum(v['passed'] for v in checks),'requests':len(checks),'checks':checks,'note':'Same exact prompt/token hashes as original known misses, different cold/serial condition. Do not infer full16-way quality parity from this diagnostic.'},indent=2)+'\n')
    print(json.dumps({'project_known_misses_cold_serial_passed':sum(v['passed'] for v in checks),'requests':3}),flush=True)

if __name__=='__main__':main()
