# TensorFold Python opt16 policies

GPU-qualified runtime bundle for the pinned v0.6.5 deployment and documented
sixteen-user workloads. Three matched timing pairs show 43.98% less total elapsed
time in the returning-context test; cold batch completion is about 7% slower.
Qualification, raw evidence and limits live in
`../../benchmarks/tensorfold-python-opt16-20261023/REPORT.md`. The public profile
was synchronized; the original service was restored after tests.

The launcher installs the tested compatible-prefix retention, pressure-aware
snapshot retention/unused-allocator trimming and eager final KV tail policies.
`serve.py` records the selected prefill threshold and all bundle source hashes.
The model checkpoint, INT8 KV, MTP, SSD batching and native vision remain those of
the original deployment. The YAML sets upstream memory reserve to 8 GiB.

This bundle performs no benchmark tracing, CUDA synchronizations or persistent
conversation storage. `policy_runtime.py` is a no-op event sink and local counters
used to preserve the screened policy bodies. Installed upstream files are checked
against the exact source hashes captured from the running baseline; startup fails
on drift. The normal KEEP64 and SSD patches remain explicit in the YAML.

Pressure pruning can discard older conversation branch checkpoints, trading an
old-branch cache hit for space. It retains at least the newest checkpoint of each
retained slot. Coalescing preserves a compatible earlier checkpoint within 255
tokens on the same slot, which can require a small amount of extra prefill.
The eager tail allocates the final partial KV step early (at the tested window,
73,728 -> 75,007 capacity), avoiding a measured late resize reservation spike.

Local `docker/` is authoritative. Synchronize the YAML and this whole directory
to the remote machine's own `~/docker/`, then start Compose there. Do not run it
alongside another model service on this GPU. The normal cache volumes persist.
The public profile uses port 8000; the release qualification copy uses private
loopback port 8009 and is automatically stopped afterward.

Pinned upstream: https://github.com/ashhart/TensorFold/tree/609ca419abecebdc5a059498a613680bd3aa847f
Upstream license: `../licenses/TensorFold-Apache-2.0.txt`.

`constraints.txt` records all 225 installed distribution versions shared by the
unchanged baseline and finalist. The reusable YAML applies these constraints;
the pinned NVIDIA image already supplies its vendor builds. Release qualification
checks the resulting inventory rather than assuming the lock reproduces it.

The lock uses effective first-path `importlib.metadata.version` resolution.
Inherited image/system metadata also reports older copies of Hugging Face Hub,
hf-xet, setuptools and wheel; the original raw inventory masked these versions.
The audit preserves that original record and proves older trials used identical
image/venv bootstrap and complete pip installation versions. The corrected lock
uses active versions, not the shadowed metadata entries.
