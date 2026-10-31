# Contributor recurrent batching on one GB10

Status: the fixed-request, retrieval and 16 × near-75k capacity tests passed.
No candidate has been promoted. Both machines are healthy on their original
Python profile. The 2225 start time is unchanged; the experimental native
container on 2226 is stopped. See `runtime-health-final.json`.

The tested changes show no demonstrated improvement over the previous Zig v3
candidate. Python remains faster for sixteen concurrent code requests.

## What was tested

The contributor's complete branch cannot run unchanged on this machine:
`BobClawblaw/TensorFold:native-v1.0.12` explicitly requires two CUDA ranks and an
`affine-experts-int8` converted checkpoint. Its code is pinned at
`67bb75747925f3ca0af6f4914f6c6ab0a6d7663e`.

This campaign tests two **single-GPU adaptations**, not that complete branch:

1. A pointer-table version of the existing v1.1.0 recurrent front/chain/shift
   operations, with per-user rollback storage preserved (`recurrent-on`).
2. The contributor's fused recurrent kernel, adapted from `gdn_multi.cu` and
   `fn_gdn.cu` to the full single-GPU `(NK=16, NV=48)` geometry and the existing
   v1.1.0 rollback buffers (`fused-on`).

Both use the complete upstream 1.1.0 source commit
`76aafcf274e60a5e31a59ce145b2f71f7b366e9d`, plus our prior v3 changes. They retain
the pinned MLX group-32 checkpoint, FP8 KV, six MTP drafts, confidence 0.60,
1,536-row prefill chunks, 16 streams, 75,000-token context, 10 GiB reserve,
vision off, prompt-prefix retention zero, and decode graphs off.

The contributor's shared attention kernels, grouped rollback/replay, batched
short-prompt admission and spare-sequence pool were **not** ported. Their
captured INT8 KV layout and two-rank host interface do not directly match our
single-GPU FP8 implementation. These measurements cannot establish the
performance of the entire contributor fork.

## Matched performance results

These are `code16-trial1`, with the same 16 payload hashes, 256 output tokens
per request, no prefix hits, no unrelated inference, no OOM and no swap-out
during the timed cohort. Trial 0 results with background swap-out are retained
but excluded from clean comparisons.

| Runtime | Aggregate output tokens/s | Median first token | Throughput vs Python 2225 |
| --- | ---: | ---: | ---: |
| Python on 2225, fresh reference | 318.89 | 0.584 s | reference |
| Python on 2226, same-host reference | 320.03 | 0.571 s | — |
| Zig control, recurrent batching off | 184.36 | 1.886 s | −42.19% |
| Zig, pointer-table recurrent batching | 185.67 | 1.911 s | −41.78% |
| Zig, contributor fused recurrent kernel | 186.75 | 1.876 s | −41.44% |

The fused candidate is +1.29% above this campaign's control, but effectively
equal to the earlier v3 result (186.78 tokens/s, −0.02% change). One clean
matched cohort does not establish a statistically significant improvement.

Cold ~16k input first-token time is 13.318 s for fused Zig versus 7.049 s for
same-host Python: **88.94% longer**. The current Python 2225 cold measurement had
an unrelated request and is excluded. The fused change does not accelerate the
single-request prompt pass.

Complete per-case throughput, first-token and wall-time percentages, plus
exclusions, are in `recurrent-on-comparison.json` and
`fused-on-comparison.json`. See `analyze.py` for the matching and eligibility
rules; the previous v3 data is under `../tensorfold-zig-release110-20261018/`.

## Correctness and GPU execution

- Both adaptations passed six real NVIDIA GB10 kernel contracts, including
  16 owners, unequal window lengths, independent state, in-place updates and
  speculative rollback preservation. The fused kernel's outputs, group sums
  and states are bit-identical to the original per-owner kernels.
- Each model adaptation reproduced all 35 fixed requests' output-token hashes
  and text exactly against its native control, including a cold ~16k input.
