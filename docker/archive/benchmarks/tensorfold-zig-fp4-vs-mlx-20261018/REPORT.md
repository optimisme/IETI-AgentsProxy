# NVIDIA FP4 / TensorFold Zig versus the current MLX service

18 October 2026. Local `docker/` is the configuration source; the candidate YAML
was copied to the remote `~/docker/models/` and launched there with Compose.

The candidate improves the two clean 16-user code-decode cohorts, but it is not
a general performance upgrade for this classroom workload. Conversation
continuation has substantially higher first-token latency. Keep the MLX profile
as the course default while the Zig profile remains experimental.

## Configurations

| | Baseline, machine 2225 | Candidate, machine 2226 |
|---|---|---|
| Checkpoint | `TensorFold/Qwen3.8-Flash-Next-MLX-4bit-MTP` | `nvidia/Qwen3.8-Flash-Next-FP4-Local` |
| Revision | `2b170fa6309d5d1ee380b35636075fac7945f286` | `b9ce18a6887e18c089fdea8509a33e63429a3300` |
| Engine | Python 0.6.5, `609ca419abecebdc5a059498a613680bd3aa847f` | Zig, TensorFold `db281878ddb836fd0df510d8771ecb7e0fe47d26` plus pinned MiaAI patches |
| Local/custom behavior | KEEP=64, SSD cross-stream batching | Recipe MTP tuning and tiled prompt experts; fair prefill **off** |
| Context / streams | 75000 / 16 | 75000 / 16 |
| KV / n-grams / vision | int8 / SSD / enabled | FP8 / SSD / enabled |
| GPU / driver | GB10 / 580.142 | GB10 / 580.159.03 |

