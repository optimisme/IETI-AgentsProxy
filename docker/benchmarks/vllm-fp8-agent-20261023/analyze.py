#!/usr/bin/env python3
"""Exclude interference and pair exact input hashes before comparing runtimes."""
import json
from pathlib import Path
import statistics

ROOT=Path(__file__).resolve().parent


def clean(report,cold=False):
    s=report['summary']
    return (s['successes']==s['full_output_requests']==s['requests']
        and all(s.get(k)==0 for k in ('external_requests','initial_running','final_running','swap_out_pages','oom_kills','preemptions'))
        and (not cold or s['cached_tokens']==0))


comparisons={}
for label in ('c2048-mtp3','c8192-mtp3','c2048-mtp0','c8192-mtp0',
              'c8192-mtp0-prefix32-gmu086','c8192-mtp0-prefix32-gmu082'):
    reference_label = 'c8192-mtp3' if 'prefix32-gmu' in label else label.replace('mtp0','mtp3')
    candidate=ROOT/label;reference=ROOT/('python-'+reference_label)
    if not candidate.exists():continue
    result={'pairs':[],'short_medians':{},
            'serving_ready':(candidate/'completed-smoke').exists(),
            'host_memory_guard_stopped':False}
    smoke=candidate/'smoke.json';quality=candidate/'quality.json';jpeg=candidate/'jpeg-smoke.json'
    result['diagnostics']={
        'tool_and_png':all(x.get('passed',False) for x in json.loads(smoke.read_text()).values()) if smoke.exists() else None,
        'retrieval':all(x.get('passed',False) for x in json.loads(quality.read_text())) if quality.exists() else None,
        'jpeg':json.loads(jpeg.read_text()).get('passed',False) if jpeg.exists() else None}
    for path in sorted(candidate.glob('*.json')):
        other=reference/path.name
        if not other.exists():continue
        c=json.loads(path.read_text());r=json.loads(other.read_text())
        if 'summary' not in c or 'summary' not in r:continue
        hashes=lambda x:[v['request_sha256'] for v in x['requests']]
        matched=hashes(c)==hashes(r)
        eligible=matched and clean(c,path.name.startswith('code')) and clean(r,path.name.startswith('code'))
        cs,rs=c['summary'],r['summary']
        pair={'case':path.stem,'matched_request_hashes':matched,'eligible':eligible,
              'candidate':cs,'python':rs}
        for field in ('aggregate_output_tok_s','ttft_p50_s','ttft_p95_s','wall_s'):
            if rs.get(field) and cs.get(field) is not None:
                pair[field+'_change_pct']=(cs[field]/rs[field]-1)*100
        result['pairs'].append(pair)
    for n in (1,16):
        pairs=[x for x in result['pairs'] if x['eligible'] and x['case'].startswith(f'code{n}-')]
        if not pairs:continue
        d={'clean_pairs':len(pairs),'cases':[x['case'] for x in pairs]}
        for metric in ('aggregate_output_tok_s','ttft_p50_s'):
            c=statistics.median(x['candidate'][metric] for x in pairs)
            r=statistics.median(x['python'][metric] for x in pairs)
            d[metric]={'candidate':c,'python':r,'change_pct':(c/r-1)*100}
        result['short_medians'][str(n)]=d
    for logname in ('startup.log','runtime.log'):
        p=candidate/logname
        if p.exists():
            import re
            log=p.read_text()
            if 'HOST_MEMORY_ABORT' in log:result['host_memory_guard_stopped']=True
            values=re.findall(r'Maximum concurrency for [\d,]+ tokens per request: ([\d.]+)x',log)
            if values:result['reported_max_full_context_concurrency']=float(values[-1])
    comparisons[label]=result
(ROOT/'comparison.json').write_text(json.dumps(comparisons,indent=2)+'\n')
capacities={}
for directory in sorted(ROOT.glob('capacity-tuned*')):
    stages=[]
    for name in ('capacity-cold16','capacity-return1-16','capacity-return2-16'):
        path=directory/(name+'.json');bounds=directory/(name+'-token-bounds.json')
        if not path.exists() or not bounds.exists():continue
        report=json.loads(path.read_text());b=json.loads(bounds.read_text());s=report['summary']
        stages.append({'case':name,'summary':s,
            'all_16_full_outputs':s['requests']==s['successes']==s['full_output_requests']==16
                and all(r['usage'].get('completion_tokens')==b['max_tokens'] for r in report['requests']),
            'token_bounds_met':len(b['input_counts'])==16 and max(b['input_counts'])+b['max_tokens']<=b['context_limit']==75000,
            'max_input_plus_output':max(b['input_counts'])+b['max_tokens'],
            'sixteen_output_streams_overlap':s.get('peak_overlapping_output_streams')==16,
            'no_preemption_oom_or_interference':all(s.get(k)==0 for k in ('preemptions','oom_kills','external_requests','initial_running','final_running')),
            'host_ram_guard_met':s['min_available_gib']>=6})
    qualified=len(stages)==3 and all(all(s[k] for k in ('all_16_full_outputs','token_bounds_met',
        'sixteen_output_streams_overlap','no_preemption_oom_or_interference','host_ram_guard_met')) for s in stages)
    capacities[directory.name]={'resident_context_target_observed':qualified,
        'zero_swap_out_all_stages':len(stages)==3 and all(s['summary']['swap_out_pages']==0 for s in stages),
        'stages':stages}
(ROOT/'capacity-assessment.json').write_text(json.dumps(capacities,indent=2)+'\n')
print(json.dumps({k:{'short_medians':v['short_medians'],
    'serving_ready':v['serving_ready'],
    'host_memory_guard_stopped':v['host_memory_guard_stopped'],
    'reported_max_full_context_concurrency':v.get('reported_max_full_context_concurrency')} for k,v in comparisons.items()},indent=2))
