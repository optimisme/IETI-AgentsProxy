#!/usr/bin/env python3
"""Unscreened pressure-aware extension of the nearby-snapshot policy."""
import collections,functools,importlib.metadata,sys,time
import instrument_paired as instrument
from candidate_coalesce_paired import install as install_coalescing


def install():
    import torch
    from tensorfold.families.qwen4_exp.cuda import prefixes
    previous=prefixes.remember
    @functools.wraps(previous)
    def bounded(owner,ids,st,snap,tail):
        result=previous(owner,ids,st,snap,tail)
        if getattr(owner,'planning',False) or owner.memory_gate.live is None:return result
        # A full sixteen-stream snapshot wave measured ~1.72 GiB. Keep 2 GiB
        # extra allocatable room above the upstream growth reserve when possible.
        target=owner.memory_gate.reserve+2*1024**3
        live=owner.memory_gate.live()
        if live>=target:return result
        counts=collections.Counter(id(k[1]) for k in owner.kept)
        removed=[];started=time.perf_counter()
        while live<target:
            entry=next((k for k in owner.kept if counts[id(k[1])]>1),None)
            if entry is None:break
            removed.append({'slot_index':next((i for i,v in enumerate(owner.slots) if v is entry[1]),None),'position':len(entry[0])})
            counts[id(entry[1])]-=1
            owner.kept=[k for k in owner.kept if k is not entry]
            del entry
            live=owner.memory_gate.live()
        if removed:
            # Return released cached blocks to the unified host pool as well.
            # This may synchronize allocator work; measure the cost explicitly.
            torch.cuda.empty_cache()
            instrument.COUNTS['pressure_pruned_snapshots']+=len(removed)
            instrument.write('snapshot_pressure_prune',removed=removed,remaining_entries=len(owner.kept),
                target_live_bytes=target,live_after_bytes=owner.memory_gate.live(),
                host_wall_s=time.perf_counter()-started,
                rule='Oldest extra checkpoint first; retain at least the newest checkpoint of every retained slot.')
        return result
    prefixes.remember=bounded
    from tensorfold.families.qwen4_exp.cuda.multi import MultiDecoder
    checked=[0.0]
    def trim_unused():
        now=time.monotonic()
        if now-checked[0]<1:return
        checked[0]=now
        from pathlib import Path
        fields=dict(line.split(':',1) for line in Path('/proc/meminfo').read_text().splitlines())
        available=int(fields['MemAvailable'].split()[0])*1024
        unused=int(torch.cuda.memory_reserved())-int(torch.cuda.memory_allocated())
        if available>=9*1024**3 or unused<256*1024**2:return
        started=time.perf_counter();before=int(torch.cuda.memory_reserved())
        torch.cuda.empty_cache()
        instrument.COUNTS['allocator_host_trims']+=1
        instrument.write('allocator_host_trim',host_available_before_bytes=available,
            unused_before_bytes=unused,reserved_before_bytes=before,
            reserved_after_bytes=int(torch.cuda.memory_reserved()),host_wall_s=time.perf_counter()-started,
            rule='Return only unused allocator blocks when unified host available RAM is below 9 GiB.')
    round0=MultiDecoder.round
    @functools.wraps(round0)
    def rounded(self,*args,**kwargs):
        trim_unused();result=round0(self,*args,**kwargs);trim_unused();return result
    MultiDecoder.round=rounded
    pass0=MultiDecoder._pass
    @functools.wraps(pass0)
    def passed(self,*args,**kwargs):
        trim_unused();result=pass0(self,*args,**kwargs);trim_unused();return result
    MultiDecoder._pass=passed
    instrument.write('candidate_installed',name='reserve8-adaptive',extra_headroom_bytes=2*1024**3,
        note='Unscreened: pressure-aware snapshot pruning; no model/precision changes. May trade older branch hits for capacity under pressure.')


if __name__=='__main__':
    instrument.install();install_coalescing();install()
    sys.argv=['tensorfold',*sys.argv[1:]]
    entry=next(e for e in importlib.metadata.entry_points(group='console_scripts') if e.name=='tensorfold')
    sys.exit(entry.load()())
