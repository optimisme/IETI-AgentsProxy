#!/usr/bin/env bash
# On 2226: prefill.py on the running Zig (int8, 16 slots, 75k), then on Python; Zig left up afterwards.
set -uo pipefail
cd ~/docker/benchmarks/tensorfold-zig-114-parity-20261024
python3 prefill.py http://127.0.0.1:8007 zig
docker stop qwen38_flash_next_tensorfold_114_ple_cuda > /dev/null 2>&1
IETI_RUN=parity-20261026-prefill docker compose -f ~/docker/models/qwen38-flash-next-python-typical-original-test-128gb.yml up -d --force-recreate > /dev/null 2>&1
start=$(date +%s)
until curl -sf http://127.0.0.1:8009/health > /dev/null; do sleep 10; [ $(( $(date +%s) - start )) -gt 1800 ] && exit 1; done
python3 prefill.py http://127.0.0.1:8009 py
docker stop qwen38_flash_next_python_lowload > /dev/null 2>&1
TENSORFOLD_KV_CACHE=fp8 TENSORFOLD_CONTEXT=75000 TF_PROMPT_CACHE_ELASTIC=1 TENSORFOLD_PROMPT_CACHE_GIB=12 TENSORFOLD_STREAMS=16 bash up-parity.sh | tail -1
