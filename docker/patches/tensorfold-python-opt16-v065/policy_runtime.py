"""No profiling hooks: retain tested policy counters with discarded trace events."""
import collections,hashlib
from pathlib import Path
COUNTS=collections.Counter()

def write(*args,**kwargs):
    pass

def guard(module,expected):
    actual=hashlib.sha256(Path(module.__file__).read_bytes()).hexdigest()
    if actual!=expected:
        raise RuntimeError(f'Pinned TensorFold source drifted: {module.__name__}: {actual}')
