# TensorFold Python for sixteen users — completed GPU validation

The tuned Python profile improves the measured sixteen-user returning-context
workload: **43.98% less total elapsed time**, with unchanged weights and INT8 KV.
Three matched timing pairs, three sustained finalist trials and three separate
release qualifications are complete. The original experimental service is
restored and healthy; the reference service remained unchanged.

This profile is a candidate for a controlled trial of the tested returning-agent
workload. It retains all sixteen near-75k histories and fixes the observed later
KV-growth cancellation. Short and mixed original-versus-tuned performance at
1, 2, 4 and 8 users has not been qualified. One warm mixed turn at sixteen users
also shows a material first-token regression, detailed below. Keep the original
reference until typical-load comparisons are complete. Cold batch completion is
about 7% slower, an earlier 65k growth boundary can still lose cache hits, and the
long-context quality probes have known misses. It is not a universal performance
or accuracy guarantee.

## Completed repeated timing result

Three matched pairs completed **288 long replies**, with fixed 896-token output budgets and contexts up to 74,985 input-plus-output tokens. The candidate used **43.98% less total time** at the median, with observed paired reductions of 43.83–48.65%. Aggregate output throughput increased **78.51%** at the median over this specific three-round workload.

These percentages use the predeclared bounded host-pageout analysis (3 pairs). The strict zero-host-pageout full-sequence subset has 1 pair; it also improves, but does not provide three clean full-sequence repetitions. Different workload stages are never counted as repetitions.

| Pair | Unchanged total s | Candidate total s | Less elapsed time | Higher output throughput |
|---|---:|---:|---:|---:|
| capacity-1 | 1427.398 | 801.779 | 43.83% | 78.03% |
| capacity-2 | 1420.038 | 795.480 | 43.98% | 78.51% |
| capacity-3 | 1540.304 | 790.926 | 48.65% | 94.75% |

| Stage | Unchanged wall s: median [range] | Candidate wall s: median [range] | Median paired wall change |
|---|---:|---:|---:|
| capacity-cold16 | 641.73 [635.42–642.41] | 680.11 [678.05–687.28] | +6.98% |
| capacity-return1-16 | 407.91 [407.37–481.70] | 76.73 [75.23–77.91] | -81.19% |
| capacity-return2-16 | 377.25 [377.08–416.88] | 37.64 [37.46–37.76] | -90.07% |

The two return stages take about **81% and 90% less time**. Their median first-token times improve by about **98%**, and every candidate return cohort has **16 overlapping outputs**. The original configuration accepts 16 HTTP requests but queues some for memory; configured parallelism and actual overlapping generation are separate measurements.

All sixteen candidate cold requests were admitted, but only 10–11 outputs
overlapped: early replies finished before later long prompts completed prefill.
The sixteen-way output-overlap result applies to the return waves.

Cold scheduling has a material tradeoff. The median paired batch-time increase is **6.98%**; median first-token time improves **16.88%**, but p95 first-token time increases **5.06%** and median per-user completion latency increases **12.18%**. The median post-first-token mean time per output token increases 118.95% while other long prompts prefill. This is a useful profile for returning histories, not a uniform improvement for sixteen uncached long requests.

Across the 9 candidate primary cohorts there were 3 host pageouts (12 KiB total), with zero observed main-serving-process CPU VmSwap. Two paired cohorts per stage meet the strict zero-host-pageout criterion; all 3 pairs meet the bounded criterion. Counter changes are not attributed to a specific other process. Minimum host available RAM across the candidate timing cohorts was 6.747 GiB, above the independent 6 GiB abort floor. No candidate request was cancelled or incomplete.

The baseline return variation has a cache correlate: first-return times of about 408 / 407 / 482 seconds retained 7 / 7 / 5 input histories. The candidate retained all 16 in these near-75k timing trials. This is an improvement in memory/admission and cache reuse, not a faster model kernel or a quantization change. The separate 65k growth qualification below exposes a remaining transition cost.

[Paired timing and memory figure](figures/primary-paired.png) · [Individual trial tables](TABLES.md) · [Machine-readable evidence](analysis.json). Error bars show observed trial ranges, not confidence intervals. The deployable bundle also passed its separate GPU release qualifications.

## What is identical and what changed

Both settings run on the experimental host's single GB10 CUDA GPU, with the same
pinned NVIDIA image, TensorFold source, model checkpoint, installed package
versions and common diagnostic wrappers. The unchanged baseline is an isolated clone of the configuration running on the reference host, measured on the same experimental GPU as the candidate. The reference host is not modified.

