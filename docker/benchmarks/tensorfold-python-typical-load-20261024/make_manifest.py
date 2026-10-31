#!/usr/bin/env python3
"""Hash stable local campaign artifacts after all writers stop; exclude credentials."""
import datetime,hashlib,json
from pathlib import Path
ROOT=Path(__file__).resolve().parent
DOCKER=ROOT.parent.parent

def main():
    excluded={'MANIFEST.sha256','manifest.json','controller.lock','controller.pid','telemetry.pid','controller.log','telemetry.log','.DS_Store'}
    paths=[]
    for p in ROOT.rglob('*'):
        if p.is_file() and p.name not in excluded and '__pycache__' not in p.parts and p.suffix not in {'.pyc','.env','.pem','.key'}:paths.append(p)
    paths+=list((DOCKER/'models').glob('qwen38-flash-next-python-typical-*-test-128gb.yml'))
    paths.append(DOCKER/'models/qwen38-flash-next-python-opt16-tuned-128gb.yml')
    paths+=[p for p in (DOCKER/'patches/tensorfold-python-opt16-v065').rglob('*') if p.is_file() and '__pycache__' not in p.parts]
    paths+=[DOCKER/'README.md',DOCKER/'patches/licenses/TensorFold-Apache-2.0.txt',DOCKER/'benchmarks/tensorfold-zig-cache-tuning-20261018/benchmark.py',DOCKER/'benchmarks/tensorfold-zig-cache-tuning-20261018/fixtures.json']
    records=[]
    for p in sorted(set(paths)):
        if p.is_symlink():raise RuntimeError(f'Unexpected artifact symlink: {p}')
        records.append({'path':p.relative_to(DOCKER).as_posix(),'bytes':p.stat().st_size,'sha256':hashlib.sha256(p.read_bytes()).hexdigest()})
    (ROOT/'manifest.json').write_text(json.dumps({'created_utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'files':records,'note':'Paths relative to local/remote docker root. Credentials, transient locks/PIDs, bytecode and this manifest are excluded.'},indent=2)+'\n')
    (ROOT/'MANIFEST.sha256').write_text(''.join(f"{r['sha256']}  {r['path']}\n" for r in records))
    print(json.dumps({'files':len(records),'bytes':sum(r['bytes'] for r in records)}))

if __name__=='__main__':main()
