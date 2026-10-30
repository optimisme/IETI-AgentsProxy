#!/usr/bin/env python3
"""Experimental retention policy: reuse a nearby earlier checkpoint on the same slot."""
import functools,hashlib,importlib.metadata,os,sys
from pathlib import Path
import instrument_paired as instrument


def install():
    from tensorfold.cuda.markers import MIN_GAP
    from tensorfold.families.qwen4_exp.cuda import prefixes
    expected=Path(__file__).resolve().parent/'upstream/families/qwen4_exp/cuda/prefixes.py'
    actual=Path(prefixes.__file__)
    assert hashlib.sha256(expected.read_bytes()).digest()==hashlib.sha256(actual.read_bytes()).digest(),'Pinned prefix-retention source drifted'
    remember=prefixes.remember
    @functools.wraps(remember)
    def coalesced(owner,ids,st,snap,tail):
        # A future extension of ids also extends this earlier compatible prefix.
        # Cap additional prefill at MIN_GAP-1 tokens; never merge across slots.
        nearby=next((k for k in reversed(owner.kept) if k[1] is st
            and 0<len(ids)-len(k[0])<MIN_GAP and ids[:len(k[0])]==k[0]),None)
        if nearby is not None:
            instrument.COUNTS['retention_coalesced']+=1
            instrument.write('snapshot_coalesced',slot_index=next((i for i,v in enumerate(owner.slots) if v is st),None),retained_position=len(nearby[0]),
                skipped_position=len(ids),extra_prefill_bound=len(ids)-len(nearby[0]))
            return
        return remember(owner,ids,st,snap,tail)
    prefixes.remember=coalesced
    instrument.write('candidate_installed',name='reserve8-coalesced',min_gap=MIN_GAP,
        original_prefixes_sha256=hashlib.sha256(actual.read_bytes()).hexdigest(),
        policy='Skip a later snapshot only if a compatible earlier snapshot exists on the same state within MIN_GAP tokens. All other retention/free-slot behavior is upstream.')


if __name__=='__main__':
    instrument.install();install()
    sys.argv=['tensorfold',*sys.argv[1:]]
    entry=next(e for e in importlib.metadata.entry_points(group='console_scripts') if e.name=='tensorfold')
    sys.exit(entry.load()())