- TensorFold Python 0.6.5 commit `609ca419abecebdc5a059498a613680bd3aa847f`.
- Checkpoint TensorFold/Qwen3.8-Flash-Next-MLX-4bit-MTP at
  2b170fa6309d5d1ee380b35636075fac7945f286; affine 4-bit weights, INT8 KV.
- Context 75,000, parallel 16, MTP up to 6 drafts/confidence 0.60, native vision,
  existing measured SSD gather patch, prompt snapshot maximum KEEP64.
- No persistent Recall/learning/conversation store. Ordinary volatile prefix/KV
  reuse remains enabled. This is runtime execution state, not conversation memory.

The finalist combines four memory policies and one scheduling choice:

1. Supported upstream memory floor 8 GiB, instead of the original default 10% of
   unified host RAM (about 12 GiB). The separate 2 GiB growth reserve remains.
2. Coalesce a later snapshot with a compatible earlier snapshot on the same
   state when fewer than 256 tokens apart. Recomputing up to 255 tokens can be
   preferable to retaining another large recurrent-state snapshot.
3. Under pressure, discard older extra snapshots while preserving at least the
   newest checkpoint of each retained state; return unused allocator blocks.
4. Allocate a small final partial KV step early: at this window 73,728→75,007 rows,
   about 0.35 GiB extra upfront across 16 states, avoiding a late resize wave.
5. Increase prefill `FILL_GUARD` 8→64. This lets some long prompts reach output
   sooner, with the cold completion-time tradeoff measured above.

Lowering the floor alone failed a return-wave safety check. Coalescing alone had
little margin. Pressure-aware retention without the early tail failed the fourth
sustained round after a late resize increased reserved CUDA memory by about
3.48 GiB while allocated memory rose about 0.24 GiB. The selected combination is
not interchangeable with those rejected screens. Their raw records remain.
Reserved-minus-allocated memory alone does not identify fragmentation's cause.

The quantization format does not change in this comparison. The results show that
admission budgets, retained recurrent-state snapshots and resize policy can alter
concurrency and latency even with identical INT8 KV and affine 4-bit weights.
This campaign does not isolate Zig-versus-Python architecture or format effects;
there is no fresh Zig/vLLM performance comparison in these percentages.

## The stronger workload found a real baseline failure

The frozen sustained fixture contains 16 distinct project histories and three
full-length recorded replies. Its four rounds have maximum input+896-output
budgets 71,896 / 72,821 / 73,746 / 74,670 tokens. All configurations receive identical
bytes and tokenized inputs. This is fixed replay, separate from the representative
suite that appends each run's actual generated answers.

The unchanged baseline completed cold and return1, then only 14/16 replies in
return2. Its cache-growth policy stopped two newest requests after 710 and 884
output tokens while an older decoding stream could not grow past 73,728 rows.
The server sent SSE error events despite HTTP 200. Host OOM kills and CUDA
allocator OOM counters stayed 0; minimum available host RAM was 11.050 GiB.
This was an engine memory-gate cancellation, not a host OOM kill.

An initial maximum-sized prompt allocates the final KV size at admission, while
a smaller history can later cross an allocation boundary under load. Therefore,
a successful maximum-window test alone does not qualify the growth trajectory.
The final candidate completed all three sustained repetitions: **192/192 replies**,
with 16 overlapping outputs in every return wave. Cold times were
657.30 / 653.92 / 653.02 seconds; return1 times 96.91 / 95.62 / 94.80, return2
92.47 / 92.21 / 92.94, and return3 87.52 / 87.22 / 86.93. Minimum host available
RAM across these timed stages was 8.050 GiB. No request was cancelled and no
safety guard or host OOM triggered.
No whole-four-round speed percentage is assigned against the failed baseline.

[Failure timeline](figures/baseline-sustained-1-sustained-return2-16.png)
shows queued users, the two error receipts, CUDA allocation and host RAM.

## Repeat design and limits

After preserving the failed stronger baseline, the repeated timing comparison
uses the historical three-round capacity workload, up to 74,985 total tokens per
request. Its assistant branches are deliberately tiny, so return speedups apply
to that exact cache-heavy workload. They do not estimate arbitrary agent traffic.
Fresh matched trials alternate A/B, B/A, A/B. Each begins in a new process with a
cold text-prefix cache; kernel/model/disk caches remain warm and no OS page-cache
dropping is performed. Startup and the 30-second idle calibration are outside the
timed cohorts. Timed requests use temperature 0, seed 180026, thinking disabled,
ignore_eos enabled and exactly 896 output tokens. Actual token counts, SSE error
payloads and full completion are checked, rather than treating HTTP 200 as success.

