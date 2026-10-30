# Typical-load original versus opt16 comparison — STOPPED

The user canceled testing on 2026-10-24 and requested restoration of the
original Python deployment on 2226 to match 2225. Do not resume this campaign.
The controller received SIGTERM and stopped the private test container; its
restoration handler starts the original Python container on port 8000.
Final service fingerprints are reference-final.json and normal-final.json.

Two clean matched pairs completed. original-pair3-clean was interrupted;
tuned-pair3-clean did not run. Preserve partial data, but do not report three
completed pairs or run the six-run completion verifier. No tuned profile is
promoted. All instructions below are superseded historical notes.

Local docker/ is authoritative. Run only synced files in remote ~/docker/.
The reference host stays read-only, with no inference load or restart.
Use the experimental host through the configured local tunnel. No agents used.

Controller PID1048577 / telemetry1048578, detached. Watch exec session22496.
Current run: original-pair3-clean. First two clean pairs complete (four runs).
All four:66/66 cohorts,45/45 checks,strict clean throughout.
Second-return TTFT slowdown reproduces across user-count order reversal.
Private container qwen38_flash_next_python_lowload on loopback8009. Normal original
qwen38_flash_next_cuda_vram128_tensorfold_mlx_4bit_mtp_int8_ssd_vision is stopped
for isolation. Controller always restores it on success/failure. Reference start
expected2026-10-11T12:08:52.452616778Z. Before service fingerprints are saved.

## Scope and frozen sources

This is qualification of the existing opt16 profile at fewer active users, not
new tuning or production promotion. Context75000/slots16 unchanged, active1/2/4/8.
Main contexts ~2k/~8k/mixed16k/2k/8k, cold plus two returning turns. Three short
cases per n. Fixed original128-token replies replayed; both inputs identical.
Separate normal-thinking arithmetic/code and named-tool requests with natural
EOS, actual live tool-result continuations. Exact old short16/mixed16 regression
replay first in each process (one65k outlier). Caches carry between blocks, no
fresh restart per individual case. See PROTOCOL.md for all limits and thresholds.

plan.json has six primary IDs: original-pair1-clean,tuned-pair1-clean,
tuned-pair2-clean,original-pair2-clean,original-pair3-clean,tuned-pair3-clean.
Pair order A/B,B/A,A/B, user-count order[1,2,4,8],[8,4,2,1],[2,8,1,4].
Each process has66 cohorts,321 requests,45 reasoning/tool checks.
No internal profiling; common launcher delegates either stock Python entry or
exact qualified opt16 bundle. Same pinned image/checkpoint/41 source files/225
effective versions/KEEP64/SSD/MTP6/INT8/vision; tuned env reserve8 and policies.

Fixture revision2 SHA256:
5b8487410235af782d8bd517dd17fb116e4d27d8eaa86b9dc7170bf215c276ae.
Do NOT modify fixtures.json,run_matrix.py,transport.py,base_probe.py,
runtime/launch.py,runtime_inventory.py or policy bundle during these six runs.
Runtime inventory records client/fixture/launcher/policy hashes, all41 source
files,225 effective versions. First primary A/B metadata matches every field.
Read-only analysis/report/status helpers may evolve separately.

## Excluded pilot

Original-pair1 (no -clean) completed and is excluded from ALL primary comparisons.
Its reasoning fixture inherited a summary instruction conflicting with the final
integer-only task. It returned summaries and sometimes correct arithmetic. These
format misses are NOT a tuned-engine regression. Fixture/plan/provenance v1
preserved under snapshots/. Pilot raw data retained. Revision2 removes conflicting
instructions; all primary lower-user checks completed so far pass. Controller
completed_runs will include pilot THEN six clean IDs; verifier expects clean suffix.

## Provisional first-pair result

Both first clean runs:66/66 cohorts,45/45 semantic checks,all66 strict-clean.
62 fixed-input eligible comparisons; four actual tool followups deliberately
excluded from timing percentages. All runtime/client/policy hashes match.
Second-return TTFT median increases47.8–74.0% across ordinary contexts at1/2/4/8.
Absolute roughly +.15s/+.22s/+.33s/+.63s. Tuned recomputes161 extra tokens/user
in EVERY one of these cells, consistent with nearby-checkpoint coalescing; no
single-policy ablation yet. Old mixed16 return2 TTFT1.421→3.005s reproduces.
Short single-user first output remains~.16s on both. Do not give final3-pair
conclusion yet. Keep original reference; no broad deployment authorized here.

## Tools and remaining work

analyze.py generates analysis.json/TABLES.md; only clean plan IDs are paired.
Eligibility requires whole matched trials complete, all hashes equal,<=1MiB host
pageout/case, main CPUVmSwap0/full coverage, no errors/OOM/external requests.
Strict subset zero host pageouts. Regression flags >10% AND>.2s in all3 pairs.
Variable-output reasoning/tool timings labeled; actual tool followups excluded.
plot_typical.py needs all3 pairs; use /tmp/ieti-python-opt16-plots/bin/python,
then inspect PNG via view_image. verify.py audits actual evidence; passed means
collection integrity, not non-regression. It separately reports semantic outcomes
and repeated performance regressions. make_manifest.py prepared for final.

Finish all six clean GPU runs, including safe restoration. Ensure controller/
telemetry exited. Pull results/ and sessions/ only (never remote sources over
local oracle). Analyze all3 pairs, verify, generate/inspect plot, write final
REPORT.md with actual per-cell medians/ranges, raw flags/correctness/limitations.
Audit reference unchanged and restored original2226 via service_check.py over
SSH stdin (no files copied to2225), private OFF. Preserve image15b8..., Cmd28b7...,
enginef8dbc..., forwardfa06..., TF0.6.5. Use previous campaign final audit pattern.

Update bundle/docs recommendation if ordinary regressions persist, preserving
all other dirty user changes. If bundle metadata or docker/README changes,
regenerate old opt16 campaign manifest too and verify it remotely (old raw data
remain immutable). Final local→remote sources/docs/audits/manifests, verify all
hashes from remote docker root. Original services restored,2225 unchanged.
Old goal is already complete; no new goal created/requested for this comparison.
Do not launch optional new policies until this finite comparison is delivered.

Restoration verified: normal 2226 container and API healthy; private test OFF;
controller, telemetry and benchmark client exited. Image, launch command,
entrypoint, TensorFold version and engine/forward source hashes match 2225.
Reference 2225 remained healthy with its original start timestamp.
Local original YAML and remote copy match byte for byte.
