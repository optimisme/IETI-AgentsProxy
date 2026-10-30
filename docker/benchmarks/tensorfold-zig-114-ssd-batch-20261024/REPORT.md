# TensorFold 1.1.4: agrupar lectures PLE entre fluxos

**El patch funciona i el guany és parcial: codi amb vuit usuaris −0,2%;
prosa +10,7% en aquesta passada. No compleix el criteri general per ampliar
l'avaluació ni iguala el nostre Python en les càrregues de codi comparables.**
Els guanys de prosa i retorns continuen sent preliminars: hi ha mostres amb
petits pageouts del host i no s'ha fet una confirmació en ordre invers.

El model és **Qwen3.8 Flash-Next**, no Qwen3.8-27B. La prova es fa a la GB10
experimental de la màquina accessible pel port SSH 2226. La màquina de
referència no s'ha utilitzat.

## Canvi implementat

Base exacta: TensorFold `v1.1.4`, commit
`eab8582819688325e371907e4706e1c602b8a273`.
El patch és `../../archive/patches/tensorfold-114-ple-batch-v1.patch`.

En un pass amb diversos fluxos, el codi calcula els índexs n-gram a partir
de l'historial independent de cadascun, els concatena en l'ordre de les
files i executa un únic gather al pool existent. Conserva la desquantització,
l'escalat, les sumes i l'ordre de càlcul per fila; actualitza els historials
després d'acabar correctament. Amb un sol flux segueix el camí original.
S'agrupa l'accés a taules mapejades en memòria; no s'ordenen índexs ni es
converteixen les lectures aleatòries en un bloc contigu al disc.

`TF_FLASHNEXT_PLE_BATCH=0` conserva el cos original de `Ngram.rows`.
Amb `1`, s'activa l'agrupació. Les dues variants executen **el mateix binari**:
`0cd48254658586e7a8564dd387acfc792f15ec4b79d209d3a0af132588006ea8`.
No canvien kernels CUDA, pesos, precisió, mostreig, política de cache ni MTP.

El [perfil experimental](../../models/qwen38-flash-next-tensorfold-114-ple-batch-mlx-4bit-vision-128gb.yml)
manté MLX affine 4-bit, BF16 KV, MTP6/confiança 0,60, vuit places, context
configurat de 75k, cache de prefixos de 8 GiB i torre visual carregada.
El checkpoint continua fixat a `2b170fa6309d5d1ee380b35636075fac7945f286`.
Memòria persistent i aprenentatge continuen desactivats.

Només el contenidor de **compilació** té quatre CPU i 10 GiB de límit.
La inferència es mesura amb el Python aturat i un únic procés de model;
`NanoCpus=0`, `Memory=0`, `CpuQuota=0` i `CpusetCpus` buit a les dues variants.

## Correcció i compilació

- Proves noves: vuit historials independents, n-gram de tres tokens, longituds
  barrejades, EOS, cinc repeticions, igualtat exacta de BF16, sumes float32 i
  historials, guards i rebuig de geometries/historials solapats.
- `test-cuda-host`: tots els **210 passos** acaben correctament amb un usuari
  ordinari. Els logs conserven els recomptes executats, omesos i resultats en cache.
- Compilació nativa SM 121: **105/105 passos** correctes. Zig 0.17.0.
- Lean: 437 incidències preexistents abans i després; **cap incidència nova**.
- Les 50 respostes compartides amb la prova anterior del binari oficial tenen
  exactament el mateix text, raonament i hash de petició que el control recompilat.

[BUILD.md](BUILD.md) documenta el build, les dues proves de permisos que fallen
com a root i passen amb un usuari ordinari, i l'intent de versió prerelease
rebutjat pel parser upstream. No s'han eliminat proves ni canviat toleràncies.
`tested-source/` i els manifests conserven els fitxers compilats i els hashes.

## Resultats

