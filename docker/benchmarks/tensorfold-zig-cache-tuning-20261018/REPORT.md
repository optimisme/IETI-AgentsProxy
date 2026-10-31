# Zig cache tuning against the customized Python deployment

18 October 2026. Work in progress; no promotion decision yet.

The goal is to improve the Zig runtime for interactive classroom use, with
16 streams and a 75000-token request limit, and retain it as the main runtime
only when the measured result warrants that change. Local `docker/` remains
the configuration source; profiles and patches are copied to the remote
machine's own `~/docker/` before execution.

## Comparison design

The customized Python/MLX profile was benchmarked on 2226 before replacing it
with Zig, providing the same GB10 and driver for the comparison. The existing
2225 Python service remains online and is not restarted. The benchmark client
runs on the inference host against loopback. Existing checkpoint, fixture,
temperature, thinking and fixed-output conventions are retained.

The main workload contains 126 requests and separate tool/image smoke checks.
`cache_probe.py` adds 63 requests covering independent ~1800-token histories at
1/4/16 concurrency, then growth and branching. Fresh and candidate runs use
the same request bodies; model IDs alone are excluded from payload hashes.
Exact-output comparisons apply between the two INT4 Zig settings, not between
different checkpoints. External inference and new swap/OOM counters are kept
in each cohort; contaminated pairs are excluded from clean speed comparisons.

## First patch

`models/qwen38-flash-next-tensorfold-zig-tuned-int4-mtp-fp8-vision-128gb.yml`
uses the same pinned INT4 checkpoint, recipe and CUDA kernels as the preceding
INT4 campaign. A checksum-guarded local patch exposes a validated
`TF_FLASHNEXT_CACHE_MIN_PROMPT` override, preserving 4096 by default in the
binary, and adds optional timing around prefix copies. The experimental YAML
selects 1024. The retained prompt cache is fixed at 8 GiB for both control and
candidate, instead of deriving a slightly different budget at every startup.
MTP, KV type, scheduling and memory reserve are otherwise unchanged.

The build-only helper compiles CUDA/native code and runs host-side logic tests
without claiming a GPU. **203/203 host tests passed**. These tests validate
cache state, branching and parameter contracts; they are not performance tests.
The actual inference container requests one NVIDIA GPU, runs on the GB10, and
was observed at 95% GPU utilization during generation. See
[gpu-evidence.json](gpu-evidence.json) and [build-tests.log](build-tests.log).

Patch v1 native executable SHA-256:
`65b96cce552774aa0beac70eda279cb9066c24f7df1320c0f91563c55b95a301`.
The patch and guarded source hashes are recorded in
[patch-manifest.json](patch-manifest.json).

## Initial control results

The same-host Python run completed 126/126 main requests and all 63 probe
requests at full output budgets. Its clean mixed-history growth median TTFT
was 1.23 s, branching 0.57 s; clean 16-user short-history growth/branch TTFT
was about 0.44/0.45 s.

The rebuilt Zig 4096 control reproduced the growth regression: 5.63 s median
TTFT and 104.5 tokens/s, versus Python's 1.23 s and 208.6 tokens/s in a clean
same-host pair. The short-history 16-user growth probe had zero cached tokens
and 10.80 s median TTFT. Short-prompt code generation remained faster, including
a clean 16-user code trial at 378.7 versus 321.5 tokens/s. One clean 16k cold
prompt was unexpectedly slower; subsequent repeats below returned about 6.1 s.

At this stage no promotion was made. The later experiments below retain the
prior stock INT4 near-75k safety abort as a failed run, and separately record
the isolated tuned-engine capacity result.

## Snapshot-spacing experiment (patch v2)

The second patch adds a validated minimum history advance, with zero preserving
upstream behavior and 256 selected by the tuned profile. A nearby turn reuses
its existing checkpoint instead of allocating and saving an almost-identical
one. Initial cold histories remain eligible, and larger advances still keep a
new state. Allocation timing is available only when explicitly enabled.

