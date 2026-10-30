set -euo pipefail
set -a
. /run/secrets/tokens.env
set +a
if [ -n "${HUGGINGFACE_ACCESS_TOKENS:-}" ]; then
  export HF_TOKEN="${HUGGINGFACE_ACCESS_TOKENS}"
fi
python3 - <<'PY_ARGS'
import os
context, streams = int(os.environ['CONTEXT_LENGTH']), int(os.environ['PARALLEL_STREAMS'])
if not 1 <= streams <= 16 or not 1 <= context <= 262144:
    raise SystemExit('Expected 1-16 streams and 1-262144 context tokens')
PY_ARGS
python3 -m venv --system-site-packages /opt/ieti-zig/venv
. /opt/ieti-zig/venv/bin/activate
if [ "$(cat /opt/ieti-zig/ready 2>/dev/null || true)" != "${RECIPE_REVISION}" ]; then
  rm -f /opt/ieti-zig/ready
  python -m pip install 'huggingface_hub>=1.0'
  python -m pip install --no-deps 'transformers==5.17.0' 'av==19.0.1'
  rm -rf /opt/mia-recipe /tensorfold
  git init -q /opt/mia-recipe
  git -C /opt/mia-recipe remote add origin https://github.com/MiaAI-Lab/Qwen3.8-Flash-Next-Single-DGX-Spark-TensorFold.git
  git -C /opt/mia-recipe fetch -q --depth 1 origin "${RECIPE_REVISION}"
  git -C /opt/mia-recipe checkout -q --detach FETCH_HEAD
  test "$(git -C /opt/mia-recipe rev-parse HEAD)" = "${RECIPE_REVISION}"
  cat /opt/mia-recipe/patches/*.patch | sha256sum | awk -v expected="${PATCHES_SHA256}" '$1 != expected { exit 1 }'
  git init -q /tensorfold
  git -C /tensorfold remote add origin https://github.com/ashhart/TensorFold.git
  git -C /tensorfold fetch -q --depth 1 origin "${TF_REVISION}"
  git -C /tensorfold checkout -q --detach FETCH_HEAD
  test "$(git -C /tensorfold rev-parse HEAD)" = "${TF_REVISION}"
  cd /tensorfold
  for patch in /opt/mia-recipe/patches/*.patch; do
    git apply --check "$patch"
    git apply "$patch"
  done
  curl -fsSL -o /opt/ieti-zig/zig.tar.xz "https://ziglang.org/download/${ZIG_VERSION}/zig-aarch64-linux-${ZIG_VERSION}.tar.xz"
  echo "${ZIG_SHA256}  /opt/ieti-zig/zig.tar.xz" | sha256sum -c -
  mkdir -p /opt/ieti-zig/zig
  tar -xJf /opt/ieti-zig/zig.tar.xz -C /opt/ieti-zig/zig --strip-components=1
  rm /opt/ieti-zig/zig.tar.xz
  /opt/ieti-zig/zig/zig build -Dnvcc=/usr/local/cuda/bin/nvcc -Doptimize=fast --prefix /opt/ieti-zig/install --cache-dir /opt/ieti-zig/build-cache -j2 fatbins install native
  python - <<'PY_MTIME'
import json, os
for name in sorted({k['source']['file'] for k in json.load(open('zig/tests/cuda/flashnext/kernels.json'))['kernels']}):
    os.utime(os.path.join('src', name), (1791318675, 1791318675))
PY_MTIME
  PYTHONPATH=/tensorfold/src python -B tools/zig/flashnext_aot.py build \
    --spec zig/tests/cuda/flashnext/kernels.json --jit zig/tests/cuda/flashnext/jit.json --tp 1 \
    --out "${TENSORFOLD_CUDA_KERNELS}" > /opt/ieti-zig/aot.log 2>&1 || true
  tail -n 20 /opt/ieti-zig/aot.log
  grep -q 'kernels ->' /opt/ieti-zig/aot.log
  if grep PROBLEM /opt/ieti-zig/aot.log | grep -v 'cubin sha256'; then exit 1; fi
  test -f "${TENSORFOLD_CUDA_KERNELS}/aot.json"
  mkdir -p /opt/ieti-zig/python /opt/ieti-zig/licenses
  cp -a src/tensorfold /opt/ieti-zig/python/
  for item in LICENSE LICENSE.md LICENSES NOTICE THIRD_PARTY_NOTICES.md; do
    if [ -e "$item" ]; then cp -a "$item" /opt/ieti-zig/licenses/; fi
  done
  cp /opt/mia-recipe/LICENSE /opt/ieti-zig/licenses/MiaAI-LICENSE
  test -x /opt/ieti-zig/install/native/bin/tensorfold-native
  echo "${RECIPE_REVISION}" > /opt/ieti-zig/ready
fi
# These host-only changes reuse the pinned CUDA assets and rebuild the native executable.
if [ "$(cat /opt/ieti-zig/ieti-cache-ready 2>/dev/null || true)" != "${IETI_CACHE_PATCH_SHA256}" ]; then
  echo "${IETI_CACHE_PATCH_SHA256}  /run/ieti-cache.patch" | sha256sum -c -
  rm -rf /opt/mia-recipe /tensorfold
  git init -q /opt/mia-recipe
  git -C /opt/mia-recipe remote add origin https://github.com/MiaAI-Lab/Qwen3.8-Flash-Next-Single-DGX-Spark-TensorFold.git
  git -C /opt/mia-recipe fetch -q --depth 1 origin "${RECIPE_REVISION}"
  git -C /opt/mia-recipe checkout -q --detach FETCH_HEAD
  cat /opt/mia-recipe/patches/*.patch | sha256sum | awk -v expected="${PATCHES_SHA256}" '$1 != expected { exit 1 }'
  git init -q /tensorfold
  git -C /tensorfold remote add origin https://github.com/ashhart/TensorFold.git
  git -C /tensorfold fetch -q --depth 1 origin "${TF_REVISION}"
  git -C /tensorfold checkout -q --detach FETCH_HEAD
  test "$(git -C /tensorfold rev-parse HEAD)" = "${TF_REVISION}"
  cd /tensorfold
  for patch in /opt/mia-recipe/patches/*.patch; do git apply --check "$patch"; git apply "$patch"; done
  git apply --check /run/ieti-cache.patch
  git apply /run/ieti-cache.patch
  /opt/ieti-zig/zig/zig build -Dnvcc=/usr/local/cuda/bin/nvcc -Doptimize=fast --prefix /opt/ieti-zig/ieti-native-build --cache-dir /opt/ieti-zig/build-cache -j2 native
  /opt/ieti-zig/zig/zig build --cache-dir /opt/ieti-zig/build-cache -j2 test --summary all > /opt/ieti-zig/ieti-cache-tests.log 2>&1
  tail -n 25 /opt/ieti-zig/ieti-cache-tests.log
  # Install only after tests pass; rename avoids overwriting a running executable.
  mv /opt/ieti-zig/ieti-native-build/native/bin/tensorfold-native /opt/ieti-zig/install/native/bin/tensorfold-native
  echo "${IETI_CACHE_PATCH_SHA256}" > /opt/ieti-zig/ieti-cache-ready
fi
if [ "${IETI_CACHE_TIMINGS}" = 1 ]; then export TF_FLASHNEXT_PASS_TIMES=1; else unset TF_FLASHNEXT_PASS_TIMES; fi

sha256sum /opt/ieti-zig/install/native/bin/tensorfold-native > /results/native-sha256-v2.txt
cp /opt/ieti-zig/ieti-cache-tests.log /results/build-tests-v2.log
