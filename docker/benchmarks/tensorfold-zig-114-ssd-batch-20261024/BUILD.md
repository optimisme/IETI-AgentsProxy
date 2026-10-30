# Private build of TensorFold v1.1.4

Base: `ashhart/TensorFold`, tag `v1.1.4`, commit
`eab8582819688325e371907e4706e1c602b8a273`. License: Apache 2.0,
retained in `../../patches/licenses/TensorFold-Apache-2.0.txt`.

The local modification is `../../patches/tensorfold-114-ple-batch-v1.patch`.
`tested-source/` preserves the four affected files after Zig formatting.
`compiled-source-sha256.txt` records their exact compiler inputs.

`build.sh` runs inside the pinned ARM64 PyTorch 26.07 image, with Zig 0.17.0
from the existing toolchain volume. It verifies the committed source archive,
applies the patch, formats the four files, checks host tests as an ordinary
user, and builds native CUDA kernels for SM 121. GPU access is unnecessary
for this build. The build container has four CPUs and a 10 GiB RAM limit;
these limits do not apply to the inference container.

Build volume: `ieti-native114-ple-build` at `/build`; toolchain volume:
`ieti-qwen38-flash-next-tensorfold-zig-tuned-int4-runtime-cache` at `/toolchain:ro`.
Mount this directory at `/results`, placing the patch there as `ple-batch.patch`.
The ignored `source.tar.gz` is a `git archive` of the base commit, with the
SHA-256 recorded in `provenance.json` and checked by `build.sh`.

The native build command is:

```sh
/toolchain/zig/zig build native -Dnvcc=/usr/local/cuda/bin/nvcc \
  -Dsm=121 -Doptimize=fast -Dversion=1.1.4 \
  --prefix /build/install --cache-dir /build/cache -j2 --summary all
```

The upstream version parser permits only MAJOR.MINOR.PATCH. The private
binary is identified by its SHA-256 and source/patch hashes, not by the
version string alone. The rejected prerelease version attempt is retained
in `native-build-version-rejected.log`.

The first full host run as root had two failures in unchanged voice-tool
permission tests. Both test chmod-based permission denial, which root bypasses.
`host-tests-root-attempt.log` preserves this run. The ordinary-user runs and
their full summaries are retained separately; no upstream tests were removed.
The existing lean checker reports 437 pre-existing findings both before and
after this patch, with zero new findings.

Run the experimental inference profile only while the normal inference
container is stopped. `TF_FLASHNEXT_PLE_BATCH=0` chooses unchanged per-stream
gathering; `1` groups multiple streams. `controller.py` performs the bounded
off/on comparison and restores the same original Python container in `finally`.
The test listener is loopback-only; weights are mounted read-only.
