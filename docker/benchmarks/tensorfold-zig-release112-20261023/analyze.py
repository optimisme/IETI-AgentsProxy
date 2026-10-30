#!/usr/bin/env python3
"""Compare identical API payloads, recording rather than concealing exclusions."""
import argparse,json,statistics
from pathlib import Path
root=Path(__file__).resolve().parent
p=argparse.ArgumentParser();p.add_argument('--baseline',default='python-2225-streams11');p.add_argument('--candidate',default='stock-vision11');p.add_argument('--output',default='comparison.json');a=p.parse_args()
base=root/a.baseline;candidate=root/a.candidate
def read(p):return json.loads(p.read_text())
def reasons(v):
 s=v['summary'];r=[]
 if s['successes']!=s['requests'] or s['full_output_requests']!=s['requests']:r.append('failed or short output')
 for key in ['cached_tokens','swap_out_pages','oom_kills','external_requests']:
  if s.get(key)!=0:r.append(f'{key}={s.get(key)}')
 if v['before'].get('requests_running',0)>0:r.append('inference already active before cohort')
 if v['after'].get('requests_running',0)>0:r.append('inference still active after cohort')
 return r
rows=[]
for p in sorted(candidate.glob('*.json')):
 if not (base/p.name).exists():continue
 c,b=read(p),read(base/p.name)
 if 'summary' not in c or 'summary' not in b:continue
 assert len(c['requests'])==len(b['requests']),p.name
 assert all(x['request_sha256']==y['request_sha256'] for x,y in zip(c['requests'],b['requests'])),p.name
 bs,cs=b['summary'],c['summary'];ttft=cs['ttft_p50_s']/bs['ttft_p50_s']*100-100 if bs['ttft_p50_s'] else None
 rows.append({'eligible_for_performance_comparison':not reasons(b) and not reasons(c),'case':p.stem,'identical_requests':True,'python_tok_s':bs['aggregate_output_tok_s'],'zig_tok_s':cs['aggregate_output_tok_s'],'zig_throughput_change_percent':100*(cs['aggregate_output_tok_s']/bs['aggregate_output_tok_s']-1),'python_ttft_p50_s':bs['ttft_p50_s'],'zig_ttft_p50_s':cs['ttft_p50_s'],'zig_ttft_change_percent':ttft,'python_exclusions':reasons(b),'zig_exclusions':reasons(c),'python_summary':bs,'zig_summary':cs})
result={'scope':'Stock TensorFold 1.1.2, CUDA GB10, vision enabled, 11 configured streams; Python reference retains 16 slots but receives the same 11-request cohort. Model checkpoint is identical; KV representation and engine arithmetic differ.','rows':rows,'clean_medians':{}}
for prefix in ['code1-','code11-']:
 eligible=[r for r in rows if r['case'].startswith(prefix) and not r['python_exclusions'] and not r['zig_exclusions']]
 if eligible:
  p=statistics.median(r['python_tok_s'] for r in eligible);z=statistics.median(r['zig_tok_s'] for r in eligible)
  pt=statistics.median(r['python_ttft_p50_s'] for r in eligible);zt=statistics.median(r['zig_ttft_p50_s'] for r in eligible)
  result['clean_medians'][prefix]={'trials':len(eligible),'python_tok_s':p,'zig_tok_s':z,'zig_change_percent':100*(z/p-1),'python_ttft_p50_s':pt,'zig_ttft_p50_s':zt,'zig_ttft_change_percent':100*(zt/pt-1)}
(root/a.output).write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps({'clean_medians':result['clean_medians'],'cases':[{'case':r['case'],'throughput_percent':r['zig_throughput_change_percent'],'ttft_percent':r['zig_ttft_change_percent'],'exclusions':r['python_exclusions']+r['zig_exclusions']} for r in rows]},indent=2))
