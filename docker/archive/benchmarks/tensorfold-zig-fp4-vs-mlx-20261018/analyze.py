#!/usr/bin/env python3
"""Join measured cohorts; keep failed/contaminated pairs visible and excluded."""
import json
from pathlib import Path

root = Path(__file__).resolve().parent
rows = []
for path in sorted((root / 'baseline-2225').glob('*.json')):
    baseline = json.loads(path.read_text())
    other = root / 'candidate-2226' / path.name
    if 'summary' not in baseline or not other.exists():
        continue
    candidate = json.loads(other.read_text())
    if 'summary' not in candidate:
        continue
    a, b = baseline['summary'], candidate['summary']
    for report, summary in ((baseline, a), (candidate, b)):
        snapshots = [s.get('health', {}) for s in report['monitor']]
        summary['peak_reported_engine_active'] = max((h.get('resident_streams',
            sum(h.get('streams', {}).get(k, 0) for k in ('decoding', 'prefilling'))) for h in snapshots), default=0)
        summary['peak_reported_near_full_native_caches'] = max((sum(v >= .98 for v in h.get('kv_cache_usage_ratio', []))
                                                     for h in snapshots), default=0)
    matches = [r['request_sha256'] for r in baseline['requests']] == [r['request_sha256'] for r in candidate['requests']]
    reasons = []
    if not matches:
        reasons.append('request bodies differ')
    for label, summary in [('baseline', a), ('candidate', b)]:
        if summary['external_requests'] != 0:
            reasons.append(label + ': external traffic or unavailable request counter')
        if summary['successes'] != summary['requests']:
            reasons.append(label + ': failed requests')
        if summary['full_output_requests'] != summary['requests']:
            reasons.append(label + ': truncated/early output compared with fixed token budget')
        if summary['oom_kills'] or summary['swap_out_pages']:
            reasons.append(label + ': memory pressure')
    rows.append({'name': a['name'], 'matching_requests': matches, 'clean_performance_pair': not reasons,
                 'exclusions': reasons, 'baseline': a, 'candidate': b,
                 'output_rate_change_pct': (b['aggregate_output_tok_s'] / a['aggregate_output_tok_s'] - 1) * 100
                    if a['aggregate_output_tok_s'] else None,
                 'median_ttft_change_pct': (b['ttft_p50_s'] / a['ttft_p50_s'] - 1) * 100
                    if a['ttft_p50_s'] is not None and b['ttft_p50_s'] is not None else None})

result = {'comparison': rows,
          'limitations': ['Different physical GB10 hosts and NVIDIA drivers; no same-host crossover.',
                          'Baseline is an existing running server with retained state, candidate starts fresh.',
                          'Two short decode cohorts per workload; long-context cohorts are single observations.',
                          'Temperature 0, thinking disabled, 256 decode tokens or 128 conversation tokens.',
                          'Throughput is output usage tokens divided by whole-cohort wall time, including prefill.',
                          'Tool and image checks are smoke checks, not a coding-quality evaluation.',
                          'Native health/metrics normalization was added after the baseline; inference request bodies are hash-checked.',
                          'Sixteen HTTP completions do not alone prove sixteen full KV contexts resident together.']}
(root / 'comparison.json').write_text(json.dumps(result, indent=2) + '\n')
for r in rows:
    a, b = r['baseline'], r['candidate']
    print(f"{r['name']:28} {a['aggregate_output_tok_s']:7.1f} -> {b['aggregate_output_tok_s']:7.1f} tok/s; "
          f"TTFT {a['ttft_p50_s']} -> {b['ttft_p50_s']}; clean={r['clean_performance_pair']}; {r['exclusions']}")
