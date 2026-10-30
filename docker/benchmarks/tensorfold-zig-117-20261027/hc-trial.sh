#!/usr/bin/env bash
# On 2226: lone prompt chunks' HC read-out on Python's prompt GEMM (TF_FLASHNEXT_PROMPT_HC=1, variants/tfhc). Replies first
# (short band, two long documents): any rubbish or wrong code stops the run. Then one cold 74k prompt by block and by
# kernel step. Results: resident/hc-*.log and resident/summary.txt. Leaves the best build running.
set -uo pipefail
H=~/docker/benchmarks/tensorfold-zig-117-20261027
D=$H/resident
S=$D/summary.txt
C=qwen38_flash_next_tensorfold_best_cuda
U=http://127.0.0.1:8007
V=${HVAR:-tfhc}
echo "# $(date -Is) hc-trial $V" >> "$S"

med() {
  python3 - "$1" <<'PY'
import re, sys
from statistics import median
rows = {}
for line in open(sys.argv[1], errors='replace'):
    m = re.search(r'blocks: 4096 rows (.*) ms', line)
    if m:
        for k, v in re.findall(r'(\w+)=([\d.]+)', m.group(1)): rows.setdefault(k, []).append(float(v))
if rows:
    print(' '.join(f'{k} {median(v):.0f}' for k, v in rows.items()), 'total', round(sum(median(v) for v in rows.values())))
PY
}

env TF_EXTRA_ENV="TF_FLASHNEXT_PROMPT_HC=1" VARIANT=$V bash $H/up-117.sh | tail -1 || exit 1
python3 $H/short_sweep.py $U 40 140 2 0 $D/hc-band-0.json 2>&1 | tail -1 | cut -c1-200 | tee -a "$S"
python3 $H/short_sweep.py $U 10 140 2 0.1 $D/hc-band-01.json 2>&1 | tail -1 | cut -c1-200 | tee -a "$S"
python3 $H/sane_replies.py $U $(( $(date +%s) % 100000 * 100 )) 2 74000 37 0.1 $D/hc-band-0.json $D/hc-band-01.json 2>&1 | cut -c1-190 | tee -a "$S"
rc=${PIPESTATUS[0]}
n=$(docker logs $C 2>&1 | grep -c ProposalPaddingPick)
echo "hc reply check exit $rc, ProposalPaddingPick lines $n" | tee -a "$S"
if [ "$rc" != 0 ] || [ "$n" != 0 ]; then
  docker logs $C > $D/hc-failed.log 2>&1
  bash $H/up-117.sh | tail -1
  echo hc-trial-done | tee -a "$S"
  exit 1
fi
for p in 2 3; do
  env TF_EXTRA_ENV="TF_FLASHNEXT_PROFILE=$p TF_FLASHNEXT_PROMPT_HC=1" VARIANT=$V bash $H/up-117.sh | tail -1 || exit 1
  echo "hc profile $p: $(python3 $H/cold_one.py $U $(( $(date +%s) % 100000 * 100 + $p )) 2>&1 | tail -1)" | tee -a "$S"
  docker logs $C > $D/hc-profile-$p.log 2>&1
  [ $p = 2 ] && echo "hc per 4096 rows: $(med $D/hc-profile-2.log)" | tee -a "$S"
  [ $p = 3 ] && grep "kernels: 4096 rows" $D/hc-profile-3.log | sed -n 9p | cut -c1-420 | tee -a "$S"
done
bash $H/up-117.sh | tail -1
echo hc-trial-done | tee -a "$S"
