# Arxiu de proves TensorFold Zig

Perfils, patches i campanyes de TensorFold Zig superats per la millor build
actual: [`../models/qwen38-flash-next-tensorfold-117-mlx-4bit-vision-128gb-best.yml`](../models/qwen38-flash-next-tensorfold-117-mlx-4bit-vision-128gb-best.yml)
i [el seu informe](../benchmarks/tensorfold-zig-117-20261027/REPORT.md).

Es conserven com a registre: 1.1.0 (`tensorfold-110-*`), 1.1.2, 1.1.4, els perfils
Zig INT4 i NVIDIA FP4 del 18 d'octubre i els patches corresponents. L'estructura
replica `docker/` (`models/`, `benchmarks/`, `patches/`), de manera que els camins
relatius entre elements arxivats continuen funcionant; els scripts que apunten a
`~/docker/models/...` a la màquina de proves s'han de corregir abans de tornar-los
a executar.

Es queden fora de l'arxiu perquè els scripts actuals en depenen:
`tensorfold-zig-114-parity-20261024` (agent i comprovacions),
`tensorfold-zig-114-ssd-batch-20261024` (mòdul de l'agent),
`tensorfold-zig-cache-tuning-20261018` (fixtures de capacitat),
`tensorfold-zig-release112-20261023` (sonda JPEG de la campanya vLLM) i
`tensorfold-zig-116-mixed-20261026` (build 1.1.6 de recanvi).
