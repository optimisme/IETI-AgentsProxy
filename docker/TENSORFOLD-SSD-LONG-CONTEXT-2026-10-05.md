# TensorFold SSD and long-context experiment — 5 October 2026

The additional SSD copy changes did **not** produce a repeatable, meaningful improvement in long-prompt performance. Keep the original production cross-stream SSD batching patch. Do not deploy the new deferred-scatter or direct-fill candidates from this experiment. Capacity and retained KV state need a separate investigation before promising 16 simultaneous near-75k contexts.

This note records completed plain benchmarks and four locally validated GPU captures. Five profiling cohorts completed remotely; the sixth, B's 65k cohort, was ended early at the user's request to restore production promptly. Its partial capture must remain labeled unfinished. The full six-capture validation gate has not passed. Production restoration is recorded separately at the end.

## Fixed deployment and experimental variants

- Machine: one NVIDIA DGX Spark / GB10, accessed through SSH port 2226; API forwarding uses local port 8006 to remote port 8000.
- Recipe: `docker/models/qwen38-flash-next-tensorfold-vontra-mlx-4bit-mtp-int8-ssd-vision-128gb.yml`. No recipe changes were made for these tests.
- TensorFold: v0.6.5, commit `609ca419abecebdc5a059498a613680bd3aa847f`.
- Model: `TensorFold/Qwen3.8-Flash-Next-MLX-4bit-MTP`, revision `2b170fa6309d5d1ee380b35636075fac7945f286`; affine 4-bit, group size 32; int8 KV cache; vision enabled.
- Serving: context 75,000; parallel 16 with the existing local **KEEP 32** customization; MTP depth 6, confidence 0.60; thinking low, budget 1,024; temperature 0.1, top-k 20, top-p 0.95.
- SSD n-grams enabled; staging ahead enabled; CUDA decode-share remains its default 0. The vision-enabled prompt plan uses bounded 2,048-row pieces. Default 0 does not mean processing an entire long prompt in one pass.
- Driver 580.159.03; PyTorch `2.13.0a0+9186a08b2c.nv26.07`, CUDA 13.3. All submitted prompts were text only; these tests do not measure vision quality or image throughput.

| Arm | Difference from the production baseline |
|---|---|
| A | Existing production cross-stream batching: gather the streams' n-gram rows together for each layer. This is already patched TensorFold, not stock. |
| B | A plus deferred scatter for large lookups: retain unique read buffers and scatter into owned pinned staging buffers without creating three reordered intermediate arrays. |
| C | B plus `os.preadv` into the unique read buffers, avoiding the temporary `pread` bytes object and its copy. Screening only. |

B and C activate their large-lookup path at 256 **token rows**, not flattened n-gram IDs. Ordinary 16-stream MTP decode has at most `16 × (6 + 1) = 112` rows and keeps A's gather path. Existing deduplication, adjacent-read coalescing, 1 MiB read limit, 16 reader workers, scheduling, model math, n-gram data, KV format and CUDA Graph behavior were unchanged. C does not reduce planned read count or bytes and does not read directly into pinned or GPU memory.

The `b.staged` event protects ownership of pinned host buffers during the preceding host-to-device copy. It does not wait for the whole preceding GPU forward pass to finish.

## Completed plain A/B comparison

Four fresh serving processes ran in A0–B0–B1–A1 order. Each process ran the same seven workloads in order, retaining its allocator/cache state between workloads. Prompts and generation settings matched within each trial; every successful request generated 512 tokens.

All 28 cohorts were attempted: **447 of 448 requests completed**, with 27 fully successful cohorts. One retained-state A1 mixed request was evicted by TensorFold's memory gate. Thus the complete-success protocol failed; it must not be reported as “all tests passed.” There are 13 clean cohort pairs out of 14. The failed pair remains in the raw results and is excluded from the clean mixed performance mean, not silently rerun.

Values below are arithmetic means of each clean trial's aggregate rate and per-trial quantiles. TTFT includes the first generated text, including reasoning. Mixed TTFT covers the eight arriving long requests; heterogeneous TTFT covers its four 65k requests. Their aggregate rates cover all 16 clients.

