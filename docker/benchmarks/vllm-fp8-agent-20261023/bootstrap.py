#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Pinned vLLM/Spark experiment; CPU download mode and supervised GPU serve."""
import ast
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tarfile
import time
import urllib.request

MODEL = 'Inferact/Qwen3.8-Flash-Next-NVFP4'
REVISION = '103a7608316173ca6edd49929544244de7ffda70'
MIA_REVISION = 'b7c5da1a9e7448a14b480deee66eda3799b1eb43'
ROOT = Path(os.environ.get('VLLM_CACHE_ROOT', '/root/.cache/vllm'))


def download():
    from huggingface_hub import snapshot_download
    snapshot = Path(snapshot_download(MODEL, revision=REVISION, max_workers=4))
    index = json.loads((snapshot / 'model.safetensors.index.json').read_text())
    names = set(index['weight_map'].values())
    assert all((snapshot / n).is_file() for n in names)
    print(json.dumps({'model': MODEL, 'revision': REVISION,
                      'snapshot': str(snapshot), 'weight_files': len(names),
                      'weight_gib': sum((snapshot/n).stat().st_size for n in names)/2**30}), flush=True)
    return snapshot


def replace(source, old, new):
    if source.count(old) != 1:
        raise RuntimeError('Pinned source anchor changed: ' + repr(old[:120]))
    return source.replace(old, new)


def patch_mmap():
    """Port Mia's 0.30 mmap storage patch onto 0.32's split/lazy implementation.

    The upstream generator is AGPL-3.0-or-later; its notice remains in the
    downloaded source. No attention, quantization or model arithmetic changes.
    """
    directory = ROOT / 'ieti-mia-source' / MIA_REVISION
    script = directory / 'files/patch_ple_mmap_v030.py'
    if not script.exists():
        url = ('https://codeload.github.com/MiaAI-Lab/'
               'Qwen3.8-Flash-Next-Single-DGX-Spark/tar.gz/' + MIA_REVISION)
        data = urllib.request.urlopen(url, timeout=120).read()
        directory.mkdir(parents=True, exist_ok=True)
        with tarfile.open(fileobj=io.BytesIO(data)) as archive:
            for member in archive.getmembers():
                rel = member.name.split('/', 1)
                if len(rel) == 2 and rel[1].startswith(('files/', 'LICENSE')):
                    member.name = rel[1]
                    archive.extract(member, directory, filter='data')
        (directory/'archive-sha256').write_text(hashlib.sha256(data).hexdigest()+'\n')
    spec = importlib.util.spec_from_file_location('mia_mmap', script)
    if hashlib.sha256(script.read_bytes()).hexdigest() != 'b63bb3d86ececfe5d0dac7f4c072407c9745fab7b6ed856175bc8f668c107309':
        raise RuntimeError('Pinned Mia generator checksum mismatch')
    upstream = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(upstream)
    package = Path(importlib.util.find_spec('vllm').origin).parent
    paths = {
        'common/ngram_embedding.py': 'ad4de618a5810aec3b02f6152b4f5c422a648ca930aa3c3e747524498489f53d',
        'nvidia/ngram_embedding.py': '54e264b837b017bf727c20742202ff0402aac1b30329c558b1271f3479fd5d44',
    }
    sources = {}
    for rel, digest in paths.items():
        target = package / 'models/qwen4_exp' / rel
        original = ROOT / 'ieti-v032-originals' / rel
        original.parent.mkdir(parents=True, exist_ok=True)
        if not original.exists():
            original.write_bytes(target.read_bytes())
        if hashlib.sha256(original.read_bytes()).hexdigest() != digest:
            raise RuntimeError('Unexpected vLLM 0.32 source: ' + rel)
        sources[rel] = original.read_text()
    common = sources['common/ngram_embedding.py']
    for i in (0, 1, 2, 3, 4, 7, 8, 9):
        common = replace(common, *upstream.EDITS[i])
    common = replace(common, 'from vllm.compilation.breakable_cudagraph import eager_break_during_capture\n',
                     'from vllm.config import get_current_vllm_config\n'
                     'from vllm.compilation.breakable_cudagraph import eager_break_during_capture\n')
    common = replace(common,
        '        self._uva_weight = get_accelerator_view_from_cpu_tensor(self.weight)\n',
        '        self._uva_weight = (get_accelerator_view_from_cpu_tensor(self.weight)\n'
        '                            if self._mmap_path is None else None)\n'
        '        self._lookup_device = (self._uva_weight.device if self._uva_weight is not None\n'
        '                               else torch.device("cuda", torch.cuda.current_device()))\n'
        '        self._block_b = triton.next_power_of_2(self.embedding_dim * self.weight.element_size())\n'
        '        logger.info("PLE mmap path=%s ready=%s GiB=%.2f", self._mmap_path,\n'
        '                    self._mmap_ready, self.weight.numel()*self.weight.element_size()/2**30)\n')
    # 0.32 allocates the side stream and output buffer lazily, unlike 0.30.
    assert common.count('device=self._uva_weight.device') == 2
    common = common.replace('device=self._uva_weight.device', 'device=self._lookup_device')
    nvidia = replace(sources['nvidia/ngram_embedding.py'], *upstream.EDITS[10])
    for rel, source in [('common/ngram_embedding.py', common), ('nvidia/ngram_embedding.py', nvidia)]:
        ast.parse(source)
        (package / 'models/qwen4_exp' / rel).write_text(source)
        print('mmap_patch', rel, hashlib.sha256(source.encode()).hexdigest(), flush=True)


