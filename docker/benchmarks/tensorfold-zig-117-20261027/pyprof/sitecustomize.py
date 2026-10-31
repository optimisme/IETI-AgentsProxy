"""IETI_ROUND_TIMES=1 (on PYTHONPATH): Python Flash-Next's shared rounds timed from outside the pinned source, one line a
round on stderr like the Zig build's TF_LANES_PHASES: streams, window rows, prompt-pass rows, the forward (synchronized
once, where sampling would wait anyway), the drafts and the round. The image's own sitecustomize runs first."""
import os
import sys

_base = '/usr/lib/python3.12/sitecustomize.py'
if os.path.exists(_base):
    exec(compile(open(_base).read(), _base, 'exec'))


def _patch():
    import time
    import torch
    m = sys.modules['tensorfold.families.qwen4_exp.cuda.multi']
    D = m.MultiDecoder
    last = {}

    blocks = {}
    if os.environ.get('IETI_BLOCK_TIMES') in ('1', '2'):  # each block synchronized before and after (as Zig's PROFILE=2)
        f = sys.modules['tensorfold.families.qwen4_exp.cuda.forward']

        def timed_block(name, fn):
            def wrap(*a, **k):
                if torch.cuda.is_current_stream_capturing():  # a graph capture (the lone path's warm-up): untimed
                    return fn(*a, **k)
                torch.cuda.synchronize()
                t = time.perf_counter()
                out = fn(*a, **k)
                torch.cuda.synchronize()
                blocks[name] = blocks.get(name, 0.0) + time.perf_counter() - t
                return out
            return wrap

        for name in ('hc_block', 'gdn_block', 'attn_block', 'moe_block', 'ple_block', 'finish', '_writeback'):
            setattr(f, name, timed_block(name, getattr(f, name)))

        if os.environ['IETI_BLOCK_TIMES'] == '2':  # each kernel step too (as Zig's PROFILE=3); matmuls named by shape
            mm = f._mm
            timed_mms = {}

            def named_mm(x, q, xs, out, b, **kw):
                key = f'mm{getattr(q, "n", 0)}x{getattr(q, "k", 0)}'
                fn = timed_mms.setdefault(key, timed_block(key, mm))
                return fn(x, q, xs, out, b, **kw)

            f._mm = named_mm
            fuser = f._hc_fuser

            def named_fuser(*a, **k):
                got = fuser(*a, **k)
                return None if got is None else timed_block('hc_upmix' if k.get('upmix') else 'hc_fused', got)

            f._hc_fuser = named_fuser
            f._prefill_chain = timed_block('gdn_chain', f._prefill_chain)
            for name in ('hc_writeback', 'hc_normed', 'hc_act', 'hc_reduce_act', 'hc_mix', 'attn_prep', 'attn_gate'):
                if hasattr(f.glue, name):
                    setattr(f.glue, name, timed_block(name, getattr(f.glue, name)))
            for name in ('qsa_pool', 'qsa_rows', 'attention'):
                setattr(f.attn_mod, name, timed_block(name, getattr(f.attn_mod, name)))

    def timed_compute(fn, mixed):
        def wrap(*a, **k):
            blocks.clear()
            t = time.perf_counter()
            out = fn(*a, **k)
            torch.cuda.synchronize()
            last['fwd'] = time.perf_counter() - t
            if blocks and not mixed:
                rows = sum(seg[2] - seg[1] for seg in a[1])  # compute(w, segs, b): segs are (state, a0, a1)
                print('pyblocks: rows=' + str(rows) + ' ' + ' '.join(f'{n}={v * 1e3:.1f}' for n, v in blocks.items())
                      + ' ms', file=sys.stderr, flush=True)
            return out
        return wrap

    m.compute = timed_compute(m.compute, False)
    m.compute_mixed = timed_compute(m.compute_mixed, True)
    fill = sys.modules['tensorfold.families.qwen4_exp.cuda.multi_fill']
    fill.compute = timed_compute(fill.compute, False)  # prompt passes (multi_fill.py): pyblocks lines as a round's
    draft_all = D._draft_all

    def _draft_all(self, streams):
        t = time.perf_counter()
        n = len(streams)
        out = draft_all(self, streams)
        last['draft'] = time.perf_counter() - t
        last['drafters'] = n
        return out

    D._draft_all = _draft_all
    round_ = D.round

    def round(self, told=None):
        last.clear()
        live = [s for s in self.streams.values() if not s.done and not s.waiting]
        fill = int(bool(self.filling))
        rows = sum(1 + len(s.drafts) for s in live)
        t = time.perf_counter()
        out = round_(self, told)
        total = time.perf_counter() - t
        if 'fwd' in last:
            print(f"pyphases: streams={len(live)} rows={rows} fill={fill} verify={last['fwd'] * 1e3:.1f} "
                  f"draft={last.get('draft', 0) * 1e3:.1f} total={total * 1e3:.1f} ms", file=sys.stderr, flush=True)
        return out

    D.round = round
    print('[ieti] round times on', file=sys.stderr, flush=True)


if os.environ.get('IETI_ROUND_TIMES') == '1':
    import threading

    def _wait():
        import time
        name = 'tensorfold.families.qwen4_exp.cuda.multi'
        while not hasattr(sys.modules.get(name), '_tensors'):  # its last definition: the module has run
            time.sleep(0.2)
        _patch()

    threading.Thread(target=_wait, daemon=True).start()
