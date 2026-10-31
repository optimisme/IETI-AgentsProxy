"""Code-review agents at once: a shared ~5k-token system prompt with four tools, then a new ~1.5k-token file each turn, six
turns, replies up to 256 tokens, greedy. Sessions share only the system prompt; repeats read different text.
usage: review_load.py URL OUT.json "LEVELS" REPEATS"""
import glob, json, statistics, sys, threading, time, urllib.request

url, out, levels, reps = sys.argv[1].rstrip('/'), sys.argv[2], [int(x) for x in sys.argv[3].split()], int(sys.argv[4])
TURNS, MAX_TOKENS, CHARS = 6, 256, 5200
model = json.load(urllib.request.urlopen(url + '/v1/models'))['data'][0]['id']
props = {'read_file': ('Read a file.', ['path']), 'search': ('Search with a regular expression.', ['pattern']),
         'edit_file': ('Replace text in a file.', ['path', 'old', 'new']), 'run_command': ('Run a shell command.', ['command'])}
tools = [{'type': 'function', 'function': {'name': n, 'description': d, 'parameters': {'type': 'object',
          'properties': {k: {'type': 'string'} for k in p}, 'required': p}}} for n, (d, p) in props.items()]
system = 'You are a careful coding agent reviewing a code base for correctness bugs. The user shows you one source file at a time. After each file, list anything suspicious with its line, say how confident you are, and name the file to read next. Use the tools when you need more context. Keep answers short and concrete.\n\n' + open(sys.argv[5]).read()[:19000]
chunks = []
for p in sorted(glob.glob('/usr/lib/python3*/*.py')):
    t = open(p, errors='replace').read()
    chunks += [(p, t[i:i + CHARS]) for i in range(0, len(t) - CHARS + 1, CHARS)]
at = [0]


def post(messages):
    body = {'model': model, 'messages': messages, 'tools': tools, 'max_tokens': MAX_TOKENS, 'temperature': 0, 'stream': True, 'stream_options': {'include_usage': True}}
    t0 = time.monotonic()
    first = last = None
    gap = 0
    usage = {}
    r = urllib.request.urlopen(urllib.request.Request(url + '/v1/chat/completions', json.dumps(body).encode(), {'Content-Type': 'application/json'}), timeout=900)
    for raw in r:
        line = raw.decode('utf8', 'replace').strip()
        if not line.startswith('data:') or line[5:].strip() == '[DONE]':
            continue
        e = json.loads(line[5:])
        now = time.monotonic()
        usage = e.get('usage') or usage
        for c in e.get('choices') or []:
            if any(v for k, v in (c.get('delta') or {}).items() if k != 'role'):
                if first is None:
                    first = now
                else:
                    gap = max(gap, now - last)
                last = now
    return {'ttft': first - t0 if first else None, 'gap': gap, 'out': usage.get('completion_tokens') or 0, 'prompt': usage.get('prompt_tokens') or 0,
            'cached': (usage.get('prompt_tokens_details') or {}).get('cached_tokens') or 0, 'decode': ((usage.get('completion_tokens') or 1) - 1) / (last - first) if first and last and last > first else None}


def session(level, rep, sid, parts, start, rows, lock):
    msgs = [{'role': 'system', 'content': system}]
    while time.monotonic() < start:
        time.sleep(0.001)
    for turn, (path, code) in enumerate(parts, 1):
        msgs.append({'role': 'user', 'content': (f'Review session L{level}-R{rep}-S{sid}. ' if turn == 1 else '') + f'Contents of {path}:\n```\n{code}\n```'})
        r = post(msgs)
        msgs.append({'role': 'assistant', 'content': 'Noted. Show me the next file.'})
        with lock:
            rows.append({'level': level, 'rep': rep, 'turn': turn, 'end': time.monotonic() - start, **r})


print('warm', post([{'role': 'system', 'content': system}, {'role': 'user', 'content': 'Ready?'}]), flush=True)
all_rows = []
for rep in range(1, reps + 1):
    for level in levels:
        rows, lock, start, ts = [], threading.Lock(), time.monotonic() + 0.5, []
        for sid in range(level):
            parts = chunks[at[0]:at[0] + TURNS]
            at[0] += TURNS
            ts.append(threading.Thread(target=session, args=(level, rep, sid, parts, start, rows, lock)))
            ts[-1].start()
        [t.join() for t in ts]
        wall = max(r['end'] for r in rows)
        print(f"rep {rep} level {level}: {len(rows)} turns, wall {wall:.1f} s, output {sum(r['out'] for r in rows) / wall:.1f} tok/s, ttft p50 {statistics.median(r['ttft'] for r in rows):.2f} s, longest pause p90 {sorted(r['gap'] for r in rows)[int(len(rows) * 0.9)]:.2f} s, decode p50 {statistics.median(r['decode'] for r in rows if r['decode']):.1f}, cached {100 * sum(r['cached'] for r in rows) / max(1, sum(r['prompt'] for r in rows)):.0f}%, prompt mean {statistics.mean(r['prompt'] for r in rows):.0f}", flush=True)
        all_rows += rows
        time.sleep(5)
json.dump(all_rows, open(out, 'w'))
print('review-done', flush=True)
