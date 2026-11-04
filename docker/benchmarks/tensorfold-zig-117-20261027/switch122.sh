#!/usr/bin/env bash
# 2225: tf119d -> tf122 on public 8000; if tf122 does not come up, tf119d comes back.
export TENSORFOLD_BIND_ADDRESS=0.0.0.0 TENSORFOLD_BIND_PORT=8000 TENSORFOLD_RESTART=unless-stopped
echo "start $(date -Is)"
if VARIANT=tf122 bash ~/docker/benchmarks/tensorfold-zig-117-20261027/up-117.sh; then echo "tf122 up $(date -Is)"; else
  echo "tf122 failed, back to tf119d $(date -Is)"; VARIANT=tf119d bash ~/docker/benchmarks/tensorfold-zig-117-20261027/up-117.sh; echo "tf119d back $(date -Is)"; fi
echo switch-done
