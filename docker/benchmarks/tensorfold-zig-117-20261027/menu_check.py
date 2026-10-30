"""Every reasoning option OpenCode's menu can pick, and the tool features, checked by content: right answers, no leaked
markers, real tool calls with valid arguments, tool results used in the answer. Run on Zig and Python, then compare the
two JSON files. Exit 1 on any failure. usage: menu_check.py URL OUT.json [--against OTHER.json]"""
import base64, json, struct, sys, time, urllib.error, urllib.request, zlib

url, out_path = sys.argv[1].rstrip('/'), sys.argv[2]
MODEL = json.load(urllib.request.urlopen(url + '/v1/models', timeout=30))['data'][0]['id']
EFFORTS = [None, 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
LEAKS = ('<think>', '</think>', '<|im_end|>', '<|im_start|>', '<tool_call>', '</tool_call>')
WEATHER = {'type': 'function', 'function': {'name': 'get_weather', 'description': 'Current weather of a city.', 'parameters': {
    'type': 'object', 'properties': {'city': {'type': 'string'}, 'units': {'type': 'string', 'enum': ['celsius', 'fahrenheit']}},
    'required': ['city'], 'additionalProperties': False}}}
EDIT = {'type': 'function', 'function': {'name': 'edit_file', 'description': 'Replace text in a file.', 'parameters': {
    'type': 'object', 'properties': {'path': {'type': 'string'}, 'edits': {'type': 'array', 'items': {'type': 'object', 'properties': {
        'old': {'type': 'string'}, 'new': {'type': 'string'}}, 'required': ['old', 'new']}}}, 'required': ['path', 'edits']}}}
results = []


def post(body, stream=False):
    body = {'model': MODEL, 'temperature': 0.1, 'stream': stream, **body}
    req = urllib.request.Request(url + '/v1/chat/completions', json.dumps(body).encode(), {'Content-Type': 'application/json'})
    t = time.time()
    try:
        r = urllib.request.urlopen(req, timeout=900)
    except urllib.error.HTTPError as e:
        return {'status': e.code, 'error': e.read()[:300].decode('utf8', 'replace'), 'content': '', 'reasoning': '', 'tools': [], 'finish': None, 'usage': None, 'seconds': time.time() - t}
    out = {'status': 200, 'content': '', 'reasoning': '', 'tools': [], 'finish': None, 'usage': None}
    if not stream:
        j = json.load(r)
        c = j['choices'][0]
        m = c['message']
        out.update(content=m.get('content') or '', reasoning=m.get('reasoning_content') or m.get('reasoning') or '', finish=c.get('finish_reason'), usage=j.get('usage'))
        out['tools'] = [{'id': x.get('id'), 'name': x['function']['name'], 'args': x['function']['arguments']} for x in m.get('tool_calls') or []]
    else:
        calls = {}
        for raw in r:
            line = raw.decode('utf8', 'replace').strip()
            if not line.startswith('data:') or line[5:].strip() == '[DONE]':
                continue
            j = json.loads(line[5:])
            if j.get('usage'):
                out['usage'] = j['usage']
            for c in j.get('choices') or []:
                d = c.get('delta') or {}
                out['content'] += d.get('content') or ''
                out['reasoning'] += d.get('reasoning_content') or d.get('reasoning') or ''
                for x in d.get('tool_calls') or []:
                    e = calls.setdefault(x.get('index', 0), {'id': None, 'name': '', 'args': ''})
                    e['id'] = x.get('id') or e['id']
                    f = x.get('function') or {}
                    e['name'] += f.get('name') or ''
                    e['args'] += f.get('arguments') or ''
                out['finish'] = c.get('finish_reason') or out['finish']
        out['tools'] = [calls[k] for k in sorted(calls)]
    out['seconds'] = round(time.time() - t, 1)
    return out


def rec(name, ok, r, why=''):
    leak = [x for x in LEAKS if x in r['content']]
    if leak:
        ok, why = False, f'leaked {leak}'
    if r['status'] != 200:
        ok, why = False, f"HTTP {r['status']} {r.get('error', '')[:120]}"
    results.append({'name': name, 'ok': bool(ok), 'why': why, 'finish': r['finish'], 'reasoning_chars': len(r['reasoning']),
                    'tools': [t['name'] for t in r['tools']], 'seconds': r['seconds'], 'content': r['content'][:160]})
    print(('ok ' if ok else 'BAD'), name, f"[{r['finish']}, {r['seconds']} s, think {len(r['reasoning'])}]", why, repr(r['content'][:70]), flush=True)


def args_of(t):
    try:
        return json.loads(t['args'])
    except Exception:
        return None


def effort_body(e):
    return {} if e is None else {'reasoning_effort': e}


def png():
    """12 x 4: blue left, yellow right."""
    rows = b''.join(b'\0' + (bytes((20, 60, 220)) * 6 + bytes((240, 220, 30)) * 6) for _ in range(4))
    chunk = lambda t, d: struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d))
    data = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', 12, 4, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(rows)) + chunk(b'IEND', b'')
    return 'data:image/png;base64,' + base64.b64encode(data).decode()


