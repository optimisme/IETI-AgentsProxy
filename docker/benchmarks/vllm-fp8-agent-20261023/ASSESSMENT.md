# vLLM 0.32.0: FP8 cache and returning agents on one Spark

GPU measurements are complete. Keep TensorFold Python as the main runtime:
the tuned vLLM deployment fits sixteen near-75k text contexts but delivers
52.32% less aggregate throughput on the matched sixteen-stream short-code
workload. Finer prefix matching substantially improves mixed-history reuse,
yet its clean second-return first-token time remains 25.15% slower than Python.
The full-window returning branches also lose most reusable prompt waypoints.

The experiment was not promoted. The original Python runtime is restored and
healthy on the experimental host; vLLM is stopped. The tuned controller exited
with code 0 and its restoration marker is 1. The reference container still has
its original `2026-10-11T12:08:52.452616778Z` start time.
All variants ran on the GB10 GPU on the experimental host; the reference
Python host was never restarted or reconfigured.

## MTP-off, finer-prefix candidate

The serving-ready 0.82 allocation reports 20.55 GiB of cache / 1,261,363
equivalent tokens / 16.82 full 75k-context concurrency. Recurrent states remain
FP32; main and indexer KV remain FP8. The local YAML defaults now reproduce
this actual candidate, with an 8,192-token chunk and MTP off.

| Metric | TensorFold Python | Tuned vLLM | Change |
| --- | ---: | ---: | ---: |
| One request, output tokens/s | 47.92 | 20.63 | -56.94% |
| Sixteen requests, aggregate tokens/s | 328.46 | 156.61 | -52.32% |
| Sixteen requests, median first token | 0.611s | 0.701s | +14.83% |
| Cold ~16k prompt, first token | 6.759s | 9.996s | +47.89% |

The single-request median uses four clean hash-matched cohorts; the sixteen
request median uses three. Its trial zero swapped out one page and is retained
in the raw record but excluded from the zero-swap paired median. The isolated
cold-prompt comparison has one pair. Its raw ~65k first token was 21.739s;
the corresponding Python reference overlapped another request and is excluded.

This is a combined configuration change: chunk size, MTP, allocation budget
and prefix settings differ from the initial variant. The results do not
isolate a speedup attributable to any one setting. In particular, disabling
MTP trades speculative throughput for cache capacity. The block-drop-disable
setting has no speculative branch to affect when MTP is off.

The finer-prefix configuration substantially improved returning turns:

| Sixteen mixed-length histories | Stock vLLM, chunk 8,192 | Tuned vLLM | Python |
| --- | ---: | ---: | ---: |
| First return: reused input tokens | 83,200 | 130,848 | 129,406 |
| First return: TTFT p50 | 12.709s | 3.667s | 1.223s |
| Second return: reused input tokens | 83,200 | 131,584 | 131,857 |
| Second return: TTFT p50 | 11.652s | 1.046s | 0.836s |
| Second return: cohort wall time | 26.728s | 13.625s | 6.664s |

The second return is a clean matched pair: tuned first token is still 25.15%
slower than Python, and wall time is 104.46% longer. The tuned first return
swapped out one page and the stock returns also recorded small swap activity;
their values above are raw observations, excluded from strict zero-swap paired
percentages. The cold mixed-agent Python cohort overlapped unrelated requests,
so no clean cold-cohort percentage is assigned. All tuned tool/PNG/JPEG and
three long-context retrieval diagnostics passed. These finite checks do not
constitute a general accuracy evaluation.

## Full-window capacity

The cold sixteen-request cohort completed all 16 x 896 output tokens with
sixteen overlapping output streams, zero cached input tokens, no preemptions,
no OOM and no swap-out. Input counts were 74,008-74,009; the largest total
input-plus-output budget was 74,905. Minimum available host RAM was 9.99 GiB.
Thus this MTP-off FP8 deployment has demonstrated simultaneous near-75k text
contexts, beyond merely accepting sixteen queued requests.

Cold burst latency was substantial: 531.88s cohort wall time, TTFT p50 219.28s
and p95 387.24s. The resulting 26.95 output tokens/s includes all cold prefill
time and must not be confused with the approximately 106 tokens/s observed
during the subsequent phase where all sixteen were decoding. There is no
matched full-window Python reference in this campaign, so these numbers do
not establish a full-window percentage comparison against Python.

Both returning branches completed too: 48/48 full-window requests across all
three stages produced all 896 output tokens, with sixteen overlapping streams
in each stage, no preemptions, OOM or swap-out. The maximum total input/output
budgets were 74,905, 74,945 and 74,985 respectively. See
`capacity-assessment.json` and the per-stage token-bound records.

| Full-window stage | Reused input tokens | Requests with reuse | TTFT p50 | TTFT p95 | Wall time |
| --- | ---: | ---: | ---: | ---: | ---: |
| Cold | 0 | 0/16 | 219.28s | 387.24s | 531.88s |
| First return | 295,936 | 4/16 | 117.28s | 285.20s | 432.58s |
| Second return | 220,192 | 3/16 | 142.15s | 308.71s | 418.40s |

