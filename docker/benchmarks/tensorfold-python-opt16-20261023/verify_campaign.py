#!/usr/bin/env python3
"""Read-only final audit of actual GPU evidence; does not launch tests or infer speedups."""
import hashlib,json
from pathlib import Path
ROOT=Path(__file__).resolve().parent

def load(path):return json.loads(path.read_text())

def main():
    data=load(ROOT/'analysis.json');runs={r['id']:r for r in data['runs']};checks=[]
    def check(name,ok,detail=None):checks.append({'name':name,'passed':bool(ok),'detail':detail})
    pairs=[p for p in data['primary_sequences'] if p['case_prefix']=='capacity-']
    check('three_complete_matched_primary_pairs',len(pairs)==3 and all(p['bounded_noise_eligible'] for p in pairs),pairs)
    ids=[f'{v}-capacity-{n}' for n in range(1,4) for v in ['baseline','candidate']]
    sustained=['reserve8tailorder64-sustained-screen1',*[f'candidate-sustained-qualification{n}' for n in [2,3]],'release-untraced-sustained1']
    others=['candidate-growth65k-qualification1','baseline-representative-1','candidate-representative-1','release-untraced-capacity1','release-untraced-representative1']
    for name in ids+sustained+others:
        r=runs.get(name)
        check(name+':complete',r is not None and r['completed'] and not r['safety_abort'])
        if r is None:continue
        for case in r['cases']:
            s=case['summary']
            check(name+':'+case['name']+':all_outputs',s['requests']==s['successes']==s['full_output_requests']==16)
            check(name+':'+case['name']+':context',all(u['input_tokens'] is not None and u['output_tokens'] is not None and u['input_tokens']+u['output_tokens']<=75000 for u in case['users']))
            check(name+':'+case['name']+':isolation',all(s.get(k)==0 for k in ['external_requests','initial_running','final_running','oom_kills']))
            if name.startswith('release-untraced-'):
                check(name+':'+case['name']+':bounded_host_pageout_and_main_CPU_swap',case['bounded_background_noise'])
                check(name+':'+case['name']+':RAM_guard',s.get('min_available_gib',0)>=6)
        for f in r['functional_checks']:check(name+':'+f['name']+':transport',f['all_transport_complete'])
    for name in [f'{v}-capacity-{n}' for v in ['baseline','candidate'] for n in [1,2,3]]+['release-untraced-capacity1']:
        r=runs.get(name)
        if not r:continue
        if name.startswith('candidate') or name.startswith('release'):
            for c in r['cases']:
                if c['name'].startswith('capacity-return'):check(name+':'+c['name']+':overlap16',c['summary']['peak_overlapping_output_streams']==16)
        if name!='baseline-capacity-1':
            f=next((x for x in r['functional_checks'] if x['kind']=='functional_agent_recall'),None)
            check(name+':explicit_ID_fork',f is not None and f['passed']==f['requests']==16)
    for name in sustained:
        r=runs.get(name)
        if r:
            check(name+':four_timed_rounds',len([c for c in r['cases'] if c['name'].startswith('sustained-')])==4)
            for c in r['cases']:
                if c['name'].startswith('sustained-return'):check(name+':'+c['name']+':overlap16',c['summary']['peak_overlapping_output_streams']==16)
    for name in ['baseline-representative-1','candidate-representative-1','release-untraced-representative1']:
        r=runs.get(name);p=ROOT/'results'/name/'client/smoke.json'
        smoke=load(p) if p.exists() else {}
        check(name+':native_tool',smoke.get('tool',{}).get('passed'))
        check(name+':inline_image',smoke.get('vision',{}).get('passed'))
        f=next((v for v in (r or {}).get('functional_checks',[]) if v['kind']=='functional_default_reasoning'),None)
        check(name+':default_reasoning_answers',f is not None and f['passed']==f['requests']==16)
    original=(runs.get('candidate-capacity-1') or {}).get('inventory') or {}
    bundle=ROOT.parent.parent/'patches/tensorfold-python-opt16-v065'
    for name in ['release-untraced-capacity1','release-untraced-sustained1','release-untraced-representative1']:
        inventory=(runs.get(name) or {}).get('inventory') or {}
        for field in ['image','packages','source_sha256']:check(name+':same_'+field,bool(original.get(field)) and original.get(field)==inventory.get(field))
        effective=(runs.get(name) or {}).get('effective_inventory') or {}
        old_effective=(runs.get('candidate-capacity-1') or {}).get('effective_inventory') or {}
        check(name+':same_effective_distribution_versions',bool(effective.get('effective_packages')) and effective.get('effective_packages')==old_effective.get('effective_packages'))
        path=ROOT/'results'/name/'runtime.log';text=path.read_text() if path.exists() else ''
        ready=next((json.loads(s.split('[ieti-opt16] ',1)[1]) for s in text.splitlines() if s.startswith('[ieti-opt16] ')),{})
        check(name+':no_profiling',ready.get('profiling') is False and ready.get('prefill_guard')==64)
        expected={p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(bundle.glob('*.py'))}
        check(name+':bundle_hashes',ready.get('policy_sha256')==expected)
        check(name+':constraints_hash',ready.get('constraints_sha256')==hashlib.sha256((bundle/'constraints.txt').read_bytes()).hexdigest())
    state=ROOT/'results/controller-result.json';controller=load(state) if state.exists() else {}
    check('last_controller_success_and_normal_restored',controller.get('error') is None and controller.get('original_python_healthy') is True)
    release_ids=['release-untraced-capacity1','release-untraced-sustained1','release-untraced-representative1']
    check('last_controller_is_current_release',controller.get('completed_runs')==release_ids and controller.get('epoch',0)>=max((load(ROOT/'results'/name/'result.json').get('epoch',float('inf')) if (ROOT/'results'/name/'result.json').exists() else float('inf') for name in release_ids)))
    result={'passed':all(x['passed'] for x in checks),'checks':checks,'note':'Requires actual completed GPU runs; preserves strict/host-pageout analysis distinctions and the failed stronger baseline. Reference/final command and source-sync hashes are recorded separately.'}
    (ROOT/'verification.json').write_text(json.dumps(result,indent=2)+'\n')
    print(json.dumps({'passed':result['passed'],'checks':len(checks),'failed':[x['name'] for x in checks if not x['passed']]}))
    return 0 if result['passed'] else 1

if __name__=='__main__':raise SystemExit(main())
