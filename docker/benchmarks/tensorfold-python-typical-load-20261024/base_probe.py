#!/usr/bin/env python3
"""Matched cold/returning-agent API workloads, run on each GPU host's loopback."""
import argparse
import concurrent.futures
import hashlib
import json
from pathlib import Path
import re
import statistics
import sys
import threading
import time
import urllib.request
import urllib.error

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT/'tensorfold-zig-cache-tuning-20261018'))
from benchmark import body, memory, percentile, smoke


def request(base, payload, barrier=None):
    if barrier: barrier.wait()
    started=time.monotonic()
    r={'request_sha256':hashlib.sha256(json.dumps({k:v for k,v in payload.items() if k!='model'},sort_keys=True).encode()).hexdigest(),
       'ttft_s':None,'content_ttft_s':None,'usage':{},'engine':{},'error':None}
    content=[];reasoning=[];tools=[]
    try:
        req=urllib.request.Request(base+'/v1/chat/completions',data=json.dumps(payload).encode(),headers={'Content-Type':'application/json'})
        with urllib.request.urlopen(req,timeout=1500) as response:
            r['http_status']=response.status
            for raw in response:
                if not raw.startswith(b'data:'): continue
                text=raw[5:].strip()
                if text==b'[DONE]': r['done']=True;break
                event=json.loads(text)
                if event.get('error'): raise RuntimeError(str(event['error']))
                if event.get('usage'): r['usage']=event['usage']
                for k in ('tensorfold','stats'):
                    if event.get(k):r['engine'].update(event[k])
                for choice in event.get('choices',[]):
                    d=choice.get('delta',{})
                    thought=d.get('reasoning') or d.get('reasoning_content') or ''
                    if d.get('content') or thought or d.get('tool_calls'):
                        if r['ttft_s'] is None:r['ttft_s']=time.monotonic()-started
                    if d.get('content'):
                        if r['content_ttft_s'] is None:r['content_ttft_s']=time.monotonic()-started
                        content.append(d['content'])
                    reasoning.append(thought);tools.extend(d.get('tool_calls',[]))
                    if choice.get('finish_reason'):r['finish_reason']=choice['finish_reason']
        if not r.get('done') or not r['usage'].get('completion_tokens'):
            raise RuntimeError('Incomplete SSE or missing completion usage')
    except urllib.error.HTTPError as e:
        r['http_status']=e.code;r['error']=e.read().decode(errors='replace')[:2000]
    except Exception as e:r['error']=repr(e)
    r.update(elapsed_s=time.monotonic()-started,started_monotonic=started,
             content=''.join(content),reasoning=''.join(reasoning),tool_calls=tools)
    return r


# The shared tool/image fixture uses this module's parser, including 0.32's
# `reasoning` field as well as TensorFold's `reasoning_content` field.
import benchmark as shared
shared.request=request


def storage():
    # Whole NVMe devices only, to avoid counting their partitions twice.
    reads=writes=0
    for path in Path('/sys/block').glob('nvme*/stat'):
        fields=path.read_text().split()
        reads+=int(fields[2])*512;writes+=int(fields[6])*512
    return {'nvme_read_bytes':reads,'nvme_write_bytes':writes}


def api(base, route, value=None):
    data = None if value is None else json.dumps(value).encode()
    with urllib.request.urlopen(urllib.request.Request(base+route, data=data,
            headers={'Content-Type':'application/json'}), timeout=20) as r:
        raw = r.read()
    return json.loads(raw) if raw else {}


def health(base):
    result = api(base, '/health')
    if 'requests_total' in result:
        return result
    with urllib.request.urlopen(base+'/metrics', timeout=3) as r:
        raw = r.read().decode()
    metrics = {}
    for line in raw.splitlines():
        if line.startswith('#'): continue
        m = re.match(r'([^\s{]+)(?:\{[^}]*\})?\s+([^\s]+)', line)
        if m:
            try: metrics[m[1]] = metrics.get(m[1], 0) + float(m[2])
            except ValueError: pass
    result.update(requests_running=metrics.get('vllm:num_requests_running', 0),
        requests_waiting=metrics.get('vllm:num_requests_waiting', 0),
        requests_total=metrics.get('vllm:request_success_total', 0),
        preemptions=metrics.get('vllm:num_preemptions_total', 0),
        kv_cache_usage=metrics.get('vllm:kv_cache_usage_perc', 0),
        prefix_queries=metrics.get('vllm:prefix_cache_queries_total', 0),
        prefix_hits=metrics.get('vllm:prefix_cache_hits_total', 0))
    return result


