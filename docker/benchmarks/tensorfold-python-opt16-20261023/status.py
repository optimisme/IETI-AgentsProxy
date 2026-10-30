#!/usr/bin/env python3
"""Compact read-only private campaign status; never exports model arguments/env."""
import json,time,urllib.request
from pathlib import Path
ROOT=Path(__file__).resolve().parent

def lines_tail(path):
    if not path.exists():return []
    with path.open('rb') as f:
        f.seek(max(0,path.stat().st_size-262144));raw=f.read().decode(errors='replace')
    events=[]
    for line in raw.splitlines():
        try:events.append(json.loads(line))
        except json.JSONDecodeError:pass
    return events

def main():
    folders=[p.parent for p in (ROOT/'results').glob('*/started.json')];current=max(folders,key=lambda p:json.loads((p/'started.json').read_text())['epoch']) if folders else None
    result={'utc':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime())}
    if current:
        result['run']=current.name;result['completed']=(current/'result.json').exists()
        result['elapsed_since_container_start_s']=round(time.time()-json.loads((current/'started.json').read_text())['epoch'])
        cases=[]
        for path in sorted((current/'client').glob('*.json')):
            try:r=json.loads(path.read_text())
            except json.JSONDecodeError:continue
            if 'summary' in r:cases.append({'name':r['summary']['name'],'wall_s':round(r['summary']['wall_s'],2),'successes':r['summary']['successes']})
        result['finished_cases']=cases
        sample=next((e for e in reversed(lines_tail(current/'engine.jsonl')) if e.get('event')=='sample'),None)
        if sample:result['engine']={k:sample.get(k) for k in ('decoding','prefilling','kept_entries','gate_waits')}
        if sample:
            positions=[s['position'] for s in sample.get('active_states',[]) if s['output_tokens']==0]
            if positions:result['prefill_positions']={'min':min(positions),'max':max(positions)}
        metrics=next((e.get('metrics',{}) for e in reversed(lines_tail(current/'prometheus.jsonl')) if 'metrics' in e),{})
        result['scheduler_waiting']=metrics.get('tensorfold:requests_waiting')
        abort=current/'safety-abort.json'
        if abort.exists():result['safety_abort']=json.loads(abort.read_text())['reason']
    try:
        with urllib.request.urlopen('http://127.0.0.1:8009/health',timeout=5) as r:health=json.load(r)
        result['health']={k:health.get(k) for k in ('ok','requests_running','requests_total','completion_tokens_total','streams')}
    except Exception as e:result['private_health']=type(e).__name__
    mem=dict(s.split(':',1) for s in Path('/proc/meminfo').read_text().splitlines());result['host_available_gib']=round(int(mem['MemAvailable'].split()[0])/1024**2,2)
    p=ROOT/'results/controller-result.json'
    if p.exists():result['controller_result']=json.loads(p.read_text())
    print(json.dumps(result))

if __name__=='__main__':main()
