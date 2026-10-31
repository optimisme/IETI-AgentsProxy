#!/usr/bin/env python3
"""Pair fixed typical-load requests; preserve latency regressions and exclusions."""
import hashlib,json,statistics
from pathlib import Path
ROOT=Path(__file__).resolve().parent
METRICS=['wall_s','aggregate_output_tok_s','ttft_p50_s','ttft_p95_s','content_ttft_p50_s','content_ttft_p95_s','completion_p50_s','completion_p95_s','post_first_token_per_token_p50_s','sse_gap_p95_per_user_median_s','worst_sse_gap_s','cached_tokens','cached_users','uncached_input_tokens_total','min_available_gib']


def read(path):
    return json.loads(path.read_text()) if path.exists() else None


def lines(path):
    result=[]
    if path.exists():
        for s in path.read_text().splitlines():
            try:result.append(json.loads(s))
            except json.JSONDecodeError:pass
    return result


def values(xs):
    xs=[x for x in xs if x is not None]
    return {'median':statistics.median(xs),'min':min(xs),'max':max(xs),'n':len(xs)} if xs else None


def main():
    runs=[]
    for folder in sorted((ROOT/'results').glob('*')):
        if not folder.is_dir() or not (folder/'started.json').exists():continue
        start=read(folder/'started.json');inventory=read(folder/'runtime-inventory.json') or {};effective=read(folder/'resolved-inventory.json') or {}
        proc=[e for e in lines(folder/'prometheus.jsonl') if 'serving_process' in e];cases={}
        for path in sorted((folder/'client').glob('*.json')):
            raw=read(path)
            if not isinstance(raw,dict) or 'case_metadata' not in raw:continue
            s=raw['summary'];requests=raw['requests']
            s['uncached_input_tokens_total']=sum(s['input_tokens'])-s['cached_tokens']
            lo=min(r['started_epoch'] for r in requests);hi=max(r['started_epoch']+r['elapsed_s'] for r in requests)
            samples=[p for p in proc if lo-1<=p['time']<=hi+1]
            stats={'samples':len(samples),'covers_case':bool(samples) and samples[0]['time']<=lo+2 and samples[-1]['time']>=hi-2,
                'max_CPU_VmSwap_kib':max((p['serving_process']['VmSwap_kib'] for p in samples),default=None)}
            fixed=raw['case_metadata']['fixed_output']
            ok=(s['successes']==s['requests'] and (not fixed or s['full_output_requests']==s['requests'])
                and all(r.get('done') and r.get('error') is None for r in requests)
                and all(s.get(k)==0 for k in ['external_requests','initial_running','final_running','oom_kills']))
            bounded=ok and s['swap_out_pages']<=256 and stats['covers_case'] and stats['max_CPU_VmSwap_kib']==0
            cases[s['name']]={'summary':s,'meta':raw['case_metadata'],'valid_transport':ok,
                'strict_clean':bounded and s['swap_out_pages']==0,'bounded_clean':bounded,'serving_process':stats,
                'request_sha256':[r['request_sha256'] for r in requests],
                'token_sha256':[r.get('token_sha256') for r in requests],
                'input_tokens':[r['usage'].get('prompt_tokens') for r in requests],
                'output_tokens':[r['usage'].get('completion_tokens') for r in requests],
                'harness_sha256':{'base':raw.get('client_sha256'),'transport':raw.get('harness_sha256'),'matrix':raw.get('matrix_source_sha256')},
                'answer_sha256':[hashlib.sha256((r['content']+'\0'+r['reasoning']).encode()).hexdigest() for r in requests],
                'all_within_context':all(r['usage'].get('prompt_tokens',75001)+r['usage'].get('completion_tokens',75001)<=75000 for r in requests)}
        runs.append({'id':folder.name,'config':start['run'],'completed':bool((read(folder/'result.json') or {}).get('completed')),
            'guard_abort':(folder/'safety-abort.json').exists(),'inventory':inventory,'effective_inventory':effective,
            'cases':cases,'quality':read(folder/'client/quality.json')})
    plan_ids={p['id'] for p in json.loads((ROOT/'plan.json').read_text())['runs']}
    by_id={r['id']:r for r in runs if r['id'] in plan_ids};pairs=[]
    for i in [1,2,3]:
        a=by_id.get(f'original-pair{i}-clean');b=by_id.get(f'tuned-pair{i}-clean')
        if not a or not b:continue
        skip={'IETI_RUN','IETI_CANDIDATE','TENSORFOLD_MEMORY_RESERVE_GIB'}
        runtime={k:bool(a['inventory'].get(k)) and a['inventory'].get(k)==b['inventory'].get(k) for k in ['image','packages','source_sha256','Cmd_sha256','Entrypoint_sha256','client_source_sha256','policy_source_sha256']}
        runtime['effective_packages']=bool(a['effective_inventory'].get('effective_packages')) and a['effective_inventory'].get('effective_packages')==b['effective_inventory'].get('effective_packages')
        runtime['common_environment']={k:v for k,v in a['inventory'].get('selected_environment',{}).items() if k not in skip}=={k:v for k,v in b['inventory'].get('selected_environment',{}).items() if k not in skip}
        for name in sorted(a['cases'].keys()&b['cases'].keys()):
            ac=a['cases'][name];bc=b['cases'][name]
            matched={k:bool(ac[k]) and ac[k]==bc[k] for k in ['request_sha256','token_sha256','input_tokens','harness_sha256']}
            complete=a['completed'] and b['completed'] and not a['guard_abort'] and not b['guard_abort']
            eligible=ac['meta']['kind']!='tool_live_return' and complete and all(runtime.values()) and all(matched.values()) and ac['bounded_clean'] and bc['bounded_clean'] and ac['all_within_context'] and bc['all_within_context']
            delta={k:(bc['summary'][k]/ac['summary'][k]-1)*100 if eligible and ac['summary'].get(k) and bc['summary'].get(k) is not None else None for k in METRICS}
            regression={k:delta[k] is not None and delta[k]>10 and bc['summary'][k]-ac['summary'][k]>.2 for k in ['ttft_p50_s','ttft_p95_s','completion_p50_s','completion_p95_s']}
            pairs.append({'pair':i,'case':name,'kind':ac['meta']['kind'],'n':ac['meta']['n'],'fixed_output':ac['meta']['fixed_output'],
                'runtime_checks':runtime,'matched':matched,'full_trials_complete':complete,'bounded_eligible':eligible,
                'strict_eligible':eligible and ac['strict_clean'] and bc['strict_clean'],
                'equal_output_tokens':ac['output_tokens']==bc['output_tokens'],'equal_answers':ac['answer_sha256']==bc['answer_sha256'],
                'original':ac['summary'],'tuned':bc['summary'],'change_pct':delta,'regression_flags':regression})
    aggregates=[]
    for name in sorted(set(p['case'] for p in pairs)):
        cells=[p for p in pairs if p['case']==name and p['bounded_eligible']]
        if not cells:continue
        flags={k:sum(c['regression_flags'][k] for c in cells) for k in cells[0]['regression_flags']}
        aggregates.append({'case':name,'kind':cells[0]['kind'],'n':cells[0]['n'],'matched_pairs':len(cells),'strict_pairs':sum(c['strict_eligible'] for c in cells),
            'fixed_output':cells[0]['fixed_output'],'all_output_counts_equal':all(c['equal_output_tokens'] for c in cells),
            'original':{k:values([c['original'].get(k) for c in cells]) for k in METRICS},
            'tuned':{k:values([c['tuned'].get(k) for c in cells]) for k in METRICS},
            'paired_change_pct':{k:values([c['change_pct'].get(k) for c in cells]) for k in METRICS},
            'repeated_regression_metrics':[k for k,v in flags.items() if len(cells)==3 and v==3], 'regression_pair_counts':flags})
    output={'runs':runs,'pairs':pairs,'aggregates':aggregates,'rules':{'strict':'Zero host pageouts plus bounded criteria','bounded':'<=256 host pages, main CPU VmSwap0 and complete edge coverage, valid requests/isolation/context and matched runtime/input hashes; whole trial complete','regression':'Both >10% and >0.2s; repeated flag requires all3 pairs. Variable-output and actual-tool followups remain identified.'}}
    (ROOT/'analysis.json').write_text(json.dumps(output,indent=2)+'\n')
    table=['# Individual typical-load comparisons','', 'Percentages use matched, complete trials meeting declared bounded pageout criteria. Variable-output reasoning/tools show observed latency; output counts are reported. Live tool continuations with differing payloads are excluded.','', '| Case | Pair | Eligible | Original wall s | Tuned wall s | Wall Δ% | Original TTFT p50 s | Tuned TTFT p50 s | TTFT Δ% | Equal output counts |','|---|---:|---|---:|---:|---:|---:|---:|---:|---|']
    for p in pairs:
        def fmt(v):return f'{v:.3f}' if v is not None else '—'
        table.append(f"| {p['case']} | {p['pair']} | {p['bounded_eligible']} | {fmt(p['original']['wall_s'])} | {fmt(p['tuned']['wall_s'])} | {fmt(p['change_pct']['wall_s'])} | {fmt(p['original']['ttft_p50_s'])} | {fmt(p['tuned']['ttft_p50_s'])} | {fmt(p['change_pct']['ttft_p50_s'])} | {p['equal_output_tokens']} |")
    (ROOT/'TABLES.md').write_text('\n'.join(table)+'\n')
    print(json.dumps({'complete_primary_runs':[r['id'] for r in runs if r['completed'] and r['id'] in plan_ids],'preserved_pilots':[r['id'] for r in runs if r['id'] not in plan_ids],'paired_cases':len(pairs),'three_pair_cells':sum(c['matched_pairs']==3 for c in aggregates),'repeated_regressions':[{'case':c['case'],'metrics':c['repeated_regression_metrics']} for c in aggregates if c['repeated_regression_metrics']]}))


if __name__=='__main__':main()
