# TensorFold 1.1.4: bounded screening against deployed Python

One sequential comparison on the experimental GB10, using an isolated clone of
the original Python configuration and the official unmodified ARM64 1.1.4 binary.
The reference GPU is not used. The normal experimental service is restored in a
controller finally block. No promotion is part of this screening.

Both deployments read checkpoint 2b170fa6309d5d1ee380b35636075fac7945f286,
MLX affine 4-bit, with vision and MTP6/confidence 0.60, context limit 75,000.
Python retains its actual INT8 KV, 16 slots and KEEP64/SSD-gather policies.
Native uses BF16 KV, eight slots and an 8 GiB volatile prompt cache; no inference
patches or persistent memory. This compares deployments, not one isolated knob.
Sixteen full contexts and image performance are outside this short screening.

The exact frozen requests from the previous typical-load fixtures are reused:
two different short-code cases at 1/4/8 users (256 output tokens each), cold and
two returning 2k-context turns at 4/8 users (128 output tokens), and one cold and
one returning 8k-context request (128 output tokens). Total: 14 cohorts and 64
requests per runtime. Returning assistant text is frozen from the old Python
fixtures, not regenerated separately by each engine. Thinking is off, greedy,
fixed output budgets and seed; no semantic equivalence claim between runtimes.
A separate unrelated warm-up precedes measurement. Cold means no relevant GPU
prefix; filesystem/model/kernel caches remain warm.

Measure cohort output tokens divided by wall time, median/p95 time to first SSE
output, cached input tokens, completed outputs, new host pageouts/OOM and minimum
available RAM. Record exact request hashes, input counts, GPU telemetry and actual
runtime arguments. Require no other inference, complete SSE and exact output
budgets. A different tokenizer/template count is reported as a comparison limit.
Abort below 6 GiB available RAM, on new OOM, or over 1 GiB new host pageouts.
Each client is limited to five minutes; each startup to six minutes. This is one
screening pair, not a repeated performance qualification or a quality benchmark.

Decision declared before GPU measurement: recommend deeper multiuser evaluation
only if all measured requests complete, no host pageouts/OOM occur, and the
geometric mean native/Python throughput ratio over the short 4/8-user cases and
returning 2k 4/8-user cases is at least 0.90. Flag median TTFT regressions above
both 25% and 0.2 seconds. A passing throughput ratio with repeated TTFT regression
is a mixed signal requiring a targeted fix before a broader campaign. Single-user
improvement alone does not pass the multiuser gate.
