# TensorFold 1.1.0: sixteen-user GPU evaluation

Follow-up: [the later contributor recurrent-batching experiment](../tensorfold-zig-shared-rounds-20261018/ASSESSMENT.md) completed 16 near-75k requests on one exact v5 MLX/FP8 text-only profile. Its throughput still trails Python. The qualification does not transfer to the earlier v3 or NVIDIA FP4 profiles discussed below.

The full 1.1.0 release is under evaluation on the 2226 GB10 for sixteen simultaneous
streams with a 75000-token total window. **No 1.1.0 candidate is promoted.**
Python on 2225 remains unchanged; its original October 11 start time was checked.
Local `docker/` is the configuration source, synchronized into remote `~/docker`.
Compose runs on the remote host. Experiments use isolated port 8007.

Release: https://github.com/ashhart/TensorFold/releases/tag/v1.1.0
Published: 2026-10-18T10:39:43Z. Source commit:
`76aafcf274e60a5e31a59ce145b2f71f7b366e9d`.
Official aarch64 archive SHA-256:
`8f18033fca9df0c56c19afb2f11b55175151ff886c2603b01c0390bf48773e59`.
`upstream-release.json` and `patch-manifest.json` preserve release and patch provenance.

Percentage comparisons and their denominators are recorded in
[PERFORMANCE-PERCENTAGES.md](PERFORMANCE-PERCENTAGES.md) and
`percentage-comparison.json`. Current results do not establish that further
optimization is impossible.

The source-level execution comparison and remaining adaptation work are recorded
in [GPU-EXECUTION-COMPARISON.md](GPU-EXECUTION-COMPARISON.md). The identified
structural differences are not yet a measured GPU timing decomposition.

## Memory features are off

All 1.1.0 profiles omit the opt-in flags for Living Weights (`--slide`), Recall
(`--recall*`), disk prompt learning (`--learn*`), saved conversations,
`--compact-memory`, and training-row recording (`--record`). Upstream CLI
`Args` defaults for these features are false/null. Checkpoints are mounted
read-only. These experiments do not train or modify checkpoint weights.

The real native process arguments were inspected. `GET /v1/recall` returns 404
with "Recall is off"; `POST /v1/imprint/resume` returns 404 with "saved
conversations are off". `verify_memory_off.py` checks the actual process,
read-only checkpoint mount, and disabled endpoints before each new probe;
a failure stops that trial. Receipts are saved as `memory-off.json`.
`memory-policy.json` preserves the policy and initial verification.

KV caches and explicitly budgeted RAM prefix caches reuse computation. They
are separate from persistent learning. Cold probes set RAM prefix cache to 0.

## Release capabilities and remaining gaps

- Native CUDA Flash Next supports the pinned MLX affine four-bit group-32
  checkpoint used by Python. Its experimental ModelOpt path reads NVIDIA FP4.
  It does not support the GPTQ AutoRound checkpoint of the older MiaAI recipe.
- Upstream CUDA MTP verifies drafted streams separately. Wider batching is
  deferred upstream to 1.1.1; the local experiments below add it to full 1.1.0.
- TCP_NODELAY, linear namespace rendering, HTTP503 admission before SSE headers,
  and unavailable-engine health handling are included in the full release.
- Automatic function calls pass. Required/named `tool_choice` returns HTTP400
  because this CUDA family cannot enforce token grammar, despite the installed
  grammar library. Native vision supports PNG, with JPEG requiring pinned
  libturbojpeg. This family's image budget is at most 4096 tokens/image.
  Native Flash Next video input is not qualified.
- The NVIDIA vision loader fails on its checkpoint's different tensor names and
  mixed quantization; renaming alone would not qualify it.

## Completed configuration experiments

All throughput values are aggregate cohort tokens/s, not per-user rates.
Admission alone does not establish sixteen simultaneously full context windows.

| Variant | GPU result | Code16, trial1 | Cold16k TTFT | Full16 near75k |
| --- | --- | ---: | ---: | --- |
| Official MLX, MTP6, vision, cache8, reserve10 | Refuses16: needs39.07GiB, room28.28GiB | 72.8 with only4 configured streams | 12.74s | Not qualified |
| Official NVIDIA FP4, MTP6, text only, reserve10 | Refuses16: needs38.74GiB, room33.73GiB | — | — | Not qualified |
| Official MLX, no drafts/vision, cache0, chunk768, reserve8 | Admits16; 35full outputs | 138.90 | 13.966s | Not run |
| MLX, BF16 KV, corrected single-GPU graph | 35full outputs, exact graph-off token hashes; QA16/16 | 139.54 | 13.865s | Not run |
| MLX, FP8 KV, headless, corrected graph | 35full outputs; QA16/16; automatic tools | 122.61 | 12.867s | Not run |
| MLX, FP8 KV, batched MTP verification v1 | Admits16, 1.49GiB/stream; 35full/exact teacher outputs; QA16/16 | 157.31 | 13.381s | Not run |
| MTP head prototype v2, scheduler still serial | 35full/exact teacher outputs; QA16/16; grouped head was not exercised | 157.19 | 13.323s | Not run |
| MTP head v3, scheduler batching enabled | 35full/exact teacher outputs, grouped GPU paths exercised; QA16/16 | 186.78 | 13.409s | Not run |
| NVIDIA FP4, FP8 KV, grouped MTP v3 | Admits16, 73.45GiB model +1.49GiB/stream; 35full outputs, QA16/16 | 198.21 | 13.018s | Not run |

