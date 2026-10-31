#!/usr/bin/env python3
"""Incremental experiment: allocate a small final cache tail before late resizes."""
import functools,hashlib,importlib.metadata,sys
from pathlib import Path
import instrument_paired as instrument
from candidate_coalesce_paired import install as install_coalescing
from candidate_adaptive_paired import install as install_adaptive


def install():
    from tensorfold.families.qwen4_exp.cuda import multi
    expected=Path(__file__).resolve().parent/'upstream/families/qwen4_exp/cuda/multi.py'
    assert hashlib.sha256(expected.read_bytes()).digest()==hashlib.sha256(Path(multi.__file__).read_bytes()).digest(),'Pinned cache-growth source drifted'
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


if __name__=='__main__':
    instrument.install();install_coalescing();install_adaptive();install()
    sys.argv=['tensorfold',*sys.argv[1:]]
    entry=next(e for e in importlib.metadata.entry_points(group='console_scripts') if e.name=='tensorfold')
    sys.exit(entry.load()())
