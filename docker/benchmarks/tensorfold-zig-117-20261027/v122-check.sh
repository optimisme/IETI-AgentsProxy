#!/usr/bin/env bash
# On 2226: does plain TensorFold 1.2.2 (variants/v122, empty patch) overflow hc_part with TF_FLASHNEXT_READOUT_ROWS=128?
# The 64-127 row band and the agent load at 128, then the agent load at the default 64 as the control.
# Plain 1.2.2 keeps bf16 caches on this family: bf16 at 40k context (about the memory of fp8 at 75k).
# Results: resident/summary.txt. Leaves the build running on 127.0.0.1:8007.
set -uo pipefail
H=~/docker/benchmarks/tensorfold-zig-117-20261027
S=$H/resident/summary.txt
export TENSORFOLD_KV_CACHE=bf16 TENSORFOLD_CONTEXT=40000
echo "# $(date -Is) v122-check" >> "$S"
STAGES="band agent" RVAR=v122 CLABEL=v122-r128 RENV="TF_FLASHNEXT_READOUT_ROWS=128" bash $H/resident-check.sh
docker logs qwen38_flash_next_tensorfold_best_cuda 2>&1 | grep -E "UnexpectedTensor|ILLEGAL|panic|round failed|error\(" | sort | uniq -c | head | tee -a "$S"
STAGES="agent" RVAR=v122 CLABEL=v122-r64 bash $H/resident-check.sh
docker logs qwen38_flash_next_tensorfold_best_cuda 2>&1 | grep -E "UnexpectedTensor|ILLEGAL|panic|round failed|error\(" | sort | uniq -c | head | tee -a "$S"
echo v122-check-done | tee -a "$S"
