set -euo pipefail
run_dir="$HOME/docker/benchmarks/tensorfold-zig-release110-20261018"
exec > "$run_dir/mtp-head-routed-build-controller.log" 2>&1
# Wait until the timed GPU comparison and retrieval checks finish.
for attempt in $(seq 1 360);do
 [ ! -f "$run_dir/mtp2-cold-complete" ] || break
 sleep 5
done
test -f "$run_dir/mtp2-cold-complete"
docker run --rm --name ieti-native110-build --cpus 4 --memory 10g --entrypoint bash \
 -e IETI_PATCH_SHA256=3c7647452c79b628cb17e1d3dbd26945bf1af6248a9f129d427b02b8367a2bf2 \
 -v ieti-native110-mtp-head-routed-v3-build:/opt/ieti-native110 \
 -v ieti-native110-graph-v2-build:/prior:ro \
 -v ieti-qwen38-flash-next-tensorfold-zig-tuned-int4-runtime-cache:/toolchain:ro \
 -v "$HOME/docker/patches/tensorfold-110-fp8-batched-mtp-v3.patch:/run/mtp-head-routed.patch:ro" \
 -v "$run_dir:/results" \
 nvcr.io/nvidia/pytorch:26.07-py3@sha256:2140e699b3beaf7f96a0081fd9c9406bc3832b435cdb60dfa2d261f7d2f34a1c \
 /results/build_batched_mtp_head_routed.sh
