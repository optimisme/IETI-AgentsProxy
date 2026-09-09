# CONFIGS

Models recomanats per programar segons VRAM.

## 128GB servidor multiusuari

Qwen3.6 35B A3B NVFP4 (vLLM, MTP=3, 75k context, image input)
- `models/qwen36-35b-a3b-vllm-nvidia-nvfp4-mtp-96gb.yml`

## 128GB monolloc

Qwen3.8 27B UD-Q6_K_XL (vLLM, DFlash2, 100k context, image input)
- `models/qwen38-27b-vllm-unsloth-q6_k_xl-dflash2-128gb.yml`

Qwen3.8 27B UD-Q2_K_XL (llama.cpp, native MTP, 64k context)
- `models/qwen38-27b-llamacpp-unsloth-q2_k_xl-16gb.yml`

## 16GB monolloc

Qwen3.6 35B A3B (llama.cpp, MTP, image input)
- `models/qwen36-35b-a3b-base-llamacpp-localweights-iq4_xs-16gb.yml`

## 12GB monolloc

Qwen3.5 9B Q6_K (llama.cpp, 32k context)
- `models/qwen35-9b-llamacpp-unsloth-q6_k-12gb.yml`

## 8GB monolloc

Qwen3.5 9B Q4_K_M (llama.cpp, 8k context)
- `models/qwen35-9b-llamacpp-unsloth-q4_k_m-8gb.yml`
