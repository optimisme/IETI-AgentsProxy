# CONFIGS

Models recomanats per programar segons VRAM.

## Local CPU (Docker Desktop / Apple Silicon)

Qwen3.5 2B UD-Q4_K_XL (llama.cpp b10853, 128k context, projector BF16)
- `models/qwen35-2b-llamacpp-unsloth-ud-q4_k_xl-local.yml`
- Perfil local amb port limitat a `127.0.0.1:8000`; no requereix NVIDIA.
- MTP desactivat: els pesos fixats no contenen capes MTP i `draft-mtp` falla
  durant la carrega. La resta de parametres de generacio segueixen la captura.
- CPU dins de Docker Desktop; no utilitza Metal.
- Provat el 2026-09-14 amb Docker ARM64 i 4 GiB: health, descoberta i resposta
  de text correctes amb context de 131072. La prova d'imatge amb un minim de
  1024 tokens ha superat 240 segons; visio configurada pero no verificada.

## 128GB servidor multiusuari

Qwen3.6 35B A3B NVFP4 (vLLM, MTP=3, 75k context, image input)
- `models/qwen36-35b-a3b-vllm-nvidia-nvfp4-mtp-96gb.yml`

## 128GB monolloc

Qwen3.8 27B UD-Q6_K_XL (vLLM, DFlash2, 100k context, image input)
- `models/qwen38-27b-vllm-unsloth-q6_k_xl-dflash2-128gb.yml`

Qwen3.8 27B UD-Q2_K_XL (llama.cpp, native MTP, 64k context)
- `models/qwen38-27b-llamacpp-unsloth-q2_k_xl-16gb.yml`

## 16GB monolloc (64GB RAM)

Ternary Bonsai 2 27B PTQ1_0 (PrismML llama.cpp, 16 GB VRAM, image input)
- `models/ternary-bonsai-2-27b-llamacpp-prism-ptq1_0-16gb.yml`
- Uses the PrismML CUDA release because stock llama.cpp cannot load PTQ1_0.
- The Q8_0 vision projector runs in system RAM to leave approximately 0.9 GiB
  of VRAM available for the model and KV cache.

## 8GB monolloc

Qwen3.5 2B Q4_K_XL (llama.cpp, 130k context)
- `models/qwen35-2b-llamacpp-unsloth-ud-q4_k_xl-local.yml`
