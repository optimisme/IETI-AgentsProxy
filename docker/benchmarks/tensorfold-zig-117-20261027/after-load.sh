#!/usr/bin/env bash
# On 2226: reply text right after 16-user agent load, on the same server process. The soak keeps timings, not text.
H=~/docker/benchmarks/tensorfold-zig-117-20261027; P=~/docker/benchmarks/tensorfold-zig-114-parity-20261024; D=$H/prod-tf119d
(cd $P && python3 agent.py --url http://127.0.0.1:8007 --users 16 --turns 8 --tag afterload --temperature 0.1 --top-p 0.95 --out $D/afterload) 2>&1 | tail -1 | cut -c1-300 > $D/after-load.txt
python3 $H/sane_replies.py http://127.0.0.1:8007 $(( $(date +%s) % 100000 )) 16 8000 >> $D/after-load.txt 2>&1
echo after-load-done >> $D/after-load.txt
