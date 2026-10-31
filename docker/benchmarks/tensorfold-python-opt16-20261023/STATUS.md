# Active GPU optimization campaign

Goal: improve TensorFold Python for sixteen users, up to 75k total tokens each.
Local docker/ is authoritative. Experimental host only; reference host untouched.
Normal service is automatically restored at campaign completion/failure.

Current phase: COMPLETE GPU validation and prepared synchronized release.
All planned GPU runs are complete. The release controller and telemetry exited;
original 2226 is healthy with unchanged command/image/engine/SSD fingerprints.
Private test container is stopped. Reference 2225 is healthy with unchanged
October 11 StartedAt, command/image/engine/SSD fingerprints. Service audit passes.

Three matched primary pairs: median wall -43.9818%, throughput +78.5135%; cold
wall +6.98%. Three instrumented sustained trials:192/192. Unprofiled release:
capacity48/48 + IDs16/16, sustained64/64, representative112/112 + tool/image/
reasoning. Known project probe misses preserved. GPU evidence audit:308/308.

REPORT.md and bundle provenance document qualification and limits. The final local→remote release includes MANIFEST.sha256 for verification from
the remote docker root. Reverify it after replication; regenerate it after any
artifact edit. No additional optional experiments are part of this campaign.

## Historical decisions and checkpoints

Frozen sustained fixture SHA-256:
74f54138348232995d55ea5afedf6de996ae06b0d3cca6e49d5270ef2321801e.
Four 16-request rounds: ~71k initial inputs, full recorded assistant replies,
896 output tokens each, max total 74670. Source is `run_sustained.py`; all future
runs load local-authored/synced `sustained-fixtures.json`. The legacy capacity
workload separately reaches 74985 and preserves the historical vLLM payloads.

Completed screens:
- baseline-1: cold 16/16, overlap14, 646.74s. One 4 KiB host swap-out page made
  it strictly flagged; v1 client prematurely aborted subsequent stages. Archived.
- reserve8-screen1: cold16/16 overlap16,623.62s,39 pages; failed 6 GiB floor on
  first return. Unsupported as a usable configuration.
- reserve8coalesced-screen1: sampler NameError during warmup; no benchmark run.
- reserve8coalesced-screen2:48/48, overlap16 all3;617.01/78.54/37.42s; RAM minima
  7.55/6.54/6.35 GiB; one host page in first return. Narrow margin, not promoted.
- reserve8adaptive-sustained-screen1: first48/64 complete, overlap16 in first3,
  600.68/95.41/95.77s. Fourth round stopped below6 GiB. Third-round resize
  73728→75007 grew CUDA allocated~0.24 GiB but reserved~3.48 GiB. empty_cache
  could not return~3.8 GiB reserved-minus-allocated. Fifteen prefix chains survived;
  one fourth-round request lost its cache. No OOM, serving-process VmSwap zero.

Eager-tail next change costs ~0.35 GiB upfront to avoid sixteen late partial
resizes. All model weights, INT8 KV, MTP6, KEEP64, vision and SSD batching remain.
Common diagnostics now also record CUDA inactive-split stats. Exact prior
samplers are archived under snapshots/. Source names / readiness hashes prove
versions; do not change executing script files. Ruff undefined-name checks pass.

`launch_validation.py` archives previous controller-session records and detaches
cleanly. Launch only after previous controller released its lock and original
service recovered. Check telemetry PID to avoid duplicate observers. Pull only
results/ and sessions/, never overwrite authored sources from remote root.

Eager-tail screen: walls 600.083/96.033/93.377/87.555 seconds; first-token
p50 516.751/9.963/8.678/7.092 seconds. Pilot only, not a repeated recommendation.

Order64 screen completed64/64: cold657.298s, TTFTp50 354.124s/p95 587.978s,
cold output overlap10 because early replies completed before later prefills.
Return waves overlapped16; separate project recall13/16 needs baseline control.
Plan010 schedules three primary pairs A/B,B/A,A/B, then representative controls.

