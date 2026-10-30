set -euo pipefail
cd /opt/ieti-native110
if [ ! -d source ]; then
 git clone -q --no-hardlinks /prior/source source
 cp -a /prior/build-cache ./build-cache
 cp -a /prior/global-cache ./global-cache
fi
cd source
[ "$(git rev-parse HEAD)" = 76aafcf274e60a5e31a59ce145b2f71f7b366e9d ]
[ -z "$(git status --porcelain)" ]
echo "$IETI_PATCH_SHA256  /run/fp8-kv.patch" | sha256sum -c -
git apply --check /run/fp8-kv.patch
git apply /run/fp8-kv.patch
export ZIG_GLOBAL_CACHE_DIR=/opt/ieti-native110/global-cache
/toolchain/zig/zig fmt zig/src/families/flashnext/cuda_cache_type.zig zig/src/families/flashnext/cuda_prompt.zig zig/src/families/flashnext/cuda_round_graph.zig
/toolchain/zig/zig build -Dnvcc=/usr/local/cuda/bin/nvcc -Dsm=121 -Doptimize=fast --prefix /opt/ieti-native110/install --cache-dir /opt/ieti-native110/build-cache -j2 fatbins native > /results/fp8-build.log 2>&1
/toolchain/zig/zig build --cache-dir /opt/ieti-native110/build-cache -j2 test-cuda-host --summary all > /results/fp8-host-checks.log 2>&1
# These are actual device comparisons of the new cache kernels, not host stand-ins.
python3 /results/fp8_kernel_probe.py /opt/ieti-native110/install/fatbin/flashnext_attn.fatbin /results/fp8-kernel-gpu.json > /results/fp8-kernel-gpu.log 2>&1
sha256sum /opt/ieti-native110/install/native/bin/tensorfold-native > /results/fp8-native-sha256.txt
find /opt/ieti-native110/install/fatbin -type f -exec sha256sum '{}' + > /results/fp8-fatbin-sha256.txt
printf '%s\n' "$IETI_PATCH_SHA256" > /opt/ieti-native110/ready
