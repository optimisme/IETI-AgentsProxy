#!/usr/bin/env python3
"""Four matched rounds: distinct ~71k histories, full-length frozen assistant replies."""
import argparse,copy,hashlib,json,random,time
from pathlib import Path
import run_suite as bench
ROOT=Path(__file__).resolve().parent


def messages(fixture,turn):
    histories=copy.deepcopy(fixture['initial_histories'])
    for t in range(turn):
        for i,h in enumerate(histories):h.extend([{'role':'assistant','content':fixture['reference_replies'][t][i]},
            {'role':'user','content':f'Turn {t+1}: describe the next regression test and explain why it matters.'}])
    return histories


def prepare(url,model):
    replies=json.loads((ROOT/'sustained-responses.json').read_text())
    histories=[]
    for i in range(16):
        rng=random.Random(180026+961748941*i)
        rows=[f'entry {j}: item_{rng.randrange(1000000)} uses version {rng.randrange(100)}; tests pass.\n' for j in range(5000)]
        def history(n):
            return [{'role':'user','content':f'sustained16 independent project {i}. Read this fictional project log.\n'+''.join(rows[:n])+'\nSummarize its engineering risks in detail.'}]
        lo,hi,best=0,len(rows),None
        while lo<=hi:
            middle=(lo+hi)//2;h=history(middle)
            count=bench.base.api(url,'/tokenize',bench.base.body(model,h,896))['count']
            if count<=71000:lo=middle+1;best=h
            else:hi=middle-1
        assert best is not None
        histories.append(best)
    return {'version':1,'seed':180026,'target_initial_input_tokens':71000,
        'initial_histories':histories,'reference_replies':replies['replies'],
        'reference_response_source_sha256':replies['source_sha256'],
        'note':'Distinct synthetic logs. Fixed full-length assistant replies were recorded from the unchanged original Python benchmark; they are replayed, not the current run answers.'}


def main():
    p=argparse.ArgumentParser();p.add_argument('--base',default='http://127.0.0.1:8009');p.add_argument('--out',required=True);p.add_argument('--suite',default='sustained');a=p.parse_args()
    out=Path(a.out);out.mkdir(parents=True,exist_ok=True);assert not (out/'started.json').exists()
    h=bench.base.health(a.base);assert h['ok'] and h['requests_running']==0 and h['streams']['max']==16 and h['context_length']==75000
    model=bench.base.api(a.base,'/v1/models')['data'][0]['id']
    frozen=ROOT/'sustained-fixtures.json'
    fixture=json.loads(frozen.read_text()) if frozen.exists() else prepare(a.base,model)
    prepared=json.dumps(fixture,sort_keys=True)
    (out/'prepared-inputs.json').write_text(prepared+'\n')
    counts=[]
    for turn in range(4):
        current=[bench.base.api(a.base,'/tokenize',bench.base.body(model,h,896))['count'] for h in messages(fixture,turn)]
        assert max(current)+896<=75000,(turn,current)
        counts.append(current)
    (out/'started.json').write_text(json.dumps({'epoch':time.time(),'suite':'sustained','fixture_sha256':hashlib.sha256((prepared+'\n').encode()).hexdigest(),'input_token_counts':counts,'max_tokens':896,'health':h,'script_sha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest()},indent=2)+'\n')
    for turn in range(4):
        name='sustained-cold16' if not turn else f'sustained-return{turn}-16'
        replies=bench.cohort(a.base,name,[bench.base.body(model,h,896) for h in messages(fixture,turn)],out)
        if not turn:assert sum(r['usage'].get('prompt_tokens_details',{}).get('cached_tokens',0) for r in replies)==0,'Cold prefix cache contaminated'
    (out/'completed').write_text('complete\n')

if __name__=='__main__':main()
