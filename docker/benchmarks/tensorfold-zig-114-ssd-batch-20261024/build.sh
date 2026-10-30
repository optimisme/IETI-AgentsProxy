#!/usr/bin/env bash
set -euo pipefail
cd /build
test "$(/toolchain/zig/zig version)" = 0.17.0
echo 'f33f834022caf917bab189d19c1f32df75d70d1bd554504ea9aef0e0df11491a  /results/source.tar.gz' | sha256sum -c -
patch_sha=$(sha256sum /results/ple-batch.patch | cut -d' ' -f1)
if [ "$(cat source-ready 2>/dev/null || true)" != "$patch_sha" ]; then
  rm -rf /build/source
  mkdir -p source
  tar -xzf /results/source.tar.gz -C source
  cd source
  git apply --check /results/ple-batch.patch
  git apply /results/ple-batch.patch
  /toolchain/zig/zig fmt zig/src/families/flashnext/cuda_ple.zig \
    zig/src/families/flashnext/cuda_ple_windows.zig \
    zig/src/families/flashnext/cuda_batch_state.zig \
    zig/src/families/flashnext/cuda_ple_pool_gather_test.zig
  cd ..
  printf '%s\n' "$patch_sha" > source-ready
fi
export ZIG_GLOBAL_CACHE_DIR=/build/global-cache
mkdir -p "$ZIG_GLOBAL_CACHE_DIR"
cd source
python3 tools/zig/lean_check.py > /results/lean-after.txt || true
sha256sum zig/src/families/flashnext/cuda_{ple,ple_windows,batch_state,ple_pool_gather_test}.zig > /results/compiled-source-sha256.txt
# Permission-refusal tests must run as an ordinary user, not the image's root.
chown -R nobody:nogroup /build/source /build/cache /build/global-cache
runuser -u nobody -- /toolchain/zig/zig build test-cuda-host --cache-dir /build/cache -j2 --summary all > /results/host-tests.log 2>&1
printf '%s\n' host-tests-passed
/toolchain/zig/zig build native -Dnvcc=/usr/local/cuda/bin/nvcc -Dsm=121 -Doptimize=fast \
  -Dversion=1.1.4 --prefix /build/install --cache-dir /build/cache -j2 --summary all > /results/native-build.log 2>&1
/build/install/native/bin/tensorfold-native --version > /results/version.txt
sha256sum /build/install/native/bin/tensorfold-native > /results/binary-sha256.txt
(cd /build/install/native/bin && sha256sum tensorfold-native > SHA256SUMS)
printf '%s\n' build-complete
