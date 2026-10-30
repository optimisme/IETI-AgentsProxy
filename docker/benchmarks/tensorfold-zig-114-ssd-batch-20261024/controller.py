#!/usr/bin/env python3
"""Bounded same-GPU screening, restoring the original service even on failure."""
import fcntl
import hashlib
import json
import os
import signal
import subprocess
import sys
import threading
import time
from pathlib import Path
import screen

ROOT = Path(__file__).resolve().parent
DOCKER = ROOT.parent.parent
NORMAL = 'qwen38_flash_next_cuda_vram128_tensorfold_mlx_4bit_mtp_int8_ssd_vision'
NATIVE = 'qwen38_flash_next_tensorfold_114_ple_cuda'
CHILD = None


def command(*args, timeout=90, check=True, env=None):
    p = subprocess.run(args, capture_output=True, text=True, timeout=timeout, env=env)
    if check and p.returncode:
        raise RuntimeError(str(args[:3]) + ': ' + (p.stdout + p.stderr)[-3000:])
    return p.stdout + p.stderr


def inspect(name):
    value = json.loads(command('docker', 'inspect', name))[0]
    return {k: value[k] for k in ('Id', 'Image', 'State', 'Mounts')} | {
        'Cmd': value['Config']['Cmd'], 'Entrypoint': value['Config']['Entrypoint'],
        'Resources': {k: value['HostConfig'][k] for k in ('NanoCpus', 'Memory', 'CpuQuota', 'CpusetCpus')},
        'PLE_flag': [x for x in value['Config']['Env'] if x.startswith('TF_FLASHNEXT_PLE_BATCH=')],
        'profile': value['Config'].get('Labels', {}).get('com.ieti.profile')}


def ready(port, name, timeout=360):
    end = time.monotonic() + timeout
    initial = screen.memory()
    while time.monotonic() < end:
        if command('docker', 'inspect', name, '--format', '{{.State.Running}}', check=False).strip() != 'true':
            raise RuntimeError(name + ' exited during startup')
        m = screen.memory()
        if m['available_gib'] < 6 or m['oom_kill'] > initial['oom_kill'] or m['pswpout'] - initial['pswpout'] > 262144:
            raise RuntimeError('Startup memory guard: ' + str(m))
        try:
            return screen.health(f'http://127.0.0.1:{port}')
        except Exception:
            time.sleep(2)
    raise RuntimeError(name + ' startup exceeded six minutes')


def interrupted(signum, frame):
    raise InterruptedError('Controller signal ' + str(signum))


def measure(label, port):
    global CHILD
    stop = threading.Event()

    def telemetry():
        with (ROOT / (label + '-telemetry.jsonl')).open('a', buffering=1) as log:
            while not stop.is_set():
                try:
                    gpu = command('nvidia-smi', '--query-gpu=name,utilization.gpu,temperature.gpu,power.draw,clocks.sm',
                                  '--format=csv,noheader,nounits', timeout=5).strip()
                    log.write(json.dumps({'epoch': time.time(), 'gpu': gpu, **screen.memory()}) + '\n')
                except Exception as exc:
                    log.write(json.dumps({'error': repr(exc)}) + '\n')
                stop.wait(1)

    worker = threading.Thread(target=telemetry, daemon=True)
    worker.start()
    try:
        with (ROOT / (label + '-client.log')).open('w') as log:
            CHILD = subprocess.Popen([sys.executable, '-u', str(ROOT / 'screen.py'), 'run',
                '--url', f'http://127.0.0.1:{port}', '--out', str(ROOT / label)], stdout=log, stderr=subprocess.STDOUT)
            code = CHILD.wait(timeout=600)
            if code:
                raise RuntimeError(label + ' client exited ' + str(code))
    finally:
        if CHILD and CHILD.poll() is None:
            CHILD.terminate()
            try:
                CHILD.wait(timeout=5)
            except subprocess.TimeoutExpired:
                CHILD.kill()
                CHILD.wait(timeout=5)
        CHILD = None
        stop.set()
        worker.join(timeout=6)


def main():
    lock = (ROOT / 'controller.lock').open('w')
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    assert not (ROOT / 'result.json').exists(), 'Preserve previous result'
    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, interrupted)
    initial = inspect(NORMAL)
    screen.save(ROOT / 'normal-before.json', initial)
    result = {'started_epoch': time.time(), 'completed': [], 'error': None, 'restored': False}
    stopped = False
    try:
        assert initial['State']['Running']
        active = command('docker', 'ps', '--filter', 'label=com.ieti.inference=true', '--format', '{{.Names}}').splitlines()
        assert active == [NORMAL], active
        assert screen.health('http://127.0.0.1:8000')['requests_running'] == 0, 'Normal service busy'
        stopped = True
        command('docker', 'stop', '--timeout', '45', NORMAL)
        profile = DOCKER / 'models/qwen38-flash-next-tensorfold-114-ple-batch-mlx-4bit-vision-128gb.yml'
        for label, flag in [('off', '0'), ('on', '1')]:
            print('Starting patched 1.1.4: ' + label, flush=True)
            env = {**os.environ, 'TENSORFOLD_CONTEXT': '75000', 'TENSORFOLD_STREAMS': '8',
                   'TENSORFOLD_PROMPT_CACHE_GIB': '8', 'TENSORFOLD_BIND_PORT': '8007',
                   'TF_FLASHNEXT_PLE_BATCH': flag}
            (ROOT / (label + '-profile.yml')).write_text(command('docker', 'compose', '-f', str(profile), 'config', env=env))
            command('docker', 'compose', '-f', str(profile), 'up', '-d', '--force-recreate', env=env, timeout=120)
            screen.save(ROOT / (label + '-health-before.json'), ready(8007, NATIVE))
            screen.save(ROOT / (label + '-runtime.json'), inspect(NATIVE))
            (ROOT / (label + '-binary-sha256.txt')).write_text(command('docker', 'exec', NATIVE,
                'sha256sum', '/opt/ieti-native114/install/native/bin/tensorfold-native'))
            measure(label, 8007)
            import functional
            functional.run(label, 'http://127.0.0.1:8007')
            result['completed'].append(label)
            (ROOT / (label + '-runtime.log')).write_text(command('docker', 'logs', NATIVE, check=False))
            command('docker', 'stop', '--timeout', '30', NATIVE)
            print(label + ' measurements complete', flush=True)
        import analyze
        analyze.main()
    except BaseException as exc:
        result['error'] = repr(exc)
        print('SCREEN_ERROR ' + repr(exc), flush=True)
    finally:
        for sig in (signal.SIGTERM, signal.SIGINT):
            signal.signal(sig, signal.SIG_IGN)
        (ROOT / 'candidate-final.log').write_text(command('docker', 'logs', NATIVE, check=False))
        if stopped:
            command('docker', 'stop', '--timeout', '20', NATIVE, check=False)
        if stopped:
            try:
                command('docker', 'start', NORMAL)
                screen.save(ROOT / 'restored-health.json', ready(8000, NORMAL, timeout=360))
                restored = inspect(NORMAL)
                screen.save(ROOT / 'normal-after.json', restored)
                result['restored'] = restored['Id'] == initial['Id'] and restored['Cmd'] == initial['Cmd'] and restored['Image'] == initial['Image']
            except Exception as exc:
                result['restore_error'] = repr(exc)
        result['ended_epoch'] = time.time()
        screen.save(ROOT / 'result.json', result)
        print(json.dumps(result), flush=True)


if __name__ == '__main__':
    main()
