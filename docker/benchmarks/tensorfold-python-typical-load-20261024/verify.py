#!/usr/bin/env python3
"""Audit completed collection; performance/semantic outcomes stay separate."""
import hashlib,json
from pathlib import Path
ROOT=Path(__file__).resolve().parent


def main():
    d=json.loads((ROOT/'analysis.json').read_text());plan=json.loads((ROOT/'plan.json').read_text());checks=[]
    def check(name,ok):checks.append({'name':name,'passed':bool(ok)})
    runs={x['id']:x for x in d['runs']};fixture=json.loads((ROOT/'fixtures.json').read_text())
    expected={x['name'] for x in fixture['cases']}|{f'tool-return-n{n}' for n in [1,2,4,8]}
    for p in plan['runs']:
        r=runs.get(p['id']);check(p['id']+':completed',r is not None and r['completed'] and not r['guard_abort'])
        if r is None:continue
        check(p['id']+':all_cases',set(r['cases'])==expected)
        for name,c in r['cases'].items():
            check(p['id']+':'+name+':transport_context_memory',c['valid_transport'] and c['all_within_context'] and c['bounded_clean'])
        check(p['id']+':normal_reasoning_tool_cases',len((r['quality'] or {}).get('cases',[]))==12)
        log=(ROOT/'results'/p['id']/'runtime.log').read_text()
        ready=next((json.loads(s.split('[ieti-lowload] ',1)[1]) for s in log.splitlines() if s.startswith('[ieti-lowload] ')),{})
        check(p['id']+':launcher_no_internal_profiling',ready.get('variant')==p['variant'] and ready.get('internal_profiling') is False)
        if p['variant']=='tuned':
            hook=next((json.loads(s.split('[ieti-opt16] ',1)[1]) for s in log.splitlines() if s.startswith('[ieti-opt16] ')),{})
            bundle=ROOT.parent.parent/'patches/tensorfold-python-opt16-v065'
            check(p['id']+':qualified_bundle',hook.get('profiling') is False and hook.get('prefill_guard')==64 and hook.get('policy_sha256')=={p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(bundle.glob('*.py'))})
        else:check(p['id']+':original_no_opt16_hooks','[ieti-opt16] ' not in log)
    aggregates={x['case']:x for x in d['aggregates']}
    for name in sorted(x['name'] for x in fixture['cases']):check(name+':three_complete_matched_pairs',aggregates.get(name,{}).get('matched_pairs')==3)
    state=ROOT/'results/controller-result.json';controller=json.loads(state.read_text()) if state.exists() else {}
    check('normal_restored_controller',controller.get('error') is None and controller.get('original_python_healthy') is True and controller.get('completed_runs',[])[-len(plan['runs']):]==[r['id'] for r in plan['runs']])
    semantic=[{'run':r['id'],'case':c['case'],'passed':c['passed'],'requests':c['requests']} for r in d['runs'] if r['id'] in {p['id'] for p in plan['runs']} for c in (r['quality'] or {}).get('cases',[])]
    output={'passed':all(c['passed'] for c in checks),'checks':checks,'all_semantic_checks_pass':bool(semantic) and all(c['passed']==c['requests'] for c in semantic),'semantic_results':semantic,
        'repeated_latency_regressions':[{'case':c['case'],'metrics':c['repeated_regression_metrics']} for c in d['aggregates'] if c['repeated_regression_metrics']],
        'note':'passed means complete evidence collection/integrity, not absence of latency regressions or approval to deploy. Service fingerprints and final source synchronization are audited separately.'}
    (ROOT/'verification.json').write_text(json.dumps(output,indent=2)+'\n')
    print(json.dumps({'passed':output['passed'],'checks':len(checks),'failed':[c['name'] for c in checks if not c['passed']],'all_semantic_checks_pass':output['all_semantic_checks_pass'],'repeated_latency_regressions':output['repeated_latency_regressions']}))
    return 0 if output['passed'] else 1


if __name__=='__main__':raise SystemExit(main())
