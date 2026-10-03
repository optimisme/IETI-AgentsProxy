# Models Docker

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
`9356df5c424b0c36b7737e37873a6f968b08de79` de v0.6.3, i els pesos a la revisio
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
per defecte `32` i enters admesos d'`1` a `32`. No es una opcio YAML/CLI nativa
de TensorFold v0.6.3. L'arrencada substitueix exactament una vegada el `KEEP = 8`
esperat del commit fixat, **abans** de la instal·lacio pip ordinaria. Si el
constant o els seus usos no coincideixen, l'arrencada falla clarament. Despres
comprova el valor i els usos al modul Python instal·lat, no nomes al checkout.

El mateix `KEEP` governa la planificacio de memoria d'`indexed_stream_geometry`
i la retencio de `MultiDecoder`. `32` son snapshots retinguts de prefixos de
text compartits pel servidor, no trenta-dues converses garantides: una conversa
pot generar-ne diversos. El nombre de streams concurrents continua sent `16`.
Augmentar-lo consumeix memoria addicional i no garanteix una millora del
rendiment. Les peticions amb imatges ometen actualment aquesta reutilitzacio
de prefixos de text. No cal recompilar CUDA ni reconstruir la imatge; si que
calen la instal·lacio i l'escalfament normals quan es recrea el contenidor.

Per tornar temporalment a setze snapshots, des de `docker/` i amb el mateix
projecte Compose i volums persistents:

```bash
TENSORFOLD_PROMPT_SNAPSHOTS=16 docker compose -f models/qwen38-flash-next-tensorfold-vontra-mlx-4bit-mtp-int8-ssd-vision-128gb.yml up -d --no-deps --force-recreate qwen-tensorfold
```

Revisa als logs el missatge `Verified installed Flash Next KEEP=16` (o `32`)
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
