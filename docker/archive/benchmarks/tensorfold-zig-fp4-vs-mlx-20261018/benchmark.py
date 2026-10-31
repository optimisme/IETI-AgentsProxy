#!/usr/bin/env python3
"""Same deterministic API workloads, run on each inference host over loopback.

No dependencies, credentials, server restarts or source patches. Measures complete
request wall time, TTFT including reasoning, usage and engine-reported timing.
Server warm/cache state and external requests are recorded, not silently reset.
"""
import argparse
import base64
import concurrent.futures
import hashlib
import json
import math
import os
import random
import statistics
import struct
import threading
import time
import urllib.error
import urllib.request
import zlib
from pathlib import Path


def api(base, route, body=None, timeout=60):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(base + route, data=data, headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=timeout) as response:
        result = json.load(response)
    # Native /health has a different schema. Its latency histogram counts finished
    # inference requests; HTTP request counters would also count our health polls.
    if route == '/health' and 'live' in result and 'requests_total' not in result:
        with urllib.request.urlopen(base + '/metrics', timeout=timeout) as response:
            lines = response.read().decode().splitlines()
        scalars = {line.split()[0]: float(line.split()[-1]) for line in lines
                   if line.startswith('tensorfold:') and '{' not in line.split()[0]}
        result['requests_total'] = int(scalars.get('tensorfold:request_latency_seconds_count', 0))
        result['requests_running'] = result['live']['connections']
        result['resident_streams'] = int(scalars.get('tensorfold:requests_running', 0))
        result['kv_cache_usage_ratio'] = [float(line.split()[-1]) for line in lines
                                        if line.startswith('tensorfold:kv_cache_usage_ratio{')]
    return result


def percentile(values, p):
    values = sorted(v for v in values if v is not None)
    if not values:
        return None
    i = (len(values) - 1) * p
    lo, hi = math.floor(i), math.ceil(i)
    return values[lo] + (values[hi] - values[lo]) * (i - lo)


def memory():
    fields = dict(line.split(':', 1) for line in Path('/proc/meminfo').read_text().splitlines())
    vm = dict(line.split() for line in Path('/proc/vmstat').read_text().splitlines())
    return {'available_gib': int(fields['MemAvailable'].split()[0]) / 1048576,
            'swap_used_gib': (int(fields['SwapTotal'].split()[0]) - int(fields['SwapFree'].split()[0])) / 1048576,
            'pswpout': int(vm['pswpout']), 'oom_kill': int(vm.get('oom_kill', 0))}


def body(model, messages, output=256):
    return {'model': model, 'messages': messages, 'max_tokens': output, 'temperature': 0,
            'top_p': 0.95, 'top_k': 20, 'seed': 180026, 'ignore_eos': True,
            'chat_template_kwargs': {'enable_thinking': False},
            'stream': True, 'stream_options': {'include_usage': True}}


def request(base, payload, barrier=None):
    if barrier:
        barrier.wait()
    start = time.monotonic()
    result = {'request_sha256': hashlib.sha256(json.dumps({k: v for k, v in payload.items() if k != 'model'}, sort_keys=True).encode()).hexdigest(),
              'ttft_s': None, 'content_ttft_s': None, 'usage': {}, 'engine': {}, 'error': None}
    content, reasoning, tools = [], [], []
    try:
        req = urllib.request.Request(base + '/v1/chat/completions', data=json.dumps(payload).encode(),
                                     headers={'Content-Type': 'application/json'})
        with urllib.request.urlopen(req, timeout=1500) as response:
            result['http_status'] = response.status
            for raw in response:
                if not raw.startswith(b'data:'):
                    continue
                text = raw[5:].strip()
                if text == b'[DONE]':
                    result['done'] = True
                    break
                event = json.loads(text)
                if event.get('error'):
                    raise RuntimeError(str(event['error']))
                if event.get('usage'):
                    result['usage'] = event['usage']
                for key in ('tensorfold', 'stats'):
                    if event.get(key):
                        result['engine'].update(event[key])
                for choice in event.get('choices', []):
                    delta = choice.get('delta', {})
                    if delta.get('content') or delta.get('reasoning_content') or delta.get('tool_calls'):
                        if result['ttft_s'] is None:
                            result['ttft_s'] = time.monotonic() - start
                    if delta.get('content'):
                        if result['content_ttft_s'] is None:
                            result['content_ttft_s'] = time.monotonic() - start
                        content.append(delta['content'])
                    reasoning.append(delta.get('reasoning_content', ''))
                    tools.extend(delta.get('tool_calls', []))
                    if choice.get('finish_reason'):
                        result['finish_reason'] = choice['finish_reason']
        if not result.get('done') or not result['usage'].get('completion_tokens'):
            raise RuntimeError('Incomplete stream or missing completion usage')
    except urllib.error.HTTPError as error:
        result['http_status'] = error.code
        result['error'] = error.read().decode(errors='replace')[:2000]
    except Exception as error:
        result['error'] = repr(error)
    result.update(elapsed_s=time.monotonic() - start, content=''.join(content), reasoning=''.join(reasoning), tool_calls=tools)
    return result


