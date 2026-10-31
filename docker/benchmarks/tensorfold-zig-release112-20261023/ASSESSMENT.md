# TensorFold 1.1.2: 11 users × 75k on one GB10

The capacity and image checks passed. **Stock 1.1.2 is not promoted:** its clean
11-request code throughput is **72.46% below the deployed Python reference**.
The tests are complete. Both machines are healthy on their original Python
profile; the native 1.1.2 experiment is stopped. The reference start time remains
`2026-10-11T12:08:52.452616778Z`; the candidate machine’s Python was restored at
`2026-10-23T15:00:24.156394771Z`. See `runtime-health-final.json`.

## Configuration and provenance

Local `docker/` is the source of truth. The profile, scripts and dependencies are
copied to the inference machine’s own `~/docker/` and executed there with actual
NVIDIA GB10 GPU access. No proxy application files were changed for this test.

| Setting | Native candidate | Python reference |
| --- | --- | --- |
| Runtime | Official Zig 1.1.2, unchanged engine/kernels | Existing customized Python 0.6.5 |
| Model | MLX affine 4-bit/group-32 with MTP | Same checkpoint/revision |
| Context cap | 75,000 prompt + reply tokens | 75,000 prompt + reply tokens |
| Configured slots | 11 | Existing 16; matched cohorts use 11 |
| KV | BF16 | INT8, group-32 FP16 scales |
| MTP | 6 drafts, confidence 0.60 | 6 drafts, confidence 0.60 |
| Vision | Enabled; one image, up to 4,096 visual tokens | Existing enabled vision |
| Prompt chunks | 1,536 | Existing deployment settings |
| Computation prefix retention | 0 GiB | Existing KEEP64/custom SSD gather |
| Persistent memory | Off | Existing deployment unchanged |

The native profile reserves 10 GiB. Living Weights, Recall, disk learning,
saved conversations and compact memory are off. Actual process arguments,
read-only checkpoint mounts and disabled endpoints are checked in
`stock-vision11/memory-off.json`. Ordinary KV computation storage is separate
from persistent learning.

- Release source: `4ff784410f70b95767684d337e59dfd6d94fec8b`.
- Release aarch64 archive SHA-256: `4da070ed641e9dc6d41fa91d690a2fdf42e5023e1f84dfc69bcad8e893e6c367`.
- Actual executable SHA-256: `a18a3e2d087fa4dac34b10009b4ba4c815d4c474cc6d0c8704b29702373dd1ab`.
- Checkpoint revision: `2b170fa6309d5d1ee380b35636075fac7945f286`.

A draft FP8/MTP batching port exists only in a temporary source directory.
It was neither built nor deployed after the user selected the 11-stream stock
configuration. The native results here contain no local inference patch.

## Matched performance

Medians of three clean cohorts per concurrency, with identical request hashes,
256 output tokens/request, thinking off, temperature 0, zero prefix hits,
zero unrelated inference, zero swap-out and zero OOM. The final six selected
cohorts contain 36 requests per runtime. These finite synthetic code prompts
are not a general workload or statistical-significance claim.

| Metric | Python | Zig 1.1.2 | Zig vs Python |
| --- | ---: | ---: | ---: |
| One request, output tokens/s | 45.55 | 72.92 | +60.10% |
| Eleven requests, aggregate output tokens/s | 265.49 | 73.11 | -72.46% |
| Eleven requests, median first token | 0.440s | 1.506s | +242.61% longer |
| Cold ~16k prompt, first token | 6.758s | 9.065s | +34.15% longer |

The cold16k row is one clean matched pair, not three repetitions. The cold65k
reference overlapped a student request and is excluded from clean comparisons.
The initial short Python cohorts also overlapped student traffic; those raw
files remain under `python-2225-streams11/`. Fresh trial IDs and idle checks
were used to collect the clean reference in `python-clean11/`, then those exact
selected requests were replayed in `stock-clean11/`.

`clean-comparison.json` contains the matched percentages and per-cohort data.
`comparison.json` retains initial measurements and explicit exclusion reasons.
No Python/Zig token-equality claim is made: their cache precision and arithmetic
differ. Correctness is checked separately with tools, schema, images and retrieval.

