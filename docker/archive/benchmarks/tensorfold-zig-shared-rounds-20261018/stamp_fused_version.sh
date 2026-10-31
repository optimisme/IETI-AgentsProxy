set -euo pipefail
run_dir="$HOME/docker/benchmarks/tensorfold-zig-shared-rounds-20261018"
exec > "$run_dir/fused-version-build.log" 2>&1
while [ ! -f "$run_dir/fused-build-exit-code" ];do sleep 2;done
test "$(cat "$run_dir/fused-build-exit-code")" = 0
test -s "$run_dir/gpu-fused-contracts.json"
docker run --rm --name ieti-shared-version-build --cpus 4 --memory 10g --entrypoint bash \
  -v ieti-native110-shared-fused-recurrent-v5-build:/opt/ieti-shared \
  -v ieti-qwen38-flash-next-tensorfold-zig-tuned-int4-runtime-cache:/toolchain:ro \
  -v "$run_dir:/results" \
  nvcr.io/nvidia/pytorch:26.07-py3@sha256:2140e699b3beaf7f96a0081fd9c9406bc3832b435cdb60dfa2d261f7d2f34a1c \
  -lc '
set -euo pipefail
cd /opt/ieti-shared/source-e5759648dcca018b0f53a1e09ce36dae182a743094784fb6e4cecfc4eeee0a0c
test "$(git rev-parse HEAD)" = 76aafcf274e60a5e31a59ce145b2f71f7b366e9d
export ZIG_GLOBAL_CACHE_DIR=/opt/ieti-shared/global-cache
/toolchain/zig/zig build -Dversion=1.1.0 -Dfatbins=/opt/ieti-shared/install/fatbin -Doptimize=fast --prefix /opt/ieti-shared/install --cache-dir /opt/ieti-shared/build-cache -j2 native
/opt/ieti-shared/install/native/bin/tensorfold-native --version > /results/fused-native-version.txt
grep -q "1.1.0" /results/fused-native-version.txt
sha256sum /opt/ieti-shared/install/native/bin/tensorfold-native > /results/fused-native-sha256.txt
sha256sum /opt/ieti-shared/install/fatbin/flashnext_batch.fatbin > /results/fused-batch-fatbin-after-version-sha256.txt
cmp /results/fused-batch-fatbin-sha256.txt /results/fused-batch-fatbin-after-version-sha256.txt
touch /results/fused-version-ready
'