def cohort(base, name, payloads, out):
    before = api(base, '/health')
    samples, stop = [], threading.Event()

    def monitor():
        initial = memory()
        while not stop.is_set():
            sample = {'time': time.time(), **memory()}
            if sample['available_gib'] < 6 or sample['oom_kill'] > initial['oom_kill'] or sample['pswpout'] - initial['pswpout'] > 262144:
                (out / (name + '-safety-abort.json')).write_text(json.dumps(sample, indent=2) + '\n')
                print(json.dumps({'safety_abort': name, **sample}), flush=True)
                os._exit(3)
            try:
                sample['health'] = api(base, '/health', timeout=2)
            except Exception as error:
                sample['health_error'] = repr(error)
            samples.append(sample)
            stop.wait(1)

    thread = threading.Thread(target=monitor, daemon=True)
    thread.start()
    start = time.monotonic()
    barrier = threading.Barrier(len(payloads))
    with concurrent.futures.ThreadPoolExecutor(max_workers=len(payloads)) as pool:
        results = list(pool.map(lambda p: request(base, p, barrier), payloads))
    elapsed = time.monotonic() - start
    stop.set()
    thread.join(timeout=3)
    after = api(base, '/health')
    tokens = sum(r['usage'].get('completion_tokens', 0) for r in results)
    cached = sum(r['usage'].get('prompt_tokens_details', {}).get('cached_tokens', 0) for r in results)
    summary = {'name': name, 'requests': len(results), 'successes': sum(r['error'] is None for r in results),
               'full_output_requests': sum(r['usage'].get('completion_tokens') == p['max_tokens'] for r, p in zip(results, payloads)),
               'wall_s': elapsed, 'aggregate_output_tok_s': tokens / elapsed,
               'ttft_p50_s': percentile([r['ttft_s'] for r in results], .5),
               'ttft_p95_s': percentile([r['ttft_s'] for r in results], .95),
               'latency_p50_s': percentile([r['elapsed_s'] for r in results], .5),
               'output_tokens': tokens, 'cached_tokens': cached,
               'input_tokens': [r['usage'].get('prompt_tokens') for r in results],
               'min_available_gib': min((s['available_gib'] for s in samples), default=None),
               'max_swap_used_gib': max((s['swap_used_gib'] for s in samples), default=None),
               'swap_out_pages': samples[-1]['pswpout'] - samples[0]['pswpout'] if samples else None,
               'oom_kills': samples[-1]['oom_kill'] - samples[0]['oom_kill'] if samples else None,
               'peak_engine_running': max((s.get('health', {}).get('requests_running', 0) for s in samples), default=0),
               'external_requests': after.get('requests_total', 0) - before.get('requests_total', 0) - len(results)
                                    if 'requests_total' in after and 'requests_total' in before else None}
    report = {'summary': summary, 'before': before, 'after': after, 'requests': results, 'monitor': samples}
    (out / (name + '.json')).write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(summary), flush=True)
    return report


def fixtures(base, model, path):
    """Freeze prompts once with baseline tokenizer; same bytes go to both hosts."""
    randomizer = random.Random(180026)
    rows = [f'entry {i}: item_{randomizer.randrange(1000000)} uses version {randomizer.randrange(100)}; tests pass.\n'
            for i in range(16000)]

    def sized(target):
        lo, hi, best = 0, len(rows), ''
        while lo <= hi:
            mid = (lo + hi) // 2
            text = 'Read this fictional project log.\n' + ''.join(rows[:mid]) + '\nSummarize its engineering risks in detail.'
            p = body(model, [{'role': 'user', 'content': text}], 128)
            n = api(base, '/tokenize', p)['count']
            if n <= target:
                lo, best = mid + 1, text
            else:
                hi = mid - 1
        return best

    x = {str(n): sized(n) for n in (1800, 7400, 16000, 65000, 74000)}
    path.write_text(json.dumps(x))
    print('fixtures_sha256=' + hashlib.sha256(path.read_bytes()).hexdigest(), flush=True)


