set -euo pipefail
source_revision=76aafcf274e60a5e31a59ce145b2f71f7b366e9d
cd /opt/ieti-native110
if [ ! -d source/.git ]; then
 git init -q source
 git -C source remote add origin https://github.com/ashhart/TensorFold.git
 git -C source fetch -q --depth 1 origin "$source_revision"
 git -C source checkout -q --detach FETCH_HEAD
fi
[ "$(git -C source rev-parse HEAD)" = "$source_revision" ]
cd source
# Refuse an already modified build tree rather than silently resetting it.
[ -z "$(git status --porcelain)" ]
echo "$IETI_PATCH_SHA256  /run/single-gpu-graph.patch" | sha256sum -c -
git apply --check /run/single-gpu-graph.patch
git apply /run/single-gpu-graph.patch
export ZIG_GLOBAL_CACHE_DIR=/opt/ieti-native110/global-cache
/toolchain/zig/zig fmt zig/src/families/flashnext/cuda_round_graph.zig
/toolchain/zig/zig build -Dnvcc=/usr/local/cuda/bin/nvcc -Dsm=121 -Doptimize=fast --prefix /opt/ieti-native110/install --cache-dir /opt/ieti-native110/build-cache -j2 fatbins native > /results/graph-build.log 2>&1
/toolchain/zig/zig build --cache-dir /opt/ieti-native110/build-cache -j2 test-cuda-host --summary all > /results/graph-host-checks.log 2>&1
sha256sum /opt/ieti-native110/install/native/bin/tensorfold-native > /results/graph-native-sha256.txt
find /opt/ieti-native110/install/fatbin -type f -exec sha256sum '{}' + > /results/graph-fatbin-sha256.txt
git diff --stat > /results/graph-source-diff-stat.txt
printf '%s\n' "$IETI_PATCH_SHA256" > /opt/ieti-native110/ready
