# Typical-load original versus opt16 qualification — declared before GPU runs

Local docker/ is authoritative; execute synced files only in remote ~/docker/.
Use experimental GPU only; reference host read-only, no inference load or changes.
Stop normal experimental service for isolation, restore it on success or failure.
All variants retain context75000 and parallel16. Active request counts vary.

## Frozen design

Three fresh-process pairs, A/B, B/A, A/B. Each pair uses the same request bytes,
token IDs, case order, pinned image/source/checkpoint/dependencies, GPU and common
launcher/external observer. Baseline retains original KEEP64 and SSD patch; tuned
adds exactly the previously qualified memory/snapshot/tail/order64 policies.
Both omit internal profiling hooks. Disk/model/kernel caches stay warm; text
prefix state starts empty in every process. Thirty seconds idle calibration.
Serving port8009 loopback. Proxy/WAN/network overhead excluded. No production
traffic is allowed into the private API.

First repeat the exact earlier short16 warmup and mixed16 requests, including
frozen original full replies, to investigate the known warm-turn TTFT regression.
Their request hashes are asserted against old original receipts. This diagnostic
has a 65k outlier and is separate from typical-load primary cells.

Then concurrency1,2,4,8 (order reversed/rotated by pair): three distinct short
code cases, ~2k and ~8k homogeneous histories and a mixed ~16k/~2k/~8k roster,
each with cold plus two returning turns. At concurrency1 the mixed case is one
~16k history. Returning inputs replay full 128-token original Python answers;
they are fixed inputs, not each current run's generated answers. Context sizes
are approximate and actual tokenizer counts/hashes are recorded. No claim of
student-traffic prevalence: workloads are synthetic fictional project logs.

Fixed timing uses temperature0, seed180026, reasoning off and exact256 (short)
or128 (conversation) output tokens, ignore_eos=true. Separate reasoning/code-
arithmetic and tool cohorts preserve normal thinking/effort/budget, temperature0
for determinism, max_tokens1200 and normal EOS. Output lengths and correctness
are reported, not treated as fixed-output throughput. Actual native tool-result
continuations use generated calls/IDs: functional/live evidence only, excluded
from fixed-input paired timing if hashes differ. Semantic misses do not erase
other performance cohorts; transport errors abort the trial and remain recorded.

## Metrics and eligibility

Per-user first SSE output and first content, completion, output count, mean
post-first-token time/output token, SSE p95/max gaps; case wall/throughput,
cache hits, active/queued counts, RAM, host pageouts, main CPU VmSwap and GPU
clock/temperature. SSE chunks can hold multiple tokens. Runtime inventory must
match at all225 effective versions and41 engine source files; variant env and
hook implementation differ intentionally. Externally measured cold/returning
state is described per case; no internal hook timing is inferred.

Report every pair individually and median paired percentages/ranges by cell.
Do not merge different contexts or cohorts as repetitions. Strict subset: zero
host pageouts. Predeclared bounded subset: <=1MiB host pageouts per case, complete
main-process sampling with zero observed CPU VmSwap, zero OOM/unrelated requests/
incomplete SSE; fixed outputs exact; no safety abort. One-second CPU sampling
coverage permits2s at each case edge. Independent guard aborts below6GiB host
available, new host OOM or >1GiB new pageouts per trial. Max120min/trial.

Deployment decision: inspect absolute and relative latency, not total time alone.
Flag repeated first-token or completion regressions exceeding both10% and0.2s;
report other metrics/tradeoffs rather than asserting universal non-regression.
Three pairs describe repeatability, not a confidence interval or a production
p95 SLA. Normal reasoning/tool samples have variable output counts and separate
quality checks. Retain original reference while unresolved typical-load regressions
remain. Prior sixteen-user near75k trials are capacity evidence, not typical-
load evidence; no new code or production rollout is included in this matrix.

## Amendment before any tuned GPU comparison

The first original-pair1 run is a preserved pilot, excluded from every primary
matched comparison. Its reasoning fixture inadvertently included the old log's
"Summarize its engineering risks" instruction alongside the final integer task.
Observed answers summarized the log, sometimes also computing the right integer;
its strict-format failures must not be presented as a tuned-engine regression.
Snapshot fixtures-pilot-v1.json and plan-pilot-v1.json preserve the original bytes.
Fixture revision2 uses raw log rows without that conflicting instruction. All
short/context/mixed/tool and exact old16 diagnostic payloads stay byte-identical.
The controller finishes the running pilot, then executes six new fresh-process
IDs suffixed -clean, A/B, B/A, A/B. Only those six plan IDs enter the primary
analysis. The pilot remains an additional complete or partial diagnostic run.
No executing client source or currently loaded pilot payloads are modified.

Tokenization is validated via /tokenize before timed dispatch. That can warm the
CPU tokenizer memo; cold means empty relevant GPU prefix state, not a cold CPU,
model, kernel or filesystem cache. All variants use this same preparation.
Cohort p95 at1/2/4/8 users is a small-sample interpolated observation, not a
production tail-latency estimate. The same finite cases are repeated in three
fresh processes per variant; different short cases are not additional trials.

Within a fresh process, caches carry over between workload blocks: exact old16
diagnostic first, then the lower-concurrency matrix. Cold per-cell means no
matching relevant prefix, with other cached histories retained. Case order is
identical within each pair and reversed/rotated between pairs. These results do
not establish an isolated fresh restart for every user-count/context cell.
