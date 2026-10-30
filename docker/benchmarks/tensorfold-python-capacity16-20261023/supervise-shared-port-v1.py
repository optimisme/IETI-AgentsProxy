#!/usr/bin/env python3
"""Guard the existing test-host Python runtime during matched 16 x 75k tests."""
import collections
import datetime
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time
import urllib.request

ROOT = Path(__file__).resolve().parent
OUT = ROOT / 'python-current'
CONTAINER = 'qwen38_flash_next_cuda_vram128_tensorfold_mlx_4bit_mtp_int8_ssd_vision'
BASE = 'http://127.0.0.1:8000'
sys.path.insert(0, str(ROOT))
import probe


def save(name, value):
    (ROOT / name).write_text(json.dumps(value, indent=2) + '\n')


def docker(*args, timeout=30):
    return subprocess.check_output(['docker', *args], text=True, timeout=timeout)


def state():
    return json.loads(docker('inspect', CONTAINER, '--format', '{{json .State}}'))


def configuration():
    # Read only these nonsensitive environment settings; never record credentials.
    allowed = {'TENSORFOLD_PROMPT_SNAPSHOTS', 'TENSORFOLD_SSD_BATCH_GATHER',
               'TENSORFOLD_CONTEXT', 'TENSORFOLD_STREAMS', 'TENSORFOLD_PREFILL_ROWS',
               'TF_FLASH_STAGE_AHEAD'}
    env = json.loads(docker('inspect', CONTAINER, '--format', '{{json .Config.Env}}'))
    selected = dict(v.split('=', 1) for v in env if v.split('=', 1)[0] in allowed)
    return {'environment': selected,
            'image': docker('inspect', CONTAINER, '--format', '{{.Image}}').strip()}


def preflight():
    h = probe.health(BASE)
    assert h['ok'] and h.get('requests_running', 0) == 0, h
    assert h['context_length'] == 75000 and h['streams']['max'] == 16, h
    model = probe.api(BASE, '/v1/models')['data'][0]['id']
    fixtures = ROOT.parent / 'tensorfold-zig-cache-tuning-20261018/fixtures.json'
    data = json.loads(fixtures.read_text())
    histories = [[{'role': 'user', 'content': f'tuned16-full independent agent {i}.\n' + data['74000']}]
                 for i in range(16)]
    stages = []
    for turn in range(3):
        if turn:
            for history in histories:
                history.extend([
                    {'role': 'assistant', 'content': 'I will preserve the public interface and add regression coverage.'},
                    {'role': 'user', 'content': f'Turn {turn}: describe the next regression test and explain why it matters.'}])
        counts = [probe.api(BASE, '/tokenize', probe.body(model, history, 896))['count']
                  for history in histories]
        assert max(counts) + 896 <= 75000, counts
        stages.append({'stage': turn, 'input_counts': counts, 'max_tokens': 896,
                       'max_input_plus_output': max(counts) + 896})
    save('preflight.json', {'utc': datetime.datetime.now(datetime.timezone.utc).isoformat(),
         'health': h, 'memory': probe.memory(), 'configuration': configuration(),
         'model': model, 'stages': stages,
         'fixtures_sha256': hashlib.sha256(fixtures.read_bytes()).hexdigest(),
         'client_sha256': hashlib.sha256((ROOT / 'probe.py').read_bytes()).hexdigest()})


def main():
    OUT.mkdir(exist_ok=True)
    assert not (OUT / 'metadata-capacity.json').exists(), 'Preserve the existing run; choose a fresh directory'
    initial_state = state()
    save('state-before.json', initial_state)
    preflight()
    initial_memory = probe.memory()
    recent = collections.deque(maxlen=120)
    interrupted = []
    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, lambda number, frame: interrupted.append(number))
    client = None
    abort = None
    client_code = None
    restarted = False
    try:
        client = subprocess.Popen([sys.executable, '-u', str(ROOT / 'probe.py'), 'capacity',
            '--base', BASE, '--out', str(OUT), '--tag', 'tuned16-full'], start_new_session=True)
        while client.poll() is None:
            sample = {'utc': datetime.datetime.now(datetime.timezone.utc).isoformat(), **probe.memory()}
            recent.append(sample)
            if interrupted:
                abort = {'reason': 'controller_interrupted', 'signal': interrupted[-1], **sample}
            elif sample['available_gib'] < 6:
                abort = {'reason': 'host_available_below_6_gib', **sample}
            elif sample['oom_kill'] > initial_memory['oom_kill']:
                abort = {'reason': 'new_host_oom_kill', **sample}
            elif sample['pswpout'] - initial_memory['pswpout'] > 262144:
                abort = {'reason': 'more_than_1_gib_new_swap_out', **sample}
            if abort:
                save('supervisor-abort.json', {'trigger': abort, 'recent_samples': list(recent)})
                print('SUPERVISOR_ABORT', json.dumps(abort), flush=True)
                break
            time.sleep(.5)
        client_code = client.poll()
        if abort is None and client_code != 0:
            abort = {'reason': 'benchmark_client_failed', 'client_exit_code': client_code,
                     'memory': probe.memory()}
            save('supervisor-abort.json', {'trigger': abort, 'recent_samples': list(recent)})
    except BaseException as error:
        abort = {'reason': 'controller_exception', 'error': repr(error), 'memory': probe.memory()}
        save('supervisor-abort.json', {'trigger': abort, 'recent_samples': list(recent)})
        raise
    finally:
        if client is not None and client.poll() is None:
            try:
                signal_group = client.pid
                os.killpg(signal_group, signal.SIGTERM)
                client.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(signal_group, signal.SIGKILL)
                client.wait(timeout=5)
        try:
            (ROOT / 'runtime.log').write_text(docker('logs', '--tail', '12000', CONTAINER))
        except Exception as error:
            save('log-capture-error.json', {'error': repr(error)})
        if abort:
            # Closing the client alone does not guarantee immediate GPU cancellation.
            docker('stop', '--timeout', '10', CONTAINER, timeout=30)
            save('state-after-abort.json', state())
            docker('start', CONTAINER)
            restarted = True
        healthy = False
        for _ in range(240):
            try:
                h = probe.health(BASE)
                if h.get('ok'):
                    save('final-health.json', h)
                    healthy = True
                    break
            except Exception:
                pass
            time.sleep(5)
        final_state = state()
        save('state-after.json', final_state)
        save('controller-result.json', {'client_exit_code': client_code, 'aborted': abort is not None,
             'abort': abort, 'runtime_restarted_for_recovery': restarted,
             'healthy_after_test': healthy,
             'started_at_before': initial_state['StartedAt'],
             'started_at_after': final_state['StartedAt'], 'memory_after': probe.memory()})
    return 0 if client_code == 0 and abort is None and healthy else 1


if __name__ == '__main__':
    sys.exit(main())
