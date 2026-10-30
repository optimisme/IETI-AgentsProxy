#!/usr/bin/env python3
"""Frozen matched payloads plus per-user SSE cadence and tokenizer identity."""
import argparse,array,concurrent.futures,hashlib,json,sys,threading,time,urllib.request,urllib.error
from pathlib import Path
import base_probe as base
ROOT=Path(__file__).resolve().parent
TOKEN_HASHES={}
DELAYS={}


def digest(payload):
    return hashlib.sha256(json.dumps({k:v for k,v in payload.items() if k!='model'},sort_keys=True).encode()).hexdigest()


def request(url,payload,barrier=None):
    key=digest(payload)
    if barrier:barrier.wait()
    time.sleep(DELAYS.get(key,0))
    started=time.monotonic();r={'request_sha256':key,'token_sha256':TOKEN_HASHES.get(key),
        'started_monotonic':started,'started_epoch':time.time(),'ttft_s':None,'content_ttft_s':None,
        'usage':{},'engine':{},'error':None}
    content=[];thoughts=[];tools=[];chunks=[]
    try:
        req=urllib.request.Request(url+'/v1/chat/completions',data=json.dumps(payload).encode(),headers={'Content-Type':'application/json'})
        with urllib.request.urlopen(req,timeout=1800) as response:
            r['http_status']=response.status
            for raw in response:
                if not raw.startswith(b'data:'):continue
                text=raw[5:].strip()
                if text==b'[DONE]':r['done']=True;break
                event=json.loads(text)
                if event.get('error'):raise RuntimeError(str(event['error']))
                if event.get('usage'):r['usage']=event['usage']
                for k in ('tensorfold','stats'):
                    if event.get(k):r['engine'].update(event[k])
                for choice in event.get('choices',[]):
                    d=choice.get('delta',{});thought=d.get('reasoning') or d.get('reasoning_content') or ''
                    if d.get('content') or thought or d.get('tool_calls'):
                        now=time.monotonic()-started
                        if r['ttft_s'] is None:r['ttft_s']=now
                        chunks.append({'at_s':now,'content_bytes':len(d.get('content','').encode()),'reasoning_bytes':len(thought.encode())})
                    if d.get('content'):
                        if r['content_ttft_s'] is None:r['content_ttft_s']=time.monotonic()-started
                        content.append(d['content'])
                    thoughts.append(thought);tools.extend(d.get('tool_calls',[]))
                    if choice.get('finish_reason'):r['finish_reason']=choice['finish_reason']
        if not r.get('done') or not r['usage'].get('completion_tokens'):raise RuntimeError('Incomplete SSE or missing usage')
    except urllib.error.HTTPError as error:
        r['http_status']=error.code;r['error']=error.read().decode(errors='replace')[:2000]
    except Exception as error:r['error']=repr(error)
    gaps=[b['at_s']-a['at_s'] for a,b in zip(chunks,chunks[1:])]
    elapsed=time.monotonic()-started
    count=r['usage'].get('completion_tokens',0)
    r.update(elapsed_s=elapsed,content=''.join(content),reasoning=''.join(thoughts),tool_calls=tools,
        sse_chunks=chunks,sse_gap_p95_s=base.percentile(gaps,.95),sse_gap_max_s=max(gaps,default=None),
        mean_time_per_output_token_after_first_s=(chunks[-1]['at_s']-r['ttft_s'])/(count-1) if chunks and count>1 else None)
    return r

base.request=request
base.shared.request=request


