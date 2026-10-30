#!/usr/bin/env python3
"""Closed-loop coding-agent load: N users, each running T turns of shared system prompt + growing history.

Each turn replays the model's actual reply and appends a tool result (a real source file or command output),
then waits a short tool-execution time before sending the next turn. Users start staggered, like students do.
"""
import argparse
import concurrent.futures
import json
import os
import random
import sys
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT.parent / 'tensorfold-zig-114-ssd-batch-20261024'))
import screen  # noqa: E402

# reply length per turn: tool calls are short, edits and explanations longer
REPLIES = [160, 96, 384, 128, 512, 96, 256, 640, 128, 384, 96, 512]

parser = argparse.ArgumentParser()
parser.add_argument('--url', default='http://127.0.0.1:8007')
parser.add_argument('--users', type=int, default=8)
parser.add_argument('--turns', type=int, default=8)
parser.add_argument('--stagger', type=float, default=6.0, help='users start spread over this many seconds')
parser.add_argument('--tag', default='agent')
parser.add_argument('--out', required=True)
parser.add_argument('--temperature', type=float, default=0.0, help='0: greedy (batched drafts); OpenCode sends its own')
parser.add_argument('--top-p', type=float, default=0.95)
args = parser.parse_args()
out = ROOT / args.out
out.mkdir(parents=True, exist_ok=False)
fx = json.loads((ROOT / 'agent-fixture.json').read_text())
files = fx['files']


def tool(user, turn, rng):
    if turn % 4 == 3:
        n = rng.randint(4, 30)
        lines = [f'  ok {i + 1} - {fx["tasks"][(user + i) % len(fx["tasks"])][:60]}' for i in range(n)]
        return f'$ npm test\n# tests {n + 1}\n' + '\n'.join(lines) + f'\n  not ok {n + 1} - expected 200, got 500\n# fail 1\nexit code 1'
    f = files[(user * 7 + turn * 3) % len(files)]
    text = f['text'][:rng.randint(3000, 9000)]
    return f'<file path="{f["path"]}">\n' + '\n'.join(f'{i + 1}\t{l}' for i, l in enumerate(text.splitlines())) + '\n</file>'


def body(messages, n):
    return {'model': '', 'messages': messages, 'max_tokens': n, 'temperature': args.temperature, 'top_p': args.top_p, 'top_k': 20,
            'seed': 180026, 'ignore_eos': True, 'chat_template_kwargs': {'enable_thinking': False},
            'stream': True, 'stream_options': {'include_usage': True}}


def agent(user, t0):
    rng = random.Random(f'{args.tag}-{user}')
    time.sleep(max(0.0, t0 + rng.uniform(0, args.stagger) - time.monotonic()))
    messages = [{'role': 'system', 'content': fx['system']},
                {'role': 'user', 'content': f'[{args.tag} user {user}] {fx["tasks"][user % len(fx["tasks"])]}'}]
    rows = []
    for turn in range(args.turns):
        n = REPLIES[turn % len(REPLIES)]
        r = screen.request(args.url, body(messages, n))
        u = r['usage']
        rows.append({'user': user, 'turn': turn, 'start': r['started_monotonic'] - t0, 'ttft_s': r['ttft_s'],
                     'elapsed_s': r['elapsed_s'], 'error': r['error'], 'prompt_tokens': u.get('prompt_tokens'),
                     'cached_tokens': (u.get('prompt_tokens_details') or {}).get('cached_tokens'),
                     'completion_tokens': u.get('completion_tokens')})
        if r['error']:
            print('error', user, turn, r['error'][:300], flush=True)
            break
        messages.append({'role': 'assistant', 'content': r['content']})
        time.sleep(rng.uniform(0.3, 1.5))
        messages.append({'role': 'user', 'content': 'Tool result:\n' + tool(user, turn, rng)})
    return rows


before = screen.memory()
stop, low = threading.Event(), [before['available_gib']]


def monitor():
    while not stop.is_set():
        m = screen.memory()
        low[0] = min(low[0], m['available_gib'])
        if m['available_gib'] < 4 or m['oom_kill'] > before['oom_kill']:
            screen.save(out / 'abort.json', m)
            os._exit(3)
        stop.wait(.5)


threading.Thread(target=monitor, daemon=True).start()
t0 = time.monotonic()
with concurrent.futures.ThreadPoolExecutor(max_workers=args.users) as pool:
    rows = [r for rs in pool.map(lambda u: agent(u, t0), range(args.users)) for r in rs]
wall = time.monotonic() - t0
stop.set()
ok = [r for r in rows if r['error'] is None]
first = [r['ttft_s'] for r in ok if r['turn'] == 0]
later = [r['ttft_s'] for r in ok if r['turn'] > 0]
decode = [r['completion_tokens'] / (r['elapsed_s'] - r['ttft_s']) for r in ok if r['elapsed_s'] > r['ttft_s']]
s = {'tag': args.tag, 'users': args.users, 'turns': args.turns, 'requests': len(rows), 'errors': len(rows) - len(ok),
     'wall_s': wall, 'output_tok_s': sum(r['completion_tokens'] for r in ok) / wall,
     'turns_per_min': len(ok) / wall * 60,
     'prompt_tokens_mean': sum(r['prompt_tokens'] or 0 for r in ok) / max(1, len(ok)),
     'prompt_tokens_max': max((r['prompt_tokens'] or 0 for r in ok), default=0),
     'cached_tokens_sum': sum(r['cached_tokens'] or 0 for r in ok),
     'ttft_first_p50': screen.percentile(first, .5), 'ttft_first_max': max(first, default=None),
     'ttft_later_p50': screen.percentile(later, .5), 'ttft_later_p95': screen.percentile(later, .95),
     'decode_tok_s_p50': screen.percentile(decode, .5), 'min_available_gib': low[0]}
screen.save(out / 'rows.json', rows)
screen.save(out / 'summary.json', s)
print(json.dumps(s), flush=True)
