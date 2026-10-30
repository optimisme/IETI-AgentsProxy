set -euo pipefail
cd /opt/ieti-native110
if [ ! -d source ];then
 git clone -q --no-hardlinks /prior/source source
 cp -a /prior/build-cache ./build-cache
 cp -a /prior/global-cache ./global-cache
 mkdir -p install
 cp -a /prior/install/fatbin install/
fi
cd source
[ "$(git rev-parse HEAD)" = 76aafcf274e60a5e31a59ce145b2f71f7b366e9d ]
[ -z "$(git status --porcelain)" ]
echo "$IETI_PATCH_SHA256  /run/graph-v2.patch" | sha256sum -c -
git apply --check /run/graph-v2.patch
git apply /run/graph-v2.patch
# The device code is exactly the FP8-v1 code that passed seventeen GPU checks.
cmp zig/kernels/cuda/flashnext_attn.cu /prior/source/zig/kernels/cuda/flashnext_attn.cu
export ZIG_GLOBAL_CACHE_DIR=/opt/ieti-native110/global-cache
/toolchain/zig/zig fmt zig/src/families/flashnext/cuda_cache_type.zig zig/src/families/flashnext/cuda_prompt.zig zig/src/families/flashnext/cuda_round_graph.zig
/toolchain/zig/zig build -Dfatbins=/opt/ieti-native110/install/fatbin -Doptimize=fast --prefix /opt/ieti-native110/install --cache-dir /opt/ieti-native110/build-cache -j2 native > /results/graph-v2-build.log 2>&1
/toolchain/zig/zig build --cache-dir /opt/ieti-native110/build-cache -j2 test-cuda-host --summary all > /results/graph-v2-host-checks.log 2>&1
sha256sum /opt/ieti-native110/install/native/bin/tensorfold-native > /results/graph-v2-native-sha256.txt
find /opt/ieti-native110/install/fatbin -type f -exec sha256sum '{}' + > /results/graph-v2-fatbin-sha256.txt
printf '%s\n' "$IETI_PATCH_SHA256" > /opt/ieti-native110/ready
