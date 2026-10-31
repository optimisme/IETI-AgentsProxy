#!/usr/bin/env python3
"""Small fixed-input comparison; loopback only, preserving complete receipts."""
import argparse
import concurrent.futures
import hashlib
import json
import math
import os
import re
import statistics
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def save(path, value):
    path.write_text(json.dumps(value, indent=2) + '\n')


def api(url, path, value=None):
    data = None if value is None else json.dumps(value).encode()
    with urllib.request.urlopen(urllib.request.Request(url + path, data=data,
            headers={'Content-Type': 'application/json'}), timeout=5) as response:
        return json.load(response)


def health(url):
    h = api(url, '/health')
    if 'requests_total' not in h:
        with urllib.request.urlopen(url + '/metrics', timeout=5) as response:
            raw = response.read().decode()
        metrics = {}
        for line in raw.splitlines():
            if line.startswith('#'):
                continue
            m = re.match(r'([^\s{]+)\s+([^\s]+)$', line)
            if m:
                try:
                    metrics[m[1]] = float(m[2])
                except ValueError:
                    pass
        h['requests_total'] = int(metrics.get('tensorfold:request_latency_seconds_count', 0))
        h['requests_running'] = int(metrics.get('tensorfold:requests_running', 0))
    return h


def memory():
    fields = dict(line.split(':', 1) for line in Path('/proc/meminfo').read_text().splitlines())
    vm = dict(line.split() for line in Path('/proc/vmstat').read_text().splitlines())
    return {'available_gib': int(fields['MemAvailable'].split()[0]) / 1048576,
            'pswpout': int(vm['pswpout']), 'oom_kill': int(vm.get('oom_kill', 0))}


def percentile(values, p):
    a = sorted(v for v in values if v is not None)
    if not a:
        return None
    i = (len(a) - 1) * p
    return a[math.floor(i)] + (a[math.ceil(i)] - a[math.floor(i)]) * (i - math.floor(i))


def request(url, payload, barrier=None):
    if barrier:
        barrier.wait()
    start = time.monotonic()
    r = {'request_sha256': hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest(),
         'started_monotonic': start, 'usage': {}, 'ttft_s': None, 'error': None}
    content, reasoning = [], []
    try:
        req = urllib.request.Request(url + '/v1/chat/completions', data=json.dumps(payload).encode(),
                                     headers={'Content-Type': 'application/json'})
        with urllib.request.urlopen(req, timeout=120) as response:
            for line in response:
                if not line.startswith(b'data:'):
                    continue
                raw = line[5:].strip()
                if raw == b'[DONE]':
                    r['done'] = True
                    break
                event = json.loads(raw)
                if event.get('error'):
                    raise RuntimeError(str(event['error']))
                if event.get('usage'):
                    r['usage'] = event['usage']
                for choice in event.get('choices', []):
                    delta = choice.get('delta', {})
                    thought = delta.get('reasoning') or delta.get('reasoning_content') or ''
                    if delta.get('content') or thought or delta.get('tool_calls'):
                        if r['ttft_s'] is None:
                            r['ttft_s'] = time.monotonic() - start
                    content.append(delta.get('content') or '')
                    reasoning.append(thought)
        if not r.get('done') or not r['usage'].get('completion_tokens'):
            raise RuntimeError('Incomplete SSE or missing usage')
    except urllib.error.HTTPError as exc:
        r['error'] = str(exc.code) + ': ' + exc.read().decode(errors='replace')[:1500]
    except Exception as exc:
        r['error'] = repr(exc)
    r.update(elapsed_s=time.monotonic() - start, content=''.join(content), reasoning=''.join(reasoning))
    return r


