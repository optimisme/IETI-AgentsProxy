#!/usr/bin/env python3
"""Incremental experiment: allocate a small final cache tail before late resizes."""
import functools,hashlib,importlib.metadata,sys
from pathlib import Path
import policy_runtime as instrument
from coalesce import install as install_coalescing
from adaptive import install as install_adaptive


def install():
    from tensorfold.families.qwen4_exp.cuda import multi
    instrument.guard(multi,'f56cbec323b6593be77efe0e9fa2c3c6af9c8bfeb17ed2859f1f31074359ef5d')
    assert multi.STEP==8192
    grow=multi.MultiDecoder._grow
    @functools.wraps(grow)
    def earlier(owner,st,rows,*args,**kwargs):
        if rows>st.capacity:
            rounded=min(st.limit,-(-rows//multi.STEP)*multi.STEP)
            if 0<st.limit-rounded<multi.STEP:
                instrument.COUNTS['tail_preallocations']+=1
                instrument.write('cache_tail_preallocate',requested_rows=rows,old_rounding=rounded,
                    new_rounding=st.limit,extra_bytes=st.cache_bytes(st.limit)-st.cache_bytes(rounded))
                rows=st.limit
        return grow(owner,st,rows,*args,**kwargs)
    multi.MultiDecoder._grow=earlier
    instrument.write('candidate_installed',name='reserve8-tail',step=multi.STEP,
        note='Allocate the final partial cache step early; at this window, 73728 becomes 75007. Model tokens and math unchanged.')

