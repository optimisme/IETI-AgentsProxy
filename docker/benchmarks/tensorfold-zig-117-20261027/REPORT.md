# TensorFold Zig 1.1.7 i 1.1.9: millor build de Flash-Next per a setze alumnes

> **Avís (30 d'octubre).** resident12 i tf119 tenen un error greu amb els prompts
> d'uns 74–136 tokens, i s'espera el mateix des de resident7: vegeu
> [Respostes corrompudes](#respostes-corrompudes-amb-trossos-de-64127-files-30-doctubre).
> No s'han de desplegar. `variants/tf119c` el corregeix, i `variants/tf119d`, que el
> conté, és la millor build.

**La millor build (30 d'octubre, `variants/tf119d`) és TensorFold 1.1.9 amb
el nostre patch de Flash-Next, el pas mixt, els drafts mostrejats de MiaAI-Lab
(0007, 0008, 0011), els estats de prompt residents, el nou planificador de
prompts, la lectura HC per files a les rondes de resposta i l'atenció de tots
els fluxos d'una ronda en un sol llançament per kernel (un 11% menys per ronda
de resposta a 74k), i el mateix per a les capes DeltaNet (un 2% més), a més de la multiplicació
de prompt del Python als trossos sols de 64 files o més. La 1.1.9
desallotja menys estats de la cache de prompts: les rondes de retorn a 74k baixen
de 140 / 120 s a 109 / 82 s (el Python, 380 / 386 s). Iguala o supera el
Python en la càrrega d'agent, en les rondes de retorn, en el primer token mitjà
amb contextos de 45k i 74k i, des de tf119d, en la ronda freda de 74k: 627 s
davant de 637 s. A 45k perd en el p95 del primer token, i tf119d encara no s'hi
ha mesurat.** Vegeu
[Contextos plens: Zig davant de Python](#contextos-plens-zig-davant-de-python-29-doctubre).
La resta de patches de MiaAI-Lab, el checkpoint NVIDIA NVFP4 i un drafter propi
s'han descartat.

El model és **Qwen3.8 Flash-Next** amb el checkpoint **MLX 4 bits**
(`TensorFold/Qwen3.8-Flash-Next-MLX-4bit-MTP`): pesos enters de 4 bits amb
escales i biaixos bf16 per grup. No és FP4 ni NVFP4. Les proves s'han fet a la
GB10 experimental del port SSH 2226; la màquina de referència no s'ha utilitzat.

## Com s'arrenca

- Perfil: [`qwen38-flash-next-tensorfold-117-mlx-4bit-vision-128gb-best.yml`](../../models/qwen38-flash-next-tensorfold-117-mlx-4bit-vision-128gb-best.yml)
- A la 2226: `bash ~/docker/benchmarks/tensorfold-zig-117-20261027/up-117.sh`
  (posa el volum `ieti-native117-tf119d-build` i el resum SHA-256 del patch).
- Patch de la millor build: [`best/best.patch`](best/best.patch), idèntic a
  [`variants/tf119d/fn.patch`](variants/tf119d/fn.patch) (diferència respecte de
  `v1.1.9`). Les builds anteriors són
  [`variants/tf119/fn.patch`](variants/tf119/fn.patch) (30 d'octubre, sense la
  correcció) i, sobre la 1.1.7,
  [`variants/resident12/fn.patch`](variants/resident12/fn.patch)
  (30 d'octubre, la mateixa feina sobre la 1.1.7),
  [`variants/resident11/fn.patch`](variants/resident11/fn.patch)
  (29 d'octubre, sense DeltaNet en un llançament),
  [`variants/resident7/fn.patch`](variants/resident7/fn.patch)
  (29 d'octubre, sense l'atenció en un llançament) i
  [`variants/sampled/fn.patch`](variants/sampled/fn.patch) (28 d'octubre).
- Configuració: 16 fluxos, finestra de 75.000 tokens, KV fp8 (files int8),
  MTP6 amb confiança 0,60, trossos de prompt de 4096 files (també mentre es
  descodifica), cache de prompts elàstica de fins a 24 GiB amb estats residents
  (`TF_PROMPT_CACHE_RESIDENT_GIB=2`), planificador de prompts
  (`TF_FILL_AGING_ROUNDS=1000000`, `TF_FILL_ROUND_STEPS=8`), lectura HC per files
  fins a 127 files (`TF_TILE_READOUT_ROWS=128`, i també
  `TF_TILE_EXPERTS_ROWS` i `TF_TILE_MATMUL_ROWS` a 128; vegeu
  [DeltaNet en un llançament](#deltanet-en-un-llançament-30-doctubre)), atenció
  i DeltaNet dels fluxos en un llançament (`TF_FLASHNEXT_ATTN_LANES=1`,
  `TF_FLASHNEXT_GDN_LANES=1`), visió activada, temperatura per
  defecte del servidor 0,1.
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
| **Zig sampled (28 oct)** | 0 | **107,1 / 106,9** | 2,7–3,2 s | 3,4–3,6 / 14–15 s | 8,2 |
| Zig 1.1.7 sense drafts mostrejats | 0,55 | 94,8 / 94,7 | 3,2 s | 3,3 / 13,2 s | 7,4 |
| **Zig sampled (28 oct)** | 0,55 | **102,8 / 102,9** | 3,1 s | 3,75 / 15,3 s | 8,1 |

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
74k tokens, i setze peticions de 74.000 tokens acaben totes (48 de 48). Amb la
build del 29 d'octubre el Zig reaprofita la cache a les rondes de retorn i hi és
2,6–3,4 vegades més ràpid que el Python; el marge de memòria a 74k és més just
(7,6 GiB lliures davant de 10,4): vegeu
[Contextos plens](#contextos-plens-zig-davant-de-python-29-doctubre).

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
4. **Estats de prompt residents** (29 d'octubre): amb les finestres plenes la
   cache elàstica no té lloc per copiar un estat. Ara una marca només guarda
   l'estat DeltaNet (~110 MiB) i les files d'atenció es queden a les caches del
   flux, que sobreviuen al flux fins que el torn de retorn les reprèn.
5. **Planificador de prompts** (`lane_host_fill.zig`): el prompt més a prop del
   final es queda els trossos (`TF_FILL_AGING_ROUNDS`), de manera que els
   prompts acaben un darrere l'altre i descodifiquen mentre la resta s'omplen;
   els prompts no començats es comparen pel que els falta des d'on es reprenen;
   i fins a vuit passos de prompt llarg entre rondes de descodificació
   (`TF_FILL_ROUND_STEPS`).
6. **Lectura HC per files a les rondes de resposta**
   (`cuda_tile_rows.zig`, `TF_TILE_READOUT_ROWS`): a partir de 64 files la
   lectura feia servir la rajola del prompt, que en una ronda de 64 files costa
   29,6 ms davant d'11,4. Amb el llindar a 128 una ronda de setze fluxos baixa de
   232 a 216 ms (+5% de tokens/s en respostes). Els bits són els mateixos.
7. **Atenció dels fluxos en un llançament** (`TF_FLASHNEXT_ATTN_LANES`): a
   les rondes compartides cada kernel d'atenció (preparació, agrupació,
   puntuacions, selecció, trossos i fusió) es llançava un cop per flux. Ara es
   llança un cop per a totes les files de la ronda i cada fila troba les caches
   del seu flux en una taula que es puja un cop per ronda, com fa el Python
   (`attn_multi.py`). Els programes són els mateixos. Vegeu
   [Atenció en un llançament](#atenció-en-un-llançament-29-doctubre).
8. **DeltaNet dels fluxos en un llançament** (`TF_FLASHNEXT_GDN_LANES`): a cada
   capa DeltaNet hi havia cinc llançaments per flux (dues còpies, la part
   frontal, la cadena i el desplaçament de la finestra). Ara en són quatre per a
   tots els fluxos, amb la mateixa taula de la ronda. Els bits són els mateixos.
   Vegeu [DeltaNet en un llançament](#deltanet-en-un-llançament-30-doctubre).

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

## Contextos plens: Zig davant de Python (29 d'octubre)

La mateixa sonda de capacitat (setze peticions alhora, una ronda freda i dues
de retorn) a 74k i 45k tokens, i la càrrega d'agent de setze usuaris, a la
2226. El Python són passades aparellades del mateix dia. Script:
[`resident-check.sh`](resident-check.sh) (`RVAR=resident7`); dades a
[`results/resident/`](results/resident/) (`summary.txt` té totes les passades,
també les intermèdies).

| Prova | Python | Zig millor build | Guanya |
|---|---|---|---|
| Agent: tokens/s | 110,3 | 112,4 / 114,6 | Zig |
| Agent: TTFT torns següents p95 | 6,1–7,5 s | 6,05 / 7,59 s | empat |
| 74k freda: temps total | **637 s** | 672 s | Python (+5%) |
| 74k freda: TTFT p50 / p95 | 473 / 579 s | **317 / 572 s** | Zig |
| 74k retorn 1 / 2 | 380 / 386 s | **148 / 113 s** | Zig |
| 74k memòria lliure mínima | **10,4 GiB** | 7,6 GiB | Python |
| 45k freda: temps total | **387 s** | 418 s | Python (+8%) |
| 45k freda: TTFT p50 / p95 | 318 / **323 s** | **188** / 340 s | Zig / Python |
| 45k retorn 1 / 2 | 79 / 51 s | **74 / 45 s** | Zig |
| 45k memòria lliure mínima | 12,6 GiB | **16,4 GiB** | Zig |

- Totes les comprovacions d'exactitud donen 8 de 8 i 9 de 9 (greedy junts =
  sols, agulles, respostes, mostrejades amb llavor) i el reaprofitament de
  converses dona el mateix text des de còpies i des d'estats residents
  ([`reuse_check.py`](reuse_check.py)).
- **On es perd el temps de la ronda freda a 74k:** la càrrega dels prompts ja
  empata amb el Python (el darrer prompt acaba als ~610 s). La resta és la cua
  de respostes amb setze fluxos a 74k: rondes de ~216 ms, de les quals ~190 ms
  verifiquen 64 files i ~25 ms fan drafts
  ([`results/resident/reply-profile-74000.txt`](results/resident/reply-profile-74000.txt),
  [`reply_profile.py`](reply_profile.py)). Els experts en prenen 105–130 ms i
  estan limitats per l'amplada de banda (canviar de kernel no hi fa res,
  [`results/resident/reply-profile-tiles.txt`](results/resident/reply-profile-tiles.txt));
  l'atenció a 74k només 35 ms.
- A les rondes de retorn de 74k encara es desallotgen alguns estats (4 en
  aquesta passada); per això aquestes xifres varien entre 113 i 157 s.

## Atenció en un llançament (29 d'octubre)

Mesurant bloc per bloc (cada bloc sincronitzat) amb 64 files en una ronda de
setze fluxos, el Zig perdia 23 ms davant del Python. La diferència més gran
era l'atenció: 12,7 ms davant de 3,8. Script: [`attn-lanes.sh`](attn-lanes.sh);
dades a [`results/resident/attn-lanes.txt`](results/resident/attn-lanes.txt).
Mateixa build (`variants/resident11`), interruptor apagat i encès.

| Prova | Apagat | Encès | Python |
|---|---|---|---|
| Bloc d'atenció, 64 files (curt) | 12,7 ms | **4,9 ms** | 3,8 ms |
| Setze respostes curtes: tokens/s | 226,6 | **235,4** (+4%) | ~243 |
| Curt: verificació / drafts per ronda | 190,4 / 24,7 ms | **183,1 / 23,0 ms** | — |
| 74k, 16 fluxos: verificació / drafts per ronda | 194,7 / 25,6 ms | **178,6 / 20,8 ms** | ~169 / ~18 ms |
| 74k, 16 fluxos: ronda sencera | 220,0 ms | **196,1 ms** (−11%) | — |
| 74k freda: temps total | 674 s | 664 s | 637 s |
| 74k retorn 1 / 2: tokens/s | 128,0 / 161,8 | 132,7 / 163,3 | 37,7 / 37,1 |

- Els drafts també baixen perquè la capa MTP fa servir la mateixa atenció.
- La ronda freda i les de retorn de la sonda depenen sobretot de la càrrega dels
  prompts, que aquest canvi no toca; per això hi canvien poc.
- Exactitud amb l'interruptor encès: greedy junts = sols 8 de 8 (dues rondes),
  agulles 9 de 9, respostes iguals a `kvcheck-117` 8 de 8 i mostrejades 8 de 8.
- Quedava per tancar: DeltaNet (~6 ms per ronda) i els experts (~7 ms).
- La build també porta tres opcions de mesura que no fan res si no s'activen:
  `TF_FLASHNEXT_ROUND_ROWS` (límit de files per ronda; l'escombrada de 32 a 128
  no va guanyar res), `TF_DRAFT_TIMES` (temps dels passos de draft) i
  `TF_DRAFT_PREFIX` (sense efecte).

## DeltaNet en un llançament (30 d'octubre)

Després de l'atenció, el bloc DeltaNet era la diferència següent: 34,5 ms
davant de 28,1 al Python en una ronda de 64 files. Mateix script
(`SW=TF_FLASHNEXT_GDN_LANES AVAR=resident12 bash attn-lanes.sh`); dades a
[`results/resident/gdn-lanes.txt`](results/resident/gdn-lanes.txt). Mateixa
build (`variants/resident12`), interruptor apagat i encès.

| Setze respostes curtes | Apagat | Encès | Python |
|---|---|---|---|
| Bloc DeltaNet, 64 files | 34,5 ms | **30,0 ms** | 28,1 ms |
| Verificació per ronda | 183,2 ms | **178,6 ms** | — |
| Ronda sencera | 206,0 ms | **201,5 ms** (−2%) | — |
| Tokens/s | 234,4–236,9 | **238,9–241,7** | ~243 |

- Exactitud amb l'interruptor encès: greedy junts = sols 8 de 8 (dues rondes),
  agulles 9 de 9, respostes iguals a `kvcheck-117` 8 de 8 i mostrejades 8 de 8.
- No s'ha mesurat a 74k: el cost de DeltaNet no depèn del context, i s'hi espera
  el mateix estalvi d'uns 4,5 ms per ronda.
- **Error trobat de passada.** En Zig, una cache declarada dins d'una funció
  genèrica és compartida per tots els noms si no fa referència al nom. Per això
  a les builds fins a resident11 `TF_TILE_READOUT_ROWS=128` també posava a 128
  els llindars dels experts i de les matmuls (`TF_TILE_EXPERTS_ROWS`,
  `TF_TILE_MATMUL_ROWS`), i totes les mesures anteriors es van fer així. Les
  respostes no canviaven. resident12 corregeix les dues caches i el perfil posa
  els dos llindars a 128 explícitament, per mantenir el comportament mesurat.
  La primera prova d'aquest canvi comparava encès amb encès per aquest motiu;
  la taula és de la build refeta.
- Queda per tancar: els drafts (~23 ms per ronda davant de ~17 al Python) i els
  experts (un 3% per darrere, limitats per l'amplada de banda de memòria).

## TensorFold 1.1.9 (30 d'octubre)

resident12 traslladada a la 1.1.9 (`variants/tf119`, `BASE=v1.1.9
sync-build.sh`). La 1.1.9 porta un índex de la cache de prompts per posició, un
nivell de disc per als estats, la pressió de memòria a l'admissió i un
pressupost de files de prompt al planificador. Script:
[`tf119-check.sh`](tf119-check.sh); dades a
[`results/resident/tf119.txt`](results/resident/tf119.txt).

| Prova | resident12 (1.1.7) | tf119 (1.1.9) | Python |
|---|---|---|---|
| Setze respostes curtes: tokens/s | 241,8 / 239,2 | 241,8 / 239,3 | ~243 |
| Setze respostes curtes: ronda | 201,4 ms | 201,2 ms | — |
| 74k freda: temps total | 664 s | 666 s | **637 s** |
| 74k freda: TTFT p50 / p95 | 316 / 571 s | 317 / 573 s | 473 / 579 s |
| 74k retorn 1 / 2 | 140 / 120 s | **109 / 82 s** | 380 / 386 s |
| 74k retorn: TTFT p95 | 48 s | **11 s** | — |
| 74k: estats desallotjats, tokens reaprofitats | 4, 1,04 M | **2, 1,11 M** | — |
| 74k: ronda de setze fluxos | 188,4 ms | 183,4 ms | — |

- Exactitud: greedy junts = sols 8 de 8 (dues rondes), agulles 9 de 9,
  respostes 8 de 8, mostrejades 8 de 8, i el reaprofitament en dos torns dona el
  mateix text 8 de 8.
- **Error trobat en el trasllat.** L'índex de la 1.1.9 suposa que cada estat de
  la cache hi entra a través seu; el nostre camí d'estats residents l'afegia
  directament a la llista i la primera cerca aturava el servidor
  (`reached unreachable code`). Ara passa per l'índex.
- A la ronda freda de 74k la 1.1.9 envia unes 36.600 pàgines a swap (la 1.1.7,
  620), sense que la memòria lliure baixi de 7,3 GiB ni que s'alenteixi.
- La ronda freda no canvia: el Zig encara hi perd uns 28 s.

## Respostes corrompudes amb trossos de 64–127 files (30 d'octubre)

Un tros de prompt de 64 files o més desa la sortida dels experts en bf16, però
només el camí de rajoles escriu aquest format. El codi decidia el format amb
`n >= 64` fix, i des de `TF_TILE_EXPERTS_ROWS=128` els experts de 64–127 files
feien servir el camí de files, que escriu fp32. Els valors es llegien
malament i el model principal quedava corromput.

- **Efecte:** amb prompts d'uns 74–136 tokens, 27 de 27 respostes a temperatura
  0,1 eren `!!!!!!!!!!!!`, sense cap error, i a temperatura 0 el servidor tornava
  un error 500 (`ProposalPaddingPick`). Amb prompts llargs passa quan el darrer
  tros cau a la mateixa franja (per exemple, 73.803–73.864 tokens).
- **Abast:** `ProposalPaddingPick` s'ha reproduït a tf119 i a resident12. El
  llindar a 128 és al perfil des de resident7, de manera que s'hi espera des
  d'aleshores; resident7 i resident11 no s'han provat. Les comprovacions
  d'exactitud no cobrien aquesta franja.
- **Primera correcció (`variants/tf119b`):** el format segueix el mateix llindar
  que els experts. Elimina l'error, però 5 de 65 respostes difereixen de les del
  llindar a 64. Dades a [`results/resident/tf119b.txt`](results/resident/tf119b.txt).
- **Correcció definitiva (`variants/tf119c`):** un tros de prompt que va sol fa
  servir les rajoles dels experts des de 64 files, el camí que escriu bf16, i el
  format es queda a `n >= 64`, com a la versió original. Les rondes conserven el
  llindar de 128. Es tria perquè segueix el camí original, no perquè el Python
  doni la raó: a temperatura 0 Python coincideix 44 de 50 amb tf119b i 43 de 50
  amb el llindar a 64, i difereix també fora de la franja, de manera que no pot
  fer d'àrbitre bit a bit.
- **Prova:** [`short_sweep.py`](short_sweep.py); dades a
  [`results/resident/tf119c.txt`](results/resident/tf119c.txt). 65 de 65 i 50 de
  50 iguals que el llindar a 64, cap error 500, 4 de 4 a 74k a temperatura 0,
  exactitud de 8 de 8 i 9 de 9, reutilització de 8 de 8. Ronda freda de 74k en
  662 s, respostes curtes a 241 tok/s i càrrega d'agents a 117,7 tok/s sense
  errors: no perd velocitat respecte de tf119.
- **Prova ràpida:** `resident-check.sh` comença per l'etapa `quick`, les passades
  curtes contra les respostes de la millor build, i s'atura a la primera diferència.

## Multiplicació de prompt del Python (30 d'octubre)

El buit de la ronda freda de 74k era d'omplir, no de la cua de respostes. La ronda
treballa sense pauses: el Zig omple un prompt cada 37 s i descodifica mentre omple
(primer token mitjà 298 s), i el Python omple en paral·lel (14 de 16 primers tokens
a uns 472 s). La descodificació costa més o menys el mateix a tots dos.

La diferència era la multiplicació: el Python usa `qmm_prefill` (grup 32, rajola 9)
per als prompts i el Zig feia servir l'aritmètica de resposta. `variants/tf119d` hi
passa els trossos sols de 64 files o més (`TF_FLASHNEXT_PROMPT_GEMM=0` ho desactiva).

| 74k, 16 alumnes | tf119c | tf119d | Python |
|---|---|---|---|
| Un prompt fred | 36,5 s | 34,3 s | 31,8 s |
| Ronda freda | 662 s | **627 s** (629,5 i 629,9 a la prova) | 637 s |
| Primer token mitjà | 316 s | 298 s | ~472 s |
| Càrrega d'agent | 117,7 tok/s | 118,8 tok/s | |

- **Respostes:** 50 de 50 i 65 de 65 iguals que la seva referència, 4 de 4 a 74k a
  temperatura 0, exactitud de 8 de 8 i 9 de 9, reutilització de 8 de 8. Dotze
  documents de 74k amb [`sane_replies.py`](sane_replies.py): tots tornen el codi
  demanat. Dades a [`results/resident/tf119d.txt`](results/resident/tf119d.txt).
- **Canvia alguns bits:** 3 de 50 i 3 de 65 respostes difereixen de tf119c en la
  redacció, no en el contingut. Un tros de menys de 64 files, o que va amb una
  ronda, continua amb l'aritmètica de resposta, de manera que un mateix prompt pot
  variar lleugerament segons la càrrega.
- **Ronda de retorn 2:** la prova ignora el final de resposta, i a tots els motors
  (Python inclòs) les 16 respostes acaben repetint text. Aquesta velocitat no és
  comparable.
- **Queda per fer:** per 4096 files, HC 393 davant de 340 ms i atenció 434 davant de
  397 ms; mesurar tf119d a 45k.

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

Aquesta secció és de la build anterior (`variants/sampled`). Les rondes de
contextos plens de la build actual són a
[Contextos plens](#contextos-plens-zig-davant-de-python-29-doctubre); la prova
d'una hora, la imatge i OpenCode encara no s'han repetit amb la build actual.

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
| Zig sampled (28 oct) | 110,5 / 110,1 | 2,6 / 2,9 s | 3,1 / 15,5 s | 8,0 / 7,9 | 10,5 GiB |
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
- [`attn-lanes.sh`](attn-lanes.sh): temps per bloc, rondes i exactitud amb
  `TF_FLASHNEXT_ATTN_LANES` apagat i encès.
- [`resident-check.sh`](resident-check.sh): exactitud, reaprofitament,
  capacitat a `TOKENS` i agent per a una variant (`RVAR`, `RENV`, `CLABEL`).
  [`reply_profile.py`](reply_profile.py) resumeix les rondes de resposta d'un
  registre amb `TF_LANES_PHASES=1 TF_FLASHNEXT_PROFILE=2`;
  [`decode_load.py`](decode_load.py) i [`tile-sweep.sh`](tile-sweep.sh) són la
  càrrega curta de respostes i l'escombrada dels llindars `TF_TILE_*_ROWS`;
  [`cold_one.py`](cold_one.py) i [`profile-batch.sh`](profile-batch.sh) perfilen
  un sol prompt fred; [`gpu-batch.sh`](gpu-batch.sh) és la tanda amb traça.
- Els scripts de càrrega (`agent.py`, `greedy_check.py`, `kv8_check.py`) són a
  [`../tensorfold-zig-114-parity-20261024/`](../tensorfold-zig-114-parity-20261024/).
- Dades: [`results/`](results/) conté el resum de cada etapa
  (`quick-<etapa>/summary.txt`), el `summary.json` de cada passada d'agent i els
  registres de les comprovacions.

## Builds i noms

| Nom | Contingut | Patch | Volum a la 2226 |
|---|---|---|---|
| **best** (variants/tf119d) | tf119c + multiplicació de prompt del Python | [`best/best.patch`](best/best.patch) | `ieti-native117-tf119d-build` |
| variants/tf119c | tf119 + correcció definitiva de les respostes corrompudes | [`variants/tf119c/fn.patch`](variants/tf119c/fn.patch) | `ieti-native117-tf119c-build` |
| variants/tf119b | tf119 + primera correcció, substituïda per tf119c | [`variants/tf119b/fn.patch`](variants/tf119b/fn.patch) | `ieti-native117-tf119b-build` |
| variants/tf119 | resident12 traslladada a TensorFold 1.1.9 (amb l'error) | [`variants/tf119/fn.patch`](variants/tf119/fn.patch) | `ieti-native117-tf119-build` |
| variants/resident12 | resident11 + DeltaNet dels fluxos en un llançament + caches dels llindars separades | [`variants/resident12/fn.patch`](variants/resident12/fn.patch) | `ieti-native117-resident12-build` |
| variants/resident11 | resident7 + atenció dels fluxos en un llançament | [`variants/resident11/fn.patch`](variants/resident11/fn.patch) | `ieti-native117-resident11-build` |
| variants/resident7 | sampled + estats residents + planificador de prompts + lectura HC per files | [`variants/resident7/fn.patch`](variants/resident7/fn.patch) | `ieti-native117-resident7-build` |
| variants/sampled | 1.1.7 + patch + pas mixt + drafts mostrejats (millor del 28 d'octubre) | [`variants/sampled/fn.patch`](variants/sampled/fn.patch) | `ieti-native117-sampled-build` |
| tf117-20261027 | 1.1.7 + patch + pas mixt | [`tf117-20261027/fn.patch`](tf117-20261027/fn.patch) | `ieti-native117-fn-build` |
| variants/stop | millor + 0017 | [`variants/stop/fn.patch`](variants/stop/fn.patch) | `ieti-native117-stop-build` |
| variants/decode | millor + 0012 + 0016 (meitat DeltaNet) | [`variants/decode/fn.patch`](variants/decode/fn.patch) | `ieti-native117-decode-build` |
| tf116-20261026c | 1.1.6 + patch + pas mixt | `../tensorfold-zig-116-mixed-20261026/tf116-20261026c/fn.patch` | `ieti-native116-tf20261026c` |
| tf114-20261026b | 1.1.4 + patch | `../tensorfold-zig-114-parity-20261024/tf114-20261026b.patch` | `ieti-native114-tf20261026b` |

Els arxius `source.tar` (61 MB, còpia del codi de TensorFold) no es versionen;
cada build es pot refer aplicant el seu patch a TensorFold 1.1.7 (tf119: 1.1.9).
