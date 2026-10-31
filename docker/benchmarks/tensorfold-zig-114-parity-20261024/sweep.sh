#!/usr/bin/env bash
# On 2226: restart the parity build once per value of env VAR and run the same cohorts. Usage: sweep.sh TAG VAR v1 v2 ...
set -uo pipefail
cd ~/docker/benchmarks/tensorfold-zig-114-parity-20261024
tag=$1; var=$2; shift 2
cases=${CASES:-short-n1-case0,short-n8-case0,short-n8-case1,prose-n8-case0,prose-n8-case1}
for value in "$@"; do
  env "$var=$value" bash up-parity.sh | tail -1 || exit 1
  rm -rf "$tag-$var-$value"
  python3 bench.py --out "$tag-$var-$value" --cases "$cases" 2>&1 \
    | python3 -c "import sys,json
for l in sys.stdin:
    try: s=json.loads(l); print('$var=$value', s['name'], round(s['output_tok_s'],1), 'ttft50', round(s['ttft_p50_s'],3), 'pageouts', s['pageouts'], flush=True)
    except Exception: print(l.strip()[:200], flush=True)"
done
