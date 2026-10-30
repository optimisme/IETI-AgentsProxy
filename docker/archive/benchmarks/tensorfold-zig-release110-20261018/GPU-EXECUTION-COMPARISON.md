# Why customized Python currently scales better than Zig 1.1.0

There is no demonstrated fundamental barrier to adapting Zig. The current result
shows an incomplete GPU execution port, not that Python is intrinsically faster.
Both runtimes send the expensive work to compiled GPU kernels. The host language
alone does not determine the efficiency of those kernels or how requests share them.

## Verified source differences

The Python source below was inspected at the actual pinned v0.6.5 commit
`609ca419abecebdc5a059498a613680bd3aa847f`. Its startup profile applies only the
recorded snapshot-retention and SSD-gather changes. The Zig comparison uses full
v1.1.0 plus the local v3 patch, not the older MiaAI engine.

| Operation | Customized Python path | Current Zig v3 path |
| --- | --- | --- |
| Recurrent model state (DeltaNet/GDN) | `multi.py` installs per-user pointer tables; `forward.gdn_block` calls `gdn_multi.block`, with GPU front/tree/back work across the round's users. | Projection work is grouped, but `cuda_batch.gdnBlock` loops over owners for front/chain operations and convolution shifts. |
| Attention | `multi.py` installs `attn_multi.Step`; `forward.attn_block` calls `attn_multi.layer`. GPU kernels find each row's own cache through pointer tables. The draft head also uses this path. | Projection work is grouped, but `cuda_batch.attnBlock` calls `attnRows` separately for each owner, including prep/pooling/selection/chunk/merge launches. |
| Draft token selection | `MultiDecoder._picks` calculates candidates for all rows, then reads their compact result back together. | `cuda_draft_batch.run` still calls `Ops.pick` per owner; each pick launches its best-row calculation and synchronizes/downloads. Non-greedy picks also download logits. |
| SSD n-gram lookup staging | Our deployment patch concatenates the users' row IDs for each layer before table gathering and transfer. Staging supports reading ahead of the previous GPU-step wait. | There is already grouped host n-gram gathering in the native pass, but its exact staging/overlap behavior and GPU convolution launches differ. It is not valid to assume the same costs. |

These loops create repeated GPU launches and synchronization opportunities.
They do **not** mean the GPU computes sixteen times the model arithmetic, nor
that Python launches only one kernel for an entire model. Large projections and
expert work are already grouped in our Zig patch. The remaining difference is
how individual stages address and process each user's state.

The source establishes these structural differences. A matched GPU timeline is
still needed to assign measured milliseconds or percentages to each bottleneck.
It would be premature to claim that one of them explains the entire remaining gap.

## Source references

- [Python concurrent decoder, pointer-table setup and grouped sampling](https://github.com/ashhart/TensorFold/blob/609ca419abecebdc5a059498a613680bd3aa847f/src/tensorfold/families/qwen4_exp/cuda/multi.py): lines 355–366, 457–495.
- [Python forward dispatch](https://github.com/ashhart/TensorFold/blob/609ca419abecebdc5a059498a613680bd3aa847f/src/tensorfold/families/qwen4_exp/cuda/forward.py): lines 149–169 and 219–266.
- [Python grouped recurrent kernels](https://github.com/ashhart/TensorFold/blob/609ca419abecebdc5a059498a613680bd3aa847f/src/tensorfold/families/qwen4_exp/cuda/gdn_multi.py).
- [Python grouped attention kernels](https://github.com/ashhart/TensorFold/blob/609ca419abecebdc5a059498a613680bd3aa847f/src/tensorfold/families/qwen4_exp/cuda/attn_multi.py).
- Local deployment patch: `../../models/qwen38-flash-next-tensorfold-vontra-mlx-4bit-mtp-int8-ssd-vision-128gb.yml`, `PY_PATCH_SSD_BATCH`.
- Local Zig changes: `../../patches/tensorfold-110-fp8-batched-mtp-v3.patch`; source functions `cuda_batch.gdnBlock`, `cuda_batch.attnBlock`, and `cuda_draft_batch.run`.
- [Upstream Zig draft selection and synchronized read-back](https://github.com/ashhart/TensorFold/blob/76aafcf274e60a5e31a59ce145b2f71f7b366e9d/zig/src/families/flashnext/cuda_mtp_ops.zig): `download`, `pick`, `draws`.

## What adapting Zig requires

1. Profile matching GPU workloads to identify launch overhead, synchronization,
   kernel execution time, and CPU/SSD staging gaps.
2. Group draft candidate selection/read-back across users. This is a bounded
   change that can preserve keyed sampling and confidence decisions.
3. Port the pointer-table approach to grouped recurrent-state and attention
   kernels, preserving separate user state and speculative rollback semantics.
4. Reuse compatible compiled GPU kernels where layouts and parameters match;
   adapt kernels otherwise. Python currently uses INT8 KV with scales, whereas
   the new Zig candidate uses E4M3 FP8 KV. Their buffers are not interchangeable.
5. Check exact output contracts and real GPU performance after each change,
   then complete the final configuration's sixteen near-75k context trial.

This work can run under the full 1.1.0 server. It requires GPU kernel and buffer
integration beyond changing YAML settings. It is not a guarantee of parity.

## What the measurements do establish

Grouped draft-head work already raised clean MLX sixteen-user throughput from
157.31 to 186.78 tokens/s (+18.7%). Single-user MLX Zig is 51.6% ahead of the
2225 Python reference, while its sixteen-user result is 41.0% below. That pattern
supports investigating concurrent execution, but is not an isolated causal
measurement of any one kernel.

Retaining 64 prompt snapshots helps ongoing conversations. It does not explain
the cold code-cohort difference: the clean measurements have zero cached input
tokens. Persistent learning and saved-conversation features remain disabled.
See `PERFORMANCE-PERCENTAGES.md` for matching payloads and timing exclusions.