Input and token hashes, common instrumentation, installed code/package versions
and image must match for paired percentages. Three pairs provide an observed
repeatability range, not a confidence interval or production p95 SLA. Each cohort
p95 is calculated from 16 users. SSE chunks can contain multiple tokens; chunk
cadence is not an individual-token timestamp measurement. The client runs on
remote loopback: proxy overhead, WAN latency and student network conditions are
outside these numbers. Long timed tests disable reasoning on both settings.
The short default-reasoning check verifies that feature remains enabled; it does
not qualify sixteen long reasoning workloads or their task accuracy.

Strict clean analysis requires zero whole-host pageouts. The separately declared
bounded analysis allows at most 1 MiB of host pageouts per stage, complete main-
serving-process counter coverage and zero observed CPU VmSwap in that process,
with no incomplete outputs, unrelated requests, OOM or safety abort. The first
candidate pair had two 4 KiB host pageouts total; main-process VmSwap and major
fault deltas were 0. This does not prove every container process never swapped,
or identify the cause of the host counter changes. All raw flags remain visible.
The independent supervisor aborts below 6 GiB host available RAM, on a host OOM,
or above 1 GiB new swap-out, and restores the normal service on failure/end.

## Functional and representative workloads

Both configurations completed all **112 timed representative replies** in one
fresh-process trial each. The three short cases are different cases within one
trial, not three independent repetitions. Later conversation rounds append each
run's actual answers, so those inputs need not remain byte-identical.

| Workload | Unchanged wall s | Candidate wall s |
|---|---:|---:|
| Short burst 0 / 1 / 2 | 12.29 / 11.54 / 10.89 | 11.95 / 11.31 / 10.84 |
| Conversation 0 / 1 / 2 | 73.24 / 13.61 / 12.62 | 73.35 / 13.31 / 13.47 |
| Four longer users, then twelve short users after 2 s | 48.72 | 47.59 |

These small differences are descriptive, not evidence of a repeatable speedup.
The candidate's final warm conversation case was 0.85 s slower overall
(13.472 versus 12.619 s, +6.76%). Its median first-token latency also rose from
1.568 to 3.163 s (+101.76%); p95 rose from 2.097 to 3.352 s (+59.84%). The
unprofiled candidate reproduced a roughly 2.987 s median and 3.183 s p95 in that
case. There is only one controlled baseline/finalist representative trial, so
this is a regression signal requiring repeated comparison, not an established
population estimate. This finding was highlighted explicitly during the later
review of typical-load suitability; the original raw measurements are unchanged.

The optimization campaign does **not** contain matched short/mixed trials at
1, 2, 4 or 8 concurrent users. Single-user long-context quality controls are not
normal-load performance qualifications. The 16-user/75k workload is a stress
boundary, not a substitute for the actual traffic distribution. Before broader
promotion, compare original and tuned profiles on the same experimental GPU at
those concurrency levels, cold and returning histories, with ordinary reasoning
and tools; use sixteen-user near-75k tests as a capacity regression check.

Both passed the native `record_number` tool call with argument `42`, recognition
of an inline red PNG, and **16/16 arithmetic answers using the normal reasoning
settings**. All sixteen reasoning responses contained reasoning output. The
long-context explicit user-ID/fork check passed **32/32 baseline** and **48/48
candidate** answers after timing; the first baseline trial predates that check.
These are limited functional checks, not a general coding-quality benchmark.
Sixteen simultaneous image-heavy 75k contexts remain unqualified.

The stronger sustained project-number probe scored **13/16 in each of three
candidate trials**. The three misses returned `16`. Exact-input cold serial
controls of those three requests scored **0/3 on the baseline and 0/3 on the
candidate**, with no prefix-cache hits and the same wrong answers. Thus the
failure is reproducible without the new cache policies. The control does not
establish general accuracy parity at sixteen-way concurrency or isolate the
model/prompt cause; the original misses remain part of the evidence.

## Reusable deployment: GPU-qualified for the measured workloads

