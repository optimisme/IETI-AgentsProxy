#!/usr/bin/env bash
# On 2226: lone prompt chunks on Python's prompt GEMM (TF_FLASHNEXT_PROMPT_GEMM=1, variants/tfgemm) against the same build
# with the switch off: one cold 74k prompt, block times (PROFILE=2) and kernel steps (PROFILE=3), then the quick stage
# (replies may differ from tf119c at near ties), the exact stage, and sane_replies.py: long documents must return the
# code they hold, every band reply must be real text.
# Results: resident/gemm-*.log and resident/summary.txt. Leaves the best build running.
set -uo pipefail
H=~/docker/benchmarks/tensorfold-zig-117-20261027
D=$H/resident
S=$D/summary.txt
C=qwen38_flash_next_tensorfold_best_cuda
V=${GVAR:-tfgemm}
echo "# $(date -Is) gemm-trial $V" >> "$S"

med() { # log
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

run() { # label gemm profile
  env TF_EXTRA_ENV="TF_FLASHNEXT_PROFILE=$3 TF_FLASHNEXT_PROMPT_GEMM=$2" VARIANT=$V bash $H/up-117.sh | tail -1 || exit 1
  echo "$1: $(python3 $H/cold_one.py http://127.0.0.1:8007 $(( $(date +%s) % 100000 * 100 + $2 )) 2>&1 | tail -1)" | tee -a "$S"
  docker logs $C > $D/gemm-$1.log 2>&1
  grep -i -E "panic|segfault|CudaFailed" $D/gemm-$1.log | head -3 | cut -c1-200 | sed "s/^/# /" | tee -a "$S"
  [ "$3" = 2 ] && { echo "$1 per 4096 rows: $(med $D/gemm-$1.log)" | tee -a "$S"; }
  [ "$3" = 3 ] && { tail -60 $D/gemm-$1.log | grep -i -E "gdn_|attn_|lap|step" | tail -24 | cut -c1-160 | sed "s/^/# /" | tee -a "$S"; }
}

run off-blocks 0 2
run on-blocks 1 2
run on-steps 1 3
STAGES=quick RVAR=$V RENV="TF_FLASHNEXT_PROMPT_GEMM=1" bash $H/resident-check.sh
python3 $H/sane_replies.py http://127.0.0.1:8007 $(( $(date +%s) % 100000 * 100 )) 6 74000 37 0.1 $D/band-0.json $D/band-01.json 2>&1 | cut -c1-190 | tee -a "$S"
echo "on rubbish check exit ${PIPESTATUS[0]}" | tee -a "$S"
python3 $H/sane_replies.py http://127.0.0.1:8007 $(( $(date +%s) % 100000 * 100 + 50 )) 6 74000 37 0 2>&1 | cut -c1-190 | tee -a "$S"
echo "on temperature 0 rubbish check exit ${PIPESTATUS[0]}" | tee -a "$S"
docker logs $C 2>&1 | grep -c ProposalPaddingPick | sed 's/^/ProposalPaddingPick lines: /' | tee -a "$S"
STAGES=exact RVAR=$V RENV="TF_FLASHNEXT_PROMPT_GEMM=1" bash $H/resident-check.sh
VARIANT=${AFTER:-tf119c} bash $H/up-117.sh | tail -1
echo gemm-trial-done | tee -a "$S"
