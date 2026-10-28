#!/usr/bin/env bash
# On 2226: start the patched 1.1.7 build (mixed pass on), then greedy together vs alone, needles, and greedy answers
# against the 1.1.6 build's (kvcheck-116-m0) and tf114-20261026b's (kvcheck-kv8fix), and cold fill speeds. Left running.
set -uo pipefail
P=~/docker/benchmarks/tensorfold-zig-114-parity-20261024
H=~/docker/benchmarks/tensorfold-zig-117-20261027
bash $H/up-117.sh | tail -1 || exit 1
docker logs qwen38_flash_next_tensorfold_best_cuda 2>&1 | grep -m3 -E "streams at once|TF_FLASHNEXT_MIXED|version"
cd $P
python3 greedy_check.py 2>&1 | tail -3
python3 kv8_check.py http://127.0.0.1:8007 kvcheck-117 2>&1 | tail -2
python3 -c "import json
b=json.load(open('kvcheck-117/answers.json'))
for ref in ('kvcheck-116-m0','kvcheck-kv8fix'):
    a=json.load(open(ref+'/answers.json')); print('answers equal to', ref+':', sum(a[k]==b.get(k) for k in a), 'of', len(a))"
python3 prefill.py http://127.0.0.1:8007 117 2>&1 | tail -8
docker logs qwen38_flash_next_tensorfold_best_cuda 2>&1 | grep -i -E "error|panic|fault" | head -5
