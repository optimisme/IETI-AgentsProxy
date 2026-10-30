# INT4-AutoRound with the unchanged Zig engine

18 October 2026. Experimental profile:
`models/qwen38-flash-next-tensorfold-zig-autoround-int4-mtp-fp8-vision-128gb.yml`.
Local `docker/` is the source of truth; the profile was copied to the remote
`~/docker/models/`. The original 2226 service stays online during downloading
and is restored after testing. Machine 2225 is not restarted.

## Controlled changes

The checkpoint is `azampatti/Qwen3.8-Flash-Next-125B-A5B-INT4-AutoRound`, revision
`1464274120d36a4d8fcaa934552334a7d83ce0fd`, the INT4 revision selected by the same
pinned MiaAI recipe used for FP4. It has GPTQ-format 4-bit weights and an FP8
n-gram table loaded on the GPU. The complete repository download at that revision
is **121.85 GiB**, according to the Hub's file metadata; the safetensors index's
`total_size` is not used as an actual download or resident-memory measurement.

The serving command and tuning environment are identical to FP4. Only `MODEL_ID`
and `MODEL_REVISION` differ in the service environment. Preparation validates
GPTQ/INT4 and the n-gram files instead of NVFP4, and uses the recipe's 93 GiB
INT4 startup-memory check. The engine still keeps its 10 GiB reserve and 2 GiB
vision workspace. Context is **75000**, streams **16**, KV **FP8**, MTP depth **6**,
product-confidence threshold **5**, fair prefill **off**, vision enabled,
temperature **0.1**, low reasoning effort and thinking budget **1024** by default.
Measured requests explicitly disable thinking and use temperature zero.

The installed native executable, AOT assets and Python helper sources were copied
into exclusive INT4 caches and compared byte-for-byte: **728 files match**.
The native executable SHA-256 is
`2a34b24a396c8186e998cb4fe5ae1903ac951e83452d13a99168da90b1de4462`, matching the
earlier FP4 test. See [engine-equivalence.json](engine-equivalence.json) and
[validation.json](validation.json). No source patch, MTP retuning, scheduling
change or prompt-cache change was introduced for INT4. The same engine selects
its checkpoint-format-specific execution paths automatically.

## Protocol and references

[benchmark.py](benchmark.py) and [fixtures.json](fixtures.json) are byte-identical
copies from the preceding FP4 campaign. Both hosts run clients against loopback.
The fixtures SHA-256 is
`d7d055f5c21f7cf1500eb9c46b37d2139928346d4ff199ea3ea7283ccb2533d9`.
The same 126-request decode/prefill/conversation campaign is repeated, plus a
16-request near-75k capacity cohort on the INT4 host. Tool and image smoke checks
are separate from the performance cohorts. Video and coding-agent task quality
are not evaluated by these checks.

MLX measurements are collected again on the existing 2225 server with its
retained state; it is not a fresh server process. Its near-75k capacity result is
reused from the earlier campaign to avoid repeating a swapping production load.
FP4 references are from the earlier run on the same physical 2226 host, same
NVIDIA driver and same engine binary, not an alternated checkpoint crossover.

[analyze.py](analyze.py) checks inference request hashes (excluding only model ID),
fixed output budgets, other inference requests and memory-pressure counters.
Contaminated, failed or unexpectedly cached cold cohorts remain in the raw
results but are excluded from clean speed claims. Small trial counts, ongoing
traffic, retained state, host/driver differences for MLX, and checkpoint-specific
output/template differences limit causal conclusions. No simultaneous-residency
claim follows solely from completing sixteen near-75k HTTP requests.

## Results

Both the fresh MLX baseline and INT4 completed **126/126** main performance
requests with their complete requested output budgets. Both passed the separate
tool-call and image smoke checks. INT4 startup took 119.8 seconds and reported
**33.55 GiB of sequence memory**, versus **25.81 GiB** in the preceding FP4 run
(+7.74 GiB, about 30%). This pool measurement is more useful for this deployment
than treating checkpoint download size as loaded memory.

Selected complete-request aggregate output rates, in tokens/second:

