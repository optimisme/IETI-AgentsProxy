# Gestio de models Docker

Aquest directori separa dues responsabilitats:

- `compose-*.yml`: defineixen com arrenca cada servei Docker.
- `models.json`: es el cataleg operatiu de models.
- `RANKING.md`: ordena els perfils recomanats per programacio, VRAM i modalitat.
- `CONFIGS.md`: resumeix context, concurrencia, VRAM, imatge i puntuacio dels compose actius.
- `modelctl.sh`: es el gestor unic per listar, arrencar, parar, veure logs i gestionar caches.

`run_docker.sh` ha quedat retirat. Fes servir sempre `modelctl.sh`.

## Arquitectura

Els serveis continuen arrencant amb Docker Compose, pero els noms curts, contenidors,
fitxers compose i volums associats viuen a `models.json`. Aixi evitem mantenir la
mateixa informacio duplicada dins d'un script amb blocs `case`.

Els volums de cache son especifics de cada perfil/model i es declaren a
`models.json`. Aixo fa mes facil esborrar totes les dades d'un perfil concret
quan ja no es fa servir, sense barrejar-les amb caches d'altres proves.

| Volum | Us |
|---|---|
| `xtec-<model>-hf-cache` | Cache de Hugging Face del perfil: pesos, tokenizers i snapshots |
| `xtec-<model>-vllm-cache` | Cache/runtime vLLM del perfil |
| `xtec-<model>-gguf-cache` | Models GGUF i cache llama.cpp del perfil, nomes en perfils GGUF |

Els compose declaren aquests volums com a externs. `modelctl.sh start ...` els crea
automaticament abans d'arrencar el servei si encara no existeixen.

## Descoberta de capacitats

`modelctl.sh` arrenca nomes el servei d'inferencia definit al Compose. No genera
manifests ni arrenca servidors Python auxiliars. `info` mostra la configuracio del
cataleg; no es una comprovacio de les capacitats del model en execucio.

El proxy consulta `/v1/models` i prova directament el model seleccionat amb
peticions petites de text, imatge, eines i historial de raonament. Les dades
publicades pel servidor tenen prioritat. Les proves inconclusives no canvien els
valors existents. No cal exposar `/server_info` ni activar el mode de desenvolupament.

Docker ha d'estar configurat per iniciar-se amb el sistema. Cada model conserva
la politica `restart` del seu Compose. Un contenidor eliminat amb `docker compose
down` no es reinicia automaticament.

Si encara existeixen sidecars d'una instal·lacio anterior, elimina nomes els
contenidors amb les etiquetes `com.xtec.modelctl.owner=modelctl` i
`com.xtec.modelctl.role=metadata`. Els manifests antics de `.modelctl-state/` ja no
s'utilitzen. Aquesta migracio no requereix reiniciar el model.

Els volums globals antics `xtec-hf-cache`, `xtec-vllm-cache` i `xtec-gguf-cache`
es mantenen al cataleg nomes com a objectius de neteja despres de la migracio.

## Estat actual

El model per defecte de `models.json` es:

```text
qwen38-27b-cuda-vram128-vllm-radixark-nvfp4-dspark-128k-image
```

Tots els `compose-*.yml` que es mantenen en aquesta carpeta han d'apareixer a
`RANKING.md`, i tots els compose del ranking han de tenir entrada a `models.json`.
`CONFIGS.md` es la vista rapida per comparar perfils abans de desplegar.

Els perfils amb imatge han de servir-se amb 64k de context
(`--max-model-len 65536`) i el client tambe s'ha de configurar a 64k. Amb 32k
les imatges poden fallar per falta de context.

## Tokens privats de HuggingFace

