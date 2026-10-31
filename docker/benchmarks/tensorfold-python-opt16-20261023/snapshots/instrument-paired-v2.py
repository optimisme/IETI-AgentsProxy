#!/usr/bin/env python3
"""Low frequency host-side diagnostics; never synchronizes CUDA or changes math."""
import array
import collections
import functools
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import sys
import threading
import time

TRACE = Path('/ieti-results') / os.environ['IETI_RUN'] / 'engine.jsonl'
TRACE.parent.mkdir(parents=True, exist_ok=True)
FILE = TRACE.open('a', buffering=1)
LOCK = threading.Lock()
COUNTS = collections.Counter()
LAST = {}


def write(kind, **data):
    with LOCK:
        FILE.write(json.dumps({'event':kind, 'time':time.time(), 'monotonic':time.monotonic(), **data}, separators=(',',':'))+'\n')


def tokens_hash(tokens):
    values=array.array('i',tokens)
    if sys.byteorder!='little': values.byteswap()
    return hashlib.sha256(values.tobytes()).hexdigest()


def throttle(key, interval=1):
    now=time.monotonic()
    if now-LAST.get(key,0)<interval:return False
    LAST[key]=now
    return True


def install():
    import torch
    from tensorfold.cuda.memory_gate import MemoryGate, NoRoom
    from tensorfold.cuda.scheduler import Waiting
    from tensorfold.cuda.streams import Stream
    from tensorfold.families.qwen4_exp.cuda.multi import MultiDecoder

    def size(objects):
        seen=set();storages=set();total=0
        def visit(x,depth):
            nonlocal total
            if x is None or isinstance(x,(str,bytes,int,float,bool)) or id(x) in seen:return
            seen.add(id(x))
            if isinstance(x,torch.Tensor):
                if x.device.type=='cuda':
                    storage=x.untyped_storage();key=(x.device.index,storage.data_ptr())
                    if key not in storages:storages.add(key);total+=storage.nbytes()
                return
            if depth<=0:return
            if isinstance(x,dict):items=x.values()
            elif isinstance(x,(list,tuple)):items=x
            elif type(x).__module__.startswith('tensorfold'):items=vars(x).values() if hasattr(x,'__dict__') else ()
            else:return
            for item in items:visit(item,depth-1)
        visit(objects,8)
        return total

    def sample(owner, force=False):
        if getattr(owner,'planning',False) or not force and not throttle(('sample',id(owner))):return
        started=time.perf_counter()
        gate=owner.memory_gate
        data={'allocated_bytes':torch.cuda.memory_allocated(),'reserved_bytes':torch.cuda.memory_reserved(),
            'max_allocated_bytes':torch.cuda.max_memory_allocated(),'gate_room_bytes':gate.room,
            'gate_held_bytes':gate.held,'gate_reserve_bytes':gate.reserve,
            'last_gate_live_bytes':getattr(gate,'_ieti_live',None),
            'decoding':len(owner.streams),'prefilling':len(owner.filling),'free_slots':len(owner.free),
            'kept_entries':len(owner.kept),'gate_waits':gate.waits,'gate_ends':gate.ends,
            'growing_cache_bytes':sum(st.cache_bytes() for st in owner.slots),
            'slot_capacities':[st.capacity for st in owner.slots],
            'counters':dict(COUNTS),
            'active_states':[{'sid':v.sid,'capacity':v.st.capacity,'position':v.st.pos,'output_tokens':len(v.out),
                'waiting':v.waiting,'token_sha256':getattr(v,'_ieti_token_hash',None)} for v in [*owner.streams.values(),*owner.filling]]}
        if force or throttle(('breakdown',id(owner)),10):
            data['component_bytes']={'slots':size(owner.slots),'retained_snapshots':size([k[2:] for k in owner.kept]),
                'shared_buffers':size([owner.buf,owner.mbuf,owner.pbuf,owner.gdn]),
                'weights_discovered':size(owner.w),'vision_discovered':size(owner.vision)}
            data['component_note']='Unique CUDA storages within each category; categories may overlap; discovered weights/vision may be incomplete. Not additive to allocator memory.'
        data['diagnostic_host_time_s']=time.perf_counter()-started
        write('sample',**data)

    init=MemoryGate.__init__
    @functools.wraps(init)
    def gate_init(self,room,reserve,live=None):
        def measured_live():
            value=live();self._ieti_live=value;return value
        return init(self,room,reserve,None if live is None else measured_live)
    MemoryGate.__init__=gate_init
    fits=MemoryGate.fits
    @functools.wraps(fits)
    def gate_fits(self,extra):
        result=fits(self,extra)
        if not result:
            reason='fixed_cache_budget' if self.held+int(extra)>self.room-self.reserve else 'live_memory'
            COUNTS['gate_reject_'+reason]+=1
            if throttle(('gate_reject',id(self),reason)):
                write('gate_reject',reason=reason,extra_bytes=int(extra),room_bytes=self.room,
                    held_bytes=self.held,reserve_bytes=self.reserve,live_bytes=getattr(self,'_ieti_live',None))
        return result
    MemoryGate.fits=gate_fits

    from tensorfold.families.qwen4_exp.cuda import prefixes
    remember0=prefixes.remember
    @functools.wraps(remember0)
    def remembered(owner,ids,st,snap,tail):
        result=remember0(owner,ids,st,snap,tail)
        if not getattr(owner,'planning',False):
            write('retention',slot_index=next((i for i,v in enumerate(owner.slots) if v is st),None),
                position=len(ids),kept_entries=len(owner.kept),
                slot_positions=[len(k[0]) for k in owner.kept if k[1] is st],
                allocated_bytes=torch.cuda.memory_allocated())
        return result
    prefixes.remember=remembered

    put=Waiting.put
    @functools.wraps(put)
    def enqueue(self,item,*args,**kwargs):
        stream=item[0]
        stream._ieti_token_hash=tokens_hash(stream.prompt)
        stream._ieti_enqueued=time.monotonic()
        write('enqueue',token_sha256=stream._ieti_token_hash,prompt_tokens=len(stream.prompt),output_allowance=stream.count)
        return put(self,item,*args,**kwargs)
    Waiting.put=enqueue

    admit=MultiDecoder.admit
    @functools.wraps(admit)
    def admitted(self,stream,*args,**kwargs):
        try:result=admit(self,stream,*args,**kwargs)
        except NoRoom as error:
            COUNTS['admission_rejections']+=1
            if throttle(('admit_reject',id(stream))):
                write('admission_reject',token_sha256=getattr(stream,'_ieti_token_hash',None),reason=str(error))
                sample(self)
            raise
        if not getattr(self,'planning',False):
            write('admitted',token_sha256=getattr(stream,'_ieti_token_hash',None),sid=stream.sid,
                cached=stream.cached,prompt_tokens=len(stream.prompt),output_allowance=stream.count,
                queue_s=time.monotonic()-getattr(stream,'_ieti_enqueued',time.monotonic()))
            sample(self,force=True)
        return result
    MultiDecoder.admit=admitted

    grow=MultiDecoder._grow
    @functools.wraps(grow)
    def grew(self,st,rows,*args,**kwargs):
        before=st.capacity;t0=time.perf_counter()
        result=grow(self,st,rows,*args,**kwargs)
        if before!=st.capacity and not getattr(self,'planning',False):
            write('cache_resize',from_rows=before,to_rows=st.capacity,requested_rows=rows,
                host_wall_s=time.perf_counter()-t0,copy_peak_layer_bytes=st.layer_bytes(st.capacity))
        return result
    MultiDecoder._grow=grew

    round0=MultiDecoder.round
    @functools.wraps(round0)
    def rounded(self,*args,**kwargs):
        result=round0(self,*args,**kwargs);sample(self);return result
    MultiDecoder.round=rounded

    pass0=MultiDecoder._pass
    @functools.wraps(pass0)
    def passed(self,*args,**kwargs):
        result=pass0(self,*args,**kwargs);sample(self);return result
    MultiDecoder._pass=passed

    take=Stream.take
    @functools.wraps(take)
    def took(self,new,*args,**kwargs):
        if not self.out and getattr(self,'_ieti_token_hash',None):
            write('first_token',token_sha256=self._ieti_token_hash,sid=self.sid,
                server_prefill_work_s=self.prefill_s,cached=self.cached)
        result=take(self,new,*args,**kwargs)
        if self.done and getattr(self,'_ieti_token_hash',None):
            write('finished',token_sha256=self._ieti_token_hash,sid=self.sid,output_tokens=len(self.out),
                stats=self.stats(),error=str(self.error) if self.error else None)
        return result
    Stream.take=took
    write('instrumentation_ready',pid=os.getpid(),candidate=os.environ.get('IETI_CANDIDATE','baseline'),
        note='No CUDA synchronization. Memory checks retain original return values; identical wrappers on all compared runs.',
        instrument_sha256=hashlib.sha256(Path(__file__).read_bytes()).hexdigest())


if __name__=='__main__':
    install()
    sys.argv=['tensorfold',*sys.argv[1:]]
    entry=next(e for e in importlib.metadata.entry_points(group='console_scripts') if e.name=='tensorfold')
    sys.exit(entry.load()())
