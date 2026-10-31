# TensorFold 1.1.0: percentage comparisons

100*(Zig/Python-1). Higher throughput is better; lower TTFT/wall time is better. Positive latency means longer wait.

All rows below use matching request payload hashes and pass the clean timing rules.

| Measurement | Python | Tuned Zig 1.1.0 | Zig change | Python reference |
| --- | ---: | ---: | ---: | --- |
| MLX: one code request | 48.091 tokens/s | 72.928 tokens/s | +51.6% | python-2225 |
| MLX: 16 code requests | 316.829 tokens/s | 186.779 tokens/s | -41.0% | python-2225 |
| NVIDIA FP4: 16 code requests | 316.829 tokens/s | 198.208 tokens/s | -37.4% | python-2225 |
| MLX: first token, cold16k | 6.950 s | 13.409 s | +92.9% | python-same-host |
| NVIDIA FP4: first token, cold16k | 6.950 s | 13.018 s | +87.3% | python-same-host |
| MLX: first token, 16 code requests | 0.608 s | 1.841 s | +202.6% | python-2225 |
| NVIDIA FP4: first token, 16 code requests | 0.608 s | 2.065 s | +239.5% | python-2225 |

Grouped MTP head batching improved the clean MLX 16-user code result by **18.7%** over batched verification alone, from 157.31 to 186.78 aggregate tokens/s. This is an observed result on matching deterministic workloads.

The FP4 result needs another **59.8% throughput increase** to match the 2225 Python reference. A 37.4% throughput deficit is not the same as requiring only 37.4% additional throughput.

These results do not establish that parity is impossible. The current 1.1.0 modifications improve 16-user throughput but do not reach customized Python. MLX Zig already exceeds Python in the measured single-user workload.

The 16-request measurements are short code-generation bursts, with the server configured for 16 streams and a 75000-token maximum window. **No full 16×75k capacity/performance qualification was completed for these 1.1.0 profiles.**

Cold 16k first-token comparisons use the same-host Python control. The 2225 cold reference is excluded because it recorded outside inference. Other noisy/failed/short comparisons remain flagged in `alternatives-comparison.json`; they are not presented here as clean results.

FP4 and Python use different quantizations; MLX uses the same pinned checkpoint as Python. These are controlled measurements from one campaign, without statistical confidence intervals. The 16/16 retrieval check is limited quality coverage.

Full precision numbers, denominators and raw-result paths are in `percentage-comparison.json`. Every pair in `alternatives-comparison.json` now includes explicit throughput, TTFT and wall-time percentage changes, together with its exclusions.

Further GPU profiling and batching of remaining per-owner operations are reasonable experiments, not demonstrated solutions or a guarantee of parity. All persistent memory features remain off; Python remains the healthy primary runtime.