def cohort(url, case, out):
    before, initial = health(url), memory()
    assert before['requests_running'] == 0, before
    stop, samples = threading.Event(), []

    def monitor():
        while not stop.is_set():
            m = memory()
            samples.append({'epoch': time.time(), **m})
            if m['available_gib'] < 6 or m['oom_kill'] > initial['oom_kill'] or m['pswpout'] - initial['pswpout'] > 262144:
                save(out / (case['name'] + '-abort.json'), m)
                os._exit(3)
            stop.wait(.5)

    thread = threading.Thread(target=monitor, daemon=True)
    thread.start()
    start = time.monotonic()
    barrier = threading.Barrier(len(case['payloads']))
    with concurrent.futures.ThreadPoolExecutor(max_workers=len(case['payloads'])) as pool:
        replies = list(pool.map(lambda p: request(url, p, barrier), case['payloads']))
    wall = time.monotonic() - start
    stop.set()
    thread.join(timeout=2)
    after = health(url)
    for _ in range(30):
        if after['requests_running'] == 0 and after['requests_total'] >= before['requests_total'] + len(replies):
            break
        time.sleep(.1)
        after = health(url)
    m = memory()
    tokens = sum(r['usage'].get('completion_tokens', 0) for r in replies)
    s = {'name': case['name'], 'n': case['n'], 'kind': case['kind'], 'turn': case.get('turn'),
         'requests': len(replies), 'successes': sum(r['error'] is None for r in replies),
         'full_outputs': sum(r['usage'].get('completion_tokens') == p['max_tokens'] for r, p in zip(replies, case['payloads'])),
         'output_tokens': tokens, 'wall_s': wall, 'output_tok_s': tokens / wall,
         'ttft_p50_s': percentile([r['ttft_s'] for r in replies], .5),
         'ttft_p95_s': percentile([r['ttft_s'] for r in replies], .95),
         'input_tokens': [r['usage'].get('prompt_tokens') for r in replies],
         'cached_tokens': sum(r['usage'].get('prompt_tokens_details', {}).get('cached_tokens', 0) for r in replies),
         'external_requests': after['requests_total'] - before['requests_total'] - len(replies),
         'final_running': after['requests_running'],
         'min_available_gib': min(x['available_gib'] for x in samples),
         'pageouts': m['pswpout'] - initial['pswpout'], 'oom_kills': m['oom_kill'] - initial['oom_kill']}
    save(out / (case['name'] + '.json'), {'summary': s, 'requests': replies, 'before': before, 'after': after, 'monitor': samples})
    print(json.dumps(s), flush=True)
    assert s['successes'] == s['full_outputs'] == len(replies), s
    assert s['external_requests'] == s['final_running'] == s['oom_kills'] == 0, s
    return s


def run(url, out):
    out.mkdir(exist_ok=False)
    fixture = ROOT / 'fixtures.json'
    save(out / 'metadata.json', {'epoch': time.time(), 'health': health(url),
        'models': api(url, '/v1/models'), 'fixtures_sha256': hashlib.sha256(fixture.read_bytes()).hexdigest(),
        'client_sha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest()})
    warm = json.loads(fixture.read_text())['cases'][0]['payloads'][0]
    warm = {**warm, 'messages': [{'role': 'user', 'content': 'Unmeasured warmup: count the first ten integers.'}], 'max_tokens': 32}
    w = request(url, warm)
    save(out / 'warmup.json', w)
    assert w['error'] is None, w
    time.sleep(1)
    for case in json.loads(fixture.read_text())['cases']:
        cohort(url, case, out)
    save(out / 'completed.json', {'epoch': time.time()})


def analyze():
    rows = []
    for c in json.loads((ROOT / 'fixtures.json').read_text())['cases']:
        p = json.loads((ROOT / 'python' / (c['name'] + '.json')).read_text())
        z = json.loads((ROOT / 'native' / (c['name'] + '.json')).read_text())
        a, b = p['summary'], z['summary']
        matched = [r['request_sha256'] for r in p['requests']] == [r['request_sha256'] for r in z['requests']]
        ratio = b['output_tok_s'] / a['output_tok_s']
        ttft = b['ttft_p50_s'] - a['ttft_p50_s']
        eligible = matched and all(x['successes'] == x['full_outputs'] == x['requests'] and
            x['pageouts'] == x['oom_kills'] == x['external_requests'] == 0 for x in (a, b))
        rows.append({'case': c['name'], 'n': c['n'], 'kind': c['kind'], 'turn': c.get('turn'),
            'matched_requests': matched, 'equal_input_counts': a['input_tokens'] == b['input_tokens'],
            'eligible': eligible, 'python': a, 'native': b, 'throughput_ratio': ratio,
            'ttft_regression': ttft > .2 and b['ttft_p50_s'] > a['ttft_p50_s'] * 1.25})
    primary = [r for r in rows if r['n'] in (4, 8) and (r['kind'] == 'short' or r.get('turn') in (1, 2))]
    geomean = math.exp(statistics.mean(math.log(r['throughput_ratio']) for r in primary))
    result = {'rows': rows, 'primary_geomean_ratio': geomean, 'all_eligible': all(r['eligible'] for r in rows),
              'ttft_regressions_primary': sum(r['ttft_regression'] for r in primary),
              'multiuser_throughput_gate': all(r['eligible'] for r in rows) and geomean >= .9}
    save(ROOT / 'comparison.json', result)
    table = ['| Cas | Python tok/s | Natiu tok/s | Canvi | TTFT Python → natiu |', '|---|---:|---:|---:|---:|']
    for r in rows:
        a, b = r['python'], r['native']
        table.append(f"| {r['case']} | {a['output_tok_s']:.2f} | {b['output_tok_s']:.2f} | {(r['throughput_ratio']-1)*100:+.1f}% | {a['ttft_p50_s']:.3f} → {b['ttft_p50_s']:.3f} s |")
    (ROOT / 'TABLES.md').write_text('\n'.join(table) + '\n')
    print(json.dumps({k: v for k, v in result.items() if k != 'rows'}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('mode', choices=['run', 'analyze'])
    parser.add_argument('--url')
    parser.add_argument('--out')
    args = parser.parse_args()
    run(args.url, Path(args.out)) if args.mode == 'run' else analyze()
