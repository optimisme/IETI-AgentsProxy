#!/usr/bin/env bash
# On 2226: tf122's production-readiness checks, as tf119d's before 2225: the tool and image smoke, needles, an hour of
# 16-user agent load, menu_check.py, then replies after load on the same process. Results: prod-tf122/. Ends with
# the build back on 0.0.0.0:8000 (restart unless-stopped), as the soak had it.
set -uo pipefail
H=~/docker/benchmarks/tensorfold-zig-117-20261027
export PROD_DIR=$H/prod-tf122 VARIANT=tf122
mkdir -p $PROD_DIR
STAGES="smoke quality soak" bash $H/prod-check.sh
python3 -u $H/menu_check.py http://127.0.0.1:8007 $PROD_DIR/menu-zig.json > $PROD_DIR/menu-zig.txt 2>&1
docker logs qwen38_flash_next_tensorfold_best_cuda 2>&1 | grep -i -E "panic|segfault|CudaFailed|out of memory|UnexpectedTensor|ILLEGAL|round failed" | head -3 >> $PROD_DIR/menu-zig.txt
bash $H/after-load.sh
docker logs qwen38_flash_next_tensorfold_best_cuda 2>&1 | grep -c -i -E "panic|segfault|CudaFailed|out of memory|UnexpectedTensor|ILLEGAL|round failed" | sed 's/^/log errors /' >> $PROD_DIR/after-load.txt
TENSORFOLD_BIND_ADDRESS=0.0.0.0 TENSORFOLD_BIND_PORT=8000 TENSORFOLD_RESTART=unless-stopped bash $H/up-117.sh | tail -1
echo prod122-done >> $PROD_DIR/summary.txt