| Workload | Clean pairs | A output tok/s | B output tok/s | A TTFT p50 / p95 (s) | B TTFT p50 / p95 (s) | A / B completion p50 (s) |
|---|---:|---:|---:|---:|---:|---:|
| Short decode, approximately 120 input tokens | 2/2 | 203.47 | 204.11 | 1.39 / 1.47 | 1.27 / 1.35 | 37.67 / 37.48 |
| Uniform 7.4k prefill | 2/2 | 82.34 | 82.00 | 60.19 / 62.68 | 60.42 / 62.91 | 97.89 / 98.28 |
| Uniform 16k prefill | 2/2 | 48.58 | 48.49 | 124.84 / 129.95 | 124.68 / 129.79 | 166.36 / 166.38 |
| Uniform 32k prefill | 2/2 | 29.91 | 29.93 | 231.91 / 235.60 | 231.93 / 235.63 | 271.70 / 271.49 |
| Uniform approximately 65k prefill | 2/2 | 15.17 | 15.26 | 396.95 / 500.60 | 411.17 / 497.31 | 467.77 / 476.45 |
| Retained-state mixed: 8 short decoders + 8 arriving 16k prompts | **1/2** | 75.31 | 74.93 | 61.37 / 71.79 | 61.35 / 71.77 | 105.23 / 105.12 |
| Heterogeneous: 4 each short / 4k / 16k / 65k | 2/2 | 35.75 | 35.69 | 168.49 / 199.17 | 169.17 / 199.82 | 225.67 / 226.11 |

B's paired output-rate changes were +0.05% to +0.56% for decode, −0.45% to −0.38% for 7.4k, −0.34% to −0.01% for 16k, −0.08% to +0.17% for 32k, −0.74% to +1.95% for 65k, −0.51% for the one clean retained mixed pair, and −0.37% to +0.05% for heterogeneous traffic. None establishes a consistent practical 5% long-prompt improvement. The decode TTFT improvement in trial 0 reversed in trial 1; it is not a repeatable startup-latency finding.

The earlier approximately 190 → 212 tok/s improvement belongs to the **original cross-stream batching patch already present in A**. This experiment did not rerun stock TensorFold and does not assign that improvement to B or C.

### Separate fresh-process mixed control

After the retained-state failure, the identical mixed request bodies and trial seeds were tested in four additional fresh processes, again A–B–B–A. All **64/64** requests completed. These results are separate from the retained-state table and are not pooled with it.

| Workload | Clean pairs | A / B output tok/s | A TTFT p50 / p95 (s) | B TTFT p50 / p95 (s) | A / B completion p50 (s) |
|---|---:|---:|---:|---:|---:|
| Fresh mixed: 8 short decoders + 8 arriving 16k prompts | 2/2 | 74.33 / 74.58 | 62.70 / 73.14 | 62.57 / 72.97 | 105.87 / 105.55 |

B's paired rate changes were +0.25% and +0.42%; long TTFT p50 changed by +0.10% and −0.49%. These small changes do not support deploying B. Fresh mixed started with approximately 82.2 GiB reported GPU-process allocation and 32 GiB available host memory; the failed retained-state run started around 103 GiB and 11 GiB. Fresh success does not remove the risk after earlier large contexts.

### Preliminary B/C screening

Each screened arm had one matched run per workload. Pure 16k/32k prompts generated **128 tokens**; decode and mixed generated 512. These shorter runs are not pooled with final measurements.

| Screen | A / B / C output tok/s | B / C TTFT p50 change relative to A |
|---|---:|---:|
| Short decode | 204.81 / 202.65 / 205.80 | +25.55% / −3.41% |
| Uniform 16k | 16.66 / 16.70 / 16.69 | −0.22% / −0.12% |
| Uniform 32k | 9.00 / 9.00 / 8.97 | +0.05% / +0.41% |
| Mixed 16k | 74.70 / 75.77 / 75.08 | −0.41% / +0.05% |

No consistent long-prompt gain appeared. C was not advanced to final 65k testing. An earlier unmatched manual decode control used a different seed and is excluded. All matched screen replies and work counters were exact; 37 CPU validation executions passed and one was skipped. CPU tests check synthetic bytes, planning and buffer ownership, not every possible GPU race.

## Capacity, retained state and mixed users

The uniform “65k” prompts actually contained **65,758–66,178 input tokens**. Admission adds the MTP allowance and rounds KV growth in 8,192-row increments. All therefore required **73,728 KV rows**, crossing the 65,536-row boundary. No paired just-below-boundary test was run, so this experiment does not measure the cost of that boundary or prove that reducing prompt length fixes capacity.

All 16 HTTP requests completed in each uniform 65k cohort, but sampled resident engine concurrency peaked at **13/14 for A and 14/14 for B**. Sixteen clients were not 16 fully resident near-65k GPU contexts throughout. Client-minus-engine occupancy persisted for approximately 453–467 seconds per cohort. Minimum host `MemAvailable` ranged from 9.33 to 10.88 GiB. TTFT includes this capacity waiting as well as shared prompt processing.

The 75k setting is a per-request prompt-plus-reply bound, memory permitting; it does not guarantee 16 resident full-size windows. Source inspection shows admission can wait on `NoRoom`. The integrated-GPU capacity calculation also keeps a default 10% host-memory floor, approximately 12.17 GiB on this machine, plus growth/copy reserves and allocator accounting. Health samples do not expose the exact failed gate condition.