23:41 UTC: baseline-sustained-1 FAILED third round:14/16 complete; engine stopped
users8/15 at710/884 output tokens when growing73728-capacity KV buffers. No host
OOM, no6 GiB guard trip. Controller is restoring normal service. Plan011 replaces
unexecuted plan010 runs with three alternating legacy near75k timing pairs, plus
two fresh sustained candidate qualifications and representative A/B. Preserve
failed trial; no four-round speed percentage can be assigned. Relaunch only after
normal healthy / old lock released. Watch exec session25192 exits on restoration.

23:43 UTC: original service restored healthy after the failed strong baseline;
plan011 launched with controller695743/telemetry695744. Main timing workload now
legacy3 rounds; strong sustained qualification stays separate. Old watch25192 ended.

00:06 UTC: baseline-capacity-1 completed cold642.41s and first return407.906s
(7 cached histories /518052 tokens). Third stage running, no errors. Current
watch exec session43178. Plan012 adds unambiguous ID/fork checks after future
primary timing trials, without changing run_suite.py or timed payloads.

00:24 UTC checkpoint: baseline-capacity-1 PASSED48/48, walls
642.414925/407.905511/377.077793s (sum1427.398229), hostpageouts0 all3.
Candidate-capacity-1 now running, all16 admitted promptly, zero scheduler waiting.
Current detachedcontroller695743, telemetry695744, live watch exec43178.
Plan012: six alternating near75k timing trials, two extra four-round sustained
candidate qualifications (screen1 is first), then representative A/B.

Prepared final untraced bundle: docker/patches/tensorfold-python-opt16-v065/.
serve.py uses coalesce+adaptive+tail+order64; no benchmark sampling hooks.
Same tested policy bodies, source SHA guards. constraints.txt pins225 installed
distributions shared by baseline and candidate; public/private release YAMLs use
this lock. Still requires actual release GPU qualification! Do not call ready yet.
Profiles: models/qwen38-flash-next-python-opt16-tuned-128gb.yml (public8000),
models/qwen38-flash-next-python-opt16-release-test-128gb.yml (private8009/testname).
Release plan: untraced near75k capacity+explicitID/fork check, representative
(tool/image and16 default-reasoning arithmetic checks). Use launch_release.py only
after validation controller ends/restores normal/lockfree/oldtelemetryexited.
It launches controller_release.py, which uses process_metrics_untraced.py's
exact /ieti-opt16/serve.py PID match without needing an engine trace.

Read-only analysis updates: analyze.py supports primary case-prefix/count
(capacity3 fallback), strict and bounded-host-pageout criteria, paired median
percentages/ranges, sequence totals, common package/source/instrument checks.
tabulate.py generates TABLES.md. plot_primary.py generates PNG/SVG once completed
matched pairs exist, with dynamic3-stage fallback. plot_case.py now marks failed
requests with redX; baseline-sustained-1/sustained-return2-16 figure inspected.

Remaining: finish all planned GPU trials; inspect semantic ID controls and
sustained repeat outcomes (old ambiguous project probe13/16 must remain visible);
run untraced release qualification and verify actual225-version inventory; write
REPORT.md with3 matched-pair percentages/ranges, all cold tradeoffs/cache counts
and flags. Reusable profile/bundle needs GPU release success before qualified.
Generate/inspect final primary plot, update README/provenance/status, sync
source/report results/hash manifest locally→remote; preserve oracle. Final normal
2226 health/command restored and2225 original start/command checked read-only.
Update goal COMPLETE only when delivered and restored. No budget requested.

00:29 UTC: first matched pair complete. A1427.398s, B801.779s (-43.83% wall,
+78.03% aggregate throughput). Bwalls687.283/76.733/37.763s; cold+6.98%,
return output overlap16/16, ID/fork16/16. Only n1 so far, not final recommendation.
Bounded-host-pageout eligible, strict full-sequence ineligible: Bpageouts1/0/1
(8KiB total); main CPUVmSwap0/majorfault0 with full coverage. RAM minima B
8.321/7.209/6.884GiB; fork check6.808GiB. Spot health readings~8.5GiB miss
transient snapshot peaks, so report raw minima! No guard/OOM.
Candidate-capacity-2 now running. Scientific primary plot generated/inspected
at n1; regenerate and inspect at n3 before final. TABLES/analysis regenerated.

