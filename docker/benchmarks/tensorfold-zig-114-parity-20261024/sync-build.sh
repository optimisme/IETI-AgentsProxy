#!/usr/bin/env bash
# Local helper: ship the working copy's diff against base-ple to 2226 and rebuild there.
set -euo pipefail
. "$(dirname "$0")/../ssh.env"  # SSH_PORT, SSH_TARGET (local, not versioned)
SRC=${SRC:?working copy}
HERE=$(cd "$(dirname "$0")" && pwd)
cd "$SRC"
git diff base-ple > "$HERE/parity.patch"
{ git diff --name-only base-ple; } | COPYFILE_DISABLE=1 tar -cf "$HERE/sync.tar" -T -
cd "$HERE"
scp -P "$SSH_PORT" -q parity.patch sync.tar build-parity.sh "$SSH_TARGET":docker/benchmarks/tensorfold-zig-114-parity-20261024/
ssh -p "$SSH_PORT" "$SSH_TARGET" 'set -o pipefail; docker run --rm --cpus 8 --memory 16g \
  -v ieti-native114-parity-build:/build \
  -v ieti-qwen38-flash-next-tensorfold-zig-tuned-int4-runtime-cache:/toolchain:ro \
  -v ~/docker/benchmarks/tensorfold-zig-114-parity-20261024:/results \
  nvcr.io/nvidia/pytorch:26.07-py3@sha256:2140e699b3beaf7f96a0081fd9c9406bc3832b435cdb60dfa2d261f7d2f34a1c \
  bash /results/build-parity.sh 2>&1 | grep --line-buffered -v -E "Ignoring unknown extended|^(=|NVIDIA|PyTorch|Container|Copyright|All rights|Various|GOVERNING|\(found|and the|NOTE|  Using|  See|$)"'
