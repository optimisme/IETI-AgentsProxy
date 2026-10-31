#!/usr/bin/env python3
"""Separate experiment: retain pressure-aware memory policy, change prefill ordering."""
import hashlib,importlib.metadata,sys
from pathlib import Path
import policy_runtime as instrument
from coalesce import install as install_coalescing
from adaptive import install as install_adaptive
from tail import install as install_tail


def install():
    from tensorfold.families.qwen4_exp.cuda import multi_fill
    instrument.guard(multi_fill,'f2996562162e91a2faeb391bc0cefec6266b4aa3637aa05010bd0b24b7d97456')
    assert multi_fill.FILL_GUARD==8
    multi_fill.FILL_GUARD=64
    policy_files=('policy_runtime.py','coalesce.py','adaptive.py','tail.py','order64.py')
    root=Path(__file__).resolve().parent
    instrument.write('candidate_installed',name='reserve8-tail-order64',prefill_guard=64,
        policy_source_sha256={name:hashlib.sha256((root/name).read_bytes()).hexdigest() for name in policy_files},
        note='Only this increment changes prefill overdue-pass threshold 8 to 64. No chunk-size, model, precision or MTP change.')

