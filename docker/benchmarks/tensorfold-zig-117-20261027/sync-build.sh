#!/usr/bin/env bash
# Local helper: ship the patched 1.1.7 Flash-Next tree to 2226 and build it there.
# VARIANT=name builds a candidate beside the best (variants/<name>/, volume ieti-native117-<name>-build); start it with VARIANT=name up-117.sh.
# BASE=v1.1.9 cuts the patch from another release tag (default v1.1.7) and builds with that version.
# The test machine's SSH port and user@host come from ../ssh.env (local, not versioned; see ../ssh.env.example).
set -euo pipefail
SRC=${SRC:?working copy}
HERE=$(cd "$(dirname "$0")" && pwd)
. "$HERE/../ssh.env"
V=${VARIANT:-}
BASE=${BASE:-v1.1.7}
SUB=tensorfold-zig-117-20261027${V:+/variants/$V}
mkdir -p "$HERE${V:+/variants/$V}"
OUT="$HERE${V:+/variants/$V}"
cd "$SRC"
git diff "$BASE" > "$OUT/fn.patch"
git ls-files -c -o --exclude-standard | grep -v -E '^(app|docs|assets)/' | COPYFILE_DISABLE=1 tar -cf "$OUT/source.tar" -T -
cd "$OUT"
sed "s/1\.1\.7/${BASE#v}/g" "$HERE/build-117.sh" > build-117.sh
ssh -p "$SSH_PORT" "$SSH_TARGET" "mkdir -p ~/docker/benchmarks/$SUB"
scp -P "$SSH_PORT" -q fn.patch source.tar build-117.sh "$SSH_TARGET":docker/benchmarks/$SUB/
# the remote side gets the subdirectory and volume as arguments (single-quoted script, no local expansion inside)
ssh -p "$SSH_PORT" "$SSH_TARGET" bash -s -- "$SUB" "ieti-native117-${V:-fn}-build" <<'REMOTE'
set -o pipefail
docker volume create "$2" > /dev/null
docker run --rm --cpus 12 --memory 24g -v "$2":/build \
  -v ieti-qwen38-flash-next-tensorfold-zig-tuned-int4-runtime-cache:/toolchain:ro \
  -v ~/docker/benchmarks/"$1":/results \
  nvcr.io/nvidia/pytorch:26.07-py3@sha256:2140e699b3beaf7f96a0081fd9c9406bc3832b435cdb60dfa2d261f7d2f34a1c \
  bash /results/build-117.sh 2>&1 | grep --line-buffered -v -E "Ignoring unknown extended|^(=|NVIDIA|PyTorch|Container|Copyright|All rights|Various|GOVERNING|\(found|and the|NOTE|  Using|  See|$)"
REMOTE
