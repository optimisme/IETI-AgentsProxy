#!/usr/bin/env python3
"""Run the tested sixteen-user policies without benchmark instrumentation."""
import hashlib,importlib.metadata,json,sys
from pathlib import Path
from coalesce import install as coalesce
from adaptive import install as adaptive
from tail import install as tail
from order64 import install as order64

def main():
    coalesce();adaptive();tail();order64()
    root=Path(__file__).resolve().parent
    print('[ieti-opt16] '+json.dumps({'profiling':False,'prefill_guard':64,'constraints_sha256':hashlib.sha256((root/'constraints.txt').read_bytes()).hexdigest(),
        'policy_sha256':{p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(root.glob('*.py'))}}),flush=True)
    sys.argv=['tensorfold',*sys.argv[1:]]
    entry=next(e for e in importlib.metadata.entry_points(group='console_scripts') if e.name=='tensorfold')
    return entry.load()()

if __name__=='__main__':sys.exit(main())