for e in EFFORTS:
    label = e or 'default'
    for stream in (False, True):
        q = {'messages': [{'role': 'user', 'content': 'What is 17 * 23? Finish with a line "Answer: N".'}], 'max_tokens': 2500, **effort_body(e)}
        r = post(q, stream)
        ok = '391' in r['content'] and r['finish'] == 'stop' and (e != 'none' or not r['reasoning'])
        rec(f'{label} answer {"stream" if stream else "plain"}', ok, r, '' if ok else 'wrong answer, finish or thinking')
    msgs = [{'role': 'user', 'content': 'Use the tool to get the weather in Lleida, then tell me the temperature.'}]
    r = post({'messages': msgs, 'tools': [WEATHER], 'max_tokens': 2500, **effort_body(e)}, True)  # as OpenCode: streamed, tool_choice auto
    a = args_of(r['tools'][0]) if r['tools'] else None
    ok = len(r['tools']) >= 1 and r['tools'][0]['name'] == 'get_weather' and bool(a) and 'lleida' in str(a.get('city', '')).lower() and r['finish'] == 'tool_calls'
    rec(f'{label} tool call', ok, r, '' if ok else f'no valid call: {r["tools"][:1]}')
    if ok:
        turn = {'role': 'assistant', 'content': r['content'] or None, 'tool_calls': [{'id': r['tools'][0]['id'] or 'call_0', 'type': 'function', 'function': {'name': 'get_weather', 'arguments': r['tools'][0]['args']}}]}
        if r['reasoning']:
            turn['reasoning_content'] = r['reasoning']  # OpenCode's interleaved field
        back = msgs + [turn, {'role': 'tool', 'tool_call_id': turn['tool_calls'][0]['id'], 'content': '{"temperature_c": 37.4, "sky": "clear"}'}]
        r2 = post({'messages': back, 'tools': [WEATHER], 'max_tokens': 2500, **effort_body(e)}, True)
        ok2 = '37.4' in r2['content'] or '37,4' in r2['content']
        rec(f'{label} tool result used', ok2 and r2['finish'] == 'stop', r2, '' if ok2 else 'tool value not in the answer')

base = {'max_tokens': 1500, 'reasoning_effort': 'none'}
user = lambda t: [{'role': 'user', 'content': t}]
r = post({**base, 'messages': user('Say hello.'), 'tools': [WEATHER], 'tool_choice': 'required'})
rec('tool_choice required', bool(r['tools']) and args_of(r['tools'][0]) is not None, r)
r = post({**base, 'messages': user('Say hello.'), 'tools': [WEATHER, EDIT], 'tool_choice': {'type': 'function', 'function': {'name': 'edit_file'}}})
rec('tool_choice named', bool(r['tools']) and r['tools'][0]['name'] == 'edit_file' and args_of(r['tools'][0]) is not None, r)
r = post({**base, 'messages': user('What is the weather in Lleida?'), 'tools': [WEATHER], 'tool_choice': 'none'})
rec('tool_choice none', not r['tools'] and bool(r['content'].strip()), r)
r = post({**base, 'messages': user('Get the weather in Lleida and in Girona. Call the tool once for each city.'), 'tools': [WEATHER], 'parallel_tool_calls': True}, True)
cities = sorted(str((args_of(t) or {}).get('city', '')).lower() for t in r['tools'])
rec('parallel tool calls', any('girona' in c for c in cities) and any('lleida' in c for c in cities), r, str(cities))
r = post({**base, 'messages': user('In src/a.py replace "x = 1" with "x = 2" and "y = \'à\'" with "y = \'é\'" using one tool call.'), 'tools': [EDIT]}, True)
a = args_of(r['tools'][0]) if r['tools'] else None
rec('nested and unicode arguments', bool(a) and isinstance(a.get('edits'), list) and len(a['edits']) == 2 and 'é' in json.dumps(a, ensure_ascii=False), r, str(a)[:100])
r = post({**base, 'messages': user('Give a JSON object with keys "city" and "country" for Barcelona.'), 'response_format': {'type': 'json_object'}})
try:
    j = json.loads(r['content'])
