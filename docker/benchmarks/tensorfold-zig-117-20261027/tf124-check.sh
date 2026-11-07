#!/usr/bin/env bash
# On 2226: tf122 ported to TensorFold 1.2.4 (variants/tf124). The tf122 checks: exactness, the 64-127 row band, reuse,
# short replies, the 74k probe and the agent load, with the same READOUT_ROWS=128 and LANE_PARTS=0.
# TF_FLASHNEXT_KEEP_INPASS=0: 1.2.4 keeps prompt-cache marks inside a pass (#1866); that changes chunk shapes (first
# tokens differ from tf119d on 7 of 50 band prompts) and our resident states need a chunk cut at the mark (NotAtMark).
# TF_FLASHNEXT_LANE_PARTS=0: 1.2.4's lane parts pool a 4096-row draft block a stream outside the memory budget, which
# 16 streams at 74k cannot spare. Results: resident/summary.txt. Leaves the build running on 127.0.0.1:8007.
set -uo pipefail
H=~/docker/benchmarks/tensorfold-zig-117-20261027
D=$H/resident
S=$D/summary.txt
C=qwen38_flash_next_tensorfold_best_cuda
U=http://127.0.0.1:8007
R="TF_FLASHNEXT_READOUT_ROWS=128 TF_FLASHNEXT_LANE_PARTS=0 TF_FLASHNEXT_KEEP_INPASS=0"
echo "# $(date -Is) tf124-check" >> "$S"
STAGES="quick exact band reuse" RVAR=tf124 RENV=$R bash $H/resident-check.sh || { echo tf124-check-stopped | tee -a "$S"; exit 1; }
env TF_EXTRA_ENV="$R TF_LANES_PHASES=1" VARIANT=tf124 bash $H/up-117.sh | tail -1
python3 $H/decode_load.py $U 16 800 > /dev/null 2>&1
r1=$(python3 $H/decode_load.py $U 16 800 2>&1 | tail -1); r2=$(python3 $H/decode_load.py $U 16 800 2>&1 | tail -1)
docker logs $C > $D/tf124-short.log 2>&1
echo "tf124 short: $r1 / $r2" | tee -a "$S"
python3 $H/reply_profile.py $D/tf124-short.log | grep ' 16 streams' | tee -a "$S"
STAGES="capacity agent" RVAR=tf124 CLABEL=phases RENV="$R TF_LANES_PHASES=1" bash $H/resident-check.sh
env TF_EXTRA_ENV="$R" VARIANT=tf124 bash $H/up-117.sh | tail -1
python3 $H/sane_replies.py $U $(( $(date +%s) % 100000 * 100 )) 6 74000 37 0.1 2>&1 | cut -c1-190 | tee -a "$S"
python3 $H/sane_replies.py $U $(( $(date +%s) % 100000 * 100 + 50 )) 6 74000 37 0 2>&1 | cut -c1-190 | tee -a "$S"
TOKENS=45000 STAGES=capacity RVAR=tf124 CLABEL=45k RENV="$R TF_LANES_PHASES=1" bash $H/resident-check.sh
echo tf124-check-done | tee -a "$S"