All 204 host tests passed. The GPU variant completed 126 main requests and
63 short-history probe requests, all at full budgets, with tool/image smoke
checks passing. All 189 outputs match the 4096 control exactly; the control's
126 main outputs also match the earlier unmodified INT4 engine exactly.
All 727 AOT/vision helper assets match the unmodified engine. Native executable
SHA-256: `bb6e1b7ee59e6d5f250955d71768fb2ddd0aab40aa7e24a9731214de2496b5fc`.

| Clean same-host workload | Python | Zig v2, 8 GiB retention |
|---|---:|---:|
| 16 code, trial 1 aggregate output | 321.5 tok/s | 406.1 tok/s |
| Mixed-history continuation median TTFT | 1.23 s | 0.85 s |
| Same continuation aggregate output | 208.6 tok/s | 218.3 tok/s |
| Earlier-turn branch median TTFT | 0.57 s | 0.85 s |
| Same branch aggregate output | 184.4 tok/s | 240.5 tok/s |
| 16 short histories, continuation median TTFT | 0.44 s | 0.81 s |
| 16 short histories, branch median TTFT | 0.45 s | 0.84 s |
| 16k cold median TTFT | 6.95 s | 6.14 s |

The isolated near-75k burst completed **16/16** requests with full 256-token
outputs in **531.86 s**, minimum host MemAvailable **15.76 GiB**, one new
swapped-out page, and no OOM. No external inference requests were recorded.
This passes the existing 1 GiB swap-out guard. It is not a zero-swap result,
and it does not prove sixteen full windows resident at once. Workload order,
retained state, isolation and source policy differ from the earlier aborted
stock run, so the capacity outcome is not attributed solely to the patch.

The added coding-workflow probe freezes 256-token assistant replies from the
Python baseline and synthetic tool logs, with no tools actually executed.
All 64 v2 requests completed, but returning to an earlier substantial turn had
zero cache reuse and 12.43 s median TTFT. This exposes a limitation hidden by
short follow-up messages. Python was then measured on the identical histories
on the same host before testing a larger retention budget.

No production promotion was made at the v2 stage.

## Longer assistant/tool-history baseline

The same-host Python baseline completed all 64 longer-history requests at full
output budgets, without new swapping or OOM. The first continuation was a clean
pair: Python 7.57 s median TTFT and 74.6 tokens/s, versus Zig v2/cache8 6.31 s
and 96.2 tokens/s. Their cached-token totals differed (115011 versus 131505),
which limits attribution to compute speed. The second continuation was also
clean: Python 2.94 s and 154.1 tokens/s, versus Zig 2.74 s and 128.2 tokens/s.

Returning to the earlier substantial tool turn was slow for both: Python
18.05 s median TTFT with 12896 cached tokens, Zig 12.43 s with zero. Python's
branch cohort overlapped two requests, so its timing comparison is excluded
from clean speed claims. The next 16 GiB experiment checked whether Zig could retain those older-turn
checkpoints. It changed retention only, keeping the same v2 executable and
other serving parameters.

## Retention budget and LRU experiment

Increasing v2's retained-state budget from 8 to 16 GiB did not resolve the
substantial-turn branch failure: its median TTFT remained 12.42 s with zero
cached tokens. This isolated budget change is retained in
`zig1024gap256cache16-*`; it is not presented as a successful branch fix.

The source prefers discarding a conversation's superseded states before stale
unrelated entries. With a full cache, this can repeatedly remove the earlier
turn a branch needs, regardless of a larger budget. Patch v3 adds a strict,
reversible `TF_FLASHNEXT_CACHE_BRANCH_LRU=1` option: choose the least recently
used entry, retaining the existing protection for the state being resumed.
The binary default preserves upstream policy; the tuned profile opts into LRU.
A regression test exercises stale unrelated history and an exact earlier-turn
resume under a bounded budget. No sequence ownership or CUDA arithmetic changed.