The source still verifies and drafts each MTP stream separately; therefore
single-stream speed does not establish shared throughput. Profiling would be
required to assign exact portions of the observed gap to individual operations.

## Why concurrency differs: quantization or native architecture?

**Assessment: the strongest evidence points to the current native Flash Next
batching/execution implementation. KV precision contributes to memory pressure
and may affect speed, but its performance share was not isolated in this run.**
This is an implementation limitation; it does not establish that the Zig
language cannot match or beat Python.

There are two different meanings of quantization here:

1. **Model weights:** both runtimes read the exact same MLX affine 4-bit/group-32
   checkpoint at the same immutable revision. This comparison does not switch
   between NVIDIA FP4 and AutoRound INT4, so a different checkpoint quantization
   format cannot explain the observed difference. Each runtime’s packing and
   kernels can still differ; identical weights do not imply identical execution.
2. **KV computation cache:** Python uses INT8 codes plus FP16 group scales;
   stock native Flash Next uses BF16 K/V. BF16 needs two bytes per K/V element
   versus approximately one plus scale overhead for INT8. Indexer/pooled keys
   are not all halved by INT8. This explains a substantial part of native’s
   lower context admission. It can also increase attention memory traffic and
   leave less RAM for the mapped embedding tables, especially at long context.
   INT8 also adds conversion/dequantization work, so a smaller cache does not
   guarantee a throughput gain.

The measured scaling pattern is revealing:

| Same short-code workload | Python | Native Zig 1.1.2 |
| --- | ---: | ---: |
| One request | 45.55 tok/s | 72.92 tok/s |
| Eleven requests, aggregate | 265.49 tok/s | 73.11 tok/s |
| Aggregate scaling from one to eleven | 5.83× | 1.00× |

Native is faster for one request, yet its aggregate rate stays nearly flat
when eleven users share it. That pattern supports a concurrency/batching
bottleneck rather than a uniformly slower quantized model. These are short
prompts, where large occupied attention caches are not the dominant context
payload, although their formats and reserved storage still differ.

