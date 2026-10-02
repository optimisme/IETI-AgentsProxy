# CONFIGS

Models recomanats per programar segons VRAM.


## 128GB servidor multiusuari

Qwen3.8 Flash Next MLX4bit (TensorFold, MTP=6, image input)
- `qwen38-flash-next-tensorfold-vontra-mlx-4bit-mtp-int8-ssd-vision-128gb`

Qwen3.6 35B A3B NVFP4 (vLLM, MTP=3, 75k context, image input)
- `models/qwen36-35b-a3b-vllm-nvidia-nvfp4-mtp-96gb.yml`

## 128GB monolloc

Qwen3.8 Flash Next MLX4bit (TensorFold, MTP=6, image input)
- `qwen38-flash-next-tensorfold-vontra-mlx-4bit-mtp-int8-ssd-vision-128gb`

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
