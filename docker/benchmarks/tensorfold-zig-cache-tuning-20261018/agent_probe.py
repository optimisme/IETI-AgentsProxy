#!/usr/bin/env python3
"""Frozen longer assistant/tool histories; no actual tools are executed."""
import argparse
import json
from pathlib import Path

import benchmark as bench

p = argparse.ArgumentParser()
p.add_argument('--base', default='http://127.0.0.1:8000')
p.add_argument('--out', required=True)
p.add_argument('--tag', default='A')
args = p.parse_args()
out = Path(args.out)
out.mkdir(parents=True, exist_ok=True)
data = json.loads(Path('fixtures.json').read_text())
frozen = json.loads(Path('agent-fixtures.json').read_text())
model = bench.api(args.base, '/v1/models')['data'][0]['id']
tools = [{'type': 'function', 'function': {'name': 'read_test_log',
    'description': 'Read the local test results supplied by the coding agent.',
    'parameters': {'type': 'object', 'properties': {'path': {'type': 'string'}}, 'required': ['path']}}}]

def payload(history):
    body = bench.body(model, history, 128)
    body['tools'] = tools
    body['tool_choice'] = 'none'
    return body

preflight = payload([
    {'role': 'user', 'content': 'Inspect the supplied test result.'},
    {'role': 'assistant', 'content': 'I will read the log.', 'tool_calls': [
        {'id': 'call_preflight', 'type': 'function', 'function':
            {'name': 'read_test_log', 'arguments': '{"path":"tests.log"}'}}]},
    {'role': 'tool', 'tool_call_id': 'call_preflight', 'content': 'All tests passed.'},
    {'role': 'user', 'content': 'Reply with OK only.'},
])
preflight.update(stream=False, max_tokens=8, ignore_eos=False)
preflight.pop('stream_options')
check = bench.api(args.base, '/v1/chat/completions', preflight)
(out / 'history-preflight.json').write_text(json.dumps(check, indent=2) + '\n')
assert check['choices'][0]['message'].get('content', '').strip() == 'OK', check

histories, first, second, branches = [], [], [], []
for i in range(16):
    size = '1800' if i < 8 else '7400' if i < 15 else '65000'
    h = [{'role': 'user', 'content':
        f'IETI frozen coding workflow {args.tag}; independent project {i}.\n' + data[size] +
        '\nThese are project notes. Explain how to validate an LRU cache. Use text, with no new tool calls.'}]
    step = h + [{'role': 'assistant', 'content': frozen['assistant'][i],
        'tool_calls': [{'id': f'call_log_{i}', 'type': 'function', 'function':
            {'name': 'read_test_log', 'arguments': json.dumps({'path': f'tests/project_{i}.log'})}}]},
        {'role': 'tool', 'tool_call_id': f'call_log_{i}', 'content': frozen['tool_log']},
        {'role': 'user', 'content': 'Use the supplied test log. Explain the first concurrency regression test; no new tools.'}]
    next_step = step + [{'role': 'assistant', 'content': frozen['assistant'][(i + 1) % 16]},
        {'role': 'user', 'content': 'Now examine eviction while concurrent updates occur. Explain the test in text; no tools.'}]
    branch = step[:-1] + [{'role': 'user', 'content':
        'Instead of that earlier request, focus on eviction order. Explain the regression test in text; no tools.'}]
    histories.append(h)
    first.append(step)
    second.append(next_step)
    branches.append(branch)

(out / 'metadata-agent.json').write_text(json.dumps({
    'model': model, 'tag': args.tag, 'health': bench.api(args.base, '/health'),
    'memory': bench.memory(), 'tools_executed': False,
    'assistant_source': frozen['source'], 'tool_log_rows': 48,
}, indent=2) + '\n')
for phase, rows in [('cold', histories), ('growth1', first), ('growth2', second), ('branch', branches)]:
    bench.cohort(args.base, f'agent16-{phase}-{args.tag}', [payload(h) for h in rows], out)
