#!/usr/bin/env python3
"""Compare the same executable with host PLE grouping off and on."""
import hashlib
import json
import math
import statistics
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def digest(reply):
    data = {k: reply[k] for k in ('content', 'reasoning')}
    return hashlib.sha256(json.dumps(data, sort_keys=True).encode()).hexdigest()


def main():
    rows = []
    for case in json.loads((ROOT / 'fixtures.json').read_text())['cases']:
        a, b = [json.loads((ROOT / label / (case['name'] + '.json')).read_text()) for label in ('off', 'on')]
        x, y = a['summary'], b['summary']
        requests_match = [r['request_sha256'] for r in a['requests']] == [r['request_sha256'] for r in b['requests']]
        output_matches = [digest(r) == digest(s) for r, s in zip(a['requests'], b['requests'])]
        token_matches = [r['usage'].get('completion_tokens') == s['usage'].get('completion_tokens') and
                         r['usage'].get('prompt_tokens') == s['usage'].get('prompt_tokens')
                         for r, s in zip(a['requests'], b['requests'])]
        clean = all(v['successes'] == v['full_outputs'] == v['requests'] and
                    v['pageouts'] == v['oom_kills'] == v['external_requests'] == v['final_running'] == 0
                    for v in (x, y))
        rows.append({'case': case['name'], 'kind': case['kind'], 'n': case['n'], 'turn': case.get('turn'),
            'matched_requests': requests_match, 'equal_input_output_counts': all(token_matches),
            'equal_output_text': all(output_matches), 'output_matches': output_matches,
            'strict_clean': clean, 'off': x, 'on': y, 'ratio': y['output_tok_s'] / x['output_tok_s'],
            'ttft_regression': y['ttft_p50_s'] > x['ttft_p50_s'] * 1.1 and
                               y['ttft_p50_s'] - x['ttft_p50_s'] > .1})
    def mean_ratio(selected):
        return math.exp(statistics.mean(math.log(r['ratio']) for r in selected))
    code = [r for r in rows if r['kind'] == 'short' and r['n'] == 8]
    prose = [r for r in rows if r['kind'] == 'prose']
    result = {'rows': rows, 'code8_geomean': mean_ratio(code), 'prose8_geomean': mean_ratio(prose),
        'all_equal': all(r['matched_requests'] and r['equal_input_output_counts'] and r['equal_output_text'] for r in rows),
        'all_strict_clean': all(r['strict_clean'] for r in rows),
        'primary_ttft_regressions': sum(r['ttft_regression'] for r in code + prose)}
    result['provisional_gain_gate'] = (result['all_equal'] and result['all_strict_clean'] and
        result['code8_geomean'] >= 1.1 and result['prose8_geomean'] >= 1.1 and
        all(r['ratio'] >= 1.1 for r in code + prose) and result['primary_ttft_regressions'] == 0)
    result['needs_confirmation'] = (result['all_equal'] and
        min(result['code8_geomean'], result['prose8_geomean']) >= 1.05)
    (ROOT / 'comparison.json').write_text(json.dumps(result, indent=2) + '\n')
    table = ['| Cas | Off tok/s | On tok/s | Canvi | TTFT off → on | Text igual | Net |',
             '|---|---:|---:|---:|---:|---|---|']
    for r in rows:
        a, b = r['off'], r['on']
        table.append(f"| {r['case']} | {a['output_tok_s']:.2f} | {b['output_tok_s']:.2f} | {(r['ratio']-1)*100:+.1f}% | "
                     f"{a['ttft_p50_s']:.3f} → {b['ttft_p50_s']:.3f} s | {r['equal_output_text']} | {r['strict_clean']} |")
    (ROOT / 'TABLES.md').write_text('\n'.join(table) + '\n')
    print(json.dumps({k: v for k, v in result.items() if k != 'rows'}), flush=True)


if __name__ == '__main__':
    main()
