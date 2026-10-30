#!/usr/bin/env python3
"""Read source files from containers without importing or initializing CUDA."""
import hashlib
import io
import json
import subprocess
import tarfile
from pathlib import Path

containers = {
    'baseline': 'qwen38_flash_next_python_lowload',
    'normal': 'qwen38_flash_next_cuda_vram128_tensorfold_mlx_4bit_mtp_int8_ssd_vision',
}
result = {}
for label, name in containers.items():
    archive = subprocess.check_output(['docker', 'cp', name +
        ':/opt/tensorfold-venv/lib/python3.12/site-packages/tensorfold/families/qwen4_exp/cuda', '-'])
    with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
        result[label] = {m.name: hashlib.sha256(tar.extractfile(m).read()).hexdigest()
                         for m in tar.getmembers() if m.isfile() and m.name.endswith('.py')}
result['identical'] = result['baseline'] == result['normal'] and bool(result['baseline'])
Path(__file__).with_name('python-source-equivalence.json').write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps({'identical': result['identical'], 'source_files': len(result['baseline'])}))
