#!/usr/bin/env python3
"""Prove that checkpoint selection did not change the installed engine assets."""
import hashlib
import json
import sys
from pathlib import Path


def fingerprint(root):
    root = Path(root)
    paths = [root / 'install/native/bin/tensorfold-native']
    paths += sorted((root / 'install/share/tensorfold/cuda').rglob('*'))
    paths += sorted((root / 'python/tensorfold').rglob('*.py'))
    hashes = {str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest()
              for p in paths if p.is_file()}
    return hashes


a, b = map(fingerprint, sys.argv[1:3])
assert a == b, 'Native executable, AOT kernels or Python vision helper sources differ'
expected = '2a34b24a396c8186e998cb4fe5ae1903ac951e83452d13a99168da90b1de4462'
assert a['install/native/bin/tensorfold-native'] == expected
print(json.dumps({'identical': True, 'files_compared': len(a), 'native_sha256': expected,
                  'asset_manifest_sha256': hashlib.sha256(json.dumps(a, sort_keys=True).encode()).hexdigest(),
                  'assets': a}, indent=2))