def smoke(base, model, out):
    tool = body(model, [{'role': 'user', 'content': 'Call record_number with value 42.'}], 128)
    tool.update(ignore_eos=False, tools=[{'type': 'function', 'function': {'name': 'record_number', 'description': 'Record an integer.',
                'parameters': {'type': 'object', 'properties': {'value': {'type': 'integer'}}, 'required': ['value']}}}],
                tool_choice={'type': 'function', 'function': {'name': 'record_number'}})
    t = request(base, tool)
    names = [v.get('function', {}).get('name', '') for v in t['tool_calls']]
    args = ''.join(v.get('function', {}).get('arguments', '') for v in t['tool_calls'])
    t['passed'] = t['error'] is None and 'record_number' in names and json.loads(args).get('value') == 42 if args else False
    def chunk(kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data) & 0xffffffff)
    png = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', 64, 64, 8, 2, 0, 0, 0))
    png += chunk(b'IDAT', zlib.compress((b'\0' + b'\xff\0\0' * 64) * 64)) + chunk(b'IEND', b'')
    image = body(model, [{'role': 'user', 'content': [{'type': 'text', 'text': 'What is the dominant color? Answer one word.'},
                  {'type': 'image_url', 'image_url': {'url': 'data:image/png;base64,' + base64.b64encode(png).decode()}}]}], 64)
    image['ignore_eos'] = False
    v = request(base, image)
    v['passed'] = v['error'] is None and 'red' in v['content'].lower()
    (out / 'smoke.json').write_text(json.dumps({'tool': t, 'vision': v}, indent=2) + '\n')
    print(json.dumps({'tool_smoke': t['passed'], 'vision_smoke': v['passed']}), flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('mode', choices=['fixtures', 'bench', 'capacity'])
    parser.add_argument('--base', default='http://127.0.0.1:8000')
    parser.add_argument('--out', required=True)
    parser.add_argument('--fixtures', required=True)
    args = parser.parse_args()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    model = api(args.base, '/v1/models')['data'][0]['id']
    if args.mode == 'fixtures':
        fixtures(args.base, model, Path(args.fixtures))
        return
    data = json.loads(Path(args.fixtures).read_text())
    meta = {'started_at_utc': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'model': model,
            'health': api(args.base, '/health'), 'memory': memory(), 'thinking': False, 'temperature': 0,
            'fixtures_sha256': hashlib.sha256(Path(args.fixtures).read_bytes()).hexdigest(),
            'script_sha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest()}
    (out / ('metadata-' + args.mode + '.json')).write_text(json.dumps(meta, indent=2) + '\n')
    if args.mode == 'capacity':
        prompts = [body(model, [{'role': 'user', 'content': f'Independent full-window request {i}.\n' + data['74000']}], 256) for i in range(16)]
        cohort(args.base, 'capacity16-near75k', prompts, out)
        return
    smoke(args.base, model, out)
    # Unique first lines prevent exact-prefix hits between independent trials.
    for trial in range(2):
        for kind, counts in [('prose', (1, 4, 16)), ('code', (1, 16))]:
            for count in counts:
                question = ('Explain transaction isolation, race conditions and deadlock prevention with examples.' if kind == 'prose'
                            else 'Write a Python LRU cache with type hints, docstrings and extensive unit tests.')
                prompts = [body(model, [{'role': 'user', 'content': f'Trial {trial}, {kind}, cohort {count}, user {i}.\n' + question}]) for i in range(count)]
                cohort(args.base, f'{kind}{count}-trial{trial}', prompts, out)
    for size in ('16000', '65000'):
        cohort(args.base, 'cold-' + size, [body(model, [{'role': 'user', 'content': 'Cold isolated workload ' + size + '\n' + data[size]}], 128)], out)
    histories = []
    for i in range(16):
        size = '1800' if i < 8 else '7400' if i < 15 else '65000'
        histories.append([{'role': 'user', 'content': f'Independent programming project {i}.\n' + data[size]}])
    cohort(args.base, 'projects-cold16', [body(model, h, 128) for h in histories], out)
    grown = [h + [{'role': 'assistant', 'content': 'I will preserve the existing public interface and add regression coverage.'},
                  {'role': 'user', 'content': 'Now describe the first regression test and explain why it matters.'}] for h in histories]
    cohort(args.base, 'projects-growth16', [body(model, h, 128) for h in grown], out)
    branched = [h + [{'role': 'assistant', 'content': 'I will preserve the existing public interface and add regression coverage.'},
                     {'role': 'user', 'content': 'Instead, focus on validating concurrent updates and explain the test.'}] for h in histories]
    cohort(args.base, 'projects-branch16', [body(model, h, 128) for h in branched], out)


if __name__ == '__main__':
    main()
