#!/usr/bin/env bash
# Native build of TensorFold 1.1.6 plus our Flash-Next patch (and the mixed pass) in ieti-native116-fn-build.
# /results/source.tar holds the patched source tree; /results/fn.patch records the diff against v1.1.6.
set -euo pipefail
test "$(/toolchain/zig/zig version)" = 0.17.0
mkdir -p /build/source
cd /build/source
tar -xf /results/source.tar
export ZIG_GLOBAL_CACHE_DIR=/build/global-cache
/toolchain/zig/zig build native -Dnvcc=/usr/local/cuda/bin/nvcc -Dsm=121 -Doptimize=fast \
  -Dversion=1.1.6 --prefix /build/install --cache-dir /build/cache -j6 --summary failures > /results/native-build.log 2>&1 || { grep -E "error|^zig/src" /results/native-build.log | grep -v "failed command" | head -30; exit 1; }
/build/install/native/bin/tensorfold-native --version
(cd /build/install/native/bin && sha256sum tensorfold-native > SHA256SUMS && cat SHA256SUMS)
sha256sum /results/fn.patch | cut -d' ' -f1 > /build/source-ready
echo build-complete
