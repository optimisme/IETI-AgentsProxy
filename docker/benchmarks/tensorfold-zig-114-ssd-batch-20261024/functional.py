#!/usr/bin/env python3
"""Small greedy oracle: plain concurrent, resumed solo and drafted concurrent."""
import copy
import json
from pathlib import Path
import analyze
import screen

ROOT = Path(__file__).resolve().parent


def run(label, url):
    out = ROOT / (label + '-functional')
    out.mkdir(exist_ok=False)
    fixture = json.loads((ROOT / 'fixtures.json').read_text())['cases'][2]['payloads']
    payloads = copy.deepcopy(fixture)
    for i, p in enumerate(payloads):
        p.update(draft=False, max_tokens=64)
        notes = 'A loop maintains an accumulator and advances the counter by one at each iteration.\n' * 30
        p['messages'] = [{'role': 'user', 'content': f'PLE correctness control {i}. Study notes:\n' + notes + '\nWrite a Python function '
                         f'that returns the sum of squares of the integers from 1 to {17+i}, and explain its loop.'}]
    screen.cohort(url, {'name': 'plain', 'kind': 'functional', 'n': 4, 'payloads': payloads}, out)
    plain = json.loads((out / 'plain.json').read_text())['requests']
    solo = []
    for i, payload in enumerate(payloads):
        name = 'solo-' + str(i)
        screen.cohort(url, {'name': name, 'kind': 'functional', 'n': 1, 'payloads': [payload]}, out)
        solo += json.loads((out / (name + '.json')).read_text())['requests']
    drafted = [{**p, 'draft': True} for p in payloads]
    screen.cohort(url, {'name': 'drafted', 'kind': 'functional', 'n': 4, 'payloads': drafted}, out)
    drafts = json.loads((out / 'drafted.json').read_text())['requests']
    report = {'plain_equals_resumed_solo': [analyze.digest(a) == analyze.digest(b) for a, b in zip(plain, solo)],
              'plain_equals_drafted': [analyze.digest(a) == analyze.digest(b) for a, b in zip(plain, drafts)]}
    report['solo_cached_tokens'] = [r['usage'].get('prompt_tokens_details', {}).get('cached_tokens', 0) for r in solo]
    report['resume_exercised'] = all(n > 0 for n in report['solo_cached_tokens'])
    report['all_equal'] = all(report['plain_equals_resumed_solo'] + report['plain_equals_drafted'])
    screen.save(out / 'comparison.json', report)
    print('FUNCTIONAL ' + json.dumps(report), flush=True)
    return report
