#!/usr/bin/env python3
import json
from pathlib import Path
base=Path(__file__).resolve().parent; prior=base.parent/'tensorfold-zig-cache-tuning-20261018'
results={}
for folder in sorted(base.iterdir()):
 if not folder.is_dir() or folder.name in ('invalid-image-limit-attempt','__pycache__'):continue
 rows={}
 for p in folder.glob('*.json'):
  j=json.loads(p.read_text())
  if 'summary' not in j or p.name.startswith('quality'):continue
  b=j['summary'];refs={}
  for refname,refdir in [('python-same-host',prior/'python-same-host-2226'),('python-2225',base.parent/'tensorfold-zig-int4-vs-mlx-20261018'/'baseline-2225'),('graph-off',base/'mlx-built-plain-graph0')]:
   q=refdir/p.name
   if not q.exists():continue
   ref=json.loads(q.read_text());a=ref['summary']
   same=[r['request_sha256'] for r in ref['requests']]==[r['request_sha256'] for r in j['requests']]
   exclusions=[] if same else ['different payloads']
   for tag,s in [('reference',a),('candidate',b)]:
    if s['successes']!=s['requests'] or s['full_output_requests']!=s['requests']:exclusions.append(tag+': failed/short outputs')
    if s['external_requests']!=0:exclusions.append(tag+': outside or unknown traffic')
    if s['swap_out_pages'] or s['oom_kills']:exclusions.append(tag+': swapping/OOM')
    if s['cached_tokens']:exclusions.append(tag+': unexpected cold cache hit')
   keys=('content','reasoning','tool_calls','finish_reason')
   equal=sum(all(x.get(k)==y.get(k) for k in keys) for x,y in zip(ref['requests'],j['requests']))
   ratio=b['aggregate_output_tok_s']/a['aggregate_output_tok_s'] if a['aggregate_output_tok_s'] else None
   def delta(candidate,reference):
    return 100*(candidate/reference-1) if candidate is not None and reference is not None and reference>0 else None
   refs[refname]={'same_payloads':same,'clean':not exclusions,'exclusions':exclusions,
    'throughput_ratio':ratio,
    'throughput_change_pct':None if ratio is None else 100*(ratio-1),
    'throughput_increase_to_match_reference_pct':None if not ratio else max(0,100*(1/ratio-1)),
    'ttft_p50_change_pct':delta(b['ttft_p50_s'],a['ttft_p50_s']),
    'cohort_wall_change_pct':delta(b['wall_s'],a['wall_s']),
    'exact_outputs':equal,'requests':b['requests'],'reference':a}
  rows[p.stem]={'candidate':b,'comparisons':refs}
  print(folder.name,p.stem,round(b['aggregate_output_tok_s'],2),round(b['ttft_p50_s'],3) if b['ttft_p50_s'] is not None else None,'full',b['full_output_requests'],'swap',b['swap_out_pages'])
 if rows:results[folder.name]=rows
(base/'alternatives-comparison.json').write_text(json.dumps(results,indent=2)+'\n')