The failed request was `final-baseline-mixed-16000-t1-t1-prefill-11`, after the preceding uniform 65k workload. TensorFold stopped the newest request after **35 server-reported tokens**, with nine streams decoding, so the other 15 could finish. Its final usage and token hash are unavailable. The exact error uniquely matches `MultiDecoder._make_room` in `families/qwen4_exp/cuda/multi.py:189–202`: a **proactive memory-gate eviction**, not an observed Torch CUDA OOM exception or host OOM kill. The exact held-budget versus live-headroom condition was not recorded.

Finished HTTP requests can retain large KV slots and prefix snapshots. API quiescence therefore does not guarantee startup memory has returned. A1's later heterogeneous workload followed this eviction and allocator cleanup; its second pair is a valid retained-state comparison with exact outputs, but weaker confirmation of an isolated SSD-copy effect.

All heterogeneous arms sampled 16 admitted streams. Their short users received first tokens in about 1.67 seconds for A and 2.02 seconds for B, but median completion was about 209 seconds. Corresponding first-token medians for 4k / 16k / 65k were approximately 8.25 / 66.63 / 168.49 seconds for A and 8.35 / 67.18 / 169.17 seconds for B. Mixed prompt lengths therefore share prompt service time and can interrupt existing decode progress even when initial short TTFT is low.

## Limited GPU timeline evidence

The following four locally available software Nsight captures are **one separate instrumented A/B pair** for decode and one for 16k prefill. Capture-window clocks, phase alignment and observer effects limit causal interpretation. Their rates are excluded from plain performance estimates. GPU busy means the union of traced kernels, copies and memsets, not an SM-utilization percentage.

| Capture | Complete intervals | Mean interval (ms) | Mean GPU idle (ms) | Mean gather wall (ms) | GPU busy / idle over complete intervals |
|---|---:|---:|---:|---:|---:|
| Decode A | 58 | 170.82 | 41.49 | 27.53 | 75.71% / 24.29% |
| Decode B | 58 | 171.31 | 41.53 | 27.72 | 75.76% / 24.24% |
| 16k prefill A | 10 | 897.45 | 151.88 | 591.20 | 83.08% / 16.92% |
| 16k prefill B | 10 | 897.94 | 128.58 | 591.00 | 85.68% / 14.32% |

Decode recovered **−0.033 ms per round**, effectively no additional idle recovery. Decode idle p95 was 58.05 ms for A and 59.89 ms for B. The gather range accounts for roughly 66% of decode idle; worker-fill union covers roughly 93% of gather wall time. This leaves a measurable staging dependency, but does not identify Python/GIL time versus page-cache/storage/native work.

The 16k pair has 23.30 ms less idle but 23.79 ms more GPU-active time, with essentially unchanged interval and gather wall time. More busy GPU time alone is not evidence of a faster staging pipeline; the plain matched TTFT results show no material improvement. Prefill intervals are prompt passes, not decode rounds. Gather wall time overlaps GPU work; nested timings cannot be added as exclusive categories.

No CUDA Graph replay envelopes occur inside these four selected capture windows. A global parser count includes events outside the window and is not evidence of replay during steady 16-stream decode. The initial hardware-trace attempt generated no Nsight report and is preserved as failed; missing metrics are unknown, never zero.

**Incomplete profiling:** A's 65k cohort completed remotely but has no locally reviewed matched B cohort. B's sixth cohort was deliberately ended early for production restoration. Preserve its raw partial capture; do not treat it as a complete response run or claim that the six-capture gate passed. There is no validated paired 65k, heterogeneous or mixed GPU-timeline conclusion in this note. Actual SSD syscalls/bytes per round, physical storage wait, allocations and GIL occupancy were not isolated; process-wide I/O counters cannot substitute for those measurements.

## Practical next steps

1. Resume the original production A implementation with its existing cross-stream SSD batching and KEEP 32 customization. Keep the current model, MTP, vision, context and recipe settings. Do not add B/C from these results.
2. Investigate long-context capacity separately: record memory-gate room/held/reserve/live, Torch allocated/reserved bytes, per-slot KV capacities and retained prefixes before and after repeated large-to-mixed traffic. Compare prompts safely below and above 65,536 rows, including the output and MTP allowance.
3. Test prefill fairness parameters separately if short-user responsiveness matters. Positive decode-share or smaller prompt pieces may change the latency/throughput tradeoff; their benefit is unmeasured here. Do not lower memory reserves or force a 4,096-row vision prompt plan on these findings alone.
4. A scheduler rewrite is unsupported by this experiment. A native SSD backend remains a separate measured question: residual decode gather cost still exists, but this experiment cannot divide it into Python/GIL versus actual I/O. C++ may help Torch/CUDA pinned-buffer integration; Rust may suit an isolated I/O backend. Neither benefit has been demonstrated.
5. Multistream CUDA Graphs are a future implementation opportunity, not a parameter switch. The source already has eligible single-stream graphs; shared 16-stream rounds use eager execution. Multistream graphs require stable metadata, shape/context buckets and invalidation when KV pointers change. SSD staging would still be needed outside replay. No graph changes were tested.

