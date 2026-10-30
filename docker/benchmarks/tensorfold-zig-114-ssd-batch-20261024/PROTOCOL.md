# Local 1.1.4 PLE gather batching experiment

User-authorized private port on tag v1.1.4, commit
eab8582819688325e371907e4706e1c602b8a273. No upstream issue, claim, public
check-in, PR or publication is part of the task. The requested frozen tag takes
precedence over upstream's main-branch contribution workflow. Native contributor
instructions and ATC guidance were inspected; the ATC CLI is not installed.

Change only host-side n-gram gathering for a shared Flash-Next CUDA pass:
compute each stream's IDs from its own history, collect them in row order,
perform one pooled table gather and unchanged dequantization/sums, then commit
each stream's history. No GPU kernel, precision, sampling, scheduling, KV or
weight change. TF_FLASHNEXT_PLE_BATCH=0 preserves upstream per-stream gathers;
1 enables grouping in the same executable. Single streams keep their old path.

Owning modules: cuda_ple.zig, a new cuda_ple_windows.zig, and Gather.main in
cuda_batch_state.zig. Validate exact row bytes, float32 group sums, independent
histories, guards and malformed-window refusal using actual in-memory affine
tables and existing pooled-gather tests. Host suite and zero new lean findings
are required. GPU kernels are unchanged, so no new kernel arithmetic gate is
claimed. CUDA/model behavior is tested on one GB10 with the existing pinned
TensorFold/Qwen3.8-Flash-Next-MLX-4bit-MTP checkpoint
2b170fa6309d5d1ee380b35636075fac7945f286, affine4/BF16 KV, MTP6/0.60,
75k configured context, eight slots, 8 GiB prompt cache, vision loaded.

Compile in a CPU/memory-bounded build container while the original Python service
is available. Measure one model process at a time on the experimental GPU;
restore the same original Python container in a finally block on every outcome.
The reference GPU is not used. Preserve exact commands and binary/kernel hashes.

Initial screening: off and on from fresh processes, two greedy short code cases
at 1/4/8 users plus three distinct prose groups at 8 users, fixed output counts,
identical payloads and no relevant prefix hits. Compare hashes of full content,
reasoning and usage before interpreting speed. Include a two-turn 2k conversation
and a sampled group for state/sampling regression checks; do not claim semantic
quality or full-window capacity from these samples. Record TTFT, end-to-end
output rate, cached tokens, memory, pageouts and GPU clocks/temperature.

A meaningful provisional gain requires at least 10% throughput improvement in
both the eight-user code and prose categories, consistent across their cases,
without median TTFT regression above both 10% and 0.1s or any mismatch/error.
If improvement is below 5% or negative, stop after this pair and report that it
does not justify deeper evaluation. An intermediate or promising result needs
an alternating confirmation before calling it repeatable. 'Significant' here
means practically meaningful; these finite synthetic cases are not a statistical
significance test. Strict clean comparisons have zero host pageouts/OOM and no
external inference. Preserve excluded attempts rather than rerunning indefinitely.
