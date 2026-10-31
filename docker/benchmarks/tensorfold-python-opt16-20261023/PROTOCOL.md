# TensorFold Python: instrumented sixteen-user optimization

The target is better service for sixteen users with a 75,000-total-token request
limit, preserving image support, the existing model, INT8 KV, MTP and measured
SSD batching unless an explicitly isolated experiment changes one parameter.
Normal production on the reference host is untouched. All test source and YAML
are authored in local `docker/`, synchronized to the experimental host's own
`~/docker/`, and executed there. Private loopback port 8009 excludes normal users.

## Trial design

Begin with the unchanged deployment plus common diagnostics. Each capacity
trial creates a fresh private container/process and runs the frozen historical
sixteen-request cold/return1/return2 sequence: 74,008–74,089 input tokens and
896 output tokens, up to 74,985 total. Fixed assistant branches preserve identical
request bytes. Fresh process means cold text-prefix cache; model/kernel/disk
caches remain warm and no page-cache dropping is performed.

Use the first baseline's actual rejection reasons to choose one candidate.
For a viable candidate target three trials per setting, in order A/B, B/A, A/B
(A=baseline). A cheap screening failure is not promoted to repeated performance
claims. The appendable plan records the chosen order and selected profiles;
completed or partial trial IDs cannot be overwritten. Finalists additionally
run repeated short bursts, sixteen distinct mixed-length conversations with
actual generated answers appended, and four long prefills interrupted by twelve
short users. Every turn is tokenized before dispatch and checked against the
75,000-token total allowance. Synthetic text is not student data.

## Diagnostics and outcome

- Compare identical payload hashes and actual token counts within each fixed
  workload/stage, on the same physical GPU and driver. Confirm initial/final
  idleness, full output budgets, no unrelated requests, OOM or new swap-out.
- Record every user's TTFT, completion latency, generated-token count, mean
  post-first-token time per output token and SSE chunk gap p95/max. SSE chunks
  can contain multiple tokens; their cadence is not per-token latency.
- Correlate tokenizer token-ID hashes with engine enqueue/admitted/first-token/
  finished events. Queue time covers engine enqueue through successful admission.
  Admission-to-first-token is elapsed wall time including interleaving; the
  upstream `prefill_s` is separately reported apportioned prefill work.
- Record exact fixed-budget versus live-memory rejections and required bytes,
  actual CUDA allocated/reserved memory, KV growth, retained snapshots, shared
  buffers, slot capacities, engine activity and real scheduler waiting metrics.
  Component storage counts deduplicate within categories, can overlap between
  categories and do not claim a complete partition of allocator memory.
- Common wrappers preserve original memory decisions and model calculations,
  with no CUDA synchronization. Log diagnostic host time. Comparison settings
  share identical instrumentation; independently recheck a finalist without
  instrumentation before treating it as a production performance result.
- Report per-trial results and ranges, then median paired changes. Three trials
  are a practical repeatability check, not a precise significance or tail-SLA
  estimate. Output overlap, queue times and memory rejection reasons matter
  independently of aggregate tokens/s. Verify tool and image smoke tests.

A candidate should show a consistent useful improvement in capacity, TTFT or
throughput without OOM/swap, degraded correctness or a material regression in
short/returning workloads. Small changes within baseline variation are
inconclusive. The ambition is sixteen overlapping near-full-context outputs;
completion of sixteen queued HTTP requests does not meet that ambition.

## Isolation and recovery

The detached controller holds a process lock, waits for the normal service to
be idle, stops it, and runs only the private test runtime. An independent guard
monitors host available RAM (6 GiB floor), new OOMs and swap-out (>1 GiB abort),
including startup. Any such event invalidates a performance candidate; even
smaller new swap-out invalidates the clean client comparison. On completion,
error or interruption the controller stops its private container, restores the
original Python container and records its health. Original profiles/settings
are not silently changed to experimental values. Keep all raw evidence.

## Primary repeated workload after screening

The primary repeated comparisons use the locally frozen sustained fixture
SHA-256 `74f54138348232995d55ea5afedf6de996ae06b0d3cca6e49d5270ef2321801e`.
It contains sixteen independently seeded project histories and full-length
recorded replies from the original unchanged Python campaign. Four rounds have
maximum input/output totals 71,896 / 72,821 / 73,746 / 74,670 tokens. Every
configuration receives the same request bytes, with the same 896-token output
allowance. This is fixed replay, distinct from live-answer append validation.
The legacy three-round tiny-branch workload remains a continuity/capacity check;
its different rounds are never counted as repetitions of one condition.

Target three baseline/candidate pairs on this sustained workload, alternating
A/B, B/A, A/B, after screening selects a viable candidate. A safety failure
disqualifies that configuration for the affected operating envelope; completed
stages remain diagnostic evidence, not a successful full trial. Do not repeat a
known unsafe configuration merely to manufacture a completed timing comparison.
If a full sequence fails, report that failure rather than assigning an invented
full-sequence speed percentage. Preserve every trial and selected order.

