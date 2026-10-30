# Python optimization for sixteen users — experiment in progress

The eager-final-tail memory candidate completed the four-round sustained screen
(64/64 replies), with sixteen overlapping output streams in every round and more
than 8 GiB available RAM. A separate prefill-order screen is running; three paired
primary comparisons and uninstrumented qualification are still required.
The normal service is isolated during tests and automatically restored afterward.
The reference host is untouched. See `PROTOCOL.md` for the comparison rules.

## First observed admission cause

Thirteen long prompts were admitted. A fourteenth was rejected by the **live
memory** branch, while the fixed cache-growth budget still allowed its resize.
One recorded decision asked for 1,473,853,056 bytes plus the unchanged
2,147,483,648-byte growth reserve, with only 3,472,854,221 live bytes reported
by the original gate. These are original decisions, not reconstructed estimates.

Source `cuda/capacity.py::available_bytes` subtracts a default floor of ten
percent of the unified host's memory (about 12 GiB on this machine); the runtime
MemoryGate additionally keeps 2 GiB. CUDA allocator reusable bytes also affect
the live value. The baseline has ~98.1 GiB allocated to CUDA at this point,
including ~16.6 GiB of growing context caches. Diagnostics distinguish cache
capacity from model/stream state and shared scratch allocations.

The first candidate changes the supported upstream
`TENSORFOLD_MEMORY_RESERVE_GIB` setting to 8. It retains the original INT8 KV,
MLX checkpoint, KEEP64, MTP6, vision, SSD batching and prefill settings. This
setting affects upstream startup/runtime budgeting and host staging reserves;
it is not a change to precision or model math. The runtime growth reserve and
independent 6 GiB host-RAM abort guard remain active. Whether the change safely
admits sixteen contexts and improves latency must be measured, not assumed.

Candidate screening follows the first baseline; any viable finalist will be
repeated against the baseline in alternating pair order. Read
`results/<run>/client/`, `engine.jsonl`, `prometheus.jsonl` and `runtime.log` for
raw evidence. Failed or partial trials are preserved. `analysis.json` is a
read-only generated summary; incomplete trials are labeled accordingly.

## Initial baseline screening record

`baseline-1` completed all sixteen cold requests in 646.74s, with fourteen
overlapping output streams, no OOM and 9.54 GiB minimum host available RAM.
The host recorded one swap-out page (4 KiB), so the cohort is excluded from
strict clean performance comparisons. All sixteen tokenizer hashes matched
engine traces. Queue p95 was 547.96s. The historical 13-stream peak is therefore
an observation, not a hard admission ceiling.

The initial client treated any nonzero swap-out counter as an assertion failure
and prematurely ended the whole sequence. Its exact source is archived in
`snapshots/run_suite-v1.py`; the original service was automatically restored.
The corrected client still excludes flagged cohorts from clean comparisons,
but continues later independent diagnostic stages. The independent OOM, host
RAM and >1 GiB swap-out abort conditions are unchanged. This correction was
made before testing any candidate. Controller-session recovery records are
archived under `sessions/`; partial data are never overwritten.

A separate, not-yet-executed coalescing candidate is prepared. It skips a later
snapshot only when a compatible earlier snapshot exists on the same slot
within 256 tokens, keeping a resumable prefix at the cost of at most 255 extra
prefill tokens. It retains KEEP64 and does not merge different users' states.
It will be screened separately if memory traces justify it; no result is
assigned to that patch yet.

## Reserve8-only screening: rejected

`reserve8-screen1` admitted all sixteen near-74k prompts within ~3.2s and
completed all sixteen 896-token cold replies with sixteen overlapping output
streams. Cold wall time was 623.62s, TTFT p50/p95 542.71/543.09s and minimum
available host RAM 6.54 GiB. The host recorded 39 swap-out pages (156 KiB), so
this is not a clean timing percentage comparison. No OOM occurred.

During the first returning round, the independent guard observed 5.54 GiB of
available RAM and stopped the private GPU container. Thirty-two retained
snapshots accounted for about 3.45 GiB before the new turn's snapshot growth.
The lower reserve alone is rejected: cold completion does not qualify it for
sustained sixteen-user service. The normal Python service is restored by the
controller. Source, events, the guard trigger and partial data are retained.

The next screen uses versioned `instrument_paired.py`: it additionally samples
between prefill passes, records retention positions and fingerprints itself.
The initial round-end sampler had long gaps when all sixteen requests filled
inside one worker round. Independent RAM guarding and Prometheus sampling
continued throughout. Primary repeated comparisons will use the same corrected
diagnostics on both baseline and candidate; the initial screens are diagnostic
evidence rather than the repeated performance result.

## Sampler startup retry and next validation

The first coalescing attempt (`reserve8coalesced-screen1`) ended during CUDA
warmup because a new diagnostic comprehension referenced `self` instead of its
`owner` argument. No benchmark API requests ran. The faulty source is archived
in `snapshots/instrument-paired-startup-bug.py`, and the normal service recovered.
The corrected root scripts pass Ruff undefined-name checks. Retry
`reserve8coalesced-screen2` uses a new run directory and records the corrected
instrumentation SHA-256 at startup. This is a harness failure, not a measured
retention-policy result.