01:20 UTC: TWO complete matched pairs. Primary A/B sequence walls:
capacity1 A1427.398229 B801.779390 (-43.8293% wall),
capacity2 A1420.037975 B795.479528 (-43.9818% wall).
Bounded-host-pageout n2, median wall-43.9056%, throughput+78.2711%; strict full
sequence n0 due tiny hostpageouts (all raw flags remain). A2 ID/fork16/16 in
330.979s; both candidates16/16 in~2s. C2walls680.114327/77.907447/37.457754s,
RAM minima8.336/7.273/7.200GiB; hostpageouts0/1/0; mainCPUVMswap0.
Candidate2 complete; baseline2 complete; third pair still queued.

Plan013 inserted candidate-growth65k-qualification1 between complete pairs2/3.
run_growth65k.py uses existing65000 fixture +distinct prefix,16x896 outputs
forcing65536 cache boundary during generation, then a real-answer return wave.
This is separate qualification, not a matched primary timing repetition.
Starting near71k already rounds to73728; earlier-boundary behavior needs actual
GPU data. Do not change current runtime speculatively: no new policy has been
implemented for this test. Current candidate remains same coalesce/adaptive/tail/
order64 sources as C1/C2. If it fails, preserve failure and investigate; if it
passes, record cache-hit retention/any waits as limitations, not justHTTP200.

REPORT.md now exists as explicit IN-PROGRESS draft with first-pair results and
method/limitations. Rewrite into final report only after remaining qualification.
Need update draft values/counts, readability spacing, final untraced results,
hash manifest, service restoration. It currently is not a ready recommendation.

01:35 UTC: growth65k qualification PASSED32/32; cold594.3945s, actual-answer
return221.2638s; returnoutputoverlap16, prefixhitusers12/16, cached779802tokens.
Four prefixes lost during growth/eviction. RAM minima7.963/7.825GiB,
hostpageouts0 both, gateends0/waits0, final16x75007 capacities and16keptentries.
This is a remaining performance cliff, not an inference/hostOOM failure.
No new policy was applied; no speculative full-KV preallocation patch exists.
REPORT draft records this limitation and preallocation as FUTURE experiment.
Current scope: finish third original/finalist pair, two extra strong sustained
qualifications, representative A/B, untraced release qualification+final report.
Do not keep adding optional configurations indefinitely; finish current tested
improvement with honest tradeoffs. Controller695743/watch43178 still active.

02:16 UTC: all3 baseline timing trials complete; baseline3 walls
641.73/481.695/416.88s, explicitID/fork16/16. Candidate3 now running; all16
admitted, zeroqueue, common engine sources/instrumentation unchanged.

IMPORTANT resolved-version metadata fix (does NOT change serving tests): original
last-wins importlib.metadata.distributions dictionary masks active versions when
venv/image/Ubuntu distributions overlap. Found4 masked entries: HFHub active1.33
vsraw1.24, hf-xet1.6vs1.5.2, setuptools81vs68.1.2, wheel0.47vs0.42.
Raw225 inventories remain preserved. Live candidate3 has direct
resolved-inventory.json using canonical importlib.metadata.version (225 effective
versions,5 duplicate names inclpip;venvpip24 active). All earlier measured runs
passed audit: same pinned image, same complete raw inventory, identical full pip
installation versions and same pinned-image venv bootstrap.
audit_resolved_versions.py writes separately LABELED historical supplements with
reference/log hashes. resolved-version-audit.json recordsno unresolved runs.
All supplemental JSONs synced back with resolved-inventory.json-only rsync filter
(never overwrite live engine/prometheus files!).

runtime_inventory.py now preserves legacy field AND invokes resolved_inventory.py
after capture for future runs; old source archived snapshots/runtime_inventory-v1.py.
Both helpers synced remote. analyze.py checks effective_distribution_versions
in addition to original package/source/instrument matches; first2 pairs remain
eligible in bounded analysis. verify_campaign.py also checks effective versions
for release. constraints.txt corrected to actual225 versions before any release
run; bundle synced remote. Do NOT revert to legacy last-wins package locks.

