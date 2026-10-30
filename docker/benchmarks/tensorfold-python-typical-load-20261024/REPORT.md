# Original versus tuned Python at typical load — STOPPED

The user canceled testing on 2026-10-24 and requested restoration of the
original Python deployment on 2226, matching 2225. No tuned deployment is
promoted. Two clean matched pairs completed; the third original run was
interrupted and its tuned counterpart did not run. The text below preserves
the earlier provisional observations and protocol. References to further
scheduled trials are historical; there is no active test campaign.

The previous capacity campaign does not establish normal-load non-regression.
This new comparison measures the original and qualified opt16 profile at1,2,4,8
active users while the server keeps its75k context limit and16-slot capacity.
The first matched pair is complete; two more are running. There is no broader
promotion decision yet. Both first-pair runs completed all66 cohorts, passed45/45
reasoning/tool checks and met strict zero-host-pageout criteria throughout.

The exact previous short16/mixed16 inputs are also repeated, because one earlier
warm mixed turn increased median first-token time from1.568 to3.163s. Completion
time alone hid the size of that first-token regression. This diagnostic contains
a65k outlier; it is separate from ordinary contexts in the main matrix.

Main matrix: three short code cases per concurrency, homogeneous~2k and~8k
histories, and a mixed~16k/~2k/~8k roster, cold plus two returns. At one user,
the mixed roster is one~16k history. Return inputs replay fixed full128-token
original Python answers. Separate normal-thinking arithmetic/code and named-tool
requests allow normal EOS; actual tool-result continuations test live behavior.
These synthetic workloads are not a measured distribution of student traffic.

Six new fresh-process trials form three matched pairs, A/B,B/A,A/B, on the
experimental GPU only. The reference service remains unchanged. Read PROTOCOL.md
for source/runtime/hash matching, fixed versus variable output distinctions,
latency metrics, declared host-pageout bounds and regression thresholds.

The first original-pair1 run is a preserved excluded pilot. Its reasoning fixture
combined an inherited summary instruction with an integer-only question.
The revision2 primary fixture removes that conflict and starts fresh; no pilot
case is counted in primary percentages. Raw pilot data and its original fixture
and plan remain in results/ and snapshots/.

The detached controller runs the experimental machine's local ~/docker/ files,
uses real CUDA GPU access and restores the original service on completion or
failure. Local docker/ remains the source of truth. New results never overwrite
the earlier completed capacity campaign.

Evidence will be summarized in analysis.json, TABLES.md, verification.json and
standalone figures after all planned GPU trials and restoration are complete.

## Provisional first-pair finding

Second-return median first-token latency is47.8–74.0% higher on the tuned
profile across the ordinary1/2/4/8-user conversation cells. Absolute increases
are about0.15s at one user,0.21–0.23s at two,0.33–0.34s at four and0.61–0.65s
at eight. Report absolute values alongside percentages. The tuned profile
reprocesses161 additional input tokens per user in each of these cells,
consistent with retaining an earlier nearby checkpoint instead of a new one.
That association has not been isolated in a one-policy ablation.

The old mixed16 second-return signal also reproduces: median first token
1.421→3.005s. Small one-user short-code first-token times remain near0.16s.
These are one-pair observations, not the final three-pair recommendation.
