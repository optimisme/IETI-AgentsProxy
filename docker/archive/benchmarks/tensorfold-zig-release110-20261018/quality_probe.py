#!/usr/bin/env python3
"""Controlled retrieval across sixteen long histories; GPU model QA, no external tools."""
import argparse,json,sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parent.parent/'tensorfold-zig-cache-tuning-20261018'))
from benchmark import api,body,cohort
p=argparse.ArgumentParser();p.add_argument('--base',default='http://127.0.0.1:8007');p.add_argument('--out',required=True);a=p.parse_args()
out=Path(a.out);out.mkdir(exist_ok=True);model=api(a.base,'/v1/models')['data'][0]['id']
f=json.loads((Path(__file__).resolve().parent.parent/'tensorfold-zig-cache-tuning-20261018/fixtures.json').read_text())
payloads=[];expected=[]
for i,size in enumerate(['1800']*8+['7400']*4+['16000']*2+['65000']*2):
 code=f'SPARK_ROUTE_{i:02d}_X7';course=f'CLASS_{i:02d}';text=f[size];where=len(text)*(1+i%3)//4
 text=f'Independent course lookup {i}.\n'+text[:where]+f'\nThe active ROUTE_CODE for {course} is {code}.\n'+text[where:]
 prompt=text+f'\nQuestion: What is the active ROUTE_CODE for {course}?'
 b=body(model,[{'role':'system','content':'Use the supplied log to answer. Reply with only the exact ROUTE_CODE value, no explanation.'},{'role':'user','content':prompt}],64)
 b['ignore_eos']=False;payloads.append(b);expected.append(code)
r=cohort(a.base,'quality16-retrieval',payloads,out)
cases=[]
for i,(v,want) in enumerate(zip(r['requests'],expected)):
 answer=v['content'].strip('`\n\r \"\'.,')
 cases.append({'index':i,'expected':want,'answer':answer,'passed':v['error'] is None and answer==want and not v['reasoning'],'request_sha256':v['request_sha256'],'input_tokens':v['usage'].get('prompt_tokens')})
result={'cases':cases,'requests':len(cases),'passed':sum(v['passed'] for v in cases),'scope':'Fixed long-context retrieval; not a general model-quality benchmark'}
(out/'quality-result.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result),flush=True)