The failed new candidates do not invalidate the earlier measured benefit of the original batching patch, and they do not establish that the older SSD bottleneck has disappeared.

## Saved evidence and recovery

Remote artifact root: `~/tensorfold-ssd-long-context-20261005`. Local experiment directory has the same basename under the Codex experiment-artifact area. Relevant paths relative to that root:

- `analysis/final-deferred-scatter/long-context-analysis.json`, `analysis/recorded-failures.json`: main results and retained failed request.
- `analysis/fresh-mixed/long-context-analysis.json`: separate fresh mixed control.
- `analysis/report-support/final-plain-independent-review.csv` and `final-plain-independent-pairs.csv`: table values and paired changes.
- `analysis/resource_io_final.json`, `analysis/resource_io_fresh_mixed.json`: CPU, memory, I/O and admission samples.
- `analysis/mixed-memory-failure-review.txt`, `analysis/mixed-memory-failure-data.json`, `analysis/installed-source-hash-receipt.json`: source-backed failure interpretation and source hashes.
- `analysis/screen-summary.json`, `variants/`: candidate descriptions, patches and screen results.
- `analysis/decode-profile-independent-review.json`, `analysis/prefill-16k-profile-independent-review.json`, `traces/`: four locally validated paired timeline summaries, plus preserved incomplete campaign artifacts when collected.
- `preservation/`: private original source/container/image recovery material. Full traces and Docker inspect data belong in the private archive, not an upstream attachment.

The original batching patch is also preserved in the earlier `tensorfold-ssd-16stream-followup/shareable/ssd-batch-gather.patch`. No new license was added and no GitHub comment was posted by this documentation step.

## Verified production restoration

Verified at **2026-10-05 16:15:28 CEST**. The preserved original production container was resumed using its normal startup recipe. The experimental container was stopped and removed; benchmark/profiler processes were ended. Five profiling cohorts completed before restoration, and the sixth was curtailed; this does not change the completed plain A/B results above.

- Container: `qwen38_flash_next_cuda_vram128_tensorfold_mlx_4bit_mtp_int8_ssd_vision`, ID `68d8b9b4c196`; Docker status **running / healthy**.
- Original image preserved: `sha256:15b8de8baabe68e46afc51e88f3ccad5042013bafe8f244ec082ce0bb06d47e3`. The separate pre-experiment recovery image remains saved.
- TensorFold **0.6.5**, release commit `609ca419abecebdc5a059498a613680bd3aa847f`; original cross-stream SSD batching **enabled**, **KEEP 32** verified in installed code.
- Model/API: `TensorFold/Qwen3.8-Flash-Next-MLX-4bit-MTP`, pinned revision `2b170fa6309d5d1ee380b35636075fac7945f286`; **16 streams, 75,000 context, int8 KV, vision, MTP 6 / 0.60**, original reasoning/sampling defaults.
- Both `/health` and `/v1/models` passed. Forwarding through local port **8006** passed; a normal text-generation smoke test returned **READY** in approximately **0.35 seconds**. This is a readiness check, not a new benchmark.
- GB10 visible inside the container. No experimental profiler hooks or added profiling capabilities are deployed; the saved experimental supervisor was restored to its plain version.
- **Deferred-scatter and direct-fill/preadv candidates are not deployed.** Model weights, quantization, context, MTP and n-gram data are unchanged.
- Local Compose SHA-256 remains `e195dc49d4fdb4dd99a861e9b00516643247d79787622d3487834ced41474768`; no YAML edits were made during this experiment or restoration.

Installed production source SHA-256 checks matched the preserved baseline:

| Source | SHA-256 |
|---|---|
| `families/qwen4_exp/cuda/forward.py` | `fa06db912a4d02437875a7e146f1ccf4daf36fcf1093df9b50caf9ea316b03bf` |
| `families/qwen4_exp/ssd_table.py` | `b3fabaee9cdfbb6ce5d69bf216f63afe98ae54abc88b222a0c8f1312dd6af45e` |
| `families/qwen4_exp/cuda/ngram.py` | `cf3c061978f1dc33ea2d714807763524c6498e30a2373123829af41fcf790736` |

Verification receipts: `production-resume-status.json`, `production-command-verification.json`, `experiment-ended-for-production.json`, and local `analysis/deployment-restored-production.json` in the experiment artifact directory.
