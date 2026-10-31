#!/usr/bin/env bash
# On 2226: the 74k cold round with the mixed pass able to run. A prompt chunk rides a decode round only when the chunk and
# the round's rows fit the prompt scratch (the chunk size); with TF_FLASHNEXT_LIVE_CHUNK at the chunk size (4096) none
# fits and every chunk runs alone. LIVE (default 3968) leaves room for a round's rows (16 x 7 = 112 at most); STEPS
# (default "8 1") are TF_FILL_ROUND_STEPS values tried. Each: the capacity probe on the best build with phases and the
# host trace (how many chunks mixed). Results: resident/summary.txt. Leaves the best build running.
set -uo pipefail
H=~/docker/benchmarks/tensorfold-zig-117-20261027
D=$H/resident
S=$D/summary.txt
V=${MVAR:-tf119}
for s in ${STEPS:-8 1}; do
  L=live${LIVE:-3968}-s$s
  STAGES=capacity RVAR=$V CLABEL=$L \
    RENV="TF_FLASHNEXT_LIVE_CHUNK=${LIVE:-3968} TF_FILL_ROUND_STEPS=$s TF_LANES_PHASES=1 TF_HOST_TRACE=1" bash $H/resident-check.sh
  f=$D/capacity-$V-$L-74000.log
  echo "$L chunks: $(grep -c 'prompt chunk.*mixed' $f) mixed, $(grep -c 'prompt chunk.*alone' $f) alone" | tee -a "$S"
  python3 $H/reply_profile.py $f | grep ' 16 streams' | tee -a "$S"
done
bash $H/up-117.sh | tail -1
echo mixfit-done | tee -a "$S"
