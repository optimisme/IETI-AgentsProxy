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
(80,2 GiB) i la cache de prompts a la memòria. Les agulles passen a 16k, 65k i
74k tokens, i setze peticions de 74.000 tokens acaben totes (48 de 48). Però
amb contextos plens el Zig és més lent que el Python i el marge de memòria és
just: vegeu [Proves de preparació](#proves-de-preparació-per-substituir-la-2225).

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

## Proves de preparació per substituir la 2225

Fetes el 28 d'octubre de 2026 a la 2226 amb [`prod-check.sh`](prod-check.sh) i
[`zig_probe.py`](zig_probe.py) (la sonda de la campanya de capacitat del Python
adaptada al `/health` del Zig). Dades a [`results/prod/`](results/prod/).

**Conclusió: el Zig és estable, correcte i funciona amb OpenCode, però no
supera clarament el Python.** Empaten en tokens/s amb la càrrega d'agent. El
Zig respon molt abans el primer torn, i el Python té millor la cua dels torns
següents i va més ràpid amb contextos plens.

### Python davant de Zig a temperatura 0,1

Càrrega `py16-u16` de vuit torns, dues passades alternades, cada servidor
acabat d'arrencar. Prompts de fins a 21.800 tokens, 128 peticions per passada,
cap error.

| Servidor | tokens/s | TTFT 1r torn p50 | TTFT torns següents p50 / p95 | descodificació per usuari | memòria lliure mínima |
|---|---|---|---|---|---|
| Zig millor build | 110,5 / 110,1 | 2,6 / 2,9 s | 3,1 / 15,5 s | 8,0 / 7,9 | 10,5 GiB |
| Python (perfil de producció) | 110,3 / 109,2 | 46,2 / 51,1 s | 3,1–3,3 / 6,1–7,5 s | 8,5 / 8,9 | 18,6 GiB |

### Setze usuaris a prop dels 75k

Setze peticions de 74.000 tokens i 896 de sortida, enviades alhora: una ronda
freda i dues de retorn (el mateix prompt amb la resposta i un torn nou). És la
mateixa prova que el Python i el vLLM van fer a
[`tensorfold-python-capacity16-20261023`](../tensorfold-python-capacity16-20261023/ASSESSMENT.md).

| Ronda | Zig temps total | Python | vLLM | Zig TTFT p50 / p95 | Python TTFT p50 / p95 | Fluxos simultanis Zig / Python / vLLM | Tokens en cache Zig / Python |
|---|---|---|---|---|---|---|---|
| Freda | 757 s | 645 s | 532 s | 677 / 679 s | 440 / 593 s | 16 / 13 / 16 | 0 / 0 |
| Retorn 1 | 730 s | 446 s | 433 s | 652 / 654 s | 158 / 385 s | 15 / 11 / 16 | 0 / 444.046 |
| Retorn 2 | 687 s | 375 s | 418 s | 636 / 638 s | 92 / 341 s | 15 / 10 / 16 | 0 / 518.331 |

- El Zig admet els setze alhora (el Python, com a molt 13) i completa les 48
  peticions sense OOM ni preempcions.
- Omple tots els prompts abans de descodificar: tothom rep el primer token
  alhora, als 10–11 minuts. Després descodifica a uns 22 tokens/s per usuari.
- **A les rondes de retorn no reaprofita res de la cache de prompts.** Els
  fluxos plens ocupen la memòria que la cache elàstica faria servir. El Python
  en reaprofita 444k i 518k tokens, i per això és un 64% i un 83% més ràpid.
- Memòria: el motor arriba a 107,2 GiB. En el primer intent, amb la cache de
  prompts encara plena de la prova d'agulles, la memòria lliure de la màquina
  va baixar a 5,8 GiB i la sonda es va aturar pel seu límit de 6 GiB. En la
  repetició (servidor acabat d'arrencar, límit a 3 GiB) es va llegir 9 GiB
  lliures a mitja ronda freda, 26 MiB d'intercanvi i cap OOM. El mínim exacte
  no es va registrar: el monitor de la sonda va fallar per un error de la
  modificació del límit, ja corregit.
- Cada prompt llegeix del disc les files d'embeddings per capa
  (`TF_FLASHNEXT_PLE_PREAD=hybrid`), uns 180 KB per token: 439 GiB a la ronda
  freda. És el comportament previst.

### Altres comprovacions

- **Crida d'eina i imatge** (sonda de la campanya del Python): les dues bé.
- **Agulles** a 16k, 65k i 74k tokens: 3 de 3.
- **Sessió real d'OpenCode** (v2.0.27, proveïdor `@ai-sdk/openai-compatible`,
  [`results/prod/opencode/`](results/prod/opencode/)): en 18 s fa cinc crides
  d'eina (executa els tests, llegeix dos fitxers alhora, edita i torna a
  executar), arregla el bug i els tests passen, i descriu bé la imatge (blau a
  l'esquerra i groc a la dreta).
- **Una hora seguida:** 12 passades d'agent de 16 usuaris en 65 minuts, 1.536
  peticions i cap error. 107–113 tokens/s (mitjana 111,0) sense degradar-se,
  TTFT dels torns següents p95 10–18 s. La memòria activa es manté a uns
  101 GB (pic de 105,9 GiB) i la lliure no baixa de 10 GiB.

### Què implica per a la 2225

| A favor del Zig | A favor del Python |
|---|---|
| Primer torn en 3 s davant de 46–51 s quan tots comencen alhora | TTFT p95 dels torns següents: 6–7,5 s davant de 15,5 s |
| Admet setze contextos plens alhora | Contextos plens: un 17–83% més ràpid gràcies a la cache de prompts |
| Estable una hora, cap error | Descodificació per usuari un poc més ràpida (8,7 davant de 8,0) |
|  | Més marge de memòria (18,6 GiB lliures davant de 10,5) |

## Mètode

- [`quick.sh`](quick.sh): cribratge, una passada de cinc torns per candidat
  amb el servidor reiniciat (uns 8 minuts cadascuna). La confirmació d'un
  guanyador és `TURNS=8 PASSES=2 CHECK=1`. Un guany s'accepta si supera el 3%
  en el cribratge i es manté en la confirmació.
- [`check-117.sh`](check-117.sh), [`check-sampled.sh`](check-sampled.sh),
  [`check-decode.sh`](check-decode.sh): exactitud de cada build.
- [`bench-117.sh`](bench-117.sh): 1.1.7 davant de 1.1.6, alternats dues vegades.
- [`prod-check.sh`](prod-check.sh): proves de preparació (Python davant de Zig,
  crida d'eina i imatge, agulles, setze contextos plens i una hora seguida).
  El límit de memòria lliure de la sonda es pot canviar amb `PROBE_MIN_FREE_GIB`
  (per defecte 6).
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
