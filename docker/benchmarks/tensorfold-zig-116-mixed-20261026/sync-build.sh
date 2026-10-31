#!/usr/bin/env bash
# Local helper: ship the patched 1.1.6 Flash-Next tree to 2226 and build it there.
set -euo pipefail
. "$(dirname "$0")/../ssh.env"  # SSH_PORT, SSH_TARGET (local, not versioned)
SRC=${SRC:?working copy}
HERE=$(cd "$(dirname "$0")" && pwd)
cd "$SRC"
git diff base116 > "$HERE/fn.patch"
git ls-files -c -o --exclude-standard | grep -v -E '^(app|docs|assets)/' | COPYFILE_DISABLE=1 tar -cf "$HERE/source.tar" -T -
cd "$HERE"
ssh -p "$SSH_PORT" "$SSH_TARGET" 'mkdir -p ~/docker/benchmarks/tensorfold-zig-116-mixed-20261026'
scp -P "$SSH_PORT" -q fn.patch source.tar build-116.sh "$SSH_TARGET":docker/benchmarks/tensorfold-zig-116-mixed-20261026/
ssh -p "$SSH_PORT" "$SSH_TARGET" 'docker volume create ieti-native116-fn-build > /dev/null; set -o pipefail; docker run --rm --cpus 12 --memory 24g \
  -v ieti-native116-fn-build:/build \
  -v ieti-qwen38-flash-next-tensorfold-zig-tuned-int4-runtime-cache:/toolchain:ro \
  -v ~/docker/benchmarks/tensorfold-zig-116-mixed-20261026:/results \
  nvcr.io/nvidia/pytorch:26.07-py3@sha256:2140e699b3beaf7f96a0081fd9c9406bc3832b435cdb60dfa2d261f7d2f34a1c \
  bash /results/build-116.sh 2>&1 | grep --line-buffered -v -E "Ignoring unknown extended|^(=|NVIDIA|PyTorch|Container|Copyright|All rights|Various|GOVERNING|\(found|and the|NOTE|  Using|  See|$)"'