Els models Qwen amb pesos restringits necessiten un token
de [HuggingFace](https://huggingface.co). El token no es desa dins dels `compose-*.yml`: es posa en un
fitxer local `docker/tokens.env`, que no s'ha de publicar.

Pots aconseguir un "Access Token" a l'espai "Settings" del teu compte personal de ["Hugging Face Settings"](https://huggingface.co/settings/profile)

Format esperat:

```bash
HUGGINGFACE_ACCESS_TOKENS=hf_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

Els compose munten aquest fitxer com a `/run/secrets/tokens.env` i, abans
d'executar el runtime, fan:

- carrega de `/run/secrets/tokens.env`
- lectura de `HUGGINGFACE_ACCESS_TOKENS`
- exportacio de `HF_TOKEN` i `HUGGING_FACE_HUB_TOKEN`

Aixo fa que `huggingface_hub`, vLLM i llama.cpp rebin el token amb els noms que
esperen internament.

`modelctl.sh start ...` i `modelctl.sh restart ...` preparen `tokens.env` abans
d'executar Docker Compose:

- si `HUGGINGFACE_ACCESS_TOKENS` ja existeix a l'entorn, l'escriu a
  `docker/tokens.env` i la fa servir;
- si no existeix pero `docker/tokens.env` ja conte la variable, fa servir aquest
  fitxer;
- si no existeix enlloc i l'script s'executa en una terminal interactiva,
  pregunta en angles si vols introduir el token;
- si no hi ha terminal interactiva, continua sense token i mostra un avis.

Per tant, en una maquina remota pots desplegar el token de dues maneres: sincronitzar
`docker/tokens.env` abans d'arrencar el model, o executar `modelctl.sh` amb
`HUGGINGFACE_ACCESS_TOKENS` definida a l'entorn remot.

## Comandes principals

Llista els models configurats:

```bash
./docker/modelctl.sh list
```

Mostra la vista detallada amb motor, contenidor i compose:

```bash
./docker/modelctl.sh list-full
```

Arrenca un model sense parar altres serveis:

```bash
./docker/modelctl.sh start qwen36-35b-a3b-cuda-vram128-vllm-nvidia-nvfp4-64k-image
```

Reinicia un model aturant abans tots els contenidors configurats:

```bash
./docker/modelctl.sh restart qwen36-35b-a3b-cuda-vram128-vllm-nvidia-nvfp4-64k-image
```

Segueix els logs:

```bash
./docker/modelctl.sh logs qwen36-35b-a3b-cuda-vram128-vllm-nvidia-nvfp4-64k-image
```

El perfil arrencat exposa el model com `active-model` a
`http://127.0.0.1:8000/v1`.

Mostra contenidors:

```bash
./docker/modelctl.sh ps
```

Atura tots els models configurats:

```bash
./docker/modelctl.sh stop
```

## Gestio de caches

Llista els volums de cache configurats:

```bash
./docker/modelctl.sh cache ls
```

Mostra la mida de cada cache:

```bash
./docker/modelctl.sh cache du
```

Esborra un volum de cache. Aquesta operacio requereix `--force`:

```bash
./docker/modelctl.sh cache rm xtec-gguf-cache --force
```

Esborra tots els volums de cache associats a un model concret:

```bash
./docker/modelctl.sh cache rm-model qwen36-35b-a3b-cuda-vram128-vllm-nvidia-nvfp4-64k-image --force
```

Esborra totes les caches configurades:

```bash
./docker/modelctl.sh cache rm all --force
```

Docker no permet esborrar un volum que estigui muntat per un contenidor existent.
Atura primer els serveis amb `./docker/modelctl.sh stop` si cal.

## Afegir un model

1. Crea el fitxer `compose-{model}-{target}-{runtime}-{origin}-{quant}.yml`. Exemple: `compose-qwen36-35b-a3b-cuda-vram128-vllm-qwen-fp8.yml`.
2. Munta els volums especifics del model i conserva els punts interns:
   - `xtec-<model>-hf-cache:/root/.cache/huggingface`.
   - `xtec-<model>-vllm-cache:/root/.cache/vllm` per vLLM.
   - `xtec-<model>-gguf-cache:/root/.cache/llama.cpp` per llama.cpp/GGUF.
3. Afegeix l'entrada corresponent a `models.json`.
4. Documenta el compose a `RANKING.md` i actualitza `CONFIGS.md`.
5. Valida:

```bash
python3 -m json.tool docker/models.json >/tmp/models_valid.json
for f in docker/compose-*.yml; do docker compose -f "$f" config --quiet; done
./docker/modelctl.sh list
```

Comprovacio de consistencia entre ranking i cataleg:

```bash
node - <<'NODE'
const fs = require('fs');
const ranking = fs.readFileSync('docker/RANKING.md', 'utf8');
const ranked = new Set([...ranking.matchAll(/compose-[A-Za-z0-9._-]+\.yml/g)].map(m => m[0]));
const models = JSON.parse(fs.readFileSync('docker/models.json', 'utf8')).models;
const catalog = new Set(Object.values(models).map(m => m.compose));
for (const compose of ranked) {
  if (!catalog.has(compose)) throw new Error(`Missing in models.json: ${compose}`);
}
for (const compose of catalog) {
  if (!ranked.has(compose)) throw new Error(`Missing in RANKING.md: ${compose}`);
}
console.log('Ranking and models.json are aligned');
NODE
```
