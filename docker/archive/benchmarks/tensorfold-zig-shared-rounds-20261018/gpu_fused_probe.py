#!/usr/bin/env python3
"""Execute the adapted kernels on GB10; check every output against serial kernels."""
import ctypes as C
import json
import sys
from pathlib import Path
import torch

assert torch.cuda.is_available()
torch.manual_seed(180026)
torch.empty(1, device='cuda')
d = C.CDLL('libcuda.so.1')

def check(code):
    if code:
        raise RuntimeError(f'CUDA error {code}')

module = C.c_void_p()
check(d.cuModuleLoad(C.byref(module), sys.argv[1].encode()))
functions = {}

def launch(name, grid, threads, args):
    if name not in functions:
        f = C.c_void_p()
        check(d.cuModuleGetFunction(C.byref(f), module, name.encode()))
        functions[name] = f
    vals = [C.c_uint64(v.data_ptr()) if isinstance(v, torch.Tensor) else
            C.c_longlong(v[0]) if isinstance(v, tuple) else C.c_float(v) if isinstance(v, float) else C.c_int(v) for v in args]
    ptrs = (C.c_void_p * len(vals))(*[C.cast(C.byref(v), C.c_void_p) for v in vals])
    stream = C.c_void_p(torch.cuda.current_stream().cuda_stream)
    check(d.cuLaunchKernel(functions[name], *[C.c_uint(x) for x in grid],
                          C.c_uint(threads), C.c_uint(1), C.c_uint(1),
                          C.c_uint(0), stream, ptrs, None))
    torch.cuda.synchronize()

F, B = torch.float32, torch.bfloat16
NK, NV, DK, DV, TAPS = 16, 48, 128, 128, 4
CH, PW = 10240, 16480
checks = []
for counts in ([1, 1], [1, 3, 8], [1, 2, 3, 4, 5, 6, 7, 8] * 2):
    for speculative in (False, True):
        n = sum(counts)
        proj = torch.randn(n, PW, device='cuda', dtype=B)
        cw = torch.randn(CH, TAPS, device='cuda', dtype=B) / 5
        alog = torch.randn(NV, device='cuda', dtype=F)
        dt = torch.randn(NV, device='cuda', dtype=F)
        def intermediates():
            return [torch.empty(n, NK * DK, device='cuda'),
                    torch.empty(n, NK * DK, device='cuda'),
                    torch.empty(n, NV * DV, device='cuda'),
                    torch.empty(n, NV * 2, device='cuda'),
                    torch.empty(n, NV * DV, device='cuda')]
        serial, multi = intermediates(), intermediates()
        norm = torch.randn(DV, device='cuda', dtype=B)
        expected_out = torch.empty(n, NV*DV, device='cuda', dtype=B)
        expected_xs = torch.empty(n, NV*DV//32, device='cuda')
        fused_out, fused_xs = torch.empty_like(expected_out), torch.empty_like(expected_xs)
        fused_desc, fused_states, fused_convs = [], [], []
        owners, desc, held, convs, states = [], [], [], [], []
        at = 0
        for i, count in enumerate(counts):
            conv0 = torch.randn(TAPS - 1, CH, device='cuda', dtype=B)
            state0 = torch.randn(NV, DV, DK, device='cuda', dtype=F) / 10
            conv1, state1 = conv0.clone(), state0.clone()
            output0 = torch.empty_like(state0) if speculative else state0
            output1 = torch.empty_like(state1) if speculative else state1
            kp = torch.empty_like(proj[at:at+count]) if speculative else None
            kh = torch.empty_like(conv1) if speculative else None
            held.append((kp, kh, proj[at:at+count].clone(), conv1.clone()))
            convs.append((conv0, conv1)); states.append((state0, state1, output0, output1))
            state2, conv2 = state0.clone(), conv0.clone()
            output2 = torch.empty_like(state2) if speculative else state2
            fused_states.append((state2, output2)); fused_convs.append(conv2)
            fused_desc.append([proj[at:].data_ptr(), conv2.data_ptr(), state2.data_ptr(), output2.data_ptr(), 0, 0, at, count])
            launch('fn_gdn_front', (count, NK + NV, 1), 256,
                   [proj[at:], conv0, cw, alog, dt] + [a[at:] for a in serial[:4]])
            args = [a[at:] for a in serial[:4]] + [state0]
            if speculative:
                args.append(output0)
            launch('fn_gdn_rows_to' if speculative else 'fn_gdn_rows', (NV, DV//16, 1), 128,
                   args + [count, serial[4][at:]])
            launch('fn_shift_window', ((CH+255)//256, 1, 1), 256,
                   [conv0, proj[at:], (PW,), count, TAPS - 1, CH])
            desc.append([proj[at:].data_ptr(), conv1.data_ptr(), state1.data_ptr(), output1.data_ptr(),
                         kp.data_ptr() if kp is not None else 0, kh.data_ptr() if kh is not None else 0, at, count])
            owners += [i] * count
            at += count
        launch('fn_gdn_norm', (n, NV, 1), 128, [serial[4], proj, norm, 1e-6, expected_out, expected_xs])
        fused_table = torch.tensor(fused_desc, device='cuda', dtype=torch.int64)
        launch('fn_gdn_fused_multi', (NV, len(counts), 1), 1024,
               [fused_table, cw, alog, dt, norm, 1e-6, fused_out, fused_xs])
        assert torch.equal(expected_out, fused_out), ('fused output mismatch', counts, speculative)
        assert torch.equal(expected_xs, fused_xs), ('fused sums mismatch', counts, speculative)
        for (_, _, serial_out, _), (_, fused_state) in zip(states, fused_states):
            assert torch.equal(serial_out, fused_state), ('fused state mismatch', counts, speculative, (serial_out-fused_state).abs().max().item())
        table = torch.tensor(desc, device='cuda', dtype=torch.int64)
        rowowners = torch.tensor(owners, device='cuda', dtype=torch.int32)
        if speculative:
            launch('fn_gdn_preserve_multi', ((max(max(counts)*PW, (TAPS-1)*CH)+255)//256, len(counts), 1), 256, [table])
        launch('fn_gdn_front_multi', (n, NK+NV, 1), 256,
               [table, rowowners, cw, alog, dt] + multi[:4])
        launch('fn_gdn_rows_multi', (NV, DV//16, len(counts)), 128, [table] + multi)
        launch('fn_gdn_shift_multi', ((CH+255)//256, len(counts), 1), 256, [table])
        for i, (a, b) in enumerate(zip(serial, multi)):
            assert torch.equal(a, b), ('intermediate mismatch', counts, speculative, i, (a-b).abs().max().item())
        for c0, c1 in convs:
            assert torch.equal(c0, c1), 'convolution shift mismatch'
        for s0, s1, o0, o1 in states:
            assert torch.equal(s0, s1), 'input state mutation mismatch'
            assert torch.equal(o0, o1), 'output state mismatch'
        if speculative:
            for kp, kh, rp, rh in held:
                assert torch.equal(kp, rp) and torch.equal(kh, rh), 'rollback preservation mismatch'
        checks.append({'owners': len(counts), 'rows': counts, 'speculative': speculative, 'bit_exact': True, 'fused_bit_exact': True})
result = {'gpu': torch.cuda.get_device_name(), 'all_passed': True, 'checks': checks,
          'scope': 'Real GPU recurrent kernels, independent state and speculative preservation; no model throughput claim.'}
Path(sys.argv[2]).write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps(result), flush=True)
