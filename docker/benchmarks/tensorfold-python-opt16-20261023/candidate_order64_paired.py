#!/usr/bin/env python3
"""Separate experiment: retain pressure-aware memory policy, change prefill ordering."""
import hashlib,importlib.metadata,sys
from pathlib import Path
import instrument_paired as instrument
from candidate_coalesce_paired import install as install_coalescing
from candidate_adaptive_paired import install as install_adaptive
from candidate_tail_paired import install as install_tail


def install():
    from tensorfold.families.qwen4_exp.cuda import multi_fill
    expected=Path(__file__).resolve().parent/'upstream/families/qwen4_exp/cuda/multi_fill.py'
    assert hashlib.sha256(expected.read_bytes()).digest()==hashlib.sha256(Path(multi_fill.__file__).read_bytes()).digest(),'Pinned prefill source drifted'
    assert multi_fill.FILL_GUARD==8
    multi_fill.FILL_GUARD=64
    policy_files=('instrument_paired.py','candidate_coalesce_paired.py','candidate_adaptive_paired.py','candidate_tail_paired.py','candidate_order64_paired.py')
    root=Path(__file__).resolve().parent
    instrument.write('candidate_installed',name='reserve8-tail-order64',prefill_guard=64,
        policy_source_sha256={name:hashlib.sha256((root/name).read_bytes()).hexdigest() for name in policy_files},
        note='Only this increment changes prefill overdue-pass threshold 8 to 64. No chunk-size, model, precision or MTP change.')


if __name__=='__main__':
    instrument.install();install_coalescing();install_adaptive();install_tail();install()
    sys.argv=['tensorfold',*sys.argv[1:]]
    entry=next(e for e in importlib.metadata.entry_points(group='console_scripts') if e.name=='tensorfold')
    sys.exit(entry.load()())
