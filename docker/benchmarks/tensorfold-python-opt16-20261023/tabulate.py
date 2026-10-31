#!/usr/bin/env python3
"""Generate raw trial tables from read-only analysis; no recommendation is inferred."""
import json
from pathlib import Path
ROOT=Path(__file__).resolve().parent

def number(x):
    return '—' if x is None else f'{x:.2f}'

def main():
    data=json.loads((ROOT/'analysis.json').read_text());lines=['# Recorded GPU trial tables','',
        'Generated from `analysis.json`; individual runs and incomplete trials remain visible.', '',
        '| Run | Stage | Full trial | Wall s | TTFT p50/p95 s | Output tok/s | Output overlap | Queue p95 s | Min free GiB | Host pageouts | Strict / bounded |',
        '|---|---|---|---:|---:|---:|---:|---:|---:|---:|---|']
    for run in data['runs']:
        for case in run['cases']:
            s=case['summary']
            lines.append(f"| {run['id']} | {case['name']} | {run['completed']} | {number(s['wall_s'])} | {number(s['ttft_p50_s'])} / {number(s['ttft_p95_s'])} | {number(s['aggregate_output_tok_s'])} | {s['peak_overlapping_output_streams']} | {number(case['queue_p95_s'])} | {number(s.get('min_available_gib'))} | {s['swap_out_pages']} | {case['clean']} / {case['bounded_background_noise']} |")
    lines.extend(['','## Matched primary changes','',
        'Negative latency/wall changes are improvements; positive throughput changes are improvements.', '',
        '| Analysis | Stage | Metric | Pairs | Median change % | Min/max % |','|---|---|---|---:|---:|---:|'])
    for group in data['primary_aggregate']:
        for metric,v in group['metrics'].items():
            lines.append(f"| {group['analysis']} | {group['case']} | {metric} | {v['n']} | {number(v['median_change_pct'])} | {number(v['min_change_pct'])} / {number(v['max_change_pct'])} |")
    lines.extend(['','## Whole matched timing sequence','', '| Pair | Eligible strict / bounded | Baseline s | Candidate s | Wall change % | Throughput change % |','|---|---|---:|---:|---:|---:|'])
    for v in data['primary_sequences']:
        lines.append(f"| {v['pair_id']} | {v['strict_eligible']} / {v['bounded_noise_eligible']} | {number(v['baseline_sequence_wall_s'])} | {number(v['candidate_sequence_wall_s'])} | {number(v['wall_change_pct'])} | {number(v['throughput_change_pct'])} |")
    lines.extend(['','## Separate functional recall','', '| Run | Passed |','|---|---:|'])
    for run in data['runs']:
        for check in run['functional_checks']:
            lines.append(f"| {run['id']} | {check['passed']}/{check['requests']} |")
    lines.extend(['','Strict means zero whole-host swap-out. Bounded allows at most 256 host pages (1 MiB),',
        'with full main-serving-process counter coverage and zero observed main-process CPU VmSwap.',
        'Both require full outputs, no unrelated requests or OOM. Primary aggregates additionally',
        'require both complete trials, identical payload/token/fixture hashes, common instrumentation,',
        'image, installed package versions/source hashes and common serving settings.',
        'A raw stage timing from a failed trial does not qualify that configuration.', ''])
    (ROOT/'TABLES.md').write_text('\n'.join(lines))

if __name__=='__main__':main()