REPORT still explicitdraft; finalneedsall3pairs andqualifications. New local
verify_campaign.py performs final evidence audit (GPUrun completion, fulloutputs,
contextlimits,ID,tool,image,defaultreasoning,uninstrumentedhashes,restoration);
run AFTER analyze.py at end. It is not itself a GPU performance test.

03:06 UTC: ALL3 timing pairs complete and ALL3 sustained qualifications pass.
Primary median wall-43.9818% (range-48.6513 to-43.8293), throughput+78.5135%.
Strict full-sequence n1 (pair3:wall-48.6513%); boundedn3; strictperstage n2 each.
C3timings678.052/75.230/37.643s, ID16/16, allhostpageouts0.
3 sustained runs192/192 replies, returnwavesalwaysoverlap16; minRAM8.050GiB.
Q3walls653.02/94.80/92.94/86.93s, allhostpageouts0. All3projectprobe13/16.

Plan015 changes representative wrappers to run_representative_with_diagnostic.py:
unchanged timed+tool/image+defaultreasoning suite, then exact originalpayloads
for3known project misses, cold/serial diagnostic onbothsettingsandrelease.
Frozen project-known-misses-payloads.json generatedlocally from Q2 withasserted
request/tokenSHA identity. Do not claim this low-load control equals16-way
cached quality. No runtime change. Release plan014 also adds unprofiled full4
rounds to coverearlytail path (near75k initialprompts wouldnotexerciseit).
Remaining: representative A/B (+diagnostic), controllerrestore, launchrelease
3runs (capacity+ID, fullsustained, representative+diagnostic), verifyactualeffective
225versions/bundlehashes, finalreport/sourcehashsync/normalrestore/refunchanged.

03:26 UTC: validation controller finished all11 plan015 runs successfully and
restored original2226 healthy (root result errornull, completed11). Oldtelemetry
exited; oldwatch43178 ended. Source/bundle/newYAMLs fully synced.
Unprofiled RELEASE launched: controller972122 /telemetry972123 /watch33676.
Release has3 runs: capacity+ID48 long replies, full4rounds+project64,
representative+defaultreasoning+native tool/image+3coldserialdiagnostics.
Do not skip actualunprofiled growth case: initial74k capacity alone doesnot
exerciseearly-tail helper. Package constraints corrected to225effectiveversions;
private/publicresolvedcommand/image/env/mount/GPU equivalence preflight PASSED.

Representative baseline/candidate bothpassed112timedresponses,16defaultreasoning
math answers (all16reasoningnonempty), native tool/image. Shortcases baseline
12.29/11.54/10.89 vsnew11.95/11.31/10.84s. Mixed73.24/13.61/12.62 vs
73.35/13.31/13.47s. Fair48.72vs47.59s. n1trial perconfig: smallchanges not
conclusive; later live-answer inputs maydiffer, reportdescriptiveonly.
Coldserial EXACT3known-project-miss diagnostics: BASELINE0/3 andCANDIDATE0/3,
bothanswered16forIDs0/1/2 withcachedtokens0. Thusnotunique tonewcache;
do notclaimgeneralaccuracyorattributeonlytopromptambiguity.

Finaltools preparedlocally: verify_campaign.py (actualGPUevidence audit; includes
release fullsustained), service_check.py (read-onlyDocker/health/sourcefingerprint
viaSSHstdin; noenv/commandsecrets), profile_equivalence.py (safeComposecompare,
neverprintsresolvedconfig), make_manifest.py (hashcampaign/runtime/profiles/data
afterwritersstop; excludescredentials/PID/locks). Runfinalservicecheckon2225
READONLY, nevercopywriteanyfilethere; saveJSONlocally. On2226privateOFF/original
healthy andoriginalCmd28b...hash/source/imageunchanged. Syncfinaloracle/hashes
afterallwritersstop andverifysha256sum-cfrom~/docker.
