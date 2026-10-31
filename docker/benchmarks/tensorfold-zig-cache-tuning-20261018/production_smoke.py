#!/usr/bin/env python3
"""GPU API compatibility checks after installing the selected production profile."""
import argparse
import json
import re
from pathlib import Path

import benchmark as bench

p = argparse.ArgumentParser()
p.add_argument('--base', default='http://127.0.0.1:8000')
p.add_argument('--out', required=True)
args = p.parse_args()
out = Path(args.out)
out.mkdir(parents=True, exist_ok=True)
canonical = 'azampatti/Qwen3.8-Flash-Next-125B-A5B-INT4-AutoRound'
legacy = 'TensorFold/Qwen3.8-Flash-Next-MLX-4bit-MTP'
models = bench.api(args.base, '/v1/models')
assert {canonical, legacy}.issubset({x['id'] for x in models['data']}), models
results = {'models': models, 'health': bench.api(args.base, '/health')}
assert results['health']['max_batch_size'] == 16
for label, model in [('canonical', canonical), ('legacy', legacy)]:
    target = out / label
    target.mkdir(exist_ok=True)
    bench.smoke(args.base, model, target)
    smoke = json.loads((target / 'smoke.json').read_text())
    assert smoke['tool']['passed'] and smoke['vision']['passed'], smoke
    results[label + '_tool_and_image'] = True

messages = [{'role': 'user', 'content': 'Compute 19 times 23. Give the final integer only.'}]
thinking = {'model': legacy, 'messages': messages, 'max_tokens': 128,
    'temperature': 0, 'thinking_budget': 32, 'reasoning_effort': 'low',
    'chat_template_kwargs': {'enable_thinking': True}, 'stream': False}
reply = bench.api(args.base, '/v1/chat/completions', thinking)
(out / 'thinking.json').write_text(json.dumps(reply, indent=2) + '\n')
message = reply['choices'][0]['message']
assert message.get('reasoning_content'), reply
assert re.search(r'\b437\b', message.get('content', '')), reply
messages += [message, {'role': 'user', 'content': 'Now add one. Give the integer only.'}]
follow = bench.api(args.base, '/v1/chat/completions', {
    'model': legacy, 'messages': messages, 'max_tokens': 32, 'temperature': 0,
    'chat_template_kwargs': {'enable_thinking': False}, 'stream': False})
(out / 'reasoning-history-followup.json').write_text(json.dumps(follow, indent=2) + '\n')
assert re.search(r'\b438\b', follow['choices'][0]['message'].get('content', '')), follow
results.update(thinking_and_reasoning_history=True, legacy_model_alias=True)
(out / 'summary.json').write_text(json.dumps(results, indent=2) + '\n')
print(json.dumps({'passed': True, 'canonical_and_legacy_tool_image': True,
                  'thinking_and_reasoning_history': True}))
