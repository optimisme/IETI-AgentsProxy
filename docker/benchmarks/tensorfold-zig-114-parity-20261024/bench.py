#!/usr/bin/env python3
"""Quick same-GPU parity probe: selected fixture cohorts from the 1.1.4 screening, loopback only."""
import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SCREEN = ROOT.parent / 'tensorfold-zig-114-ssd-batch-20261024'
sys.path.insert(0, str(SCREEN))
import screen  # noqa: E402

parser = argparse.ArgumentParser()
parser.add_argument('--url', default='http://127.0.0.1:8007')
parser.add_argument('--cases', default='short-n8-case0,short-n8-case1,prose-n8-case0')
parser.add_argument('--out', required=True)
args = parser.parse_args()
out = ROOT / args.out
out.mkdir(parents=True, exist_ok=False)
cases = {c['name']: c for c in json.loads((SCREEN / 'fixtures.json').read_text())['cases']}
# 16 users at once: two distinct 8-user cases' requests released together
for kind, pairs in (('short', ((0, 1),)), ('prose', ((0, 1), (1, 2)))):
    for i, (a, b) in enumerate(pairs):
        one, two = cases[f'{kind}-n8-case{a}'], cases[f'{kind}-n8-case{b}']
        cases[f'{kind}-n16-case{i}'] = {**one, 'name': f'{kind}-n16-case{i}', 'n': 16, 'payloads': one['payloads'] + two['payloads']}
warm = cases['short-n1-case0']['payloads'][0]
warm = {**warm, 'messages': [{'role': 'user', 'content': 'Unmeasured warmup: count the first ten integers.'}], 'max_tokens': 32}
assert screen.request(args.url, warm)['error'] is None
for name in args.cases.split(','):
    screen.cohort(args.url, cases[name], out)
