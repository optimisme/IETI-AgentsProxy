#!/usr/bin/env bash
# 2225: tf122 -> tf124 on public 8000; if tf124 does not come up, tf122 comes back.
# tf124 needs TF_FLASHNEXT_KEEP_INPASS=0 (in the profile with READOUT_ROWS=128 and LANE_PARTS=0).
export TENSORFOLD_BIND_ADDRESS=0.0.0.0 TENSORFOLD_BIND_PORT=8000 TENSORFOLD_RESTART=unless-stopped
echo "start $(date -Is)"
if VARIANT=tf124 bash ~/docker/benchmarks/tensorfold-zig-117-20261027/up-117.sh; then echo "tf124 up $(date -Is)"; else
  echo "tf124 failed, back to tf122 $(date -Is)"; VARIANT=tf122 bash ~/docker/benchmarks/tensorfold-zig-117-20261027/up-117.sh; echo "tf122 back $(date -Is)"; fi
echo switch-done