Minimum available RAM was 9.99, 10.43 and 10.43 GiB. The first return's four
hits reused 73,984 tokens each; the second return's three hits reused 72,128,
74,016 and 74,048 tokens. Fitting sixteen active contexts therefore does not
guarantee retaining sixteen reusable prompt waypoints. The loss is observed;
the experiment does not isolate the exact allocator/eviction mechanism.

The rejected 0.86 allocation reported 20.94 full-context capacity but crossed
the 6 GiB host-RAM guard during startup autotuning (5.56 GiB available).
The supervisor stopped it without an OOM, before serving readiness. It has no
qualified inference results and is not a usable capacity result.

## Stock-prefix results

Three clean, hash-matched short cohorts per concurrency, thinking off,
256 output tokens/request, no swap-out/OOM/unrelated requests/cache hits:

| Metric | TensorFold Python | vLLM 0.32, chunk 2,048 | Change |
| --- | ---: | ---: | ---: |
| One request, output tokens/s | 42.43 | 37.14 | -12.47% |
| Sixteen requests, aggregate tokens/s | 330.04 | 245.78 | -25.53% |
| Sixteen requests, median first token | 0.613s | 0.572s | -6.66% |
| Cold ~16k prompt, first token (one pair) | 6.750s | 10.280s | +52.30% |

The 8,192-token stock-prefix variant reached 242.69 aggregate tokens/s versus
328.46 for Python (-26.11%, three clean paired sixteen-request cohorts).
Median first token was 0.531s versus 0.611s (-13.06%). Its four clean paired
single-request cohorts reached 36.96 versus 47.92 tokens/s (-22.87%). Different
paired subsets and request tags mean these two variant tables should not be
treated as a precisely isolated chunk-size effect. Cold ~16k first token was
10.051s versus 6.759s (+48.70%, one pair).

Its raw cold ~65k first token improved to 22.652s from the 2,048-token variant's
29.092s. Both corresponding Python ~65k references overlapped another request,
so neither establishes a clean percentage against Python.

The ~65k reference overlapped another request; no clean percentage is assigned.
vLLM's raw ~65k TTFT was 29.09s. Tool, PNG, JPEG and all three retrieval
diagnostics (16k/65k/74k) passed. This is not a comprehensive accuracy evaluation.

The first returning-agent turn reused 83,200 tokens with TTFT p50 12.201s,
versus Python's 120,204 reused tokens and 1.217s. The second reused the same
83,200 tokens with TTFT 12.663s, versus Python's 131,857 tokens and 0.795s.
The stock physical/hash block size is 3,200 tokens, with MTP block drop enabled.
These stock results motivated the finer-prefix MTP-off variant measured above.
Its combined changes improve reuse; the individual flags' contributions were
not isolated.

The engine allocated 17.75 GiB of KV storage and reported 721,666 equivalent
cache tokens / 9.62 full 75k-context concurrency. Sixteen short streams worked;
sixteen full resident contexts are not established by that admission count.
The short/agent cohorts recorded little NVMe read traffic, so the observed
returning-turn delay cannot simply be attributed to large SSD reads.
The stock 8,192-token variant reported 8.89 full-context capacity; all sixteen
mixed-length output streams overlapped, but its mixed-agent runs swapped out
29, 4 and 17 pages respectively. These remain in the raw record and are excluded
from the strict zero-swap paired comparisons. No OOM or preemption occurred.
Its returning turns still reused only 83,200 tokens, with median first tokens
12.709s and 11.652s.

The local Docker profile and scripts are the source of truth; they are copied
to each test machine's own `docker/` folder and executed there. The reference
Python container is never restarted or reconfigured. The candidate controller
restores the original Python container when it exits, including after failure.

## Candidate

- vLLM 0.32.0, ARM64 image manifest
  `sha256:befccf0e7e4089aa23926bb6f887a85c0d46c2a99e6de5c5ffdf5cb7957c5b34`.
- `Inferact/Qwen3.8-Flash-Next-NVFP4`, revision
  `103a7608316173ca6edd49929544244de7ffda70`, approximately 170.23 GiB of
  checkpoint shards. Most of the large n-gram table is file-backed, not an
  additional fully resident CPU table. This checkpoint differs from the
  deployed MLX 4-bit checkpoint, so this is a deployment comparison rather
  than a controlled comparison of runtime implementations alone.
- FP8 main K/V and FP8 QSA indexer; FP32 recurrent state preserved in all variants.
  FP8 is a floating-point format, not INT8. This model's NVIDIA QSA backend
  does not currently implement the generic INT8/INT4 KV options.
- Sixteen configured slots and a 75,000-token total request limit, with one
  image allowed; actual simultaneous full-context capacity is measured
  separately from API admission and queueing.
