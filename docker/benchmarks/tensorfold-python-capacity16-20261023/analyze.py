#!/usr/bin/env python3
"""Compare matching full-window requests with the completed vLLM GPU campaign."""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PYTHON = ROOT / 'isolated/python'
VLLM = ROOT.parent / 'vllm-fp8-agent-20261023/capacity-tuned-gmu082'


def clean(report):
    s = report['summary']
    return (s['requests'] == s['successes'] == s['full_output_requests'] == 16
            and all(s.get(k) == 0 for k in ('external_requests', 'initial_running',
                                           'final_running', 'swap_out_pages', 'oom_kills')))


def main():
    results = []
    observer = ROOT / 'isolated/engine-metrics.jsonl'
    samples = []
    if observer.exists():
        for line in observer.read_text().splitlines():
            try:
                sample = json.loads(line)
            except json.JSONDecodeError:
                continue
            if 'metrics' in sample:
                samples.append(sample)
    for name in ('capacity-cold16', 'capacity-return1-16', 'capacity-return2-16'):
        p = PYTHON / (name + '.json')
        bounds = PYTHON / (name + '-token-bounds.json')
        if not p.exists() or not bounds.exists():
            continue
        py = json.loads(p.read_text())
        vl = json.loads((VLLM / (name + '.json')).read_text())
        b = json.loads(bounds.read_text())
        ps, vs = py['summary'], vl['summary']
        hashes = lambda x: [r['request_sha256'] for r in x['requests']]
        matching = hashes(py) == hashes(vl)
        input_tokens_match = ps['input_tokens'] == vs['input_tokens']
        full = (ps['requests'] == ps['successes'] == ps['full_output_requests'] == 16
                and all(r['usage'].get('completion_tokens') == 896 for r in py['requests']))
        token_bounds = len(b['input_counts']) == 16 and max(b['input_counts']) + b['max_tokens'] <= b['context_limit'] == 75000
        live = [s.get('health', {}).get('streams', {}) for s in py['monitor']]
        peaks = {'decoding': max((s.get('decoding', 0) for s in live), default=0),
                 'prefilling': max((s.get('prefilling', 0) for s in live), default=0),
                 'combined': max((s.get('decoding', 0) + s.get('prefilling', 0) for s in live), default=0)}
        start = min(s['time'] for s in py['monitor'])
        end = max(s['time'] for s in py['monitor']) + 1
        observed = [s for s in samples if start <= s['time'] <= end]
        real = None
        if observed:
            real = {'first_observed_epoch': observed[0]['time'],
                    'last_observed_epoch': observed[-1]['time'],
                    'peak_running': max(s['metrics'].get('tensorfold:requests_running', 0) for s in observed),
                    'peak_waiting': max(s['metrics'].get('tensorfold:requests_waiting', 0) for s in observed),
                    'peak_live_cache_entries': max(len(s['kv_pool_usage']) for s in observed),
                    'peak_near_full_declared_context_entries': max(sum(v >= .98 for v in s['kv_pool_usage'].values()) for s in observed),
                    'scheduler_lane_yields_counter_min': min(s['metrics'].get('tensorfold:preemptions_total', 0) for s in observed),
                    'scheduler_lane_yields_counter_max': max(s['metrics'].get('tensorfold:preemptions_total', 0) for s in observed)}
        eligible = matching and input_tokens_match and token_bounds and clean(py) and clean(vl)
        pair = {'case': name, 'matched_request_hashes': matching,
                'actual_input_token_counts_match': input_tokens_match,
                'eligible_for_clean_percent_comparison': eligible,
                'all_16_full_outputs': full, 'token_bounds_met': token_bounds,
                'max_input_plus_output': max(b['input_counts']) + b['max_tokens'],
                'sixteen_output_streams_overlap': ps.get('peak_overlapping_output_streams') == 16,
                'peak_python_engine_streams': peaks,
                'python': ps, 'vllm': vs,
                'observed_python_metrics': real,
                'preemption_note': 'Frozen client health fields default to zero. The independent Prometheus observer records real waiting and preemption counters; CUDA preemptions_total counts scheduler lane yields.'}
        if eligible:
            pair['python_vs_vllm_change_pct'] = {
                field: (ps[field] / vs[field] - 1) * 100
                for field in ('wall_s', 'aggregate_output_tok_s', 'ttft_p50_s', 'ttft_p95_s')
                if vs.get(field) and ps.get(field) is not None}
        results.append(pair)
    complete = len(results) == 3
    capacity = complete and all(r['all_16_full_outputs'] and r['token_bounds_met']
                               and r['sixteen_output_streams_overlap'] for r in results)
    assessment = {'complete': complete,
        'sixteen_near_full_context_output_overlap_observed': capacity,
        'sixteen_near_full_context_output_overlap_observed_any_completed_stage': any(r['all_16_full_outputs'] and r['token_bounds_met'] and r['sixteen_output_streams_overlap'] for r in results),
        'zero_swap_oom_all_stages': complete and all(r['python']['swap_out_pages'] == r['python']['oom_kills'] == 0 for r in results),
        'all_payloads_match_vllm': complete and all(r['matched_request_hashes'] for r in results),
        'completed_requests': sum(r['python']['successes'] for r in results),
        'full_output_requests': sum(r['python']['full_output_requests'] for r in results),
        'total_generated_tokens': sum(r['python']['output_tokens'] for r in results),
        'all_three_comparisons_clean': complete and all(r['eligible_for_clean_percent_comparison'] for r in results),
        'independent_python_engine_metrics_available': bool(samples), 'stages': results}
    (ROOT / 'comparison.json').write_text(json.dumps(assessment, indent=2) + '\n')
    print(json.dumps({k: v for k, v in assessment.items() if k != 'stages'}, indent=2))
    for r in results:
        print(r['case'], 'overlap', r['python']['peak_overlapping_output_streams'],
              'engine', r['peak_python_engine_streams'], 'wall', r['python']['wall_s'],
              'clean', r['eligible_for_clean_percent_comparison'],
              'changes', r.get('python_vs_vllm_change_pct'))


if __name__ == '__main__':
    main()
