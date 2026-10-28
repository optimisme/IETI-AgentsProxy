#!/usr/bin/env bash
# On 2226: the decode candidate (variants/decode: best + MiaAI-Lab 0012 late DeltaNet rows + 0016 DeltaNet lanes) with
# each path on: greedy together vs alone, needles and answers against the 1.1.7 check's, and sampled replies (fixed
# seeds) against the best's (variants/sampled/sampled-on.json); all must be identical.
set -uo pipefail
H=~/docker/benchmarks/tensorfold-zig-117-20261027
P=~/docker/benchmarks/tensorfold-zig-114-parity-20261024
C=qwen38_flash_next_tensorfold_best_cuda
# 0012's late-row log (~38 MiB a stream) does not fit 16 streams at 75000 tokens; screen at 72000
export TENSORFOLD_CONTEXT=${TENSORFOLD_CONTEXT:-72000}
for spec in late:TF_FLASHNEXT_KEEP_LATE=1 lanes:TF_FLASHNEXT_KEEP_LATE=1,TF_FLASHNEXT_GDN_LANES=1; do
  label=${spec%%:*}; ON=${spec#*:}; ON=${ON//,/ }
  echo "== $label: $ON"
  env $ON TF_EXTRA_ENV="$ON" VARIANT=decode bash $H/up-117.sh | tail -1 || exit 1
  docker logs $C 2>&1 | grep -m1 "extra env"
  (cd $P && python3 greedy_check.py 2>&1 | tail -2 && python3 kv8_check.py http://127.0.0.1:8007 decode-$label 2>&1 | tail -1 &&
    python3 -c "import json
a=json.load(open('kvcheck-117/answers.json')); b=json.load(open('decode-$label/answers.json'))
print('answers equal to kvcheck-117:', sum(a[k]==b.get(k) for k in a), 'of', len(a))")
  python3 $H/sampled_check.py http://127.0.0.1:8007 $H/variants/decode/sampled-$label $H/variants/sampled/sampled-on.json
  docker logs $C 2>&1 | grep -i -E "panic|fault|CudaFailed|error" | head -5
done
echo check-decode-done
