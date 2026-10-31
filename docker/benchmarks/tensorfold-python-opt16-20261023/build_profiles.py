#!/usr/bin/env python3
"""Generate test-only profiles from the frozen original serving profile."""
from pathlib import Path
root=Path(__file__).resolve().parent
source=(root.parent/'tensorfold-python-capacity16-20261023/python-profile-snapshot.yml').read_text()
source=source.replace('name: ieti-qwen38-flash-next-tensorfold-mlx-4bit-mtp-int8-ssd-vision-128gb\n','name: ieti-qwen38-python-opt16\n',1)
source=source.replace('container_name: qwen38_flash_next_cuda_vram128_tensorfold_mlx_4bit_mtp_int8_ssd_vision','container_name: qwen38_flash_next_python_opt16')
source=source.replace('restart: unless-stopped','restart: "no"',1).replace('"8000:8000"','"127.0.0.1:8009:8000"',1)
source=source.replace('    volumes:\n','    volumes:\n      - ../benchmarks/tensorfold-python-opt16-20261023:/ieti-experiment:ro\n      - ../benchmarks/tensorfold-python-opt16-20261023/results:/ieti-results\n',1)
source=source.replace('    environment:\n','    environment:\n      IETI_RUN: "${IETI_RUN:?Set a unique experiment run ID}"\n      IETI_CANDIDATE: "baseline"\n',1)
needle='exec tensorfold serve "$${MODEL_PATH}"'
assert source.count(needle)==1
source=source.replace(needle,'exec python /ieti-experiment/instrument.py serve "$${MODEL_PATH}"',1)
name='qwen38-flash-next-python-opt16-baseline-128gb.yml'
source=source.replace('com.ieti.profile: "qwen38-flash-next-tensorfold-vontra-mlx-4bit-mtp-int8-ssd-vision-128gb.yml"',f'com.ieti.profile: "{name}"')
(root.parent.parent/'models'/name).write_text('# Test only: original inference settings with common host-side instrumentation.\n'+source)
candidate_name='qwen38-flash-next-python-opt16-reserve8-128gb.yml'
candidate=source.replace(f'com.ieti.profile: "{name}"',f'com.ieti.profile: "{candidate_name}"')
candidate=candidate.replace('IETI_CANDIDATE: "baseline"','IETI_CANDIDATE: "reserve8"\n      # Supported upstream setting; runtime growth reserve and external guard remain.\n      TENSORFOLD_MEMORY_RESERVE_GIB: "8"',1)
(root.parent.parent/'models'/candidate_name).write_text('# Test only: lower the default unified-memory floor to 8 GiB; all serving settings retained.\n'+candidate)

coalesced_name='qwen38-flash-next-python-opt16-reserve8-coalesced-128gb.yml'
coalesced=candidate.replace(f'com.ieti.profile: "{candidate_name}"',f'com.ieti.profile: "{coalesced_name}"')
coalesced=coalesced.replace('IETI_CANDIDATE: "reserve8"','IETI_CANDIDATE: "reserve8-coalesced"',1)
coalesced=coalesced.replace('/ieti-experiment/instrument.py serve','/ieti-experiment/candidate_coalesce.py serve',1)
(root.parent.parent/'models'/coalesced_name).write_text('# Unscreened experiment: 8 GiB reserve plus nearby compatible snapshot coalescing.\n'+coalesced)
