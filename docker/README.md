# Models Docker

## Flash-Next: millor build TensorFold Zig (28 d'octubre)

El perfil [`qwen38-flash-next-tensorfold-117-mlx-4bit-vision-128gb-best.yml`](models/qwen38-flash-next-tensorfold-117-mlx-4bit-vision-128gb-best.yml)
serveix la millor build: TensorFold 1.1.7 amb el nostre patch, el pas mixt i
els drafts mostrejats de MiaAI-Lab, sobre el checkpoint MLX 4 bits. Setze
fluxos a 75k tokens amb KV fp8. En la càrrega d'agent de setze usuaris dona
107 tokens/s agregats a temperatura 0 (Python 105,1) i 102,8 a temperatura 0,55
(+8,5% respecte de la build sense drafts mostrejats). El Python continua sent
millor en el p95 del TTFT dels torns següents (6,6 s davant de 15 s). Les
proves de preparació per substituir la 2225 (temperatura 0,1, setze contextos
de 74k, OpenCode i una hora seguida) donen un empat en tokens/s, un primer torn
molt més ràpid amb Zig i contextos plens més ràpids amb Python. S'arrenca
a la 2226 amb `benchmarks/tensorfold-zig-117-20261027/up-117.sh`. Proves,
patches inclosos i descartats, i dades:
[l'informe](benchmarks/tensorfold-zig-117-20261027/REPORT.md).

## TensorFold 1.1.4: prova curta amb Flash-Next

El nou perfil experimental
[`qwen38-flash-next-tensorfold-114-mlx-4bit-vision-128gb.yml`](archive/models/qwen38-flash-next-tensorfold-114-mlx-4bit-vision-128gb.yml)
fixa el binari oficial ARM64 1.1.4 i el mateix checkpoint MLX de Python.
Configura 75k tokens, vuit places, MTP6, visió i 8 GiB de cache de prefixos.
La comparació curta completa 64/64 peticions per motor: a vuit usuaris en codi
curt dona 187–193 tokens/s agregats davant de 279–313 de Python, amb més TTFT.
No passa el criteri per ampliar la campanya multiusuari. Es conserva el Python
original com a servei habitual. Les exclusions per petits pageouts, la comparació
estrictament neta i tots els resultats consten a
[l'informe](archive/benchmarks/tensorfold-zig-release114-quick-20261024/REPORT.md).

El [patch PLE per a 1.1.4](archive/patches/tensorfold-114-ple-batch-v1.patch) agrupa
les lectures n-gram dels fluxos d'un mateix pass. La prova off/on a la GB10
dona **−0,2% en codi amb vuit usuaris** i **+10,7% en prosa** en una passada,
amb respostes idèntiques. El guany de prosa és preliminar: diverses mostres
tenen petits pageouts i no hi ha confirmació inversa. No passa el criteri
general ni iguala Python. Es conserven el
[YAML experimental](archive/models/qwen38-flash-next-tensorfold-114-ple-batch-mlx-4bit-vision-128gb.yml)
i [l'informe amb dades i límits](benchmarks/tensorfold-zig-114-ssd-batch-20261024/REPORT.md).

## TensorFold Python: perfil opt16 validat el 24 d’octubre

El nou [perfil opt16](models/qwen38-flash-next-python-opt16-tuned-128gb.yml)
conserva pesos, KV INT8, MTP, SSD i visió. Tres parelles a la mateixa GPU donen
**43,98% menys temps total** a la prova de tres rondes amb setze historials prop
de 75k; els retorns baixen un 81% i un 90%. La ronda freda és un **6,98% més lenta**.
Tres proves de creixement completen 192/192 respostes; el paquet sense hooks
interns de perfilatge també passa 64/64, capacitat i proves funcionals.
Els resultats usen el criteri declarat de pageouts limitats; no totes les
execucions tenen zero pageouts. Hi ha límits de reutilització en créixer des de
65k i errors coneguts de recuperació també reproduïbles al Python original.

[Informe, metodologia, límits i dades](benchmarks/tensorfold-python-opt16-20261023/REPORT.md).
El YAML i el paquet local s’han sincronitzat al `docker/` del servidor experimental.
El servei original s’ha restaurat; el servidor de referència no s’ha modificat.
Els apartats següents conserven les comparacions històriques anteriors a l’ajust.

## TensorFold Python: prova real de setze peticions prop de 75k

La prova del 23 d'octubre al servidor experimental completa 48/48 peticions
amb ~74k tokens d'entrada i 896 de sortida, sense OOM ni swap-out nou.
El desplegament Python existent accepta les setze peticions, però en deixa
algunes en cua: els pics de streams de sortida superposats són 13, 11 i 10.
El perfil vLLM anterior arriba a setze en les tres rondes.

Python triga 644,91/445,98/375,23 s en les rondes freda/primer retorn/segon
retorn, contra 531,88/432,58/418,40 s de vLLM: +21,25%, +3,10% i −10,32%.
Els resultats amb contextos curts continuen afavorint Python, però el requisit
estricte de setze contextos llargs generant alhora té més validació amb vLLM.
No s'ha canviat la configuració d'inferència ni la selecció del servei habitual.
Perfil privat de prova:
`models/qwen38-flash-next-python-capacity16-private-test-128gb.yml`.
Metodologia, dades, percentatges de TTFT i límits de la conclusió:
`benchmarks/tensorfold-python-capacity16-20261023/ASSESSMENT.md`.

## vLLM 0.32.0: FP8 KV i setze contextos de 75k

El perfil experimental
`models/qwen38-flash-next-vllm-032-nvfp4-fp8-agent-128gb.yml` fixa vLLM 0.32.0,
pesos Inferact NVFP4, KV principal i indexador FP8, estats recurrents FP32,
16 slots i 75.000 tokens totals per petició. Desactiva MTP, usa chunks de 8.192
i reutilització de prefixos amb granularitat de 32 tokens. Admet una imatge;
el vídeo està desactivat. No activa aprenentatge ni memòria de converses.
FP8 és un format de coma flotant; aquest backend QSA no implementa KV INT8/INT4.

La prova GPU ha completat setze entrades de ~74k +896 tokens de sortida amb
setze streams de sortida superposats, sense OOM, preempcions ni swap-out.
El resultat no valida setze imatges simultànies. A setze peticions curtes,
el perfil dona 156,61 tokens/s agregats contra 328,46 de TensorFold Python
(−52,32%). En històries mixtes, l'ajust de prefixos redueix el segon retorn
d'11,65 a 1,05 s de TTFT p50, encara per sobre dels 0,84 s de Python.
Els retorns amb setze contextos llargs perden part de la reutilització.
Python continua seleccionat per al servei habitual. La prova posterior de
contextos llargs, descrita a dalt, limita la recomanació segons la càrrega.

L'adaptació mmap dels pesos PLE està a
`benchmarks/vllm-fp8-agent-20261023/bootstrap.py`; cal sincronitzar-la amb el
YAML i preparar el checkpoint fixat als volums abans de servir en mode offline.
Els pesos difereixen del checkpoint MLX de Python: és una comparació de
desplegaments. Metodologia, percentatges, limitacions i dades a
`benchmarks/vllm-fp8-agent-20261023/ASSESSMENT.md`.

## TensorFold 1.1.2: prova d’11 usuaris amb imatges

El perfil local `archive/models/qwen38-flash-next-tensorfold-112-mlx-4bit-vision-128gb.yml`
fixa el binari oficial 1.1.2 i el seu SHA-256, els pesos MLX existents i 11 streams
amb 75.000 tokens totals per petició. Activa visió (una imatge, màxim 4.096 tokens
visuals), MTP6 i chunks de 1.536; desactiva la retenció de prompts i totes les
funcions de memòria persistent. Utilitza BF16 KV sense pegats locals.

Les proves han completat 11 peticions de ~74k entrada +256 sortida sense OOM,
amb 761 MiB de swap-out; PNG i JPEG han passat. A 11 peticions curtes, el binari
oficial dona 73,11 tokens/s agregats contra 265,49 de Python (−72,46%). A una sola
petició és més ràpid. Els pesos són els mateixos; l’informe diferencia l’efecte
de BF16 KV dels límits actuals del batching MTP natiu. Python continua seleccionat
i els dos serveis originals estan sans després de restaurar el servidor de prova.

Les proves es documenten a
`benchmarks/tensorfold-zig-release112-20261023/ASSESSMENT.md`. El perfil de prova
s’executa a la carpeta `docker/` pròpia del servidor; el servei Python de
referència continua funcionant sense reiniciar-lo. No és una promoció a producció.

## TensorFold Zig INT4: ajustos de cache i revisio 1.1.0

El perfil ajustat es
`archive/models/qwen38-flash-next-tensorfold-zig-tuned-int4-mtp-fp8-vision-128gb.yml`.
Conserva el checkpoint INT4-AutoRound i els kernels CUDA de la recepta MiaAI,
amb llindar de cache 1024, separacio de snapshots 512 i checkpoints abans de
l'ultim missatge d'usuari. La variant amb LRU i 16 GiB de retencio ha passat
253 peticions deterministes en dues execucions GPU, pero ha fallat la prova
de capacitat prop de 75k amb un error CUDA. La configuracio actual redueix
retencio a 8 GiB i amplia la separacio a 512 tokens; encara es valida a la GPU.
Els resultats identics i les limitacions de latencia es documenten a
[l'informe d'ajustos](benchmarks/tensorfold-zig-cache-tuning-20261018/REPORT.md).
La validacio de capacitat del perfil seleccionat es una prova separada.

La revisio oficial TensorFold 1.1.0 continua en proves GPU. La configuracio
inicial MLX amb MTP i visio rebutja 16 streams de 75000 tokens. Sense MTP ni
visio, amb prefill de 768 files i reserva de 8 GiB, admet els 16 streams;
les 35 peticions completes de comparacio passen, pero els cohorts de codi
amb setze usuaris arriben a 133–139 tok/s, per sota de Python (285–321).
L'admissio inicial no substitueix la prova amb tots els contextos prop de 75k.
Les crides automatiques a eines funcionen; una funcio obligatoria continua
sense suport al backend CUDA natiu.

Els nous experiments parteixen del commit complet de la versio 1.1.0,
`76aafcf274e60a5e31a59ce145b2f71f7b366e9d`. Inclouen el checkpoint NVIDIA FP4,
graphs CUDA en una GPU i una cache KV FP8 optativa. Els perfils locals son:

- `archive/models/qwen38-flash-next-tensorfold-110-mlx-4bit-vision-128gb.yml`
- `archive/models/qwen38-flash-next-tensorfold-110-nvidia-fp4-vision-128gb.yml`
- `archive/models/qwen38-flash-next-tensorfold-110-tuned-mlx-4bit-128gb.yml`
- `archive/models/qwen38-flash-next-tensorfold-110-fp8-kv-mlx-4bit-128gb.yml`
- `archive/models/qwen38-flash-next-tensorfold-110-fp8-batched-mtp-head-routed-mlx-4bit-128gb.yml`
- `archive/models/qwen38-flash-next-tensorfold-110-tuned-nvidia-fp4-128gb.yml`
- `archive/models/qwen38-flash-next-tensorfold-110-fp8-batched-mtp-nvidia-fp4-128gb.yml`
- `archive/models/qwen38-flash-next-tensorfold-110-shared-recurrent-mlx-4bit-128gb.yml`
- `archive/models/qwen38-flash-next-tensorfold-110-shared-fused-recurrent-mlx-4bit-128gb.yml`

Tots son experimentals, publiquen 8007 per defecte i no es promocionen fins
que les proves de GPU, outputs i capacitat ho justifiquin. Els perfils ajustats
requereixen els artefactes compilats amb SHA verificat pels scripts de
`archive/benchmarks/tensorfold-zig-release110-20261018/`. Els resultats es documenten a
[l'avaluacio de 1.1.0](archive/benchmarks/tensorfold-zig-release110-20261018/ASSESSMENT.md).
La carpeta local continua sent l'origen dels YAML i patches, que se sincronitzen
al `docker/` propi del servidor. La maquina de referencia manté Python en marxa.
Living Weights, Recall, aprenentatge a disc i converses persistents estan
**desactivats** en tots els perfils 1.1.0. El runner verifica els arguments reals,
els endpoints desactivats i els pesos en nomes lectura abans de mesurar.
La KV i la cache de prefixes en RAM son caches de calcul independents.

Els dos perfils `shared-*-recurrent` adapten el batching recurrent de la branca
de BobClawblaw a la base completa 1.1.0, en una sola GPU i amb els pesos MLX
existents. La branca original exigeix dues GPU i un checkpoint convertit;
no s'executa sencera. Les proves reutilitzen les peticions i fixtures anteriors,
verifiquen els kernels a la GB10 i comparen outputs exactes. L'experiment de
taules de punters es una ablacio; la prova amb setze contextos prop de 75k es
reserva al candidat amb el kernel fusionat. Aquest ha completat els 16 contextos
de prop de 74k tokens mes 256 de resposta, sense OOM, pero els cohorts curts de
setze usuaris encara donen un 41,4% menys de tok/s que Python. Els resultats i
limits es registren a [l'informe de batching recurrent](archive/benchmarks/tensorfold-zig-shared-rounds-20261018/ASSESSMENT.md).
Es conserva Python com a runtime principal; els dos servidors han quedat sans
amb el perfil original i el candidat natiu aturat.

## Perfils experimentals TensorFold Zig / FP4 i INT4

La variant INT4 sense canvis al motor es
`archive/models/qwen38-flash-next-tensorfold-zig-autoround-int4-mtp-fp8-vision-128gb.yml`.
Conserva els mateixos commits, patches, MTP, scheduler i limits (16 streams,
75000 tokens). Utilitza el checkpoint AutoRound top-5 fixat a la recepta,
amb la taula n-gram FP8 a la GPU. Te volums exclusius; la primera descarrega
es d'aproximadament 122 GiB i exigeix almenys 93 GiB disponibles abans de
carregar pesos. Els resultats de la comparacio es conserven a
[l'informe INT4](archive/benchmarks/tensorfold-zig-int4-vs-mlx-20261018/REPORT.md).
La prova ha verificat el mateix executable i 728 fitxers del runtime que FP4.
INT4 disposa de 33.55 GiB per a sequencies, davant dels 25.81 GiB de FP4,
i millora diversos bursts curts. La prova de 16 peticions prop de 75000 tokens
s'ha aturat en superar 1 GiB de swap addicional, sense OOM; aquesta prova no
compta com a passada. La continuacio de converses tambe afavoreix mantenir MLX
com a perfil de servei.

`archive/models/qwen38-flash-next-tensorfold-zig-nvidia-fp4-mtp-fp8-ssd-vision-128gb.yml`
configura 16 streams i 75000 tokens per peticio (prompt + resposta), amb KV FP8,
MTP i imatges/video. El prefill equitatiu es opcional amb
`TENSORFOLD_FAIR_PREFILL=1` (desactivat per defecte com a la recepta original).
Compila el motor Zig amb revisions
fixades de TensorFold i de la recepta MiaAI; conserva runtime, kernels i pesos
en volums propis. La primera arrencada inclou compilacio i una descarrega
d'aproximadament 96 GiB. Requereix almenys 108 GiB disponibles abans de carregar
els pesos i mante el marge de memoria de 10 GiB del motor.

El limit de 16 streams no garanteix setze finestres completes residents:
comprova la capacitat real i els resultats de
`archive/benchmarks/tensorfold-zig-fp4-vs-mlx-20261018/` abans de substituir el perfil
MLX. Cada perfil publica el port 8000; executa nomes un model gran en cada
Spark. FP4 anuncia `nvidia/Qwen3.8-Flash-Next-FP4-Local` i INT4 anuncia
`azampatti/Qwen3.8-Flash-Next-125B-A5B-INT4-AutoRound`; cal redescobrir el model
al proxy si es canvia el perfil actiu.

## Execucio local en un Mac amb Apple Silicon

El perfil `models/qwen35-2b-llamacpp-unsloth-ud-q4_k_xl-local.yml` utilitza
llama.cpp b10853 amb CPU ARM64 dins de Docker Desktop. Prepara `tokens.env`
segons la seccio de tokens i arrenca Docker Desktop abans d'executar, des de `docker/`:

```bash
docker --context desktop-linux compose -f models/qwen35-2b-llamacpp-unsloth-ud-q4_k_xl-local.yml up -d
docker --context desktop-linux compose -f models/qwen35-2b-llamacpp-unsloth-ud-q4_k_xl-local.yml logs -f --tail 80
curl -fsS http://127.0.0.1:8000/health
curl -fsS http://127.0.0.1:8000/v1/models
```

Publica nomes a `127.0.0.1:8000`; la URL base OpenAI es
`http://127.0.0.1:8000/v1`. Els pesos i el projector BF16 es descarreguen
automaticament en un volum exclusiu. No necessita CUDA. Per aturar-lo conservant
els pesos, utilitza el mateix `docker --context desktop-linux compose -f ... down`.
En altres hosts, utilitza el context local de Docker corresponent.

## Aturar el model actual i arrencar-ne un altre

Executa les comandes dins de `docker/` al servidor GPU (o `~/docker` si nomes
hi has copiat aquesta carpeta). Consulta el nom del YAML del model en execucio:

```bash
docker ps --filter label=com.ieti.inference=true --format 'table {{.Names}}\t{{.Label "com.ieti.profile"}}\t{{.Status}}'
ls models/*.yml
```

Atura el perfil actual amb el seu YAML; conserva els pesos descarregats:

```bash
docker compose -f models/qwen38-27b-vllm-unsloth-nvfp4-mtp-128gb.yml down
```

Arrenca el nou perfil indicant el seu YAML:

```bash
docker compose -f models/qwen35-9b-llamacpp-unsloth-q6_k-12gb.yml up -d
docker compose -f models/qwen35-9b-llamacpp-unsloth-q6_k-12gb.yml logs -f --tail 80
```

Substitueix els noms dels exemples pels perfils que vols aturar i arrencar.
Tots publiquen el port 8000: primer atura l'anterior. La primera arrencada pot
trigar mentre descarrega pesos i prepara el runtime. Comprova l'estat i el model:

```bash
docker compose -f models/qwen35-9b-llamacpp-unsloth-q6_k-12gb.yml ps
curl -fsS http://127.0.0.1:8000/v1/models
```

Els contenidors anteriors a aquesta reorganitzacio no tenen l'etiqueta del YAML.
Si la primera comanda no els mostra, consulta la seccio de migracio abans d'arrencar.
Per una instal·lacio nova, prepara primer `tokens.env` com s'explica mes avall.

## Eliminar un model i els seus volums per recuperar espai

Indica el YAML exacte del perfil que vols eliminar. Consulta primer els seus
volums i imatges; els noms retornats per `config --volumes` coincideixen amb els
noms persistents dels volums en aquests YAML:

```bash
profile=models/qwen35-9b-llamacpp-unsloth-q6_k-12gb.yml
docker compose -f "$profile" config --volumes
docker compose -f "$profile" config --images
docker compose -f "$profile" down --volumes --rmi all
docker system df
```

Aixo elimina els contenidors (inclosos els logs i els fitxers del seu sistema de
fitxers), la xarxa del projecte i tots els volums del perfil: pesos, tokenizers,
GGUF i caches de runtime o pip. Tambe intenta eliminar les imatges del servei.
Les imatges o capes compartides amb altres contenidors poden continuar ocupant
espai; Docker pot rebutjar-ne l'eliminacio si encara estan en us. Els altres
perfils que comparteixen una imatge eliminada l'hauran de tornar a descarregar.
Una imatge `local/...` necessita tornar-se a importar o construir; conserva'n
una copia o la recepta abans d'eliminar-la si la voldras reutilitzar.

Si un volum antic encara existeix despres del `down`, comprova els contenidors
que el munten i elimina nomes aquell volum quan ja no estigui en us:

```bash
docker ps -a --filter volume=NOM_EXACTE_DEL_VOLUM
docker volume inspect NOM_EXACTE_DEL_VOLUM
docker volume rm NOM_EXACTE_DEL_VOLUM
```

Conserva el YAML si vols poder tornar a desplegar el perfil. Per retirar-lo tambe
del repositori, elimina'l **despres** de completar la neteja:

```bash
rm -- "$profile"
```

Actualitza `CONFIGS.md` i sincronitza la retirada als servidors. El fitxer de
tokens es compartit i es conserva. `down` sense `--volumes` conserva les caches.
No cal fer una neteja global de Docker per retirar un perfil.

Referencia: [volums Compose](https://docs.docker.com/reference/compose-file/volumes/)
i [opcions de down](https://docs.docker.com/reference/cli/docker/compose/down/).

## Estructura i requisits

- `models/*.yml`: un fitxer autonom per perfil, amb motor, arguments, identitat
  real, health check i volums. Cada YAML declara un `name` de projecte unic.
- `CONFIGS.md`: seleccio de models recomanats segons VRAM i tipus d'us.
- `explain-docker.md`: origen local, sincronitzacio i execucio remota.
- `tokens.env.example`: format del fitxer privat `tokens.env`.

Cal Docker amb Compose i un host GPU compatible amb el runtime del perfil.
No cal cap gestor, cataleg JSON ni carpeta de scripts. Els perfils experimentals
que necessiten preparar dependències o aplicar patches ho fan dins del YAML.
Els perfils que utilitzen una imatge `local/...` necessiten que aquesta imatge
ja existeixi al servidor; consulta el camp `image` del YAML.

No canviis el `name` del projecte ni els noms persistents dels volums quan ajustis
context o concurrencia. Els volums son exclusius de cada perfil, encara que
alguns perfils descarreguin els mateixos pesos. Cada YAML es fa servir tot sol,
sense combinar-lo amb altres fitxers `-f` ni sobreescriure el projecte amb `-p`.

## Preparar el token de Hugging Face

Crea el fitxer una sola vegada, sense sobreescriure un token existent:

```bash
[ -f tokens.env ] || cp tokens.env.example tokens.env
chmod 600 tokens.env
```

Edita `tokens.env` i posa el token a `HUGGINGFACE_ACCESS_TOKENS`. Si el perfil no
el necessita, deixa el valor buit. El fitxer esta ignorat per Git. Els YAML el
munten en mode lectura des de `../tokens.env` i exporten `HF_TOKEN` i
`HUGGING_FACE_HUB_TOKEN` dins del contenidor. Si falta el fitxer, l'arrencada falla
sense crear un directori amb el seu nom. Ja no hi ha cap pregunta interactiva ni
copia automatica del token des de l'entorn del host.

## Identitat del model i configuracio del proxy

Cada servidor publica la identitat dels pesos seleccionats, amb el repositori
i la quantitzacio quan correspon. Per exemple, el perfil Qwen3.8-27B NVFP4
publica `unsloth/Qwen3.8-27B-NVFP4`. En GGUF amb un fitxer concret, publica el
nom d'aquell fitxer. Consulta sempre `/v1/models` despres d'arrencar.

Al web del proxy, executa **Autoconfigure** al proveidor corresponent i revisa
els valors detectats. **Apply and save** desa la mateixa identitat a **Upstream
model** i **OpenCode model alias**, juntament amb les capacitats detectades.
Actualitza la configuracio dels clients despres de canviar de model. Els
mappings d'una base de dades existent no canvien fins que apliques la descoberta.
Els proveidors que publiquen la mateixa identitat queden agrupats al proxy.

## Retencio de snapshots de Flash Next CUDA

El perfil `models/qwen38-flash-next-tensorfold-vontra-mlx-4bit-mtp-int8-ssd-vision-128gb.yml`
conserva el nom historic del fitxer, pero publica
`TensorFold/Qwen3.8-Flash-Next-MLX-4bit-MTP`. TensorFold esta fixat al commit
`609ca419abecebdc5a059498a613680bd3aa847f` de v0.6.5, i els pesos a la revisio
`2b170fa6309d5d1ee380b35636075fac7945f286`. L'arrencada descarrega aquesta
revisio explicita, verifica l'index de shards i serveix el snapshot local amb
la identitat canonica; no executa `tensorfold pull` sobre la branca principal.

Els tres volums d'aquest perfil tenen noms `ieti-...-tensorfold-mlx-...` sense
`vontra`, i Compose els crea automaticament. En migrar des del projecte antic,
atura i retira primer el contenidor anterior amb el seu YAML encara disponible;
despres sincronitza el YAML local i arrenca el projecte nou. Els volums nous
comencen buits: cal tornar a descarregar aproximadament 114 GB de pesos i
escalfar els kernels. Quan el nou servei sigui saludable i validat, es poden
retirar els volums antics que cap altre contenidor utilitzi; no facis un prune
global. Els altres perfils conserven els seus volums.

El perfil
afegeix la variable **personalitzada** `TENSORFOLD_PROMPT_SNAPSHOTS`, amb valor
per defecte `64` i enters admesos d'`1` a `64`. No es una opcio YAML/CLI nativa
de TensorFold v0.6.5. L'arrencada substitueix exactament una vegada el `KEEP = 8`
esperat del commit fixat, **abans** de la instal·lacio pip ordinaria. Si el
constant o els seus usos no coincideixen, l'arrencada falla clarament. Despres
comprova el valor i els usos al modul Python instal·lat, no nomes al checkout.

El mateix `KEEP` governa la planificacio de memoria d'`indexed_stream_geometry`
i la retencio de `MultiDecoder`. `64` son snapshots retinguts de prefixos de
text compartits pel servidor, no seixanta-quatre converses garantides: una conversa
pot generar-ne diversos. El nombre de streams concurrents continua sent `16`.
Augmentar-lo consumeix memoria addicional i no garanteix una millora del
rendiment. Les peticions amb imatges ometen actualment aquesta reutilitzacio
de prefixos de text. No cal recompilar CUDA ni reconstruir la imatge; si que
calen la instal·lacio i l'escalfament normals quan es recrea el contenidor.

La prova del 2026-10-11 amb MLX 4 bits, KV int8 i 16 histories de programacio
(8 curtes, 7 de ~7400 tokens i una de ~65000) va comparar 32, 48 i 64 snapshots.
En tornar al torn anterior, 64 va conservar els 16 prefixos i va reduir TTFT
p50 de 18,54 a 2,96 s i p95 de 51,87 a 3,81 s respecte de 32. Va augmentar
l'estimacio de memoria d'arrencada en ~3,45 GiB. Els torns que nomes afegien
missatges ja reutilitzaven tots els prefixos amb 32; no es va establir una
millora de decode ni de prefill en fred. Es una campanya per configuracio,
no una validacio de setze contextos plens de 75k alhora. Dades i patches a
`benchmarks/tensorfold-snapshots-20261011/`.

v0.6.5 recull les files n-gram abans d'esperar les copies anteriors per defecte
(`TF_FLASH_STAGE_AHEAD=1`). Les rondes de setze streams continuen en mode eager;
una peticio de text sola amb MTP, sense prefill pendent, pot usar CUDA Graphs.
El perfil conserva els valors de context, streams, KV int8, MTP i visio.

El mateix perfil aplica tambe el petit patch Python de batching SSD a
`forward.stage`: concatena els IDs n-gram dels streams en el mateix ordre i fa
un gather per capa, mantenint histories, files, events CUDA i el cami EXL3.
`TENSORFOLD_SSD_BATCH_GATHER=1` es el valor per defecte; `0` recupera el staging
upstream en recrear el contenidor, sense desactivar el patch de snapshots.
L'arrencada comprova els SHA-256 exactes abans i despres del canvi, i el fitxer
instal·lat despres de pip. En tres parelles de proves a 16 peticions, el decode
va passar de 190,0 a 212,4 tok/s (+11,7%); els 144 outputs comparats coincidien.
Els comentaris del YAML documenten els parametres i els limits d'aquest resultat.

Per tornar temporalment a setze snapshots, des de `docker/` i amb el mateix
projecte Compose i volums persistents:

```bash
TENSORFOLD_PROMPT_SNAPSHOTS=16 docker compose -f models/qwen38-flash-next-tensorfold-vontra-mlx-4bit-mtp-int8-ssd-vision-128gb.yml up -d --no-deps --force-recreate qwen-tensorfold
```

Revisa als logs el missatge `Verified installed Flash Next KEEP=16` (o `64`)
i espera l'estat saludable abans d'enviar-hi càrrega. La variable es resol
quan s'executa Compose; conserva el YAML anterior per recuperar la configuracio
completa. Recrear nomes aquest servei conserva pesos, `tokens.env` i caches.

## Migracio dels desplegaments anteriors

La reorganitzacio inicial conservava els noms dels contenidors i volums de
perfil per reutilitzar les caches. El perfil Flash Next TensorFold amb visio
ara migra a la identitat i els volums canonics descrits a la seccio anterior.
Els projectes Compose tenen noms explicits diferents dels antics.

Abans del primer `up` al servidor, identifica el contenidor antic que publica
el port 8000 i el seu projecte:

```bash
docker ps -a --format 'table {{.Names}}\t{{.Ports}}\t{{.Label "com.docker.compose.project"}}'
docker inspect --format '{{index .Config.Labels "com.docker.compose.project.config_files"}}' NOM_DEL_CONTENIDOR
```

Atura i elimina nomes aquell contenidor, conservant els volums:

```bash
docker stop NOM_DEL_CONTENIDOR
docker rm NOM_DEL_CONTENIDOR
```

Si ja estava aturat, fes nomes `docker rm`. Revisa tambe els contenidors aturats
d'altres perfils abans d'arrencar-los amb els nous projectes. Pots eliminar una
xarxa antiga amb `docker network rm NOM_EXACTE_DE_LA_XARXA` quan no tingui cap
contenidor connectat. Despres fes `up -d` amb el nou YAML.

Compose pot avisar que un volum existent no pertany al nou projecte. Conserva'n
el nom i les dades; no acceptis recrear-lo si aixo n'elimina el contingut. Si la
versio de Compose en rebutja la reutilitzacio, conserva'l temporalment com a
`external: true` al YAML afectat fins a planificar la migracio. En aquest cas,
`down --volumes` no el retirara: cal la neteja explicita del volum indicada a dalt.

Les caches de perfils retirats no apareixen als YAML actuals. Revisa-les amb
`docker volume ls`, comprova qui les munta i elimina-les individualment quan
ja no calguin. Aixo inclou les antigues caches globals i de perfils retirats;
canviar els fitxers locals no elimina dades dels servidors.

## Afegir o validar un perfil

Copia el YAML mes semblant dins de `models/`, assigna un `name` de projecte,
un nom de contenidor i noms de volums exclusius, actualitza l'etiqueta
`com.ieti.profile` amb el nom del fitxer i configura la identitat real servida.
Mantén tota la logica d'arrencada dins del YAML. Actualitza `CONFIGS.md` si el
perfil forma part de la seleccio recomanada.
Valida sense arrencar contenidors:

```bash
for profile in models/*.yml; do
  docker compose -f "$profile" config --quiet || break
done
```

La validacio del YAML no comprova compatibilitat GPU, qualitat, multimodalitat
ni rendiment; registra aquests resultats als comentaris del YAML quan es provin.
