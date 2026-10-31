set -euo pipefail
cd /opt/ieti-shared
source_dir="source-$IETI_PATCH_SHA256"
if [ ! -d "$source_dir" ]; then
  git clone -q --no-hardlinks /prior/source "$source_dir"
  if [ ! -d build-cache ]; then cp -a /prior/build-cache ./build-cache; fi
  if [ ! -d global-cache ]; then cp -a /prior/global-cache ./global-cache; fi
  mkdir -p install
  cp -a /prior/install/fatbin install/
fi
cd "$source_dir"
test "$(git rev-parse HEAD)" = 76aafcf274e60a5e31a59ce145b2f71f7b366e9d
if [ ! -f "../applied-$IETI_PATCH_SHA256" ]; then
  test -z "$(git status --porcelain)"
  echo "$IETI_PATCH_SHA256  /run/shared.patch" | sha256sum -c -
  git apply --check /run/shared.patch
  git apply /run/shared.patch
  touch "../applied-$IETI_PATCH_SHA256"
fi
export ZIG_GLOBAL_CACHE_DIR=/opt/ieti-shared/global-cache
/toolchain/zig/zig fmt zig/src/families/flashnext/cuda_batch{,_state}.zig
/usr/local/cuda/bin/nvcc -fatbin -D__CUDA_NO_HALF_OPERATORS__ -D__CUDA_NO_HALF_CONVERSIONS__ -D__CUDA_NO_BFLOAT16_CONVERSIONS__ -D__CUDA_NO_HALF2_OPERATORS__ --expt-relaxed-constexpr -std=c++20 -O3 --fmad=false -gencode=arch=compute_121,code=sm_121 -o /opt/ieti-shared/install/fatbin/flashnext_batch.fatbin zig/kernels/cuda/flashnext_batch.cu > /results/cuda-build.log 2>&1
/toolchain/zig/zig build -Dfatbins=/opt/ieti-shared/install/fatbin -Doptimize=fast --prefix /opt/ieti-shared/install --cache-dir /opt/ieti-shared/build-cache -j2 native > /results/native-build.log 2>&1
/toolchain/zig/zig build --cache-dir /opt/ieti-shared/build-cache -j2 test-cuda-host --summary all > /results/host-contracts.log 2>&1
python3 /results/gpu_recurrent_probe.py /opt/ieti-shared/install/fatbin/flashnext_batch.fatbin /results/gpu-recurrent-contracts.json > /results/gpu-recurrent-contracts.log 2>&1
sha256sum /opt/ieti-shared/install/native/bin/tensorfold-native > /results/native-sha256.txt
sha256sum /opt/ieti-shared/install/fatbin/flashnext_batch.fatbin > /results/batch-fatbin-sha256.txt
printf '%s\n' "$IETI_PATCH_SHA256" > /opt/ieti-shared/ready