def memory():
    m = {k: int(v.split()[0]) for k, v in
         (line.split(':', 1) for line in Path('/proc/meminfo').read_text().splitlines())}
    return m['MemAvailable']/1048576


def serve(snapshot):
    patch_mmap()
    count = int(os.environ.get('MAX_NUM_SEQS', '16'))
    mtp = int(os.environ.get('MTP_TOKENS', '3'))
    graph_sizes = [1,2,4,8,12,16] + ([24,32,48,64] if mtp else [])
    command = ['vllm', 'serve', str(snapshot), '--served-model-name', MODEL,
        '--host', '0.0.0.0', '--port', '8000', '--tensor-parallel-size', '1',
        '--max-model-len', '75000', '--max-num-seqs', str(count),
        '--max-num-batched-tokens', os.environ.get('MAX_NUM_BATCHED_TOKENS', '2048'),
        '--kv-cache-dtype', 'fp8', '--attention-config.indexer_kv_dtype', 'fp8',
        '--gpu-memory-utilization', os.environ.get('GPU_MEMORY_UTILIZATION', '0.80'),
        '--engram-config', '{"cpu_offload":true,"dp_shared_memory":false}',
        '--enable-prefix-caching', '--enable-chunked-prefill',
        '--enable-prompt-tokens-details',
        '--load-format', 'safetensors', '--safetensors-load-strategy', 'lazy',
        '--limit-mm-per-prompt', '{"image":1,"video":0}',
        '--mm-processor-kwargs', '{"max_pixels":1048576}',
        '--reasoning-parser', 'qwen3', '--enable-auto-tool-choice', '--tool-call-parser', 'qwen3_coder',
        '--compilation-config', json.dumps({'mode':0, 'cudagraph_mode':'FULL_DECODE_ONLY',
            'cudagraph_capture_sizes': graph_sizes})]
    if mtp:
        spec = {'method':'mtp','num_speculative_tokens':mtp}
        if os.environ.get('MTP_DISABLE_BLOCK_DROP') == '1':
            spec['disable_eagle_block_drop'] = True
        command += ['--speculative-config', json.dumps(spec)]
    granularity = int(os.environ.get('PREFIX_MATCH_UNIT', '0'))
    if granularity:
        command += ['--prefix-match-unit', str(granularity)]
    if os.environ.get('SHARED_PREFIX_CHECKPOINT') == '1':
        command += ['--enable-mamba-shared-prefix-checkpoint']
    ssm = os.environ.get('SSM_CACHE_DTYPE', 'float32')
    command += ['--mamba-ssm-cache-dtype', ssm]
    if os.environ.get('ENFORCE_EAGER') == '1':
        command += ['--enforce-eager']
    print('serve_command', json.dumps(command), flush=True)
    process = subprocess.Popen(command, start_new_session=True)
    def stop(*_):
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGTERM)
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    low = 0
    while process.poll() is None:
        low = low + 1 if memory() < 6 else 0
        if low >= 3:
            print('HOST_MEMORY_ABORT', memory(), flush=True)
            stop()
            try: process.wait(timeout=30)
            except subprocess.TimeoutExpired: os.killpg(process.pid, signal.SIGKILL)
            return 78
        time.sleep(2)
    return process.returncode


if __name__ == '__main__':
    if '--patch-only' in sys.argv:
        patch_mmap()
        sys.exit(0)
    snapshot = download()
    if '--download-only' not in sys.argv:
        sys.exit(serve(snapshot))