- Each passed automatic `record_number(42)` tool use and all 16 retrieval cases,
  including two ~65k histories. Retrieval is a limited correctness check, not
  a general quality benchmark.
- The CUDA host contract suite passed 1,738 tests; one JPEG decoder test was
  skipped. These checks supplement the actual GPU and model tests.
- Runtime logs confirm the fused recurrent path executed. Before timing, the
  final probe hashes `/proc/<pid>/exe` and checks it against the build artifact.

## Capacity and runtime decision

The fused candidate completed **16/16 concurrent requests**, each with
74,005–74,006 input tokens and exactly 256 output tokens, under a configured
75,000-token prompt/reply limit. That is 1,184,086 input tokens and 4,096 output
tokens. The monitor recorded 16 resident streams and 16 KV pools, with no
unrelated inference or prefix hits.

| Full-window stress metric | Fused candidate |
| --- | ---: |
| Total wall time | 1,093.34 s (18 min 13 s) |
| Median first token | 1,060.44 s (17 min 40 s) |
| p95 first token | 1,064.47 s |
| Minimum available system memory | 15.27 GiB |
| OOM kills | 0 |
| OS swap-out during the cohort | 42,764 pages, 167.05 MiB |

The measured host page size is 4,096 bytes. This demonstrates completion and
capacity for this exact text-only configuration, but the cold prompt latency
is high. It does not qualify vision, a larger prefix cache, another checkpoint
or a different patch. End-to-end output rate includes all cold prefill time;
it is not a standalone decode-speed measurement.

The first pointer-table variant is an ablation; its capacity test was explicitly
deferred to the fused candidate in `capacity-policy.json`. No full-window
capacity claim is made for that variant.

The historical Python 2225 capacity run completed all 16 near-75k requests,
but included ten unrelated requests and active swap-out. It supplies capacity
evidence only; its timings are not used for a clean percentage comparison.

Python remains the selected runtime. These text-only experimental profiles do
not qualify vision or change the known native forced-tool-choice limitation.
Living Weights, Recall, disk learning and saved conversations remain off;
the model checkpoint is mounted read-only and disabled endpoints are checked.
Ordinary KV computation storage is separate from persistent learning.

## Reproduction and provenance

Local `docker/` remains the source for profiles, patches and test scripts. They
are copied to the inference host's own `~/docker/` and run there. The 2225
reference service is not restarted. Controllers restore Python on 2226 when
the trial ends; runtime health is verified separately before final reporting.

- `patch-manifest.json`: pointer-table adaptation and SHA-256.
- `fused-patch-manifest.json`: fused adaptation and SHA-256.
- `native-sha256.txt`, `fused-native-sha256.txt`: compiled executables.
- `gpu-recurrent-contracts.json`, `gpu-fused-contracts.json`: GPU receipts.
- `recurrent-off/`, `recurrent-on/`, `fused-on/`: raw requests and monitors.
- `python-2225/`, `python-2226/`: fresh unchanged Python references.
- `UPSTREAM-NOTICE.md`: source attribution and Apache-2.0 license reference.

Developer builds of the pinned 1.1.0 source default to the stale `1.0.12`
manifest banner. The final fused binary uses `-Dversion=1.1.0`; this changes the
release label, and the CUDA fatbin hash is checked unchanged. An overlap of
two queued controllers was resolved before fused inference timing; details
are recorded in `controller-coordination.json`. Only the final controller's
completed benchmark files are used.

Primary upstream references:

- [Shared-round implementation and the author's two-GB10 results](https://github.com/BobClawblaw/TensorFold/pull/2).
- [Flash Next native port discussion and qualification limits](https://github.com/ashhart/TensorFold/issues/472#issuecomment-6089764258).
- [Separate group-32 prompt-kernel development discussion](https://github.com/ashhart/TensorFold/pull/869#issuecomment-6230194848).
