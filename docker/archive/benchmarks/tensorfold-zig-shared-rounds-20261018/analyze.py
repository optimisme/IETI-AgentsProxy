#!/usr/bin/env python3
"""Only compare identical full requests with no prefix hits or external inference."""
import argparse
import json
from pathlib import Path

root = Path(__file__).resolve().parent
prior = root.parent / 'tensorfold-zig-release110-20261018/mlx-fp8-batched-mtp-v3'
p = argparse.ArgumentParser()
p.add_argument('--candidate', default='recurrent-on', choices=['recurrent-on', 'fused-on'])
a = p.parse_args()

def read(directory, name):
    f = directory / (name + '.json')
    return json.loads(f.read_text()) if f.exists() else None

def eligibility(r):
    if r is None:
        return ['missing']
    s = r['summary']
    reasons = []
    if not s['successes'] == s['full_output_requests'] == s['requests']:
        reasons.append('incomplete')
    if s.get('external_requests') != 0:
        reasons.append('external inference or unverified counters')
    if s['cached_tokens'] != 0:
        reasons.append('prefix cache hit')
    if s['oom_kills'] or s['swap_out_pages']:
        reasons.append('OOM or active swap-out')
    return reasons

rows, excluded = [], []
for label, directory in [('Python 2225', root/'python-2225'), ('Python 2226', root/'python-2226'),
                         ('Previous Zig v3', prior), ('Shared batching off', root/'recurrent-off'),
                         ('Pointer-table batching', root/'recurrent-on')]:
    if directory == root/a.candidate:
        continue
    for name in ['code1-trial0', 'code16-trial0', 'code1-trial1', 'code16-trial1', 'cold-16000']:
        reference, candidate = read(directory, name), read(root/a.candidate, name)
        reasons = eligibility(reference) + eligibility(candidate)
        if not reasons:
            if [r['request_sha256'] for r in reference['requests']] != [r['request_sha256'] for r in candidate['requests']]:
                reasons.append('different payloads')
        if reasons:
            excluded.append({'reference': label, 'case': name, 'reasons': sorted(set(reasons))})
            continue
        r, c = reference['summary'], candidate['summary']
        row = {'reference': label, 'case': name, 'reference_summary': r, 'candidate_summary': c}
        for key, result in [('aggregate_output_tok_s', 'throughput_change_pct'), ('ttft_p50_s', 'ttft_change_pct'), ('wall_s', 'wall_change_pct')]:
            row[result] = 100 * (c[key]/r[key] - 1)
        rows.append(row)
capacity = read(root/a.candidate, 'capacity16-near75k')
result = {'candidate': a.candidate, 'comparisons': rows, 'excluded': excluded,
    'capacity': capacity['summary'] if capacity else None,
    'scope': 'Adapted recurrent batching on full TensorFold 1.1.0; contributor attention/prefill optimizations are not included.'}
(root/(a.candidate+'-comparison.json')).write_text(json.dumps(result, indent=2) + '\n')
for r in rows:
    if r['case'] in ('code16-trial1', 'cold-16000'):
        print(f"{r['reference']}: {r['case']} throughput {r['throughput_change_pct']:+.2f}%, TTFT {r['ttft_change_pct']:+.2f}%")
print('capacity:', result['capacity'])