Python reference: same-host code16 trials285.5/321.5tokens/s, cold16k TTFT6.949s.
The earlier clean 2225 code16 trial measured316.8tokens/s. Requests share fixed
payloads and sampling settings. `alternatives-comparison.json` records matching
payload hashes and excludes outside traffic, short/failed outputs, new swapping,
OOM, or unexpected cache hits from clean timing comparisons. The first official
four-stream trial reused two prompt tokens/request; most of those timings are
therefore excluded from strict cold comparisons.

The v1 batched-verification trial0 measured158.46tokens/s but swapped16 pages;
trial1 above was clean. Its retrieval cohort swapped54pages, so no clean retrieval
latency claim is made. V2 trial0 swapped157pages; trial1 was clean. V2 retrieval
swapped67pages. No host OOM occurred in these cohorts.

The warm FP8 headless run passed PNG and completed the first76 decode requests
of the main workload. Its code16 rate remained around122tokens/s, so that run was
intentionally stopped before finishing the full253-request suite and capacity
trial. Those unrun stages are not passes. The stop is preserved in
`fp8-headless-stopped.json` on the remote campaign folder.

## GPU correctness and local patches

The opt-in FP8 patch uses E4M3 K/V while retaining BF16 indexer and pooled keys.
Seventeen GPU kernel checks passed: quantized prep bytes at multiple positions,
dense/sparse attention including75k contexts, and both ahead modes match BF16
kernels fed the same quantized values. This does not establish equality with
unquantized BF16. Model retrieval is checked separately.

The original graph patch failed on `UnownedCaptureSource` and establishes no
speedup. The corrected patch uploads owned IDs/positions/ngram planes before
capture, scopes invalidated captures correctly, and preserves the exact84 FP8-v1
fatbins. Thirty-five GPU outputs and token hashes match the graph-off control.
Graphs did not produce a measured speedup.

Batched verification groups dense/expert work while retaining separate owner
attention, recurrent, convolution, and rollback state. Its35 output token hashes
match the serial FP8 teacher exactly. Controlled retrieval passed16/16 on Python,
BF16, FP8, and the verify-batched runs, including two65k prompts. This is limited
retrieval coverage, not a general quality benchmark.

The draft-head prototype groups its projection/expert work across owners, with
independent head caches and keyed sampling. V2 omitted the scheduler's
`draft_streams` fact, so its GPU results only validate the serial fallback.
V3 enables that fact under the opt-in flag and logs the first grouped head and
verification calls. The probe requires those logs as well as exact teacher hashes,
automatic tools, and retrieval non-regression. V3 compiled successfully; host
checks passed80/80 steps,1738tests passed,1JPEG-dependent test skipped. These
compiler/source checks supplement the real GPU inference tests. V3 completed
35full-budget outputs with exact serial FP8 teacher hashes, automatic tools,
and16/16 retrieval answers. Both grouped paths were exercised. Trial0 swapped
18pages and is excluded; trial1 was clean. Retrieval swapped20pages, so its
latency is excluded from clean comparisons. The187tokens/s clean throughput is
about19% above verify-only batching, still below Python. NVIDIA ModelOpt FP4
with the same FP8 KV and batching patches completed35full fixed-budget outputs
with no new swapping or outside inference. Both grouped paths and memory-off
checks passed. Controlled retrieval passed16/16 with no new swapping, OOM,
or outside inference. This different
checkpoint has not been compared with its own serial teacher, has no qualified
NVIDIA vision loader, and remains below Python throughput. Startup admitted16
streams with a73.45GiB model footprint and1.49GiB per stream; this does not
establish full-window physical residency. The existing swap-use counter was
about1.19GiB when this benchmark started, not zero; the timed short cohorts
had no additional swap-out.

## Promotion requirements and recovery

A candidate needs full outputs, quality/protocol checks, a competitive full
interactive workload, and all16 requests near75k completed under the final
profile. No new release candidate has completed that capacity qualification.
Memory guards stop experiments below6GiB host available, on a new host OOM,
or after more than1GiB new swap-out. All failures retain receipts and restore
Python on2226; runtime readiness must be checked after restoration.

An earlier interrupted Python extension compilation left a lock. The dedicated
recovery helper stops its sole writer, checks no other container owns that volume,
and removes only the known orphan lock. It never removes an active compiler lock.

The older tuned MiaAI INT4 engine is a separate implementation. Its253-request
results and one earlier capacity pass cannot qualify these full1.1.0 profiles,
or a different snapshot/cache configuration.

Final runtime check: Python on2226 is healthy again through Docker and its API.
Python on2225 is healthy with its original October11 start unchanged.
`runtime-health-final.json` preserves the read-only verification. No new Zig
runtime was promoted.
