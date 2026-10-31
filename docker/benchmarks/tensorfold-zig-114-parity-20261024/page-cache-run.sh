#!/usr/bin/env bash
# On 2226 with the traced Zig container up: drop the uploaded weights' page cache, read the n-gram tables in, rerun cohorts into $1.
set -uo pipefail
cd ~/docker/benchmarks/tensorfold-zig-114-parity-20261024
out=${1:?out dir}
c=qwen38_flash_next_tensorfold_114_ple_cuda
snap=/root/.cache/huggingface/hub/models--TensorFold--Qwen3.8-Flash-Next-MLX-4bit-MTP/snapshots/2b170fa6309d5d1ee380b35636075fac7945f286
docker cp ngram_cache.py $c:/tmp/ngram_cache.py
free -g | sed -n 2p
start=$(date +%s)
docker exec $c python3 /tmp/ngram_cache.py $snap apply
docker exec $c python3 /tmp/ngram_cache.py $snap read
echo "page cache prepared in $(( $(date +%s) - start ))s"; free -g | sed -n 2p
lines=$(docker logs $c 2>&1 | wc -l)
rm -rf "$out"; mkdir -p "$out.tmp"; rmdir "$out.tmp"
python3 bench.py --out "$out" --cases short-n8-case0,short-n8-case1,prose-n8-case0,prose-n8-case1 2>&1 \
  | python3 -c "import sys,json
for l in sys.stdin:
    try: s=json.loads(l); print(s['name'], round(s['output_tok_s'],1), 'ttft50', round(s['ttft_p50_s'],3), flush=True)
    except Exception: print(l.strip()[:200], flush=True)"
docker logs $c 2>&1 | tail -n +$lines | grep '^ple gather' > "$out/gather.log"
python3 - "$out/gather.log" <<'PY'
import re,sys
rows=[tuple(map(int,m.groups())) for m in (re.search(r"items=(\d+) parts=(\d+): fill (\d+) us, sums (\d+) us, minflt (-?\d+), majflt (-?\d+), last start (\d+) us, longest part (\d+) us, busy (\d+) us",l) for l in open(sys.argv[1])) if m and int(m.group(1))>=200]
for name,i in [("items",0),("fill_us",2),("majflt",5),("last_start_us",6),("longest_part_us",7),("busy_us",8)]:
    v=sorted(r[i] for r in rows); print(name,"p50",v[len(v)//2],"p90",v[int(len(v)*.9)],"n",len(v))
PY
free -g | sed -n 2p
