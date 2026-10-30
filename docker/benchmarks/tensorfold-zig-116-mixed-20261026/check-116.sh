#!/usr/bin/env bash
# On 2226: start the 1.1.6 Flash-Next build (env passes through, e.g. TF_FLASHNEXT_MIXED=0), then greedy together
# vs alone, needles and greedy answers against tf114-20261026b's (kvcheck-kv8fix), and cold fill speeds. Left running.
set -uo pipefail
label=${1:?label}
P=~/docker/benchmarks/tensorfold-zig-114-parity-20261024
H=~/docker/benchmarks/tensorfold-zig-116-mixed-20261026
bash $H/up-116.sh | tail -1 || exit 1
docker logs qwen38_flash_next_tensorfold_best_cuda 2>&1 | grep -m2 -E "streams at once|TF_FLASHNEXT_MIXED"
cd $P
python3 greedy_check.py 2>&1 | tail -3
python3 kv8_check.py http://127.0.0.1:8007 kvcheck-116-$label 2>&1 | tail -2
python3 -c "import json
a=json.load(open('kvcheck-kv8fix/answers.json')); b=json.load(open('kvcheck-116-$label/answers.json'))
print('answers equal to tf114-20261026b:', sum(a[k]==b[k] for k in a), 'of', len(a))"
python3 prefill.py http://127.0.0.1:8007 116-$label 2>&1 | tail -8
