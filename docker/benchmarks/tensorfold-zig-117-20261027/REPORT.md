# TensorFold Zig 1.1.7: millor build de Flash-Next per a setze alumnes

**La millor build és TensorFold 1.1.7 amb el nostre patch de Flash-Next, el pas
mixt i els drafts mostrejats de MiaAI-Lab (0007, 0008, 0011). En la càrrega
d'agent de setze usuaris supera lleugerament el Python en tokens/s agregats
(107 davant de 105 a temperatura 0) i, a temperatura 0,55, guanya un 8,5%
respecte de la mateixa build sense els drafts mostrejats.** La resta de patches
de MiaAI-Lab, el checkpoint NVIDIA NVFP4 i un drafter propi s'han descartat.

El model és **Qwen3.8 Flash-Next** amb el checkpoint **MLX 4 bits**
(`TensorFold/Qwen3.8-Flash-Next-MLX-4bit-MTP`): pesos enters de 4 bits amb
escales i biaixos bf16 per grup. No és FP4 ni NVFP4. Les proves s'han fet a la
GB10 experimental del port SSH 2226; la màquina de referència no s'ha utilitzat.

## Com s'arrenca

- Perfil: [`qwen38-flash-next-tensorfold-117-mlx-4bit-vision-128gb-best.yml`](../../models/qwen38-flash-next-tensorfold-117-mlx-4bit-vision-128gb-best.yml)
- A la 2226: `bash ~/docker/benchmarks/tensorfold-zig-117-20261027/up-117.sh`
  (posa el volum `ieti-native117-sampled-build` i el resum SHA-256 del patch).
- Patch de la millor build: [`best/best.patch`](best/best.patch), idèntic a
  [`variants/sampled/fn.patch`](variants/sampled/fn.patch).
- Configuració: 16 fluxos, finestra de 75.000 tokens, KV fp8 (files int8),
  MTP6 amb confiança 0,60, trossos de prompt de 4096 files (2048 mentre es
  descodifica), cache de prompts elàstica de fins a 12 GiB, visió activada,
  temperatura per defecte del servidor 0,1.
- Escollir el checkpoint: `TENSORFOLD_MODEL_ID`, `TENSORFOLD_MODEL_REVISION` i
  `TENSORFOLD_CHECKPOINT_VOLUME` (per defecte, MLX 4 bits).

## Resultat principal

Càrrega `agent.py` amb l'etiqueta `py16-u16` (els mateixos prompts que es van
fer servir per al Python): setze usuaris en bucle tancat, vuit torns cadascun,
prompt de sistema compartit, historial que creix i resultats d'eines reals.
Prompts de 13.900 tokens de mitjana i 21.600 de màxim. 128 peticions, cap error.

| Servidor | Temperatura | tokens/s agregats | TTFT 1r torn p50 | TTFT torns següents p50 / p95 | descodificació per usuari p50 |
|---|---|---|---|---|---|
| Python (perfil de producció) | 0 | 105,1 | 64,5 s | 3,2 / 6,6 s | 9,0 |
| Zig 1.1.6 (`tf116-20261026c`) | 0 | 108,4 / 104,9 | 3,0–3,3 s | 3,5 / 14–15 s | 8,1–8,2 |
| Zig 1.1.7 sense drafts mostrejats | 0 | 110,5 / 107,4 | 3,3 s | 3,5 / 14 s | 8,2 |
| **Zig millor build** | 0 | **107,1 / 106,9** | 2,7–3,2 s | 3,4–3,6 / 14–15 s | 8,2 |
| Zig 1.1.7 sense drafts mostrejats | 0,55 | 94,8 / 94,7 | 3,2 s | 3,3 / 13,2 s | 7,4 |
| **Zig millor build** | 0,55 | **102,8 / 102,9** | 3,1 s | 3,75 / 15,3 s | 8,1 |

Dues passades per configuració, cadascuna amb el servidor acabat d'arrencar.
La dispersió entre passades és d'un 1–3%.

- El Zig guanya en tokens/s agregats i, sobretot, en el TTFT del primer torn
  (3 s davant de 64 s).
- El Python guanya en el p95 del TTFT dels torns següents (6,6 s davant de
  14–15 s) i en la velocitat per usuari (9,0 davant de 8,1–8,2 tokens/s).
- El Python només s'ha mesurat a temperatura 0. A temperatura 0,55 no hi ha
  comparació directa.

## Context de 75k

Sí: el servidor arrenca amb 16 fluxos a 75.000 tokens i KV fp8, amb el model
(80,2 GiB) i la cache de prompts a la memòria. Ara bé, la llargada provada és
menor:

- les agulles passen 9 de 9 a 10.200, 25.986 i 46.196 tokens;
- els prompts de la càrrega d'agent arriben a 21.600 tokens.

**No s'ha mesurat setze usuaris amb prompts propers als 75k amb aquesta build.**
Només el Python té aquesta prova
([`tensorfold-python-capacity16-20261023`](../tensorfold-python-capacity16-20261023/ASSESSMENT.md)).

## Què inclou la millor build

1. **TensorFold 1.1.7.** Rebase del nostre patch: un 2% més ràpid que 1.1.6 en
   la càrrega d'agent (110,5 / 107,4 davant de 108,4 / 104,9).
2. **El nostre patch de Flash-Next:** recollida del següent tros de prompt
   mentre corre l'actual, cache de prompts elàstica, KV int8, trossos adaptatius
   i el **pas mixt** (un tros de prompt i la ronda de descodificació en un sol
   pas, amb els experts llegits una sola vegada).