The candidate recipe is pinned to
[`656879fd752749bbd11a6e1a065a326c00940911`](https://github.com/MiaAI-Lab/Qwen3.8-Flash-Next-Single-DGX-Spark-TensorFold/tree/656879fd752749bbd11a6e1a065a326c00940911).
Its patches' concatenated SHA-256 is
`168ed7c1d8b6c9dc22c02bec6ad5e5e9f21ec93ff3556b69970ed8c1578a24f7`.
The standalone profile builds and caches the runtime because the published image
did not contain these FP4 patches. The 320-kernel AOT build passed its upstream
checks; 101 cubins matched the capture byte-for-byte (other cubin hashes may
differ across build environments, as allowed by the upstream preparation script).

Both server defaults enable low-effort thinking with a 1024-token budget and
temperature 0.1. Measured requests explicitly use **thinking off, temperature 0**,
the same prompts, top-k/top-p, and fixed output lengths, so these results do not
measure full reasoning-agent task completion or coding quality.

## Clean performance observations

Rates are **output usage tokens / whole-cohort wall time**, including prefill.
They are not the sum of per-stream decode speeds. TTFT is first generated text.

| Workload | MLX baseline | FP4 / Zig | Observation |
|---|---:|---:|---|
| 1 code request, two trials | 49.3 / 49.1 tok/s | 55.0 / 67.8 tok/s | Faster in both |
| 16 code requests, two trials | 285.9 / 322.2 tok/s | 361.4 / 358.2 tok/s | +26.4% / +11.2%; about +18% using mean cohort rates |
| 16 prose requests, one clean pair | 234.3 tok/s | 235.8 tok/s | Essentially level |
| 4 prose requests, one clean pair | 128.5 tok/s | 93.0 tok/s | Candidate slower |
| 16 conversation continuations, median TTFT | 1.21 s | 6.57 s | Candidate latency regression |
| Same continuations, aggregate output rate | 125.0 tok/s | 120.0 tok/s | Similar total completion throughput |

The continuation input/cache token totals are similar, so the first-token
regression should not be attributed simply to fewer cache hits. Scheduling and
prefill/decode interaction also matter; this experiment does not isolate them.

Tool calling (forced function and argument) and image recognition (solid red PNG)
passed on both servers. Video input was configured but not exercised.

## Other observations, with external traffic

All these results remain in the raw files and are excluded from clean performance
pairs in [comparison.json](comparison.json):

- Cold 16k prompt TTFT: 6.78 s baseline versus 6.99 s candidate; candidate overlapped
  one other inference request.
- Cold 65k prompt TTFT: 29.19 s versus 29.60 s; baseline overlapped one other request.
- Returning to an earlier turn: baseline reused 131075 prompt tokens; candidate
  reported zero. Median TTFT was 0.62 s versus 8.13 s, and cohort completion time
  11.30 s versus 67.83 s. Two external requests overlapped the candidate cohort,
  so this is an observed cache result and a contaminated latency comparison,
  not an isolated causal measurement of its cache policy.

## Memory and near-75k capacity

The FP4 weight index declares 102138950916 bytes (95.1 GiB on disk). The n-gram
table is read from SSD. Download size is not resident weight memory. On the final
candidate start, the engine reported a **25.81 GiB sequence pool**, after keeping
**10 GiB free plus 2 GiB for vision workspace**. The earlier fair-prefill start
reported 27.21 GiB; the pool is sized from available memory at each startup.

The recipe's FP8 row accounting estimates about **20 GiB for 16 x 75000 tokens**.
Fixed sequence state, allocation granularity, scratch and retained prompt states
also consume memory. Pool arithmetic is not proof of simultaneous residency.

The capacity cohort sends 16 independent requests, each with 74005-74006 input
tokens and a 256-token reply (about 74.3k total, below the configured 75k limit).
It runs after the conversation cohorts without clearing retained state. The
baseline completed 16/16 in 591.34 s, median TTFT 482.06 s, minimum available host
memory 8.20 GiB, and no OOM kill. It swapped out 170118 host pages and overlapped
10 external requests. Its throughput is excluded from clean performance claims.

The candidate also completed **16/16**, with every reply reaching 256 tokens:

| Capacity observation | MLX baseline | FP4 / Zig |
|---|---:|---:|
| Cohort completion time | 591.34 s | 568.20 s |
| Median / p95 TTFT | 482.06 / 540.84 s | 288.64 / 520.51 s |
| Minimum host MemAvailable | 8.20 GiB | **11.67 GiB** |
| New swap-out pages | 170118 | **0** |
| OOM kills | 0 | 0 |
| Other completed inference requests in the same interval | 10 | 9 |

This is evidence that the FP4 checkpoint and this **16-request near-75k burst**
fit without new swapping or an OOM on the tested host. It does **not** establish
sixteen full 75000-token KV windows resident simultaneously, sustained multi-turn
capacity at that size, or image/video capacity under load. The requests were text
only, with vision enabled. Queueing and prefill serialization were observed.
The candidate's stream-cache occupancy metrics did not establish simultaneous
full-window residency. Both capacity timings remain excluded from clean speed
claims because of external traffic (and baseline swapping).

Across the primary campaigns, all **284 measured requests** completed with their
full output budget (142 per configuration, excluding the separate smoke tests).
There are eight clean performance cohort pairs; all other pairs remain visible
with exclusion reasons in `comparison.json`.

## Fair-prefill diagnostic

The initial `TF_FLASHNEXT_FILL_FAIR=1` variant was stopped during its final code
cohort. Completed cohorts are preserved in
[fair-prefill-2226-partial](fair-prefill-2226-partial/variant.json). It did **not**
complete a capacity test and must not be presented as a complete campaign.

Its clean four-request prose cohorts measured 72.8 and 65.2 tok/s, with median
TTFT around 2.9 s. The corresponding default-scheduling observations were 110.9
and 93.0 tok/s, with TTFT around 0.22 s. These are separate starts on the same
candidate host. Fair prefill remains opt-in as `TENSORFOLD_FAIR_PREFILL=1`; the
profile follows the recipe default of off. No checkpoint was changed to INT4.

## Reproduction and limitations

[benchmark.py](benchmark.py) runs on each inference host against loopback, so the
SSH tunnel's latency is outside the measurement. [fixtures.json](fixtures.json)
was generated once with the baseline tokenizer. Its SHA-256 is
`d7d055f5c21f7cf1500eb9c46b37d2139928346d4ff199ea3ea7283ccb2533d9`.
Request-body hashes exclude only the intentionally different model ID and are
checked by [analyze.py](analyze.py). Native health/metrics normalization was added
after baseline collection; generation payloads and workload order were unchanged.

Run from this benchmark folder on each server:

```bash
python3 benchmark.py bench --out results --fixtures fixtures.json
python3 benchmark.py capacity --out results --fixtures fixtures.json
```

Raw per-request text/reasoning, token usage, timing, errors, memory samples and
server counters are retained under `baseline-2225/` and `candidate-2226/`.
Different physical hosts/drivers, the baseline's existing retained state, small
trial counts, synthetic histories and ongoing external traffic limit conclusions.
No significance, model-quality or sixteen-full-windows-resident claim is made.

The new Compose file, its actual Bash launch command and embedded Python blocks
passed local validation. The broader existing Compose-profile test is blocked by
the pre-existing missing `docker/models/.strata-q2_0.env`; it did not establish a
failure in the new profile.

## Final service state

The original MLX container was restored on 2226 after testing. Both machines are
healthy with the original model ID, 16 streams and a 75000-token context limit;
2225 was never restarted. A generation smoke check on restored 2226 returned
`OK`, and its installed engine/SSD-batching source hashes match the baseline.
See [restoration.json](restoration.json).

The experimental FP4 container is **stopped**, with its downloaded checkpoint,
compiled runtime and kernels preserved. Its YAML remains available on both
machines under `~/docker/models/`. No proxy/provider settings were changed.
