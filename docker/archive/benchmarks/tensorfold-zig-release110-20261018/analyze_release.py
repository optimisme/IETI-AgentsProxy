#!/usr/bin/env python3
import json
from pathlib import Path
base=Path(__file__).resolve().parent
prior=base.parent/'tensorfold-zig-cache-tuning-20261018'
result={}
for p in sorted((base/'upstream110').glob('*.json')):
 j=json.loads(p.read_text())
 if 'summary' not in j: continue
 comparisons={}
 for variant in ('python-same-host-2226','zig1024gap256-main','zig1024gap256lru16-main'):
  q=prior/variant/p.name
  if not q.exists():continue
  ref=json.loads(q.read_text());a,b=ref['summary'],j['summary']
  same=[r['request_sha256'] for r in ref['requests']]==[r['request_sha256'] for r in j['requests']]
  exclusions=[] if same else ['different request payloads']
  for name,s in [('reference',a),('candidate',b)]:
   if s['successes']!=s['requests'] or s['full_output_requests']!=s['requests']:exclusions.append(name+': failed or short outputs')
   if s['external_requests']!=0:exclusions.append(name+': external inference or unknown counter')
   if s['swap_out_pages'] or s['oom_kills']:exclusions.append(name+': swapping or OOM')
   if s['cached_tokens']:exclusions.append(name+': unexpected cold cache hits')
  comparisons[variant]={'reference':a,'candidate':b,'same_payloads':same,'exclusions':exclusions,'clean_pair':not exclusions,'throughput_ratio':b['aggregate_output_tok_s']/a['aggregate_output_tok_s']}
 result[p.stem]=comparisons
(base/'release-comparison.json').write_text(json.dumps(result,indent=2)+'\n')
for name,rows in result.items():
 for variant,r in rows.items():
  a,b=r['reference'],r['candidate']
  print(name,variant,f"{a['aggregate_output_tok_s']:.1f} -> {b['aggregate_output_tok_s']:.1f} tok/s; TTFT {a['ttft_p50_s']:.3f} -> {b['ttft_p50_s']:.3f}; clean={r['clean_pair']}")
