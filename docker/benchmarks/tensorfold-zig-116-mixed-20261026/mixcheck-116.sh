#!/usr/bin/env bash
# On 2226: the mixed pass's correctness, MIXED=0 then 1 on the same build: greedy together/alone, mix_check (answers
# decoding beside filling needles) compared across the two, needles, and how many chunks ran mixed.
set -uo pipefail
P=~/docker/benchmarks/tensorfold-zig-114-parity-20261024
H=~/docker/benchmarks/tensorfold-zig-116-mixed-20261026
C=qwen38_flash_next_tensorfold_best_cuda
for m in 0 1; do
  TF_FLASHNEXT_MIXED=$m TF_HOST_TRACE=1 bash $H/up-116.sh | tail -1 || exit 1
  echo "== MIXED=$m"
  (cd $P && python3 greedy_check.py 2>&1 | tail -2)
  python3 $H/mix_check.py http://127.0.0.1:8007 $H/mixcheck-m$m 2>&1 | tail -5
  echo "chunks: $(docker logs $C 2>&1 | grep -c 'prompt chunk .* mixed') mixed, $(docker logs $C 2>&1 | grep -c 'prompt chunk .* alone') alone"
  docker logs $C 2>&1 | grep -i -E "error|panic|fault" | head -5
done
python3 - <<'P'
import json
a=json.load(open('/home/<user>/docker/benchmarks/tensorfold-zig-116-mixed-20261026/mixcheck-m0/mix.json'))
b=json.load(open('/home/<user>/docker/benchmarks/tensorfold-zig-116-mixed-20261026/mixcheck-m1/mix.json'))
same=[k for k in a['answers'] if a['answers'][k]==b['answers'].get(k)]
print('answers equal MIXED=0 vs 1:', len(same), 'of', len(a['answers']))
for k in a['answers']:
    if k in same: continue
    x,y=a['answers'][k],b['answers'][k]; i=next((j for j in range(min(len(x),len(y))) if x[j]!=y[j]), min(len(x),len(y)))
    print(' ', k, 'first diff at char', i, 'of', len(x), repr(x[max(0,i-20):i+30]), '|', repr(y[max(0,i-20):i+30]))
print('needles 0:', [n['got'] for n in a['needles']]); print('needles 1:', [n['got'] for n in b['needles']])
P