The v3 build/test step passed: 142 tests reran and other unchanged targets reused
cached passing results; all 21 steps succeeded. Its native executable SHA-256 is
`ea17f24479180a12f8d7257614cf7982c9919785ca7c9b556cd6d058d94663f4`.
Docker runtime settings were verified as minimum 1024, history gap 256, branch
LRU 1 and retained prompt budget 16 GiB. All 253 GPU requests passed and the
main/short outputs matched the 4096 control. The substantial-turn branch still
reused zero tokens: 12.397 s median TTFT and 69.27 s wall. LRU alone was not
a repair. Capacity was not run for this unsuccessful branch experiment.


## Upstream 1.1.0 and local v4

The newly released upstream 1.1.0 was evaluated on the GB10. It is a different
CUDA implementation, and its MLX path refused sixteen streams at 75000 context
(39.07 GiB stream demand versus 28.28 GiB room), while a four-stream run passed
PNG input but refused named tool choice. Full release and measured limitations
are in `../tensorfold-zig-release110-20261018/ASSESSMENT.md`. Larger CUDA draft
batching is explicitly deferred upstream. It does not replace our MiaAI engine.

V4 backports accepted-socket TCP_NODELAY (#929) and linear namespace string
accumulation (#973). Its local stable-history option selects an exact prefix
before the current user message, retaining the old endpoint when that template
boundary does not match. Rendering normally still runs twice, as before.
This repairs the branch that edits the last user message after a large tool log.
The v3 threshold, spacing and LRU controls remain selectable; the candidate uses
1024 / 256 / LRU=1 and sixteen GiB retained-state budget.

The first v4 run deliberately exercised the unresolved agent branch first.
All 253 fixed-output requests and API compatibility checks passed; all 253
outputs matched v2, and all 189 main/short outputs matched the 4096 control.
The agent branch reused 152479 input tokens across the cohort, reached its first
token in a median 0.886 s, and completed all sixteen 128-token replies in 13.31 s.
V2's same branch reused zero tokens, with TTFT 12.427 s and wall 72.107 s. This
pair is clean (no outside inference, new swap or OOM) and all sixteen outputs
match exactly. Larger retention and LRU alone had not repaired it in v3.

The earlier phases of this initial run had small swap writes and are excluded
from clean timing comparisons. Subsequent mixed-history decode throughput was
lower than the reference. Its workload order differed from the reference: the
long agent run preceded the normal benchmarks and populated caches and runtime
measurements first. A fresh replay in the reference order is required before
selection, with identical binary and settings. The first run is retained as
`zigstable16-{main,probe,agent}` rather than overwritten.


## Fresh v4 replay in the reference workload order

`zigstable16b-*` uses exactly the same binary and flags as the first v4 run,
restarting the server and running main, short probe, then agent histories as the
reference did. All 253 requests passed at full output budgets. All 189 main/short
outputs equal the 4096 control and all 253 outputs equal v2. The separate tool,
PNG, thinking, reasoning-history and model-alias checks passed. A synthetic red
MP4 also passed (`zigstable16b-video/video.json`).

| Same-host workload | Python | v4 sixteen-GiB replay |
| --- | ---: | ---: |
| 16 code, trial 0 aggregate output | 285.5 tok/s | 379.5 tok/s |
| 16 code, trial 1 aggregate output | 321.5 tok/s | 402.8 tok/s |
| 16k cold first token | 6.95 s | 6.09 s |
| Mixed-history continuation, first token | 1.23 s | 0.84 s |
| Mixed-history continuation, aggregate output | 208.6 tok/s | 216.2 tok/s |
| Mixed-history branch, first token | 0.57 s | 0.85 s |
| Mixed-history branch, aggregate output | 184.4 tok/s | 239.3 tok/s |
| Long tool-history growth 1, first token | 7.57 s | 5.84 s |
| Long tool-history growth 1, aggregate output | 74.6 tok/s | 112.7 tok/s |
| Long tool-history growth 2, first token | 2.94 s | 2.88 s |
| Long tool-history growth 2, aggregate output | 154.1 tok/s | 151.7 tok/s |

The rows above are clean under the campaign's strict criteria. Cache-hit counts
differ on the longer histories, so the improvement is an end-to-end service
result rather than an isolated compute-speed claim. The growth-2 throughput is
near parity and slightly below Python. Python still has lower TTFT on the short
16-user cached turns (~0.44/0.45 s versus ~0.81/0.83 s for Zig), and a higher
output rate on that short branch. The profile is not a universal winner.

The substantial-turn agent branch reused 152479 tokens, with median TTFT
0.831 s and total wall 9.423 s. Against v2's clean zero-cache branch, TTFT was
12.427 s and wall 72.107 s. All sixteen outputs match. The same-host Python
branch's 18.05 s timing is excluded because it overlapped outside inference;
it is not used for a clean Zig/Python speed ratio.

The previously lower mixed-history throughput returned to the reference range
in this fresh replay: 216.2/239.3 tok/s versus v3's 218.5/241.9. The first run
remains a valid robustness observation after the heavier histories; the replay
supports the comparison at the reference workload order, not a claim of fixed
throughput regardless of workload history.

All 727 external CUDA AOT and vision-helper source files match the original
unmodified INT4 runtime. The native executable changes cache/server logic and
has SHA-256 `28abc29e97ff08e39eb7ec7dd0b360dd9f1038bfe0b5af5f62e2d3032814a701`.
V4 build checks passed all 21 steps, with 142 tests executed and unchanged test
targets reusing their cached passing results. All inference and performance
qualification described here ran on the GB10 GPU.


## Rejected sixteen-GiB capacity result

The v4 sixteen-GiB replay failed the separate near-75k capacity gate. All 16
streams ended with errors and zero complete output budgets after 471.12 s.
The CUDA log first reports `cuMemAlloc: CUDA_ERROR_ILLEGAL_ADDRESS (700)`;
one stream surfaces `NoRoom`, followed by `CudaFailed` on the remaining streams.
This is not classified as a successful result merely because benchmark.py
itself returned zero. Minimum host MemAvailable was 9.71 GiB, with 13 new swap
pages (52 KiB) and no host OOM. Host reserve compliance does not establish
CUDA runtime safety. The exact failure mechanism is not yet attributed to the
retention budget alone: the CUDA context was already reporting an illegal
address at allocation. No sixteen-GiB configuration is promoted.

The next experiment keeps the same v4 native binary, short-history threshold
and exact-prefix stable boundary, but restores the previously capacity-tested
8 GiB retention and spaces new snapshots by 512 tokens. This should avoid an
extra checkpoint on the ~286-token second assistant turn, preserving the first
substantial tool-history boundary with less retained storage. It is a tested
hypothesis only after the next main/probe/agent and capacity gates pass.


## Eight-GiB retention with 512-token spacing

`zigstable8g512-*` passed main, short and agent workloads, but LRU at the smaller
budget evicted pending users' states before their follow-ups. Growth 1 lost
several long prefixes (including the ~65k project); growth 2 and the branch
reused 143062 tokens rather than 152479, with three short users re-reading
from zero. The branch reached a median TTFT of 4.63 s and wall 12.83 s: improved
against v2's zero-cache branch, but a regression against the sixteen-GiB normal
workloads. This is not selected, and capacity is skipped for this LRU setting.

The next experiment restores the original superseded-state eviction policy
(LRU=0), keeping 8 GiB retention, spacing 512, stable boundary=1 and the same
v4 binary. The original policy can discard an extended conversation's own old
state instead of a different user's pending prefix. Spacing 512 avoids keeping
a new checkpoint on the ~286-token second follow-up, which should preserve the
substantial tool-history checkpoint without retaining both near-identical turns.
Selection still requires the GPU main/probe/agent and full capacity gates.