The profile is
[`qwen38-flash-next-python-opt16-tuned-128gb.yml`](../../models/qwen38-flash-next-python-opt16-tuned-128gb.yml),
with the runtime bundle in
[`tensorfold-python-opt16-v065/`](../../patches/tensorfold-python-opt16-v065/).
It loads no internal profiling hooks; external health, RAM and serving-process
CPU sampling remain active for qualification. Its 225 effective distribution constraints match the
measured baseline and finalist. A private loopback copy completed three
fresh-process GPU qualifications: near-75k capacity, full sustained growth, and
representative/function checks. The public and private copies have identical
serving commands, image, serving environment, mounts and GPU requests; only
operational names, binding, restart policy and test labels differ.

The completed unprofiled capacity trial produced **48/48 full-length replies**
and **16/16 explicit IDs**, with wall times 677.572 / 77.231 / 37.250 s.
Return output overlap was sixteen in both stages. Minimum available RAM during
timing was 7.031 GiB (6.997 GiB during the separate ID check). One return stage
recorded 33 whole-host pageouts, **132 KiB**, with zero observed main-serving-
process CPU VmSwap and complete sampling coverage. It satisfies the declared
bounded criterion, not strict zero pageouts. This is a release qualification,
not an additional matched original/candidate timing pair.

The unprofiled sustained-growth trial also completed **64/64 full-length
replies**, with walls 651.193 / 95.707 / 92.466 / 87.090 s and sixteen overlapping
outputs in every return wave. Its timed minimum available RAM was 8.069 GiB.
The last timed wave recorded 34 host pageouts (136 KiB); main-process CPU VmSwap
remained zero and all four stages satisfy the bounded criterion. The separate
project probe again scored 13/16, with another 13 host pageouts (52 KiB) and
8.115 GiB minimum available RAM. These counter changes remain unattributed.

The final unprofiled representative trial completed **112/112 timed replies**:
short bursts 12.146 / 11.337 / 10.694 s, conversation rounds
72.746 / 13.618 / 13.695 s, and late-arriving-user fairness 47.914 s.
Every timed stage had zero host pageouts and met the bounded criterion.
Native tool arguments, inline image recognition and all sixteen default-reasoning
answers passed. The three exact cold serial known-miss controls again scored
0/3 with the same answers as both earlier controls. Release qualification confirms
that removing internal profiling hooks preserves the observed behavior; its
single trial per workload is not another original/candidate repetition.

Local `docker/` is authoritative: authored YAML/code is synchronized to the
remote machine's own `~/docker/` and executed there. The reference host is not
modified or loaded by these experiments. Both original services are healthy,
the private test container is stopped, and original command, entrypoint, image
and engine/SSD source fingerprints match. The reference container still has its
October 11 start time. See `results/service-audit.json`. The final GPU evidence
audit passed all 308 checks (`verification.json`).

The exact executed private YAML and prequalification public YAML are preserved
under `snapshots/release-*.yml`; the delivered files only update qualification
comments afterward. Resolved serving-command/environment/mount equivalence is
recorded in `profile-equivalence-final.json`. `MANIFEST.sha256` records the final
local oracle artifacts and is verified from the remote `docker/` directory.
The public profile is prepared and synchronized; the original service remains
selected after testing.

## Additional earlier-boundary qualification

The finalist also passed 32/32 replies starting around 65k, crossing 65,536 during
the first 896-token generation, then appending actual generated answers. Cold
wall time was 594.395 s; return time 221.264 s, return TTFT p50/p95 8.467/131.510 s.
The return had 16 overlapping outputs but only 12/16 prefix-hit users (779,802
cached tokens). Observed memory-gate rejections and extra allocations explain a
growth/eviction cliff; this does not support claiming every return takes 2 s TTFT.
Both stages had zero host pageouts/host OOM. Minimum available RAM 7.963/7.825 GiB.
At the end all 16 KV capacities were 75,007 and 16 latest snapshots were retained;
engine memory waits/cancellations were 0. This is a single separate qualification,
not another matched original/finalist timing pair. Upfront reservation of full
KV slots would be a useful future experiment for reducing this transition cost;
it has not been implemented or tested in this candidate.

## Effective dependency audit

A raw last-wins distribution dictionary included inherited system metadata, masking
active versions of Hugging Face Hub, hf-xet, setuptools and wheel. The original
records remain untouched. A live canonical first-path inventory captured 225
effective versions; every earlier measured inventory had the same image, raw
inventory and complete pip install versions, allowing a separately labeled
historical audit with file hashes. `resolved-version-audit.json` records this
proof. Paired eligibility now also checks effective versions. The reusable lock
was corrected before release qualification; no serving/test setting changed.