except Exception:
    j = None
rec('json_object', isinstance(j, dict) and 'city' in j, r)
schema = {'type': 'json_schema', 'json_schema': {'name': 'p', 'schema': {'type': 'object', 'properties': {'n': {'type': 'integer'}}, 'required': ['n'], 'additionalProperties': False}}}
r = post({**base, 'messages': user('Return n = 7.'), 'response_format': schema})
try:
    j = json.loads(r['content'])
except Exception:
    j = None
rec('json_schema', isinstance(j, dict) and j.get('n') == 7, r)
r = post({**base, 'messages': user('Count: one, two, three, four, five.'), 'stop': ['three']})
rec('stop sequence', 'three' not in r['content'] and r['finish'] == 'stop', r)
r = post({**base, 'messages': user('Write a long story about a river.'), 'max_tokens': 12})
rec('max_tokens', r['finish'] == 'length' and (r['usage'] or {}).get('completion_tokens') == 12, r)
r = post({**base, 'messages': [{'role': 'user', 'content': [{'type': 'text', 'text': 'Which colour is on the left of this image, and which on the right?'}, {'type': 'image_url', 'image_url': {'url': png()}}]}]})
rec('image', 'blue' in r['content'].lower() and 'yellow' in r['content'].lower(), r)
long_result = '\n'.join(f'line {i}: value {i * 7}' for i in range(3000))
msgs = [{'role': 'user', 'content': 'Read the log with the tool, then tell me the value on line 2345.'},
        {'role': 'assistant', 'content': None, 'tool_calls': [{'id': 'c1', 'type': 'function', 'function': {'name': 'read_log', 'arguments': '{}'}}]},
        {'role': 'tool', 'tool_call_id': 'c1', 'content': long_result}]
tool = {'type': 'function', 'function': {'name': 'read_log', 'description': 'Read the log.', 'parameters': {'type': 'object', 'properties': {}}}}
r = post({**base, 'messages': msgs, 'tools': [tool]}, True)
rec('long tool result', str(2345 * 7) in r['content'], r)
a = post({**base, 'messages': user('List three primes.'), 'temperature': 0})
b = post({**base, 'messages': user('List three primes.'), 'temperature': 0})
rec('temperature 0 repeats', a['content'] == b['content'] and bool(a['content']), a)
r = post({'messages': user('hi'), 'reasoning_effort': 'none', 'max_tokens': 16}, True)
rec('streamed usage or plain finish', r['finish'] in ('stop', 'length'), r)

bad = [x for x in results if not x['ok']]
json.dump(results, open(out_path, 'w'), indent=1, ensure_ascii=False)
print(f'menu check: {len(results) - len(bad)} of {len(results)} ok')
for x in bad:
    print('  BAD', x['name'], x['why'][:120])
if '--against' in sys.argv:
    other = {x['name']: x for x in json.load(open(sys.argv[sys.argv.index('--against') + 1]))}
    for x in results:
        o = other.get(x['name'])
        if o and o['ok'] != x['ok']:
            print(f"  differs: {x['name']}: here {'ok' if x['ok'] else 'BAD'}, other {'ok' if o['ok'] else 'BAD'}")
sys.exit(1 if bad else 0)