3. **MiaAI-Lab 0007, 0008 i 0011:** les peticions mostrejades fan servir el
   drafter en lot. Abans les peticions amb temperatura més gran que 0 se'n
   quedaven fora, i el servidor mostreja per defecte (0,1). Cost abans del
   canvi: −10,4% a 0,1 i −13,7% a 0,55. Guany en el cribratge: +12,0%
   (`TF_FLASHNEXT_SAMPLED_HEADS` +10,7%, `TF_FLASHNEXT_SAMPLE_CAND` +1,2%).

## Què s'ha descartat

| Candidat | Resultat | Motiu |
|---|---|---|
| MiaAI-Lab 0017, regla d'aturada dels drafts | confiança 0,5 / 0,7: −0,4% / −0,1%; producte acumulat amb 5 / 16 fluxos: −0,6% / −0,2% | Soroll |
| MiaAI-Lab 0012, files DeltaNet dels drafts rebutjats a la verificació següent | +0,5% | Soroll; necessita uns 38 MiB més per flux i no hi cap amb 16 fluxos a 75k (27,45 GiB necessaris, 26,84 disponibles) |
| MiaAI-Lab 0016, DeltaNet de tots els carrils en un llançament | +1,2% amb 0012 | Soroll; l'altra meitat (expert compartit en paral·lel) només existeix al camí NVFP4 |
| MiaAI-Lab 0014, lectura HC fusionada | — | Necessita pesos HC bf16; el checkpoint MLX els té en 4 bits |
| MiaAI-Lab 0006, prompts més ràpids | — | 1.1.7 ja té kernels equivalents i només buida la GPU un cop per prompt |
| Checkpoint NVIDIA NVFP4 (`nvidia/Qwen3.8-Flash-Next-FP4-Local`) | 102,4 davant de 111,0 tokens/s (−7,7%) | Omple els prompts més ràpid, però descodifica més lent |
| Drafter propi | — | El drafter MTP ja accepta el 68–71% dels drafts (3,3 tokens per ronda de verificació, igual a temperatura 0 i 0,55) i Flash-Next ja copia de l'historial de cada flux; guany màxim estimat d'un 10%, amb setmanes d'entrenament a la mateixa màquina |
| Ajustos: trossos de 3072 / 4096 files mentre es descodifica, quota de prompt 0,75 / 0,5 | +0,2% / +0,6%, −0,2% / −0,9% | Soroll; es mantenen els valors per defecte |

Les altres patches de MiaAI-Lab no van entrar a la llista curta en comparar els
dos repositoris i no s'han portat.

## Comprovacions d'exactitud

Cada candidat ha de donar exactament el mateix text que la build de referència:

- **greedy junts = sols:** vuit prompts de codi enviats alhora i un per un, en
  dues rondes; 8/8 idèntics a totes les builds;
- **agulles:** 9 de 9 (10k–46k tokens) a totes les builds MLX i NVFP4;
- **respostes greedy:** 8 de 8 iguals a les de la build anterior; el NVFP4 en
  dona 2 de 8 iguals, com és d'esperar amb pesos diferents;
- **mostrejades amb llavor fixa** ([`sampled_check.py`](sampled_check.py)):
  amb draft = sense draft, junts = sols, i iguals amb els camins nous activats
  o no; 8 de 8 a totes les builds.

## Mètode

- [`quick.sh`](quick.sh): cribratge, una passada de cinc torns per candidat
  amb el servidor reiniciat (uns 8 minuts cadascuna). La confirmació d'un
  guanyador és `TURNS=8 PASSES=2 CHECK=1`. Un guany s'accepta si supera el 3%
  en el cribratge i es manté en la confirmació.
- [`check-117.sh`](check-117.sh), [`check-sampled.sh`](check-sampled.sh),
  [`check-decode.sh`](check-decode.sh): exactitud de cada build.
- [`bench-117.sh`](bench-117.sh): 1.1.7 davant de 1.1.6, alternats dues vegades.
- [`sync-build.sh`](sync-build.sh) i [`build-117.sh`](build-117.sh): compilació
  a la 2226; `VARIANT=nom` deixa cada candidat a `variants/<nom>/` i al volum
  `ieti-native117-<nom>-build`.
- Els scripts de càrrega (`agent.py`, `greedy_check.py`, `kv8_check.py`) són a
  [`../tensorfold-zig-114-parity-20261024/`](../tensorfold-zig-114-parity-20261024/).
- Dades: [`results/`](results/) conté el resum de cada etapa
  (`quick-<etapa>/summary.txt`), el `summary.json` de cada passada d'agent i els
  registres de les comprovacions.

## Builds i noms

| Nom | Contingut | Patch | Volum a la 2226 |
|---|---|---|---|
| **best** | 1.1.7 + patch + pas mixt + drafts mostrejats | [`best/best.patch`](best/best.patch) | `ieti-native117-sampled-build` |
| tf117-20261027 | 1.1.7 + patch + pas mixt | [`tf117-20261027/fn.patch`](tf117-20261027/fn.patch) | `ieti-native117-fn-build` |
| variants/stop | millor + 0017 | [`variants/stop/fn.patch`](variants/stop/fn.patch) | `ieti-native117-stop-build` |
| variants/decode | millor + 0012 + 0016 (meitat DeltaNet) | [`variants/decode/fn.patch`](variants/decode/fn.patch) | `ieti-native117-decode-build` |
| tf116-20261026c | 1.1.6 + patch + pas mixt | `../tensorfold-zig-116-mixed-20261026/tf116-20261026c/fn.patch` | `ieti-native116-tf20261026c` |
| tf114-20261026b | 1.1.4 + patch | `../tensorfold-zig-114-parity-20261024/tf114-20261026b.patch` | `ieti-native114-tf20261026b` |

Els arxius `source.tar` (61 MB, còpia del codi de TensorFold) no es versionen;
cada build es pot refer aplicant el seu patch a TensorFold 1.1.7.