| Workload | MLX 2225 (fresh run) | FP4 2226 (earlier run) | INT4 2226 | Comparison caveat |
|---|---:|---:|---:|---|
| Single code, trial 0 | 44.9 | 55.0 | 59.6 | Clean observed pairs |
| Single code, trial 1 | 48.1 | 67.8 | 76.9 | Clean observed pairs |
| 16 code, trial 0 | 278.0 | 361.4 | 320.4 | Outside traffic on MLX and INT4; excluded |
| 16 code, trial 1 | 316.8 | 358.2 | 385.9 | Clean observed pairs |
| 16 prose, trial 0 | 276.4 | 235.8 | 326.3 | Clean observed pairs |
| 16 prose, trial 1 | 287.7 | 192.9 | 362.1 | Clean observed pairs |
| 4 prose, trial 0 | 162.8 | 110.9 | 137.3 | Clean observed pairs |
| 4 prose, trial 1 | 126.5 | 93.0 | 178.6 | Clean observed pairs |

In the clean 16-code trial, INT4 was **21.8% above MLX** and **7.7% above FP4**.
The two clean 16-prose trials were **18.0% and 25.8% above MLX**, and **38.4% and
87.7% above FP4**. Four-stream prose varied enough to lose to MLX once and win
once. These are observations from two trials, not a guaranteed speedup.

Conversation continuation still exposes the engine's tradeoff. For the
16-project growth cohort, median time to first token was **5.64 s INT4**, versus
**6.57 s FP4** and **1.35 s MLX**. INT4 and FP4 reused similar token totals
(116625 each); the fresh MLX cohort had outside traffic and additional
swapping, so its current speed comparison is excluded. The earlier MLX campaign
also observed a 1.21 s continuation median. INT4's aggregate continuation output
rate was 111.8 tokens/s versus FP4's 120.0, a clean observed pair.

For project branching, INT4 reused 29510 tokens, versus MLX's 97944 and FP4's 0.
Observed median time to first token was 5.58 s, 1.29 s and 8.13 s, respectively.
INT4 and FP4 had outside traffic; INT4 also recorded one swapped-out page
(4 KiB), so this cohort is excluded from clean comparisons. No OOM occurred
in the main INT4 campaign. Other exclusions, exact request hashes, cache reuse,
per-request outputs and memory samples are retained in [comparison.json](comparison.json)
and the raw result directories.

## Capacity and restoration

The 16-request capacity cohort (**74005-74006 input tokens + 256 output tokens
per request**, within a 75000-token limit) was **safety-aborted**, not passed.
At 10:32:56 UTC, about 519 seconds after the cohort began, the monitor recorded
263117 newly swapped-out pages (about 1.004 GiB), exceeding the unchanged
262144-page / 1 GiB stop threshold. Host memory available was still **16.87 GiB**,
swap in use **1.104 GiB**, and the OOM-kill counter had not increased. This is a
failure to meet the test's swap criterion; it does not establish physical memory
exhaustion or prove that the model can never complete this workload.

Other inference traffic was observed during the cohort. The benchmark intentionally
exits before serializing a complete cohort when its guard fires, so no final
16-request success count or capacity throughput is claimed. The earlier FP4
capacity burst completed in 568.20 seconds without new swapping; its outside
traffic and the current outside traffic prevent a clean timing comparison.

See [capacity16-near75k-safety-abort.json](candidate-2226/capacity16-near75k-safety-abort.json),
[metadata-capacity.json](candidate-2226/metadata-capacity.json),
[candidate-full.log](candidate-full.log), and [pipeline.log](pipeline.log).
The pipeline exited with status 3, stopped INT4 and restarted the original MLX
container automatically. Restoration is verified in [restoration.json](restoration.json):
2226 serves the original MLX model at 16 streams / 75000 tokens, a generation
returned `OK`, and both installed engine source hashes match the original.
INT4 is stopped, with its caches retained. The original 2225 container's start
time is unchanged; that service was never restarted.

The local experimental YAML and report/raw artifacts are synchronized into each
remote machine's own `~/docker/` folder. They remain experimental; the active
profile on both machines is MLX.

## Decision

INT4 is the stronger candidate of the two tested Zig checkpoints for further
work: it gives more sequence memory and better clean short-prompt code/prose
results without changing the engine. Keep MLX for the current interactive
student deployment: INT4 did not pass the near-75k swap criterion, continuation/branch
behavior remains weaker, and task quality still needs evaluation. No task-quality equivalence follows from throughput or smoke checks.
