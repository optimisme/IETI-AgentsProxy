#!/usr/bin/env bash
# Incremental native rebuild in ieti-native114-parity-build (a copy of the qualified PLE build volume).
# /results/sync.tar holds the changed source files relative to the source root; /results/parity.patch records the diff.
set -euo pipefail
cd /build/source
test "$(/toolchain/zig/zig version)" = 0.17.0
tar -xf /results/sync.tar
export ZIG_GLOBAL_CACHE_DIR=/build/global-cache
/toolchain/zig/zig build native -Dnvcc=/usr/local/cuda/bin/nvcc -Dsm=121 -Doptimize=fast \
  -Dversion=1.1.4 --prefix /build/install --cache-dir /build/cache -j4 --summary failures > /results/native-build.log 2>&1 || { grep -E "error|^zig/src" /results/native-build.log | grep -v "failed command" | head -30; exit 1; }
/build/install/native/bin/tensorfold-native --version
(cd /build/install/native/bin && sha256sum tensorfold-native > SHA256SUMS && cat SHA256SUMS)
sha256sum /results/parity.patch | cut -d' ' -f1 > /build/source-ready
echo build-complete
