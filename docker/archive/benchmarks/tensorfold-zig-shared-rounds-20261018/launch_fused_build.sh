set -euo pipefail
run_dir="$HOME/docker/benchmarks/tensorfold-zig-shared-rounds-20261018"
exec > "$run_dir/fused-build-controller.log" 2>&1
trap 'printf "%s\n" "$?" > "$run_dir/fused-build-exit-code"' EXIT
# Do not compile or run kernel probes during timed inference of the first candidate.
while [ ! -f "$run_dir/controller-exit-code" ]; do sleep 5; done
patch_sha=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["sha256"])' "$run_dir/fused-patch-manifest.json")
docker run --rm --name ieti-shared-fused-build --gpus all --cpus 4 --memory 10g --entrypoint bash \
  -e IETI_PATCH_SHA256="$patch_sha" \
  -v ieti-native110-shared-fused-recurrent-v5-build:/opt/ieti-shared \
  -v ieti-native110-mtp-head-routed-v3-build:/prior:ro \
  -v ieti-qwen38-flash-next-tensorfold-zig-tuned-int4-runtime-cache:/toolchain:ro \
  -v "$HOME/docker/patches/tensorfold-110-shared-fused-recurrent-v5.patch:/run/shared.patch:ro" \
  -v "$run_dir:/results" \
  nvcr.io/nvidia/pytorch:26.07-py3@sha256:2140e699b3beaf7f96a0081fd9c9406bc3832b435cdb60dfa2d261f7d2f34a1c \
  /results/build_fused.sh
