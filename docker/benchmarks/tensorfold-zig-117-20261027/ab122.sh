#!/usr/bin/env bash
# On 2226: tf122 with one overlap knob off at a time (the prompt GEMM, the hc fuse, the sampled candidates): one cold 74k
# prompt twice, then 16 short replies at temperature 0 and 0.55, twice each. Results: resident/summary.txt.
set -uo pipefail
H=~/docker/benchmarks/tensorfold-zig-117-20261027
S=$H/resident/summary.txt
U=http://127.0.0.1:8007
R="TF_FLASHNEXT_READOUT_ROWS=128 TF_FLASHNEXT_LANE_PARTS=0"
until tail -n +$(grep -n "tf122-check$" $S | tail -1 | cut -d: -f1) $S | grep -q "^tf122-check-done"; do sleep 20; done
echo "# $(date -Is) ab122" >> $S
for x in base:X=1 gemm0:TF_FLASHNEXT_PROMPT_GEMM=0 hc0:TF_FLASHNEXT_HC_FUSE=0 cand0:TF_FLASHNEXT_SAMPLE_CAND=0; do
  l=${x%%:*}
  env TF_EXTRA_ENV="$R ${x#*:}" VARIANT=tf122 bash $H/up-117.sh | tail -1
  for s in 1 2; do echo "$l $(python3 $H/cold_one.py $U $(( $(date +%s) % 100000 * 10 + s )) 2>&1 | tail -1)" >> $S; done
  python3 $H/decode_load.py $U 16 800 > /dev/null 2>&1
  for t in 0 0 0.55 0.55; do echo "$l temp $t $(TEMP=$t python3 $H/decode_load.py $U 16 800 2>&1 | tail -1)" >> $S; done
done
echo ab122-done >> $S
