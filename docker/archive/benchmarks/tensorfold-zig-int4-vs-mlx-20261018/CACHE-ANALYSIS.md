# Cache and first-token latency follow-up

Source inspection, 18 October 2026. No serving profile, active service or engine
binary was changed for this follow-up. These are findings and an experiment
proposal, not measured results of a cache optimization.

## What the measurements establish

INT4 improves several clean short-prompt workloads, but not every metric.
For four-stream prose trial 0, INT4 gives 137.3 tokens/s versus MLX's 162.8,
even though its median TTFT is better (0.209 versus 0.247 seconds). Continuation
aggregate output is 111.8 tokens/s versus FP4's 120.0 in a clean historical pair.
The near-75k INT4 burst hit the swap guard. Quality was not evaluated.

The main first-token regression concerns conversation growth and branching;
short-prompt TTFT is often competitive or better on INT4. Cold-prefill timings
had outside traffic and do not support a general claim that Zig is slower.

Per-request observations from the fresh conversation-growth cohort:

| History group | MLX cache hits | Zig INT4 cache hits | Observed TTFT |
|---|---:|---:|---|
| Eight ~1800-token histories | 5/8 | 0/8 | Zig about 5.52 s; MLX hits about 1.3 s |
| Seven ~7400-token histories | 6/7 | 7/7 | Zig 5.76-6.77 s; MLX hits about 1.3 s |
| One ~65000-token history | 1/1 | 1/1 | Zig 7.02 s; MLX 1.33 s |

The fresh MLX growth cohort had outside traffic and swapping; timing comparisons
remain observational. The earlier clean MLX growth cohort also had a 1.21 s
median. Similar total cached-token counts conceal differences across individual
requests. Cache hits alone do not remove Zig's observed latency gap.

## Source findings

The exact pinned TensorFold source (`db281878ddb836fd0df510d8771ecb7e0fe47d26`)
plus the recipe's 15 patches (`656879fd752749bbd11a6e1a065a326c00940911`) was
reconstructed in a temporary local checkout for inspection.

- `zig/src/core/prompt_cache.zig`: `Rules.min_prompt = 4096`; `marks()` returns
  no ordinary conversation marks below this length. The repeat-prompt feature
  is separate and does not automatically cover a novel next turn. This matches
  all eight short histories missing on Zig.
- `zig/src/families/flashnext/cuda_native.zig`: the default retained-prompt
  byte budget is `min(sequence_budget / 4, 16 GiB)`. With the measured INT4
  pool it is about 8.39 GiB; this is not a 64-snapshot setting.
- `zig/src/families/flashnext/cuda_lanes.zig`: `preparePrefill()` allocates a
  new sequence; `beginFill()` and `pass()` copy a hit's prefix from its keeper
  into that sequence. `keepAt()` normally makes a separate keeper sequence
  and copies prefix data into it. There is already deferred keeper handling
  for some paths; the proposed optimization must preserve those contracts.
- `zig/src/core/prompt_cache.zig`: eviction prefers older prefix states that
  have been extended. This can trade away useful return-to-earlier-turn states.
- Installed Python `cuda/prefixes.py`: an available cached sequence can be
  reused directly; forks can copy to a spare slot. Multiple snapshots may
  share a sequence's prefix chain. Our local Python patch raises KEEP from
  8 to 64 and updates both planning and runtime. These are different storage
  designs: simply setting a Zig count to 64 would not reproduce Python.
- Our other Python patch batches SSD n-gram reads. INT4 Zig's n-gram table
  resides on the GPU, so that SSD patch is not a direct cache fix to port.

Copy/allocation and scheduling are plausible costs, not profiled causes of the
whole delay. In particular, work on uncached short prompts may delay peers
whose long prompts do hit the cache.

Primary sources: [pinned recipe patches](https://github.com/MiaAI-Lab/Qwen3.8-Flash-Next-Single-DGX-Spark-TensorFold/tree/656879fd752749bbd11a6e1a065a326c00940911/patches),
[serving/cache backend patch](https://github.com/MiaAI-Lab/Qwen3.8-Flash-Next-Single-DGX-Spark-TensorFold/blob/656879fd752749bbd11a6e1a065a326c00940911/patches/0007-serving.patch),
[repeat-cache patch](https://github.com/MiaAI-Lab/Qwen3.8-Flash-Next-Single-DGX-Spark-TensorFold/blob/656879fd752749bbd11a6e1a065a326c00940911/patches/0013-engine-tune.patch).
The Python deployment's inline patch and validation live in its local YAML.

## Recommended controlled experiment

1. Keep INT4, KV type, MTP settings, scheduler and the current byte budget fixed.
   Capture queue/admission, allocation, prefix copy, restore, suffix prefill and
   first-token delivery separately. Existing PASS_TIMES logging does not cover
   every resume path or the initial prefix copy, so instrumentation must cover
   both paths if sliced fills are enabled. Source inspection confirms the tested
   default uses ordinary, unsliced prefill (`TF_FLASHNEXT_FILL` unset and
   `TF_FLASHNEXT_FILL_FAIR=0`). Check uninstrumented timings afterward.
2. Independently test a conversation-mark threshold of 1024 instead of 4096.
   This is a source/rule change in the pinned build, not an existing documented
   YAML environment switch. Measure hits and latency by history length, plus
   cold-prefill and decode cost. Extra small entries may evict long ones.
3. If copying/allocation is significant, implement exclusive adoption of an
   idle keeper sequence. Preserve immutable older-turn states; copy when the
   prefix is shared or concurrently used. This is a larger ownership change
   requiring correctness and concurrency tests.
4. Test older-turn retention separately within a byte limit. Prefer sharing
   sequence prefixes over duplicating complete KV data for each snapshot.
   Do not enlarge the cache blindly after the near-75k swap-guard failure.

Use short, medium and long histories, 1/4/16 users, append-only and branching
turns, clean starts on the same host, alternating original/patched runs, and
memory/OOM/swap monitoring. Check exact deterministic outputs between original
and patched INT4, cache isolation, cancellation, eviction and concurrent forks.
Acceptance requires lower median and tail TTFT without sacrificing output
correctness, throughput or the existing memory guard. Rerun the near-75k burst
separately; the current result remains aborted.

The earlier fair-prefill experiment already reduced small-burst throughput and
increased TTFT. It is not the first recommended switch to turn on again.