The validation driver records a 30-second idle calibration and per-serving-
process CPU swap/fault counters. Strict clean comparisons retain the original
zero whole-host swap-out label. Tiny background counter changes are additionally
reported with process scope; initial flagged screens are not relabeled clean.
No repeated performance conclusion is based on the diagnostic screens alone.

## Analysis rules frozen before primary baseline dispatch (2026-10-23)

Publish the original strict-zero-host-swap analysis and a separate bounded-noise
analysis. The latter requires complete identical requests/tokens, no unrelated
requests, OOM or safety abort, complete serving-process counter coverage with
zero observed main-process CPU VmSwap, and at most 1 MiB of whole-host swap-out
per stage (256 pages on this host). Keep all raw page counts and both sample
counts visible. This allowance does not prove other container processes never
swapped, and does not relabel earlier screens strictly clean. Completed full
trials are required for a primary performance recommendation.

For altered prefill ordering, fewer simultaneous cold output streams can result
from earlier replies finishing before the final prefills. Distinguish this from
capacity queuing using admission times, active cache slots, scheduler waiting
and completions. Require sixteen overlapping outputs on the sustained return
waves and independently qualify the final profile near 75k. Report cold output
overlap as measured; do not call sixteen admitted requests sixteen simultaneous
generating streams.

The representative wrapper adds sixteen small arithmetic checks without request
overrides of the configured thinking/effort/budget. Native function name/argument
and inline image color checks are retained. These are functional checks outside
the matched four-round performance percentages. Record actual reasoning bytes
and errors; do not claim realistic agent-task accuracy from simple smoke checks.

## Predeclared fallback activated after baseline failure (2026-10-23 23:41 UTC)

The unchanged primary baseline stopped two replies during third-round KV growth
(after 710 and 884 generated tokens). Its first two completed stages remain
diagnostic; the full four-round trial failed, and no full-sequence speed
percentage will be assigned. There was no host OOM/6 GiB guard event. Preserve
raw SSE errors and do not repeat this failed operating envelope solely for timing.

The repeated timing comparison now uses the historical near75k fixed capacity
fixture: three rounds up to74985 input+output tokens, where the unchanged
configuration previously completed48/48. Run three fresh matched pairs A/B,B/A,A/B.
These tiny-branch return timings describe this workload specifically, not the
longer full-reply sustained trajectory. The four-round sustained fixture remains
a separate robustness test: the finalist must repeat its64/64 qualification,
and the unchanged configuration's failure remains a central reported finding.

Plan012 adds a separate explicit agent-ID/fork check after all three unchanged
timed capacity stages in future trials. The already running baseline-capacity-1
is unchanged; baseline repetitions2/3 and candidate repetitions1/2/3 receive
identical functional payloads. This avoids conflating the sustained probe's
benchmark-tag number16 with the project ID. The original13/16 project result
remains recorded; the new check never replaces or changes a timed payload.

The internal bounded_background_noise label is a host-pageout allowance, not
proof of the activity's cause. Tiny host swap changes may be induced elsewhere
by pressure from this workload; only the main serving process CPU VmSwap/fault
counters are scoped here. Preserve both strict and bounded analysis counts.

A separate candidate qualification starts around65k and forces all16 requests
to cross the65536-row KV boundary during generation, then appends their actual
answers for a return wave. Starting around71k had already rounded into the
73728 step, so it does not cover this earlier growth path. This additional
qualification runs between complete primary pairs2/3; it never changes a
primary timed payload or counts as another matched timing repetition.

Effective-version audit correction: inherited image/system distributions can
mask active venv metadata when a plain last-wins dictionary is used. Preserve
that original225-entry inventory and add a separate canonical first-path version
capture. Live candidate3 captures all225 effective versions. Historical trials
are supplemented only when the pinned image, full original inventory and complete
pip install versions match that live reference, with source/log hashes recorded.
All earlier measured inventories passed this evidence check; serving versions
were unchanged. Future inventories capture both views directly. Reusable pip
constraints use effective versions; paired eligibility checks both inventories.

Release qualification includes the four-round sustained replay without profiling
hooks, in addition to near75k and representative cases. Initial74k prompts
already allocate the final KV step, so near75k alone would not exercise the new
early-tail path in the reusable launcher. This is artifact validation, not another
independent primary timing repetition or an unprofiled A/B speed claim.

After representative tests, diagnose the three known project-number misses using
exact original prompt/token hashes, with cold long prefixes and one request at
a time on both configurations and release. This cheap low-load model-ability
control is not a16-way cache equivalence test or a primary timing repetition.
Semantic misses remain recorded; do not assert that prompt ambiguity caused them
until the controls are inspected. Transport/token mismatches remain hard errors.
