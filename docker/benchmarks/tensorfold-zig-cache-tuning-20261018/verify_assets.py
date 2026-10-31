#!/usr/bin/env python3
"""Verify CUDA AOT assets and vision helper sources stay unchanged by cache tuning."""
import hashlib
import json
import sys
from pathlib import Path


def files(folder):
    root = Path(folder)
    paths = list((root / 'install/share/tensorfold/cuda').rglob('*'))
    paths += list((root / 'python/tensorfold').rglob('*.py'))
    return {str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in paths if p.is_file()}


a, b = map(files, sys.argv[1:3])
assert a == b, 'CUDA AOT assets or Python vision helper sources changed'
native = Path(sys.argv[2]) / 'install/native/bin/tensorfold-native'
print(json.dumps({'unchanged_assets': True, 'asset_files': len(a),
    'native_sha256': hashlib.sha256(native.read_bytes()).hexdigest(),
    'asset_manifest_sha256': hashlib.sha256(json.dumps(a, sort_keys=True).encode()).hexdigest()}, indent=2))