- Initial variants: prefix caching, chunked prefill and MTP3; compare chunks
  2,048 and 8,192 with the stock prefix settings. The current YAML subsequently
  adds 32-token matching, block-drop disable and shared-checkpoint requests;
  each rendered Compose file and actual startup command records its settings.
  RAM prefix state is disposable
  computation storage; learning, Recall and saved conversations are absent.
  The file-backed embedding table contains checkpoint weights, not prompts.

The embedding mmap adaptation derives from MiaAI Lab's
`patch_ple_mmap_v030.py` at revision
`b7c5da1a9e7448a14b480deee66eda3799b1eb43`, generator SHA-256
`b63bb3d86ececfe5d0dac7f4c072407c9745fab7b6ed856175bc8f668c107309`.
`bootstrap.py` ports it to 0.32's split common/NVIDIA modules and lazy
prefetch-buffer allocation, with exact original-source checksums. The
upstream generator and its AGPL notice remain in the runtime cache.
Attention and model arithmetic are unchanged by this storage patch.

## Why eight-bit caches do not guarantee sixteen full contexts

The capacity limit is not a language limitation and cannot be reduced to the
checkpoint's weight precision. This vLLM deployment already uses eight-bit FP8
for both QSA caches. Its hybrid allocator also accounts for recurrent states,
short-convolution states, speculative blocks, prefix checkpoints and padding.
The stock 2,048-token variant used about two thirds of its cache pool for sixteen
very short requests, demonstrating substantial per-request overhead even before
long-context token storage. These are distinct from saved conversation memory.

The [Mamba cache specification](https://github.com/vllm-project/vllm/blob/v0.32.0/vllm/v1/kv_cache_interface.py)
explicitly budgets extra speculative and checkpoint blocks. The GDN temporal
state's shape itself does not grow with the speculative-token count; the
convolution lookahead and number of allocated state blocks do. The
[hybrid allocator](https://github.com/vllm-project/vllm/blob/v0.32.0/vllm/v1/core/kv_cache_utils.py)
also budgets each cache group independently and includes padding. Changing
the layout or removing MTP overhead can therefore affect capacity without
changing the main cache's numeric precision. The combined tuned run changes
several settings together and cannot isolate their individual contributions.

## Workloads and interpretation

`probe.py` uses identical fixtures, request tags, sampling parameters and
output budgets on both hosts; model identifiers differ. It records full SSE
results and request hashes, cache hits, queueing, preemptions, available RAM,
swap-out and OOM counters. Reference runs contaminated by unrelated requests
must be excluded from clean performance comparisons.

1. Four short-code cohorts per candidate at one and sixteen concurrent requests,
   256 output tokens each, with fresh prefixes per trial. Tables use the clean,
   hash-matched paired subset; no trial is discarded merely for being first.
2. Tool and image smoke checks; long-context retrieval diagnostics.
3. Sixteen independent agent histories: eight short, seven medium and one
   approximately 65k tokens. Follow with two identical synthetic append-only
   turns, 128 output tokens/request. The appended assistant text is fixed
   across runtimes to preserve byte-identical input comparisons. Relative to
   each actual model response these are branches from the preceding prompt,
   not replay of that response. This specifically exercises retained prompt
   waypoints; it does not directly measure an ordinary client appending the
   complete generated reply.
4. If the engine establishes capacity for sixteen full contexts, issue
   sixteen independent approximately 74k-token prompts, then returning turns,
   with 896 output tokens/request. Each stage checks that the tokenizer count
   plus output budget stays within 75k. The longer replies make overlapping
   output streams observable; accepted requests and frontend running gauges
   alone do not establish simultaneous full-context generation.
   A lower reported cache capacity is recorded as a failure to qualify this
   target; completing queued requests does not establish resident capacity.

The full-window capacity requests use the same frozen ~74k fixture with distinct
leading agent tags. This exercises separate request caches, rather than sixteen
unrelated source repositories with different embedding-table working sets.
The stress test is text-only; accepting the small PNG/JPEG smoke inputs does not
qualify sixteen simultaneous maximum-resolution image requests. The profile
permits one image per prompt and disables video.
The full-window returning turns use the same fixed-assistant branching method.
Appending each real 896-token reply repeatedly would require a shorter initial
prompt or shrinking later output budgets to stay within the 75k total limit.

These experiments adapt the general lessons of
[DualPath](https://arxiv.org/html/2602.21548v2): distinguish repeated-prefix
work from cold prefill and account for I/O and scheduling. They do not port
its multi-server RDMA architecture or assume its reported speedups apply.

Sources:

- [vLLM release](https://github.com/vllm-project/vllm/releases/tag/v0.32.0)
- [Qwen recipe](https://github.com/vllm-project/recipes/blob/main/models/Qwen/Qwen3.8-Flash-Next.yaml)
- [QSA cache formats](https://github.com/vllm-project/vllm/blob/v0.32.0/vllm/models/qwen4_exp/nvidia/qsa.py)
- [Mia mmap source](https://github.com/MiaAI-Lab/Qwen3.8-Flash-Next-Single-DGX-Spark/blob/b7c5da1a9e7448a14b480deee66eda3799b1eb43/files/patch_ple_mmap_v030.py)
