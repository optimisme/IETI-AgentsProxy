#!/usr/bin/env python3
"""Compare complete cohorts, retaining traffic/memory exclusions and exact outputs."""
import hashlib
import json
from pathlib import Path

root = Path(__file__).resolve().parent


def digest(r):
    return hashlib.sha256(json.dumps({k: r.get(k) for k in
        ('content', 'reasoning', 'tool_calls', 'finish_reason')}, sort_keys=True).encode()).hexdigest()


def cohorts(folder):
    rows = {}
    for f in (root / folder).glob('*.json'):
        j = json.loads(f.read_text())
        if 'summary' in j:
            rows[f.name] = j
    return rows


def pair(a, b):
    sa, sb = a['summary'], b['summary']
    same = [r['request_sha256'] for r in a['requests']] == [r['request_sha256'] for r in b['requests']]
    exclusions = [] if same else ['different request payloads']
    cold = 'cold' in sa['name'] or sa['name'].startswith(('code', 'prose', 'capacity'))
    for name, s in [('reference', sa), ('candidate', sb)]:
        if s['successes'] != s['requests'] or s['full_output_requests'] != s['requests']:
            exclusions.append(name + ': failed or short output')
        if s['external_requests'] != 0:
            exclusions.append(name + ': external inference or unavailable counter')
        if s['swap_out_pages'] or s['oom_kills']:
            exclusions.append(name + ': new swapping or OOM')
        if cold and s['cached_tokens']:
            exclusions.append(name + ': unexpected cold cache hits')
    return {'same_payloads': same, 'clean_pair': not exclusions, 'exclusions': exclusions,
            'reference': sa, 'candidate': sb,
            'output_rate_change_pct': (sb['aggregate_output_tok_s'] / sa['aggregate_output_tok_s'] - 1) * 100,
            'ttft_change_pct': (sb['ttft_p50_s'] / sa['ttft_p50_s'] - 1) * 100,
            'exact_output_pairs': sum(digest(x) == digest(y) for x, y in zip(a['requests'], b['requests'])),
            'request_pairs': len(a['requests'])}


result = {}
for variant in sorted(root.glob('zig*-main')):
    name = variant.name.removesuffix('-main')
    result[name] = {'versus_python': {}, 'versus_4096': {}, 'versus_gap8': {}}
    for kind, reference in [('main', 'python-same-host-2226'), ('probe', 'python-short-probe'), ('agent', 'python-agent')]:
        mine = cohorts(name + '-' + kind)
        py = cohorts(reference)
        control = cohorts('zig4096-' + kind)
        gap8 = cohorts('zig1024gap256-' + kind)
        for filename, row in mine.items():
            if filename in py:
                result[name]['versus_python'][row['summary']['name']] = pair(py[filename], row)
            if name != 'zig4096' and filename in control:
                result[name]['versus_4096'][row['summary']['name']] = pair(control[filename], row)
            if name != 'zig1024gap256' and filename in gap8:
                result[name]['versus_gap8'][row['summary']['name']] = pair(gap8[filename], row)

(root / 'comparison.json').write_text(json.dumps(result, indent=2) + '\n')
for variant, comparisons in result.items():
    print(variant)
    for name, row in comparisons['versus_python'].items():
        a, b = row['reference'], row['candidate']
        print(f"  {name}: rate {a['aggregate_output_tok_s']:.1f}->{b['aggregate_output_tok_s']:.1f}; "
              f"TTFT {a['ttft_p50_s']:.3f}->{b['ttft_p50_s']:.3f}; clean={row['clean_pair']}")
    checks = list(comparisons['versus_4096'].values())
    if checks:
        print('  Exact control outputs:', sum(x['exact_output_pairs'] for x in checks), '/',
              sum(x['request_pairs'] for x in checks))