Cada variant completa **78/78 peticions de rendiment**, 16.384 tokens de
sortida fixats, i **12/12 controls funcionals** addicionals. Les 90 respostes
coincideixen entre off/on en text, raonament i recomptes d'entrada/sortida.
Els controls també donen igualtat entre plain concurrent, solo amb prefix
reutilitzat i drafted concurrent. Els retorns solo reutilitzen 521 tokens
cadascun, així que la reutilització s'ha exercitat realment.
Cada procés també rep un warmup de 32 tokens, exclòs d'aquests recomptes.

Tokens/s són tokens de sortida dividits pel temps complet del grup, incloent
prefill. Els percentatges agregats són mitjanes geomètriques de les ràtios
on/off per cas. No són taxes internes de decode.

| Càrrega | Off → on, tokens/s | Canvi |
|---|---:|---:|
| Codi, 1 usuari, dos casos | 75,64/82,50 → 74,96/82,48 | −0,5% agregat |
| Codi, 4 usuaris, dos casos | 150,38/156,67 → 150,00/148,48 | −2,8% agregat |
| Codi, 8 usuaris, dos casos | 189,14/190,11 → 190,85/187,70 | **−0,2% agregat** |
| Prosa, 8 usuaris, tres casos | 113,82/112,15/120,00 → 126,45/122,10/134,74 | **+10,7% agregat** |
| Retorns 2k, 8 usuaris, torns 1/2 | 79,16/87,51 → 89,62/97,48 | +13,2% / +11,4% |
| Mostreig, 4 usuaris | 71,84 → 81,21 | +13,0% |

No hi ha regressions principals de TTFT que superin alhora el 10% i 0,1 s.
Amb vuit usuaris de codi, la mediana continua al voltant d'1,5 s. Els retorns
2k passen de 2,68/2,71 s a 2,69/2,53 s; el primer torn fred queda en 8,84/8,89 s.
[TABLES.md](TABLES.md) i `comparison.json` inclouen totes les cel·les.

## Neteja de les mostres i decisió

No hi ha errors, OOM ni peticions externes. El mínim de RAM disponible és
27,37 GiB off i 27,99 GiB on. Els rellotges GPU queden entre 2392 i 2405 MHz;
temperatures off 40–63 °C i on 41–65 °C.

Hi ha **19 pageouts off (76 KiB)** i **113 on (452 KiB)**, de tot el host.
No s'atribueixen al procés d'inferència. Sis de les tretze parelles queden
excloses de l'anàlisi estrictament neta; tots dos retorns 2k en formen part.
No s'amaguen ni es repeteixen indefinidament les mostres excloses.

Entre les parelles netes queda un cas de prosa amb **+11,1%**, un de codi
amb vuit usuaris amb **−1,3%**, i el de mostreig amb **+13,0%**. Són senyals
puntuals, sense una repetició inversa que en demostri estabilitat.

El [protocol previ](PROTOCOL.md) exigia almenys +10% tant en codi com en prosa
amb vuit usuaris, consistència entre casos, igualtat de sortides i mostres netes.
El codi queda per sota del 5% mínim per continuar; per això s'atura després
d'aquesta parella. **No es declara una millora general significativa ni
estadísticament significativa.** El patch queda disponible per a una futura
confirmació centrada en prosa/retorns si aquella càrrega passa a ser prioritària.

Les xifres Python del test anterior, a la mateixa GPU i amb els mateixos casos,
eren 279–313 tokens/s en codi amb vuit usuaris; el candidat queda en 188–191.
El cas comparable net queda un 32,8% per sota de Python i amb TTFT d'1,49 s
contra 0,33 s. És una referència històrica, **Python no es torna a mesurar en
aquesta parella**. No justifica substituir el servei habitual.

No s'han qualificat contextos ocupats de 75k, setze usuaris, imatges/eines,
altres quantitzacions ni altres GPU. Una finestra configurada de 75k no és
una prova de capacitat amb totes les finestres ocupades.

## Estat final

El candidat queda aturat. El controlador acaba sense error i confirma
`restored=true`: el mateix contenidor Python original, amb el mateix ID,
imatge i ordre d'arrencada, torna a respondre saludable amb context 75k i
setze places. La comprovació consta a `result.json`, `normal-before.json`,
`normal-after.json` i `restored-health.json`.
