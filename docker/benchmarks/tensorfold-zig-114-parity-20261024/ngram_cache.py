#!/usr/bin/env python3
"""Page-cache experiment: drop clean cache for uploaded weights, prefetch PLE n-gram table ranges (read-only)."""
import json
import os
import struct
import sys
import time
from pathlib import Path

snap = Path(sys.argv[1])
mode = sys.argv[2] if len(sys.argv) > 2 else 'apply'
index = json.loads((snap / 'model.safetensors.index.json').read_text())['weight_map']
files = sorted(set(index.values()))
ngram_bytes = other_bytes = 0
resident = total = 0
for name in files:
    path = snap / name
    with open(path, 'rb') as fh:
        size = struct.unpack('<Q', fh.read(8))[0]
        header = json.loads(fh.read(size))
    base = 8 + size
    fd = os.open(path, os.O_RDONLY)
    try:
        for tensor, meta in header.items():
            if tensor == '__metadata__':
                continue
            lo, hi = meta['data_offsets']
            off, length = base + lo, hi - lo
            if 'ngram_embedding' in tensor:
                ngram_bytes += length
                if mode == 'apply':
                    os.posix_fadvise(fd, off, length, os.POSIX_FADV_WILLNEED)
                elif mode == 'read':
                    at = off
                    while at < off + length:
                        at += len(os.pread(fd, min(16 << 20, off + length - at), at))
            else:
                other_bytes += length
                if mode == 'apply':
                    os.posix_fadvise(fd, off, length, os.POSIX_FADV_DONTNEED)
    finally:
        os.close(fd)
print(json.dumps({'mode': mode, 'ngram_gib': ngram_bytes / 2**30, 'other_gib': other_bytes / 2**30}))
