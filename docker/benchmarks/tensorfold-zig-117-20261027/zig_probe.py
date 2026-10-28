"""The Python capacity campaign's probe (smoke, quality, capacity modes) against any server: its health() reads vLLM
metrics or Python's counters, so a TensorFold Zig /health (live connections and waiting) is mapped onto the same fields.
usage: zig_probe.py MODE --base URL --out DIR [--tag TAG]"""
import json, sys, urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / 'tensorfold-python-capacity16-20261023'))
import probe  # noqa: E402

served = [0]


def health(base):
    with urllib.request.urlopen(base + '/health', timeout=5) as r:
        h = json.load(r)
    if 'requests_total' in h:
        return h
    live = h.get('live', {})
    return {'requests_running': live.get('connections', 0), 'requests_waiting': live.get('waiting', 0),
            'requests_total': served[0], 'memory': h.get('memory')}


request = probe.request


def counted(base, payload, barrier=None):
    r = request(base, payload, barrier)
    served[0] += 1
    return r


probe.health = health
probe.request = counted
probe.shared.request = counted
probe.main()
