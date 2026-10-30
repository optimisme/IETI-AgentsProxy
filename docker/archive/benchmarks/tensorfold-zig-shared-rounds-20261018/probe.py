#!/usr/bin/env python3
"""Reuse the existing fixed API requests, monitor and 16 x near-75k capacity test."""
import argparse
import hashlib
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'tensorfold-zig-cache-tuning-20261018'))
from benchmark import api, body, cohort, memory, request

p = argparse.ArgumentParser()
p.add_argument('--base', default='http://127.0.0.1:8007')
p.add_argument('--out', required=True)
p.add_argument('--reference')
p.add_argument('--quality', action='store_true')
p.add_argument('--capacity', action='store_true')
p.add_argument('--native', action='store_true')
a = p.parse_args()
out = Path(a.out)
out.mkdir(parents=True, exist_ok=True)
if a.native:
    subprocess.run([sys.executable, str(ROOT / 'tensorfold-zig-release110-20261018/verify_memory_off.py'),
                    '--base', a.base, '--out', str(out / 'memory-off.json')], check=True)
    provenance = '''import hashlib,json,pathlib
found=[]
for entry in pathlib.Path('/proc').iterdir():
 if not entry.name.isdigit():continue
 try:args=entry.joinpath('cmdline').read_bytes().rstrip(b'\\0').split(b'\\0')
 except (OSError,PermissionError):continue
 if args and args[0].endswith(b'/tensorfold-native'):
  found.append({'argv':[v.decode() for v in args],'executable_sha256':hashlib.sha256(entry.joinpath('exe').read_bytes()).hexdigest()})
print(json.dumps(found))
'''
    processes = json.loads(subprocess.check_output(['docker', 'exec',
        'qwen38_flash_next_tensorfold_110_cuda', 'python3', '-c', provenance], text=True))
    assert len(processes) == 1, processes
    expected_name = 'fused-native-sha256.txt' if out.name == 'fused-on' else 'native-sha256.txt'
    expected = (Path(__file__).resolve().parent / expected_name).read_text().split()[0]
    assert processes[0]['executable_sha256'] == expected, 'Running executable differs from the built artifact'
    (out / 'runtime-provenance.json').write_text(json.dumps(processes[0], indent=2) + '\n')
model = api(a.base, '/v1/models')['data'][0]['id']
fixtures_path = ROOT / 'tensorfold-zig-cache-tuning-20261018/fixtures.json'
fixtures = json.loads(fixtures_path.read_text())
(out / 'metadata.json').write_text(json.dumps({'model': model, 'health': api(a.base, '/health'),
    'memory': memory(), 'fixtures_sha256': hashlib.sha256(fixtures_path.read_bytes()).hexdigest(),
    'script_sha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest()}, indent=2) + '\n')
equal = 0

def run(name, payloads):
    global equal
    r = cohort(a.base, name, payloads, out)
    s = r['summary']
    assert s['successes'] == s['requests'] == s['full_output_requests'], s
    if a.reference:
        teacher = json.loads((Path(a.reference) / (name + '.json')).read_text())
        assert len(teacher['requests']) == len(r['requests'])
        for ref, got in zip(teacher['requests'], r['requests']):
            assert ref['request_sha256'] == got['request_sha256'], name
            assert ref['engine']['token_sha256'] == got['engine']['token_sha256'], ('token mismatch', name)
            assert (ref['content'], ref['reasoning']) == (got['content'], got['reasoning']), name
            equal += 1
    return r

for trial in range(2):
    for count in (1, 16):
        question = 'Write a Python LRU cache with type hints, docstrings and extensive unit tests.'
        payloads = [body(model, [{'role': 'user', 'content':
                    f'Trial {trial}, code, cohort {count}, user {i}.\n' + question}]) for i in range(count)]
        run(f'code{count}-trial{trial}', payloads)
run('cold-16000', [body(model, [{'role': 'user', 'content':
    'Cold isolated workload 16000\n' + fixtures['16000']}], 128)])
if a.reference:
    assert equal == 35
    (out / 'equivalence.json').write_text(json.dumps({'requests': equal, 'all_token_hashes_equal': True}, indent=2) + '\n')
if a.native:
    tool = body(model, [{'role': 'user', 'content': 'Call record_number with value 42.'}], 128)
    tool.update(ignore_eos=False, tool_choice='auto', tools=[{'type': 'function', 'function': {
        'name': 'record_number', 'description': 'Record an integer', 'parameters': {
            'type': 'object', 'properties': {'value': {'type': 'integer'}}, 'required': ['value']}}}])
    response = request(a.base, tool)
    (out / 'auto-tool.json').write_text(json.dumps(response, indent=2) + '\n')
    calls = {}
    for delta in response.get('tool_calls', []):
        call = calls.setdefault(delta.get('index', 0), {'name': '', 'arguments': ''})
        fn = delta.get('function', {})
        call['name'] += fn.get('name', '')
        call['arguments'] += fn.get('arguments', '')
    assert response['error'] is None and not response.get('reasoning'), response
    assert any(c['name'] == 'record_number' and json.loads(c['arguments']) == {'value': 42}
               for c in calls.values()), response
if a.quality:
    subprocess.run([sys.executable, str(ROOT / 'tensorfold-zig-release110-20261018/quality_probe.py'),
                    '--base', a.base, '--out', str(out)], check=True)
    q = json.loads((out / 'quality-result.json').read_text())
    assert q['passed'] == q['requests'] == 16, q
policy_path = Path(__file__).resolve().parent / 'capacity-policy.json'
policy = json.loads(policy_path.read_text()) if policy_path.exists() else {}
capacity_selected = a.capacity and (not policy or out.name in policy['run_for'])
if capacity_selected:
    subprocess.run([sys.executable, str(ROOT / 'tensorfold-zig-cache-tuning-20261018/benchmark.py'),
        'capacity', '--base', a.base, '--out', str(out), '--fixtures', str(fixtures_path)], check=True)
    c = json.loads((out / 'capacity16-near75k.json').read_text())['summary']
    assert c['successes'] == c['requests'] == c['full_output_requests'] == 16, c
(out / 'checks.json').write_text(json.dumps({'fixed_requests': 35,
    'quality_requested': a.quality, 'capacity_requested': a.capacity,
    'capacity_run': capacity_selected,
    'capacity_deferral': policy.get('reason') if a.capacity and not capacity_selected else None}, indent=2) + '\n')
(out / 'complete').write_text('Selected campaign checks passed; see checks.json\n')