def cohort(base, name, payloads, out):
    deadline = time.monotonic()+180
    while health(base).get('requests_running', 0) and time.monotonic()<deadline:
        time.sleep(3)
    before = health(base)
    samples, stop = [], threading.Event()
    initial = memory();initial_io=storage()
    def monitor():
        while not stop.is_set():
            sample = {'time':time.time(), **memory(), **storage()}
            try: sample['health'] = health(base)
            except Exception as e: sample['health_error'] = repr(e)
            samples.append(sample)
            if (sample['available_gib'] < 6 or sample['oom_kill'] > initial['oom_kill']
                    or sample['pswpout']-initial['pswpout'] > 262144):
                (out/(name+'-safety-abort.json')).write_text(json.dumps(sample,indent=2)+'\n')
                print('SAFETY_ABORT '+json.dumps(sample),flush=True)
                import os
                os._exit(3)
            stop.wait(1)
    thread=threading.Thread(target=monitor,daemon=True);thread.start()
    start=time.monotonic();barrier=threading.Barrier(len(payloads))
    with concurrent.futures.ThreadPoolExecutor(max_workers=len(payloads)) as pool:
        results=list(pool.map(lambda p:request(base,p,barrier),payloads))
    elapsed=time.monotonic()-start;stop.set();thread.join(timeout=5)
    after=health(base)
    # SSE completion can precede accounting/slot release by a few milliseconds.
    # Keep this settling time outside the measured cohort wall time.
    for _ in range(20):
        if not after.get('requests_running',0) and after['requests_total']>=before['requests_total']+len(payloads):break
        time.sleep(.1);after=health(base)
    outputs=sum(r['usage'].get('completion_tokens',0) for r in results)
    cached=sum(r['usage'].get('prompt_tokens_details',{}).get('cached_tokens',0) for r in results)
    events=[]
    for r in results:
        if r['ttft_s'] is not None and r['error'] is None:
            events.extend([(r['started_monotonic']+r['ttft_s'],1),
                           (r['started_monotonic']+r['elapsed_s'],-1)])
    overlapping=peak_overlap=0
    for _,change in sorted(events):
        overlapping+=change;peak_overlap=max(peak_overlap,overlapping)
    summary={'name':name,'requests':len(results),'successes':sum(r['error'] is None for r in results),
        'full_output_requests':sum(r['usage'].get('completion_tokens')==p['max_tokens'] for r,p in zip(results,payloads)),
        'wall_s':elapsed,'aggregate_output_tok_s':outputs/elapsed,'output_tokens':outputs,
        'ttft_p50_s':percentile([r['ttft_s'] for r in results],.5),
        'ttft_p95_s':percentile([r['ttft_s'] for r in results],.95),
        'cached_tokens':cached,'input_tokens':[r['usage'].get('prompt_tokens') for r in results],
        'external_requests':after['requests_total']-before['requests_total']-len(results),
        'initial_running':before.get('requests_running',0),'final_running':after.get('requests_running',0),
        'preemptions':after.get('preemptions',0)-before.get('preemptions',0),
        'prefix_hits_delta':after.get('prefix_hits',0)-before.get('prefix_hits',0),
        'min_available_gib':min((s['available_gib'] for s in samples),default=None),
        'swap_out_pages':memory()['pswpout']-initial['pswpout'],
        'oom_kills':memory()['oom_kill']-initial['oom_kill'],
        'peak_running':max((s.get('health',{}).get('requests_running',0) for s in samples),default=0),
        'peak_waiting':max((s.get('health',{}).get('requests_waiting',0) for s in samples),default=0),
        'peak_overlapping_output_streams':peak_overlap,
        'peak_kv_usage':max((s.get('health',{}).get('kv_cache_usage',0) for s in samples),default=0),
        'nvme_read_gib':(storage()['nvme_read_bytes']-initial_io['nvme_read_bytes'])/2**30,
        'nvme_write_gib':(storage()['nvme_write_bytes']-initial_io['nvme_write_bytes'])/2**30}
    (out/(name+'.json')).write_text(json.dumps({'summary':summary,'before':before,'after':after,
        'client_sha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        'requests':results,'monitor':samples},indent=2)+'\n')
    print(json.dumps(summary),flush=True)
    if summary['successes']!=len(payloads):raise RuntimeError('Request failures: '+name)
    return results


def main():
    p=argparse.ArgumentParser();p.add_argument('mode',choices=['short','cold','agents','capacity','smoke','quality'])
    p.add_argument('--base',required=True);p.add_argument('--out',required=True)
    p.add_argument('--tag',default='vllm032-c2048-r1');p.add_argument('--trials',type=int,default=3)
    p.add_argument('--start-trial',type=int,default=0)
    a=p.parse_args();out=Path(a.out);out.mkdir(parents=True,exist_ok=True)
    fixtures=ROOT/'tensorfold-zig-cache-tuning-20261018/fixtures.json'
    data=json.loads(fixtures.read_text());model=api(a.base,'/v1/models')['data'][0]['id']
    meta={'utc':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'model':model,
        'fixtures_sha256':hashlib.sha256(fixtures.read_bytes()).hexdigest(),
        'script_sha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        'health':health(a.base),'memory':memory(),'tag':a.tag}
    (out/('metadata-'+a.mode+'.json')).write_text(json.dumps(meta,indent=2)+'\n')
    if a.mode=='smoke':
        smoke(a.base,model,out)
    elif a.mode=='short':
        for trial in range(a.start_trial,a.start_trial+a.trials):
            for n in (1,16):
                payloads=[body(model,[{'role':'user','content':f'{a.tag} trial {trial}, cohort {n}, user {i}.\nWrite a Python LRU cache with type hints, docstrings and extensive unit tests.'}],256) for i in range(n)]
                cohort(a.base,f'code{n}-trial{trial}',payloads,out)
    elif a.mode=='cold':
        for size in ('16000','65000'):
            b=body(model,[{'role':'user','content':f'{a.tag} cold isolated {size}.\n'+data[size]}],128)
            cohort(a.base,'cold-'+size,[b],out)
    elif a.mode in ('agents','capacity'):
        output=896 if a.mode=='capacity' else 128
        histories=[]
        for i in range(16):
            size='74000' if a.mode=='capacity' else '1800' if i<8 else '7400' if i<15 else '65000'
            histories.append([{'role':'user','content':f'{a.tag} independent agent {i}.\n'+data[size]}])
        def run_histories(name):
            payloads=[body(model,h,output) for h in histories]
            if a.mode=='capacity':
                counts=[api(a.base,'/tokenize',b)['count'] for b in payloads]
                assert max(counts)+output<=75000,(counts,output)
                (out/(name+'-token-bounds.json')).write_text(json.dumps({'input_counts':counts,'max_tokens':output,'context_limit':75000},indent=2)+'\n')
            return cohort(a.base,name,payloads,out)
        run_histories(a.mode+'-cold16')
        for turn in (1,2):
            for h in histories:
                h.extend([{'role':'assistant','content':'I will preserve the public interface and add regression coverage.'},
                    {'role':'user','content':f'Turn {turn}: describe the next regression test and explain why it matters.'}])
            run_histories(a.mode+f'-return{turn}-16')
    else:
        results=[]
        for i,size in enumerate(('16000','65000','74000')):
            key=f'ORCHID_{908173+i*239}'
            s=data[size];mid=len(s)//2
            text=f'{a.tag} retrieval {i}.\n'+s[:mid]+f'\nThe project recovery code is {key}.\n'+s[mid:]+ '\nReturn only the project recovery code.'
            b=body(model,[{'role':'user','content':text}],32);b['ignore_eos']=False
            r=request(a.base,b);r['expected']=key;r['passed']=r['error'] is None and key in r['content'];results.append(r)
        (out/'quality.json').write_text(json.dumps(results,indent=2)+'\n')
        print('quality', [r['passed'] for r in results],flush=True)
    (out/('completed-'+a.mode)).write_text('complete\n')


if __name__=='__main__': main()
