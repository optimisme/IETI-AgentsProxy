#!/usr/bin/env bash
set -euo pipefail
cd "$HOME/docker/benchmarks/tensorfold-zig-release112-20261023"
trap 'printf "%s\n" "$?" > clean-baseline-exit-code' EXIT
for i in $(seq 1 720);do
 [ ! -f baseline11-exit-code ] || break
 sleep 5
done
test "$(cat baseline11-exit-code)" = 0
python3 matched_probe.py baseline --base http://127.0.0.1:8000 --out python-clean11 --selection python-clean-selection.json
