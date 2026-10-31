# TensorFold Python: sixteen near-75k contexts on one GB10

The isolated GPU test completed **48/48 requests**, each with 896 output tokens,
without OOM, new swap-out, unrelated inference or supervisor intervention.
However, the current Python deployment **did not demonstrate sixteen
simultaneously generating near-full contexts**: maximum overlapping output
streams were **13, 11 and 10** across the three rounds. The engine admitted at
most 13, 12 and 12 decoding/prefilling streams, respectively, and queued requests.
This qualifies successful completion of sixteen submitted requests with
queueing, rather than sixteen simultaneously active full contexts.

The matched vLLM deployment reached sixteen overlapping output streams in all
three rounds. Python was slower on the cold and first returning batches, and
faster on the second returning batch. The earlier short-prompt throughput
advantage does not establish an advantage at this context occupancy.

## Results against the completed vLLM run

Each row is one matched cohort, not repeated independent trials. Wall time
includes prefill, queueing and generation. Percentages are Python relative to
vLLM; negative time changes mean Python was faster.

| Stage | Python wall | vLLM wall | Time change | Python output tok/s | vLLM output tok/s | Throughput change | Output overlap Python / vLLM |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Cold | 644.91s | 531.88s | +21.25% | 22.23 | 26.95 | -17.53% | 13 / 16 |
| First return | 445.98s | 432.58s | +3.10% | 32.14 | 33.14 | -3.00% | 11 / 16 |
| Second return | 375.23s | 418.40s | -10.32% | 38.21 | 34.26 | +11.51% | 10 / 16 |

| Stage | Python TTFT p50 | vLLM TTFT p50 | Change | Python TTFT p95 | vLLM TTFT p95 | Change |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Cold | 439.50s | 219.28s | +100.43% | 592.86s | 387.24s | +53.10% |
| First return | 157.57s | 117.28s | +34.35% | 384.82s | 285.20s | +34.93% |
| Second return | 91.96s | 142.15s | -35.31% | 340.93s | 308.71s | +10.43% |

| Stage | Python cached input tokens | vLLM cached input tokens | Python minimum available RAM | Engine active peak | Observed waiting peak |
| --- | ---: | ---: | ---: | ---: | ---: |
| Cold | 0 | 0 | 11.33 GiB | 13 | 3 |
| First return | 444,046 | 295,936 | 12.50 GiB | 12 | 13 |
| Second return | 518,331 | 220,192 | 12.64 GiB | 12 | 11 |

Python reports more prefix reuse in the returning rounds. This is consistent
with its better second-return result, but the experiment does not isolate
prefix reuse as the only cause. All three Python p95 first-token times were
higher than vLLM's. Engine active/waiting peaks occur at potentially different
moments; the cold waiting observer started partway through that cohort.

All 48 request hashes excluding only `model` match the earlier vLLM requests,
and actual tokenizer counts match exactly. All 43,008 requested output tokens
were generated. No round demonstrated sixteen overlapping Python output
streams. These percentages compare equal submitted workloads including each
runtime's queueing, rather than equal resident concurrency. One cohort per
stage does not establish statistical significance or production tail latency.

For a strict requirement of sixteen concurrent near-75k generating contexts,
vLLM currently has the stronger direct validation. Python remains faster in
the earlier short-prompt benchmark (328.46 versus 156.61 aggregate output
tokens/s); this test does not justify one universal performance winner or an
automatic production switch. The existing Python service is restored after
the experiment; final runtime evidence is recorded below.

## Configuration and isolation

The test uses the existing customized TensorFold Python 0.6.5 deployment:
MLX affine 4-bit weights, INT8 KV, MTP6/confidence 0.60, KEEP64 retained prompt
snapshots, batched SSD gathers and vision enabled. Context is 75,000 total
tokens per request, with sixteen configured streams. No inference optimization
or model-setting change is introduced by this experiment.

The first attempt on the normal API was interrupted after unrelated requests
arrived. Its partial data under `python-current/` is excluded. The original
runtime recovered successfully before starting the isolated test.

The private test profile changes only Docker project/container identity, host
port publication (loopback port 8009) and restart policy. It reuses the existing
model and kernel cache volumes while the normal service is stopped. The
installed CUDA-family Python source hashes, image ID, selected environment,
entrypoint and complete serving command match the original container.
Credentials and resolved secret environment values are not captured.

The canonical profile remains the local
`models/qwen38-flash-next-tensorfold-vontra-mlx-4bit-mtp-int8-ssd-vision-128gb.yml`.
The isolated profile is
`models/qwen38-flash-next-python-capacity16-private-test-128gb.yml`.
Local `docker/` files are authored first, synchronized into the experimental
host's own `~/docker/`, and executed there. The reference host is untouched.

## Matched workload