`run_sustained.py` prepares a stronger screen: sixteen independently seeded
project logs (~71k input tokens), three returns with full 896-token recorded
assistant replies, and a 896-token allowance on every round. All four stages
are tokenized before timing and must fit 75k total tokens. The reference replies
come from the unchanged original Python campaign; their source hashes are
preserved in `sustained-responses.json`. This is fixed replay with realistic
reply lengths, not a claim that each current answer is appended live. Separate
representative tests in `run_suite.py` do append current answers. Inputs will be
frozen locally before repeated baseline/candidate comparisons.

The future validation driver additionally records the private serving process's
VmSwap, faults and CPU time, and a 30-second idle calibration. Whole-host swap
counters remain recorded and the original strict zero-swap label is retained;
background versus inference-process changes will be reported separately. This
does not retrospectively relabel the initial flagged screens as clean.

## Coalescing screen completed, sustained qualification pending

`reserve8coalesced-screen2` completed 48/48 replies with sixteen overlapping
outputs in every round. Cold/return1/return2 wall times were 617.01/78.54/37.42s;
TTFT p50 was 541.20/2.35/2.12s. Cold and second return had zero swap-out; the
first return recorded one whole-host 4 KiB page. There was no OOM or guard abort.
RAM minima were 7.55/6.54/6.35 GiB. The first trial is encouraging, not a repeated
performance recommendation. The record still has little margin above the guard.

The next screen (`reserve8adaptive-sustained-screen1`) uses four distinct-history
rounds with full-length recorded replies. Its separate adaptive candidate keeps
the coalescing policy, removes oldest extra checkpoints only under low live
headroom while retaining at least the newest checkpoint of every retained slot,
and returns unused CUDA allocator blocks when host available RAM falls below
9 GiB. The pressure target includes 2 GiB above the upstream growth reserve,
covering a measured ~1.72 GiB sixteen-snapshot allocation wave. Allocator trim
and eviction counts, reclaimed bytes and host wall times are recorded. No active
model/cache tensor is explicitly freed. These mechanisms are not yet qualified.

## Sustained adaptive screen: late-allocation failure

`reserve8adaptive-sustained-screen1` completed its first three rounds, all with
sixteen overlapping output streams: 600.68 / 95.41 / 95.77s. RAM minima were
9.28 / 9.09 / 6.15 GiB. Two whole-host swap-out pages were recorded across the
returning rounds; serving-process CPU VmSwap remained zero. The fourth round
was stopped at approximately 5.9 GiB available RAM, before OOM. This candidate
is rejected for sustained qualification despite completing its first 48 replies.

The third round contained sixteen KV resizes from 73,728 to 75,007 rows. CUDA
allocation grew from 103.3306 to 103.5747 GiB, while reservation grew from
103.9297 to 107.4141 GiB. At the failed fourth admission, empty_cache returned
no reserved bytes. These observations identify a cache-growth/reservation
problem; they do not yet distinguish allocator fragmentation from graph pools.
The next common sampler records inactive-split/active allocator statistics.

The eager-tail screen allocates the last partial 8,192-row step upfront. For
this context it pads 73,728 to 75,007, about 0.35 GiB across sixteen slots,
without increasing the allowed request length. It retains all preceding model
and memory settings and avoids the measured late resize. Only after this
passes will a separate prefill-order increment be screened.

## Eager final KV tail: stronger screen completed

`reserve8tail-sustained-screen1` completed 64/64 outputs of 896 tokens on four
frozen rounds of sixteen independent histories. Wall times were
600.083 / 96.033 / 93.377 / 87.555 s; TTFT p50
516.751 / 9.963 / 8.678 / 7.092 s. Output overlap was sixteen every round.
Available RAM minima were 8.357 / 8.039 / 8.018 / 8.042 GiB. No OOM or guard trip.
Tiny whole-host pageout flags remain in the raw tables; main-serving-process CPU
VmSwap stayed zero. This is a screen, not an independent repeat of the baseline.

The policy allocates the final partial KV step upfront (73728→75007), avoiding the
late sixteen-resize wave observed in the failed preceding screen. It uses the
same INT8 KV and model weights, so the improvement is in allocation/retention
behavior rather than a quantization change. CUDA allocator statistics now record
inactive-split bytes; reserved-minus-allocated alone does not identify its cause.

## Unchanged baseline failed the stronger trajectory

`baseline-sustained-1`: cold16/16 in614.860s; first return16/16 in487.129s.
Third round14/16: the engine cancelled two replies after710/884 generated tokens
while growing73728→75007-row KV buffers. Its memory gate reported insufficient
live headroom; CUDA allocator `num_ooms` stayed0 and hostOOM count stayed0.
The host6GiB safety floor did not trigger (stage min11.050GiB). These are protective
engine memory failures, not a hostOOM kill. Keep both raw SSE error messages.

Plan011 activates the documented fallback: three fresh matched timing pairs on
the earlier successful near75k legacy workload. Candidate sustained stability is
qualified separately with two additional fresh full four-round runs. No total
sustained-four-round speed percentage is valid against this failed baseline.

## Repeat variability has a measured cache correlate

The fresh safe baseline `baseline-capacity-1` completed cold16/16 in642.41s
(previous unchanged capacity run644.91s). First return was407.906s with518052
cached tokens and7/16 cache-hit users; the earlier445.983s run had444046 cached
tokens (about six histories). This is evidence that retained-prefix variation
contributes materially to return timing variation. It is not an isolated raw
CUDA decode comparison, and three fresh matched pairs are still required.