Source inspection provides a concrete mechanism. In release 1.1.2,
[`verifyFn`](https://github.com/ashhart/TensorFold/blob/v1.1.2/zig/src/families/flashnext/cuda_lanes.zig#L434)
loops over drafted streams and invokes `Ops.verify` separately for each one.
[`draftFn`](https://github.com/ashhart/TensorFold/blob/v1.1.2/zig/src/families/flashnext/cuda_lanes.zig#L485)
also absorbs/chains each stream’s MTP drafts separately. Shared model work
therefore repeats across streams instead of combining their draft windows in
one pass. Python’s Flash Next engine combines compatible work across owners;
our deployment additionally retains its KEEP64 and batched SSD-gather changes.
The short comparisons report zero prefix hits, so direct cache reuse is not
the explanation for their measured throughput difference.

Upstream [#1069](https://github.com/ashhart/TensorFold/pull/1069) targets shared
verification and [#1155](https://github.com/ashhart/TensorFold/pull/1155) targets
shared greedy MTP heads—exactly these native limitations. They are open and
unmerged, and their authors’ limited-stream results are not our 11-user results.

**What remains unproven:** neither this campaign nor the source inspection
assigns a percentage of the gap to BF16 KV, launch overhead, repeated weight
reads, owner-specific attention/recurrence, or host synchronization. A GPU
timeline and a controlled matrix with cache precision and MTP batching varied
independently would separate those effects. Simply porting INT8 should improve
memory capacity; it is not evidence that it would close the concurrency gap.

## Full-window capacity

**11/11 requests completed**, each with 74,005–74,006 input tokens and exactly
256 output tokens. Totals: **814,056 input and 2,816 output tokens**. The monitor
recorded **11 resident streams and 11 KV pools**, with zero unrelated requests
or prefix hits. See `capacity-qualification.json` and the complete raw monitor.

| Metric | Native 1.1.2 |
| --- | ---: |
| Total wall time | 530.81s / 8m51s |
| Median first token | 479.78s / 8m00s |
| p95 first token | 482.90s |
| Minimum available RAM | 11.64 GiB |
| Peak swap in use | 1.05 GiB |
| Swap-out during test | 194,906 × 4,096-byte pages / 761.35 MiB |
| OOM kills | 0 |

This qualifies completion **with swapping**, not a no-swap performance result.
End-to-end output rate includes the entire cold prompt phase and is not standalone
decode throughput. Requests were near the 75k cap, not exactly 75,000 occupied
tokens. Vision was loaded, but these stress requests were text: maximum-size
images embedded in all eleven long contexts are unqualified.

Python also completed the matching 11-request capacity test, in 404.07s without
new swap-out or OOM. It overlapped six unrelated requests, so that timing is
excluded from a controlled percentage comparison. Both raw receipts remain.

Stock 1.1.2 originally refused 16 × 75k with vision: it priced 39.07 GiB of stream
state against 28.15 GiB available. Fourteen would also exceed that budget. The
user selected eleven. See `stock-vision16-admission.log` and `interrupted-runs.json`.

## Image and API checks

- Three single PNG color checks passed; an eleven-request PNG burst passed 11/11.
  Its short replies peaked at eight open connections, so the burst alone does
  not prove eleven simultaneous fully resident image histories.
- JPEG color recognition passed after the pinned decoder was installed and the
  native process restarted. Synthetic colors are a limited image smoke check,
  not a general visual reasoning benchmark. Multiple images, WebP and video
  were not qualified.
- Automatic, required and named `record_number(42)` calls passed, as did the
  structured JSON-schema case. Python passed the tool/image checks, but failed
  this exact schema smoke; its raw reply is retained in `python-2225/compatibility.json`.
- Long-context retrieval passed 16/16, including two ~65k histories. Requests
  beyond the eleven slots queued; this is not sixteen-stream capacity evidence.

JPEG requires **libjpeg-turbo 3.1.4.1**, separately from the official TensorFold
archive. The YAML and `install_codecs.sh` download its official arm64 package,
verify SHA-256 `d3f9d7ddd998758e1850b37153a7904bdcdeb8cf54a782c772780b0bc50dd553`,
and extract it into the runtime volume’s documented `../lib` loader path.
Library SHA-256 is `83d898d4c6c39a7297aa9086ac8a77d3f938f447501975a3b4962ef1b0e1d6bb`.
A missing-library result is cached by the process: the first JPEG returned 400,
and adding the library required a restart before it passed. No engine binary,
weight or CUDA kernel changed. The full text-capacity test preceded decoder
installation; inference settings and executable were identical after restart.

## INT8 feasibility and upstream development

An INT8 native patch is feasible, using Python’s quantizer as a reference,
but needs cache writes/scales, attention reads, MTP, snapshots, admission and
GPU/quality qualification. Smaller storage does not itself establish more speed.
As checked October 23, no dedicated current native Flash Next INT8-KV PR was found.

Related **open, unmerged** work:

- [#1069](https://github.com/ashhart/TensorFold/pull/1069): shared MTP verification.
- [#1155](https://github.com/ashhart/TensorFold/pull/1155): batched greedy MTP heads.
- [#1169](https://github.com/ashhart/TensorFold/pull/1169) and [#1170](https://github.com/ashhart/TensorFold/pull/1170): BF16 page addressing and pooling; allocation flexibility, not quantization.
- [#1195](https://github.com/ashhart/TensorFold/pull/1195): persistent PLE gather workers.
- [#1217](https://github.com/ashhart/TensorFold/pull/1217): fused prompt DeltaNet.

[#47](https://github.com/ashhart/TensorFold/pull/47) is historical Python INT8/INT4
work. It is not a native 1.1.2 implementation. Research snapshots are saved under
`upstream-research/`. None of these PRs were applied in this stock campaign.

Primary release: [TensorFold 1.1.2](https://github.com/ashhart/TensorFold/releases/tag/v1.1.2).
