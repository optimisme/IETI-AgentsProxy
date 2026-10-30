#!/usr/bin/env python3
"""GPU qualification across the earlier 65536-row KV boundary, then a real return."""
import argparse,hashlib,json,time
from pathlib import Path
import run_suite as bench
ROOT=Path(__file__).resolve().parent

def main():
    p=argparse.ArgumentParser();p.add_argument('--base',default='http://127.0.0.1:8009');p.add_argument('--out',required=True);p.add_argument('--suite',default='growth65k');a=p.parse_args()
    out=Path(a.out);out.mkdir(parents=True,exist_ok=True);assert not (out/'started.json').exists()
    health=bench.base.health(a.base);assert health['ok'] and health['requests_running']==0 and health['streams']['max']==16 and health['context_length']==75000
    source=ROOT.parent/'tensorfold-zig-cache-tuning-20261018/fixtures.json';fixture=json.loads(source.read_text());model=bench.base.api(a.base,'/v1/models')['data'][0]['id']
    histories=[[{'role':'user','content':f'growth65k independent project {i}.\n'+fixture['65000']}] for i in range(16)]
    first=[bench.base.api(a.base,'/tokenize',bench.base.body(model,h,896))['count'] for h in histories]
    assert all(n<65536<n+896<=75000 for n in first),first
    (out/'started.json').write_text(json.dumps({'epoch':time.time(),'suite':'growth65k','fixture_sha256':hashlib.sha256(source.read_bytes()).hexdigest(),'script_sha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),'input_token_counts':first,'note':'All initial requests cross65536 during their896-token reply. The next wave appends actual answers; qualify memory growth and retention, not a matched primary timing percentage.','health':health},indent=2)+'\n')
    (out/'prepared-inputs.json').write_text(json.dumps(histories,sort_keys=True)+'\n')
    for turn in range(2):
        name='growth65k-cold16' if not turn else 'growth65k-return1-16'
        results=bench.cohort(a.base,name,[bench.base.body(model,h,896) for h in histories],out)
        for h,r in zip(histories,results):h.extend([{'role':'assistant','content':r['content']},{'role':'user','content':'Describe the next regression test and explain why it matters.'}])
    (out/'completed').write_text('Two16-user growth/actual-answer return waves completed.\n')

if __name__=='__main__':main()
