set -euo pipefail
# Compile only during the next model reload, after the cold measurements and QA end.
while [ ! -f /results/fp8-cold-probe-complete ];do sleep 5;done
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
echo "$IETI_PATCH_SHA256  /run/mtp-batch.patch" | sha256sum -c -
git apply --check /run/mtp-batch.patch
git apply /run/mtp-batch.patch
cmp zig/kernels/cuda/flashnext_attn.cu /prior/source/zig/kernels/cuda/flashnext_attn.cu
export ZIG_GLOBAL_CACHE_DIR=/opt/ieti-native110/global-cache
/toolchain/zig/zig fmt zig/src/families/flashnext/cuda_{batch,batch_state,cache_type,glue,lanes,lanes_load,media,media_test,mtp_draft,prompt,round_graph,snap,verify_batch}.zig
/toolchain/zig/zig build -Dfatbins=/opt/ieti-native110/install/fatbin -Doptimize=fast --prefix /opt/ieti-native110/install --cache-dir /opt/ieti-native110/build-cache -j2 native > /results/mtp-batch-build.log 2>&1
/toolchain/zig/zig build --cache-dir /opt/ieti-native110/build-cache -j2 test-cuda-host --summary all > /results/mtp-batch-host-checks.log 2>&1
sha256sum /opt/ieti-native110/install/native/bin/tensorfold-native > /results/mtp-batch-native-sha256.txt
find /opt/ieti-native110/install/fatbin -type f -exec sha256sum '{}' + > /results/mtp-batch-fatbin-sha256.txt
printf '%s\n' "$IETI_PATCH_SHA256" > /opt/ieti-native110/ready
