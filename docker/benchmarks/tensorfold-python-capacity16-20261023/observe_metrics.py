#!/usr/bin/env python3
"""Read Python's engine metrics separately from the frozen comparison client."""
import json
from pathlib import Path
import re
import time
import urllib.request

ROOT = Path(__file__).resolve().parent
OUT = ROOT / 'isolated'


def main():
    failures = 0
    with (OUT / 'engine-metrics.jsonl').open('a', buffering=1) as target:
        while not (OUT / 'controller-result.json').exists():
            started = time.time()
            try:
                with urllib.request.urlopen('http://127.0.0.1:8009/metrics', timeout=3) as response:
                    raw = response.read().decode()
                scalar = {}
                pools = {}
                for line in raw.splitlines():
                    match = re.match(r'([^\s{]+)(?:\{([^}]*)\})?\s+([^\s]+)', line)
                    if not match or line.startswith('#'):
                        continue
                    try:
                        value = float(match[3])
                    except ValueError:
                        continue
                    if match[1] == 'tensorfold:kv_cache_usage_ratio':
                        pools[match[2]] = value
                    elif not match[2]:
                        scalar[match[1]] = value
                target.write(json.dumps({'time': started, 'metrics': scalar, 'kv_pool_usage': pools}) + '\n')
                failures = 0
            except Exception as error:
                failures += 1
                target.write(json.dumps({'time': started, 'error': repr(error)}) + '\n')
                if failures >= 3:
                    break
            time.sleep(max(0, 1 - (time.time() - started)))


if __name__ == '__main__':
    main()
