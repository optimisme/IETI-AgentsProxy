set -euo pipefail
container=qwen38_flash_next_cuda_vram128_tensorfold_mlx_4bit_mtp_int8_ssd_vision
volume=ieti-qwen38-flash-next-tensorfold-mlx-4bit-mtp-int8-ssd-vision-128gb-kernel-cache
# Only the test host: stop the sole cache writer before removing an abandoned compiler lock.
docker stop "$container"
if [ -n "$(docker ps --filter "volume=$volume" --format '{{.Names}}')" ];then
 echo 'Cache still has a running owner; lock cleanup refused.';exit 1
fi
docker run --rm --network none --memory 256m --entrypoint python3 -v "$volume:/cache" \
 nvcr.io/nvidia/pytorch:26.07-py3@sha256:2140e699b3beaf7f96a0081fd9c9406bc3832b435cdb60dfa2d261f7d2f34a1c \
 -c 'from pathlib import Path; p=Path("/cache/torch-extensions/tensorfold_experts_v7/lock"); print("Removed orphan CUDA extension lock" if p.exists() else "No orphan lock"); p.unlink(missing_ok=True)'
