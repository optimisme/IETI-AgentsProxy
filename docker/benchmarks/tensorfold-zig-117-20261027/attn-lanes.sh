#!/usr/bin/env bash
# On 2226: one-launch attention for a shared round's lanes (TF_FLASHNEXT_ATTN_LANES, variants/resident11) against the
# lane-at-a-time loop. Stages (STAGES, default all):
#   blocks   16 short replies twice, each block synchronized (TF_FLASHNEXT_PROFILE=2): median block ms by round rows
#   rounds   the same load unprofiled (TF_LANES_PHASES=1): tokens/s and the rounds' phases
#   exact    resident-check.sh's exact stage with the switch on (together vs alone, answers, sampled replies)
# Results: resident/attn-lanes-*.log and resident/summary.txt. Leaves the last server running.
set -uo pipefail
H=~/docker/benchmarks/tensorfold-zig-117-20261027
D=$H/resident
S=$D/summary.txt
C=qwen38_flash_next_tensorfold_best_cuda
V=${AVAR:-resident11}
mkdir -p "$D"
echo "# $(date -Is) attn-lanes $V stages ${STAGES:-blocks rounds exact}" >> "$S"

up() { env TF_EXTRA_ENV="$1" VARIANT=$V bash $H/up-117.sh | tail -1; }

blocks() { # log
  python3 - "$1" <<'EOF'
import re, sys
from collections import defaultdict
from statistics import median
by = defaultdict(lambda: defaultdict(list))
for line in open(sys.argv[1], errors='replace'):
    m = re.search(r'blocks: (\d+) rows (.*) ms', line)
    if not m: continue
    rows = int(m.group(1))
    for k, v in re.findall(r'(\w+)=([\d.]+)', m.group(2)): by[rows][k].append(float(v))
for rows in sorted(by):
    b = by[rows]
    if rows < 48 or rows > 80 or len(b['attn']) < 20: continue
    print(f'  {rows} rows: {len(b["attn"])} passes ' + ' '.join(f'{k} {median(v):.1f}' for k, v in b.items()))
EOF
}

for stage in ${STAGES:-blocks rounds exact}; do
  echo "== $stage $(date -Is)" | tee -a "$S"
  case $stage in
    blocks|rounds)
      for L in 0 1; do
        if [ $stage = blocks ]; then E="TF_FLASHNEXT_PROFILE=2 TF_FLASHNEXT_ATTN_LANES=$L"; else E="TF_LANES_PHASES=1 TF_FLASHNEXT_ATTN_LANES=$L"; fi
        up "$E" || exit 1
        python3 $H/decode_load.py http://127.0.0.1:8007 16 800 > /dev/null 2>&1 # warm
        r1=$(python3 $H/decode_load.py http://127.0.0.1:8007 16 800 2>&1 | tail -1)
        r2=$(python3 $H/decode_load.py http://127.0.0.1:8007 16 800 2>&1 | tail -1)
        docker logs $C > $D/attn-lanes-$stage-$L.log 2>&1
        echo "lanes=$L: $r1 / $r2" | tee -a "$S"
        docker logs $C 2>&1 | grep -i -E "panic|segfault|CudaFailed|error\." | head -3 | sed "s/^/# /" | tee -a "$S"
        if [ $stage = blocks ]; then blocks $D/attn-lanes-$stage-$L.log | tee -a "$S"
        else python3 $H/reply_profile.py $D/attn-lanes-$stage-$L.log | grep ' 16 streams' | tee -a "$S"; fi
      done ;;
    exact)
      STAGES=exact RVAR=$V RENV="TF_FLASHNEXT_ATTN_LANES=1" bash $H/resident-check.sh ;;
  esac
done
echo attn-lanes-done | tee -a "$S"