def cohort(url,name,payloads,out):
    bounds=[]
    for p in payloads:
        x=base.api(url,'/tokenize',p)
        assert x['count']+p['max_tokens']<=75000,(name,x['count'],p['max_tokens'])
        values=array.array('i',x['tokens'])
        if sys.byteorder!='little':values.byteswap()
        TOKEN_HASHES[digest(p)]=hashlib.sha256(values.tobytes()).hexdigest()
        bounds.append({'request_sha256':digest(p),'token_sha256':TOKEN_HASHES[digest(p)],'input_tokens':x['count'],'max_tokens':p['max_tokens']})
    (out/(name+'-token-bounds.json')).write_text(json.dumps(bounds,indent=2)+'\n')
    results=base.cohort(url,name,payloads,out)
    path=out/(name+'.json');report=json.loads(path.read_text());s=report['summary']
    s['dispatch_skew_s']=max(r['started_monotonic'] for r in results)-min(r['started_monotonic'] for r in results)
    s['sse_gap_p95_per_user_median_s']=base.percentile([r['sse_gap_p95_s'] for r in results],.5)
    s['worst_sse_gap_s']=max((r['sse_gap_max_s'] or 0 for r in results),default=0)
    report['harness_sha256']=hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    path.write_text(json.dumps(report,indent=2)+'\n')
    assert s['successes']==s['full_output_requests']==len(payloads),s
    # A small nonzero host swap counter invalidates a clean timing comparison,
    # but must not discard subsequent independent diagnostic stages. The
    # monitor/supervisor still aborts memory pressure and >1 GiB new swap-out.
    assert s['external_requests']==s['initial_running']==s['final_running']==s['oom_kills']==0,s
    return results


def main():
    p=argparse.ArgumentParser();p.add_argument('--base',default='http://127.0.0.1:8009');p.add_argument('--out',required=True)
    p.add_argument('--suite',choices=['capacity','representative'],default='capacity');a=p.parse_args()
    out=Path(a.out);out.mkdir(parents=True,exist_ok=True)
    assert not (out/'started.json').exists(),'Preserve previous run'
    h=base.health(a.base);assert h['ok'] and h['requests_running']==0 and h['streams']['max']==16 and h['context_length']==75000,h
    model=base.api(a.base,'/v1/models')['data'][0]['id']
    fixture=ROOT.parent/'tensorfold-zig-cache-tuning-20261018/fixtures.json';data=json.loads(fixture.read_text())
    (out/'started.json').write_text(json.dumps({'epoch':time.time(),'suite':a.suite,'health':h,'fixture_sha256':hashlib.sha256(fixture.read_bytes()).hexdigest()},indent=2)+'\n')
    if a.suite=='capacity':
        histories=[[{'role':'user','content':f'tuned16-full independent agent {i}.\n'+data['74000']}] for i in range(16)]
        for turn in range(3):
            if turn:
                for history in histories:history.extend([{'role':'assistant','content':'I will preserve the public interface and add regression coverage.'},{'role':'user','content':f'Turn {turn}: describe the next regression test and explain why it matters.'}])
            name='capacity-cold16' if not turn else f'capacity-return{turn}-16'
            results=cohort(a.base,name,[base.body(model,h,896) for h in histories],out)
            if not turn:assert sum(r['usage'].get('prompt_tokens_details',{}).get('cached_tokens',0) for r in results)==0,'Cold prefix state contaminated'
    else:
        for trial in range(3):
            cohort(a.base,f'short16-{trial}',[base.body(model,[{'role':'user','content':f'opt16 short user {i}, trial {trial}. Write a Python LRU cache with type hints and tests.'}],256) for i in range(16)],out)
        # Different deterministic row orders make sixteen distinct histories. Actual replies are appended.
        import random
        histories=[]
        for i in range(16):
            rows=data['1800' if i<8 else '7400' if i<15 else '65000'].splitlines()
            random.Random(180026+i).shuffle(rows)
            histories.append([{'role':'user','content':f'opt16 project {i}, analyze engineering risks.\n'+'\n'.join(rows)}])
        for turn in range(3):
            results=cohort(a.base,f'conversation16-{turn}',[base.body(model,h,128) for h in histories],out)
            for history,r in zip(histories,results):history.extend([{'role':'assistant','content':r['content']},{'role':'user','content':f'Turn {turn+1}: propose the next implementation step and its regression test.'}])
        # Four 16k prefills start first; twelve short users arrive two seconds later.
        payloads=[base.body(model,[{'role':'user','content':f'opt16 fairness user {i}.\n'+(data['16000'] if i<4 else 'Write a concise Python function and its tests.')}],256) for i in range(16)]
        DELAYS.update({digest(p):2 for p in payloads[4:]})
        cohort(a.base,'fairness16',payloads,out)
        base.smoke(a.base,model,out)
        smoke=json.loads((out/'smoke.json').read_text());assert smoke['tool']['passed'] and smoke['vision']['passed'],smoke
    (out/'completed').write_text('complete\n')

if __name__=='__main__':main()
