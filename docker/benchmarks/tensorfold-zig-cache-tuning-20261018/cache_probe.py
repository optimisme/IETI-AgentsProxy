#!/usr/bin/env python3
"""Length-specific cache cohorts using the campaign's unchanged SSE client/guards."""
import argparse
import json
from pathlib import Path

import benchmark as bench

p = argparse.ArgumentParser()
p.add_argument('--base', default='http://127.0.0.1:8000')
p.add_argument('--out', required=True)
p.add_argument('--fixtures', default='fixtures.json')
p.add_argument('--tag', default='A')
args = p.parse_args()
out = Path(args.out)
out.mkdir(parents=True, exist_ok=True)
data = json.loads(Path(args.fixtures).read_text())
model = bench.api(args.base, '/v1/models')['data'][0]['id']
(out / 'probe-metadata.json').write_text(json.dumps({
    'model': model, 'tag': args.tag, 'health': bench.api(args.base, '/health'),
    'memory': bench.memory(), 'thinking': False, 'output_tokens': 64,
}, indent=2) + '\n')
for count in (1, 4, 16):
    histories = [[{'role': 'user', 'content':
        f'IETI cache probe {args.tag}; short cohort {count}; project {i}.\n' + data['1800']}]
        for i in range(count)]
    grown = [h + [{'role': 'assistant', 'content': 'I will preserve the public interface and add regression coverage.'},
                   {'role': 'user', 'content': 'Describe the first regression test.'}] for h in histories]
    branch = [h + [{'role': 'assistant', 'content': 'I will preserve the public interface and add regression coverage.'},
                    {'role': 'user', 'content': 'Instead, describe a concurrency regression test.'}] for h in histories]
    for phase, rows in [('cold', histories), ('growth', grown), ('branch', branch)]:
        bench.cohort(args.base, f'short{count}-{phase}-{args.tag}',
                     [bench.body(model, h, 64) for h in rows], out)
