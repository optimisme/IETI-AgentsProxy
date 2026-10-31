#!/usr/bin/env python3
"""Compare INT4 with fresh MLX observations and the earlier FP4 campaign."""
import json
from pathlib import Path

root = Path(__file__).resolve().parent
previous = root.parent / 'tensorfold-zig-fp4-vs-mlx-20261018'
assert json.loads((root / 'engine-equivalence.json').read_text())['identical']


def compare(reference, candidate, historical):
    a, b = reference['summary'], candidate['summary']
    same = [r['request_sha256'] for r in reference['requests']] == [r['request_sha256'] for r in candidate['requests']]
    reasons = [] if same else ['request bodies differ']
    cold = a['name'].startswith(('code', 'prose', 'cold-', 'capacity')) or a['name'] == 'projects-cold16'
    for label, summary in [('reference', a), ('int4', b)]:
        if summary['external_requests'] != 0:
            reasons.append(label + ': external traffic or unavailable request counter')
        if summary['successes'] != summary['requests']:
            reasons.append(label + ': failed requests')
        if summary['full_output_requests'] != summary['requests']:
            reasons.append(label + ': output budget differs')
        if summary['oom_kills'] or summary['swap_out_pages']:
            reasons.append(label + ': memory pressure')
        if cold and summary['cached_tokens']:
            reasons.append(label + ': cached prompt tokens in nominally cold workload')
    return {'matching_requests': same, 'historical_reference': historical,
            'clean_observational_pair': not reasons, 'exclusions': reasons,
            'reference': a, 'int4': b,
            'output_rate_change_pct': (b['aggregate_output_tok_s'] / a['aggregate_output_tok_s'] - 1) * 100
                if a['aggregate_output_tok_s'] else None}


rows = []
for path in sorted((root / 'candidate-2226').glob('*.json')):
    candidate = json.loads(path.read_text())
    if 'summary' not in candidate:
        continue
    row = {'name': candidate['summary']['name']}
    fresh = root / 'baseline-2225' / path.name
    # Avoid another large, swapping capacity burst on the production baseline.
    reference = fresh if fresh.exists() else previous / 'baseline-2225' / path.name
    if reference.exists():
        row['versus_mlx'] = compare(json.loads(reference.read_text()), candidate, not fresh.exists())
    fp4 = previous / 'candidate-2226' / path.name
    if fp4.exists():
        row['versus_fp4'] = compare(json.loads(fp4.read_text()), candidate, True)
    rows.append(row)

aborts = []
for path in sorted((root / 'candidate-2226').glob('*-safety-abort.json')):
    sample = json.loads(path.read_text())
    mode = 'capacity' if path.name.startswith('capacity') else 'bench'
    metadata = json.loads((path.parent / ('metadata-' + mode + '.json')).read_text())
    aborts.append({'cohort': path.name.removesuffix('-safety-abort.json'),
                   'status': 'safety-aborted; no completed-cohort measurement',
                   'sample': sample, 'before_memory': metadata['memory'],
                   'additional_swap_out_pages': sample['pswpout'] - metadata['memory']['pswpout'],
                   'additional_oom_kills': sample['oom_kill'] - metadata['memory']['oom_kill']})

report = {'rows': rows, 'safety_aborts': aborts, 'limitations': [
    'FP4 observations are from the earlier campaign on the same physical host, not an alternated crossover.',
    'Native executable, AOT assets and Python helper sources were verified byte-identical before INT4 serving.',
    'All serving flags and tuning environment match FP4; model ID/revision and format-specific preparation differ.',
    'Fresh MLX measurements retain the running server state and use a different host/driver.',
    'MLX capacity uses the previous campaign to avoid repeating a swapping near-75k production load.',
    'External inference and memory-pressure cohorts are preserved but excluded from clean speed comparisons.',
    'Synthetic fixed-output benchmarks and tool/image smoke tests do not establish coding-agent quality.',
    'Completion of sixteen requests does not alone prove sixteen full contexts simultaneously resident.'
]}
(root / 'comparison.json').write_text(json.dumps(report, indent=2) + '\n')
for abort in aborts:
    print(abort['cohort'] + ': ' + abort['status'])
for row in rows:
    print(row['name'])
    for key in ('versus_mlx', 'versus_fp4'):
        if key not in row:
            continue
        x = row[key]
        a, b = x['reference'], x['int4']
        print(f"  {key}: {a['aggregate_output_tok_s']:.1f} -> {b['aggregate_output_tok_s']:.1f} tok/s; "
              f"TTFT {a['ttft_p50_s']} -> {b['ttft_p50_s']}; clean={x['clean_observational_pair']}; {x['exclusions']}")
