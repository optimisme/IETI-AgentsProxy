# Contributor source attribution

The fused recurrent kernel is adapted from BobClawblaw/TensorFold at
`67bb75747925f3ca0af6f4914f6c6ab0a6d7663e`:

- `zig/kernels/cuda/flashnext/gdn_multi.cu`
- `zig/kernels/cuda/flashnext/fn_gdn.cu`

Source: https://github.com/BobClawblaw/TensorFold/tree/67bb75747925f3ca0af6f4914f6c6ab0a6d7663e

TensorFold's root license is Apache-2.0; a copy accompanies the patch at
`../../patches/licenses/TensorFold-Apache-2.0.txt`. Changes adapt the stream
descriptor, full single-GPU head geometry, and v1.1.0's speculative rollback
buffers. KV caching and all checkpoint math otherwise use our existing v3 path.
The v4 pointer-table experiment's initial comment incorrectly said MIT; that
comment is corrected in v5. No external contributor branch is deployed intact.
