#!/usr/bin/env python3
"""Read-only analysis of repeated trials, admission causes and per-user latency."""
import collections,json,statistics
from pathlib import Path
ROOT=Path(__file__).resolve().parent


def percentile(xs,p):
    xs=sorted(x for x in xs if x is not None)
    if not xs:return None
    k=(len(xs)-1)*p;lo=int(k);hi=min(lo+1,len(xs)-1)
    return xs[lo]+(xs[hi]-xs[lo])*(k-lo)


def load_lines(path):
    result=[]
    if path.exists():
        for line in path.read_text().splitlines():
            try:result.append(json.loads(line))
            except json.JSONDecodeError:pass
    return result


def main():
    runs=[]
    for folder in sorted((ROOT/'results').glob('*')):
        if not folder.is_dir() or not (folder/'started.json').exists():continue
        config=json.loads((folder/'started.json').read_text())['run']
        events=load_lines(folder/'engine.jsonl');samples=[e for e in events if e['event']=='sample']
        prom=load_lines(folder/'prometheus.jsonl')
        process=load_lines(folder/'process.jsonl')
        process += [{'time':v['time'],**v['serving_process']} for v in prom if 'serving_process' in v]
        by_token=collections.defaultdict(dict)
        for e in events:
            key=e.get('token_sha256')
            if key and e['event'] in ('enqueue','admitted','first_token','finished'):
                by_token[key].setdefault(e['event'],e)
        cases=[];functional_checks=[]
        for path in sorted((folder/'client').glob('*.json')):
            if path.name.endswith('-token-bounds.json') or path.name in ('started.json','smoke.json'):continue
            report=json.loads(path.read_text())
            if 'summary' not in report:continue
            if report.get('validation_kind'):
                checks=report.get('checks',[])
                functional_checks.append({'name':report['summary']['name'],'kind':report['validation_kind'],
                    'passed':sum(c['passed'] for c in checks),'requests':len(checks),'transport_successes':report['summary']['successes'],'all_transport_complete':report['summary']['requests']==report['summary']['successes'] and all(r.get('done') and r.get('error') is None for r in report['requests']),'transport_errors':[{'user':i,'error':r['error']} for i,r in enumerate(report['requests']) if r.get('error')],'summary':report['summary']})
                continue
            s=report['summary']
            start=min(m['time'] for m in report['monitor']);end=max(m['time'] for m in report['monitor'])+1
            observed=[e for e in samples if start<=e['time']<=end]
            metrics=[m for m in prom if start<=m['time']<=end and 'metrics' in m]
            rejects=[e for e in events if start<=e['time']<=end and e['event']=='gate_reject']
            proc=[v for v in process if start-1<=v['time']<=end+1]
            proc.sort(key=lambda v:v['time'])
            process_stats=None
            if proc:
                process_stats={'first_epoch':proc[0]['time'],'last_epoch':proc[-1]['time'],
                    'covers_case':proc[0]['time']<=start+2 and proc[-1]['time']>=end-2,
                    'max_CPU_VmSwap_kib':max(v['VmSwap_kib'] for v in proc),
                    'CPU_VmSwap_delta_kib':proc[-1]['VmSwap_kib']-proc[0]['VmSwap_kib'],
                    'major_faults_delta':proc[-1]['major_faults']-proc[0]['major_faults'],
                    'CPU_s_delta':proc[-1]['cpu_s']-proc[0]['cpu_s'],
                    'host_swap_in_pages_delta':proc[-1]['host_swap_in_pages']-proc[0]['host_swap_in_pages']}
            users=[]
            for r in report['requests']:
                e=by_token.get(r.get('token_sha256'),{})
                a=e.get('admitted');first=e.get('first_token')
                user={'request_sha256':r['request_sha256'],'token_sha256':r.get('token_sha256'),
                    'ttft_s':r['ttft_s'],'elapsed_s':r['elapsed_s'],'output_tokens':r['usage'].get('completion_tokens'),
                    'input_tokens':r['usage'].get('prompt_tokens'),
                    'queue_s':a['queue_s'] if a else None,
                    'admission_to_first_token_s':first['monotonic']-a['monotonic'] if first and a else None,
                    'server_prefill_work_s':first['server_prefill_work_s'] if first else None,
                    'mean_time_per_output_token_after_first_s':r['mean_time_per_output_token_after_first_s'],
                    'sse_gap_p95_s':r['sse_gap_p95_s'],'sse_gap_max_s':r['sse_gap_max_s'],
                    'content_sha256':__import__('hashlib').sha256(r['content'].encode()).hexdigest(),
                    'engine_first_token_correlated':bool(first and a),'error':r['error']}
                users.append(user)
            clean=s['requests']==s['successes']==s['full_output_requests'] and all(s.get(k)==0 for k in ('external_requests','initial_running','final_running','oom_kills','swap_out_pages'))
            bounded=(s['requests']==s['successes']==s['full_output_requests']
                and all(s.get(k)==0 for k in ('external_requests','initial_running','final_running','oom_kills'))
                and s.get('swap_out_pages',float('inf'))<=256
                and process_stats is not None and process_stats['covers_case']
                and process_stats['max_CPU_VmSwap_kib']==0)
            case={'name':s['name'],'clean':clean,'bounded_background_noise':bounded,'summary':s,'users':users,
                'completion_p50_s':percentile([u['elapsed_s'] for u in users],.5),
                'completion_p95_s':percentile([u['elapsed_s'] for u in users],.95),
                'post_first_token_per_token_p50_s':percentile([u['mean_time_per_output_token_after_first_s'] for u in users],.5),
                'queue_p50_s':percentile([u['queue_s'] for u in users],.5),
                'queue_p95_s':percentile([u['queue_s'] for u in users],.95),
                'queue_max_s':max((u['queue_s'] or 0 for u in users),default=0),
                'all_requests_engine_correlated':all(u['engine_first_token_correlated'] for u in users),
                'serving_process':process_stats,
                'admission_to_first_token_p50_s':percentile([u['admission_to_first_token_s'] for u in users],.5),
                'gate_reject_reasons_observed':dict(collections.Counter(e['reason'] for e in rejects)),
                'gate_reject_note':'Event samples are throttled; these are observed records, not the exact number of decisions.',
                'engine_peak_active':max((e['decoding']+e['prefilling'] for e in observed),default=None),
                'engine_peak_decoding':max((e['decoding'] for e in observed),default=None),
                'scheduler_peak_waiting':max((m['metrics'].get('tensorfold:requests_waiting',0) for m in metrics),default=None),
                'max_cuda_allocated_gib':max((e['allocated_bytes']/2**30 for e in observed),default=None),
                'max_cuda_reserved_gib':max((e['reserved_bytes']/2**30 for e in observed),default=None),
                'max_inactive_split_gib':max((e['allocator_stats']['inactive_split_bytes.all.current']/2**30 for e in observed if e.get('allocator_stats',{}).get('inactive_split_bytes.all.current') is not None),default=None),
                'diagnostic_sample_host_time_s':sum(e['diagnostic_host_time_s'] for e in observed)}
            cases.append(case)
        client_start=folder/'client/started.json'
        inventory_path=folder/'runtime-inventory.json'
        inventory=json.loads(inventory_path.read_text()) if inventory_path.exists() else None
        resolved_path=folder/'resolved-inventory.json';resolved=json.loads(resolved_path.read_text()) if resolved_path.exists() else None
        readiness=next((e for e in events if e['event']=='instrumentation_ready'),{})
        runs.append({'id':folder.name,'inventory':inventory,'effective_inventory':resolved,'instrument_sha256':readiness.get('instrument_sha256'),'config':config,'completed':(folder/'result.json').exists(),
            'client_started':json.loads(client_start.read_text()) if client_start.exists() else None,
            'safety_abort':json.loads((folder/'safety-abort.json').read_text()) if (folder/'safety-abort.json').exists() else None,
            'cases':cases,'functional_checks':functional_checks,'latest_counters':samples[-1]['counters'] if samples else None,
            'latest_sample':samples[-1] if samples else None})
    paired=[]
    for candidate in runs:
        pair_id=candidate['config'].get('pair_id')
        if pair_id:
            if candidate['config'].get('variant')=='baseline':continue
            baseline=next((r for r in runs if r['config'].get('variant')=='baseline' and r['config'].get('pair_id')==pair_id),None)
        else:
            if 'reserve8' not in candidate['id']:continue
            index=candidate['id'].rsplit('-',1)[-1]
            baseline=next((r for r in runs if r['id']=='baseline-'+index),None)
        if not baseline:continue
        bi=baseline.get('inventory') or {};ci=candidate.get('inventory') or {}
        ignored={'IETI_RUN','IETI_CANDIDATE','TENSORFOLD_MEMORY_RESERVE_GIB'}
        runtime_checks={key:bool(bi.get(key)) and bi.get(key)==ci.get(key) for key in ('image','packages','source_sha256')}
        runtime_checks['common_environment']={k:v for k,v in bi.get('selected_environment',{}).items() if k not in ignored}=={k:v for k,v in ci.get('selected_environment',{}).items() if k not in ignored}
        runtime_checks['common_instrumentation']=bool(baseline.get('instrument_sha256')) and baseline['instrument_sha256']==candidate['instrument_sha256']
        br=(baseline.get('effective_inventory') or {}).get('effective_packages');cr=(candidate.get('effective_inventory') or {}).get('effective_packages')
        runtime_checks['effective_distribution_versions']=bool(br) and br==cr
        runtime_match=all(runtime_checks.values())
        for c in candidate['cases']:
            b=next((x for x in baseline['cases'] if x['name']==c['name']),None)
            if not b:continue
            matched=[u['request_sha256'] for u in b['users']]==[u['request_sha256'] for u in c['users']]
            tokens=[u['input_tokens'] for u in b['users']]==[u['input_tokens'] for u in c['users']]
            fixture=(baseline.get('client_started') or {}).get('fixture_sha256')==(candidate.get('client_started') or {}).get('fixture_sha256')
            eligible=runtime_match and matched and tokens and fixture and b['clean'] and c['clean'] and b['all_requests_engine_correlated'] and c['all_requests_engine_correlated']
            bounded=runtime_match and matched and tokens and fixture and b['bounded_background_noise'] and c['bounded_background_noise'] and b['all_requests_engine_correlated'] and c['all_requests_engine_correlated']
            p={'baseline':baseline['id'],'candidate':candidate['id'],'case':c['name'],'matched_payloads':matched,
               'runtime_match_checks':runtime_checks,'matched_frozen_fixture':fixture,'baseline_full_trial_completed':baseline['completed'],'candidate_full_trial_completed':candidate['completed'],
               'matched_input_tokens':tokens,'eligible':eligible,'bounded_noise_eligible':bounded,'primary':candidate['config'].get('phase')=='primary','baseline_overlap':b['summary']['peak_overlapping_output_streams'],
               'candidate_overlap':c['summary']['peak_overlapping_output_streams']}
            if eligible or bounded:
                p['candidate_vs_baseline_change_pct']={key:(c['summary'][key]/b['summary'][key]-1)*100 for key in ('wall_s','aggregate_output_tok_s','ttft_p50_s','ttft_p95_s','sse_gap_p95_per_user_median_s','worst_sse_gap_s') if b['summary'].get(key)}
            if eligible or bounded:
                p['candidate_vs_baseline_change_pct'].update({key:(c[key]/b[key]-1)*100 for key in ('queue_p95_s','post_first_token_per_token_p50_s','completion_p50_s','completion_p95_s') if b.get(key) and c.get(key) is not None})
            paired.append(p)
    aggregate=[]
    for label,key in (('strict_zero_host_swap','eligible'),('bounded_background_noise','bounded_noise_eligible')):
        for case in sorted({p['case'] for p in paired if p['primary']}):
            records=[p for p in paired if p['primary'] and p['case']==case and p[key] and p['baseline_full_trial_completed'] and p['candidate_full_trial_completed']]
            metrics={}
            for metric in ('wall_s','aggregate_output_tok_s','ttft_p50_s','ttft_p95_s','sse_gap_p95_per_user_median_s','worst_sse_gap_s','queue_p95_s','post_first_token_per_token_p50_s','completion_p50_s','completion_p95_s'):
                values=[p['candidate_vs_baseline_change_pct'][metric] for p in records if metric in p.get('candidate_vs_baseline_change_pct',{})]
                metrics[metric]={'n':len(values),'median_change_pct':statistics.median(values) if values else None,'min_change_pct':min(values) if values else None,'max_change_pct':max(values) if values else None,'individual_changes_pct':values}
            aggregate.append({'analysis':label,'case':case,'pairs':[{'baseline':p['baseline'],'candidate':p['candidate']} for p in records],'metrics':metrics})
    sequences=[]
    primary_ids=sorted({r['config'].get('pair_id') for r in runs if r['config'].get('phase')=='primary' and r['config'].get('pair_id')})
    for pair_id in primary_ids:
        b=next((r for r in runs if r['config'].get('pair_id')==pair_id and r['config'].get('variant')=='baseline'),None)
        c=next((r for r in runs if r['config'].get('pair_id')==pair_id and r['config'].get('variant')!='baseline'),None)
        if not b or not c:continue
        prefix=b['config'].get('primary_case_prefix','sustained-');expected=b['config'].get('expected_timed_cases',4)
        records=[p for p in paired if p['baseline']==b['id'] and p['candidate']==c['id'] and p['case'].startswith(prefix)]
        complete=b['completed'] and c['completed'] and len(records)==expected
        strict=complete and all(p['eligible'] for p in records)
        bounded=complete and all(p['bounded_noise_eligible'] for p in records)
        bs=sum(x['summary']['wall_s'] for x in b['cases'] if x['name'].startswith(prefix))
        cs=sum(x['summary']['wall_s'] for x in c['cases'] if x['name'].startswith(prefix))
        sequences.append({'pair_id':pair_id,'baseline':b['id'],'candidate':c['id'],'complete':complete,'strict_eligible':strict,'bounded_noise_eligible':bounded,'case_prefix':prefix,'expected_timed_cases':expected,'baseline_sequence_wall_s':bs,'candidate_sequence_wall_s':cs,'wall_change_pct':(cs/bs-1)*100 if (strict or bounded) and bs else None,'throughput_change_pct':(bs/cs-1)*100 if (strict or bounded) and cs else None})
    sequence_aggregate={}
    for label,key in (('strict_zero_host_swap','strict_eligible'),('bounded_background_noise','bounded_noise_eligible')):
        values=[p for p in sequences if p[key]]
        sequence_aggregate[label]={'n':len(values),'wall_change_pct':{'median':statistics.median([p['wall_change_pct'] for p in values]) if values else None,'range':[min(p['wall_change_pct'] for p in values),max(p['wall_change_pct'] for p in values)] if values else []},'throughput_change_pct_median':statistics.median([p['throughput_change_pct'] for p in values]) if values else None}
    result={'primary_sequences':sequences,'primary_sequence_aggregate':sequence_aggregate,'primary_aggregate':aggregate,'analysis_rules':{'strict':'Zero whole-host swap-out','bounded':'At most 256 whole-host 4 KiB pages; full main-process counter coverage and zero observed CPU VmSwap; no OOM, unrelated requests, incomplete outputs or guard abort; full primary trials required for aggregate.'},'runs':runs,'paired_comparisons':paired,'note':'Per-stage comparisons only. Repeat counts and observed ranges are required before a performance recommendation. Raw frozen-client preemption defaults are not measured counters.'}
    (ROOT/'analysis.json').write_text(json.dumps(result,indent=2)+'\n')
    for r in runs:
        print(r['id'],'completed',r['completed'],'counters',r['latest_counters'])
        for c in r['cases']:print(' ',c['name'],'wall',round(c['summary']['wall_s'],2),'overlap',c['summary']['peak_overlapping_output_streams'],'queue p95',c['queue_p95_s'],'correlated',c['all_requests_engine_correlated'],'clean',c['clean'])
    for p in paired:print('PAIR',p)

if __name__=='__main__':main()