`probe.py` is an unchanged copy of the client used for the completed vLLM 0.32
FP8/MTP-off experiment. It uses the same frozen fixture, `tuned16-full` request
tag, sixteen independent leading agent tags, temperature 0, seed 180026,
top-k 20, top-p 0.95, thinking disabled and 896 generated tokens per request.
Every comparison checks hashes of the complete request JSON excluding `model`.
"Cold" means no retained text-prefix hits in the fresh test process. Model,
compiled-kernel and filesystem caches were reused; this is not a cold-disk test.

| Stage | Maximum input tokens | Output allowance | Maximum total |
| --- | ---: | ---: | ---: |
| Cold | 74,009 | 896 | 74,905 |
| First return | 74,049 | 896 | 74,945 |
| Second return | 74,089 | 896 | 74,985 |

Returning turns use fixed assistant text, branching from each prior prompt
rather than replaying the actual generated answer. This preserves identical
inputs across runtimes and exercises retained prompt waypoints. It does not
directly measure a client appending the entire generated response. All sixteen
histories use the same long fixture with distinct leading tags; diverse model
weight working sets and sixteen simultaneous image requests are outside scope.

Both deployments run on the same experimental GB10 host, at different times.
Python uses the deployed MLX checkpoint and INT8 KV, while vLLM used Inferact
NVFP4 weights, FP8 main/indexer caches, FP32 recurrent states and MTP off.
This compares deployments, not Python versus another implementation language.

## Interpreting the queue

The configured maximum and the health endpoint's frontend running count can
both reach sixteen while fewer streams are admitted to the CUDA engine.
The output intervals, engine stream counts and independent waiting metric
therefore matter more than the number of accepted HTTP connections.

The installed engine has explicit memory-gate checks when growing KV buffers,
including temporary copy capacity, and makes new streams wait when existing
streams already await memory. The deployed profile also retains prompt
snapshots, MTP state and vision workspace. This is evidence of relevant
admission mechanisms, not an allocation breakdown proving which one caused
the observed queue. Source excerpts are in `admission-source.txt`.
The external supervisor's 6 GiB host-RAM guard was not reached in the completed
cohorts. Available host RAM alone does not establish how much an additional
CUDA stream can safely allocate.

Consequently this experiment cannot attribute the active-stream difference
solely to INT8 versus FP8 KV, nor establish a physical sixteen-stream limit
for the hardware. A controlled allocation/admission experiment would be the
next step before changing precision, snapshot retention or memory guards.

## Qualification and safeguards

Completion of queued requests alone does not prove sixteen simultaneous full
contexts. The record includes full output counts, exact tokenizer bounds,
overlapping output intervals and the Python engine's decoding/prefilling counts.
Unrelated inference, initial/final running counts, swap-out, OOM and host RAM
are monitored. Clean timing percentages require matched inputs and no unrelated
requests, swap-out or OOM in either cohort.

Python's health endpoint does **not** expose preemption or waiting counters.
The frozen client defaults those fields to zero; these are not observed zero
measurements. An independent observer additionally captures the actual
Prometheus running/waiting counts, live cache entries and `preemptions_total`.
The latter counts CUDA scheduler lane yields. It started partway through the
cold cohort; its timestamps and coverage are recorded. Output overlap is
measured by the frozen client over the entire cohort.
Source inspection confirms that the `pool` labels enumerate live streams, and
their ratios use the declared prompt/context length. They do not expose actual
allocated cache bytes or independently prove physical residency during prefill.

The independent supervisor stops the test runtime if host available RAM falls
below 6 GiB, more than 1 GiB of new swap-out occurs, an OOM is observed, or the
client fails. It restores the normal Python container afterward, including
after failure. The shell controller provides a second restoration handler.
The profile, source hashes, controller logs and final health records preserve
the experiment's provenance.

## Final runtime state and evidence

The isolated supervisor finished with client exit code 0, `aborted: false` and
`healthy_after_test: true`. The outer controller also exited 0 and wrote
`isolated/python-restored` = 1. The private test container is stopped and was
not OOM-killed. The normal Python service on the experimental host is healthy
again with sixteen configured streams and a 75,000-token limit; its restored
start time is `2026-10-23T20:49:27.89469311Z`.

The reference host remains healthy with its original start time
`2026-10-11T12:08:52.452616778Z`. Both hosts' serving command and entrypoint
hashes match the original recorded command. The restored experimental
runtime's 37 CUDA Python source files also match the tested files exactly.
`final-2225.json`, `final-2226.json` and `restored-installed-source.json`
record these checks. No inference settings were changed on either normal
deployment. Changes to the canonical local YAML after the test only annotate
the measured capacity result; the exact original profile is preserved as
`python-profile-snapshot.yml`.

`comparison.json` is generated by `analyze.py`. It checks completion, exact
request hashes, tokenizer bounds, clean comparison conditions and observed
output overlap against the completed vLLM campaign. Raw request/monitor data
are under `isolated/python/`; `isolated/engine-metrics.jsonl` records the
independent observer. Use `isolated/controller-result.json` for the completed
experiment: the campaign-root controller result describes the deliberately
discarded shared-port attempt. `manifest.json` records checksums and outcome.
