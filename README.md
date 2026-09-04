# IETI Agents Proxy

Proxy OpenAI-compatible pensat per a cursos d'agents d'IA. Els usuaris fan servir claus internes amb format `ieti_sk_...`, i el servidor reenvia les peticions al proveidor d'IA assignat al grup de cada usuari fent servir credencials guardades al servidor.

L'objectiu és que l'alumnat pugui treballar amb eines compatibles amb OpenAI, com OpenCode, sense rebre directament les claus reals dels proveidors externs.

## Funcionalitats

- API compatible amb OpenAI per a `GET /v1/models`, `POST /v1/chat/completions` i `POST /v1/responses`.
- Suport per respostes normals JSON i streaming SSE.
- Portal web per a estudiants amb inici de sessio, gestio de clau API i descarrega dels llançadors d'OpenCode per Bash i PowerShell.
- Backoffice d'administracio per crear usuaris, grups, proveidors, quotes i configuracio del servidor.
- Quotes per grup: crides i tokens per dia/hora.
- Rate limit per usuari.
- Registre d'us en SQLite amb tokens, proveidor i estat de la peticio.
- Claus d'usuari i tokens d'invitacio guardats com a hash, no en text pla.

## Requisits

- Node.js `>=24 <25`
- npm
- SQLite, usat a traves de `better-sqlite3`

## Posada en marxa en local

Instal.la dependencies:

```bash
npm install
```

Crea la configuracio local:

```bash
cp settings.env.example settings.env
```

Edita `settings.env` i canvia com a minim:

```env
DEFAULT_PROVIDER_API_KEY=your_deepseek_key_here
ADMIN_PASSWORD=replace_with_a_secure_admin_password
SESSION_SECRET=replace_with_a_long_random_session_secret

GOOGLE_OAUTH_ENABLED=false
GOOGLE_OAUTH_CLIENT_ID=
GOOGLE_OAUTH_CLIENT_SECRET=
GOOGLE_OAUTH_ALLOWED_DOMAINS=xtec.cat,iesesteveterradas.cat
GOOGLE_OAUTH_AUTO_REGISTER=true
```

Inicialitza la base de dades (es fa automàticament al primer inici):

```bash
npm run init-db
```

Arrenca el servidor:

```bash
npm start
```

Per defecte escolta a:

```txt
http://localhost:3000
```

El portal d'estudiants es troba a `/` i el panell d'administracio a `/admin`.

## Mode de desenvolupament

Per treballar amb reinici automatic quan canvies fitxers:

```bash
npm run dev
```

Aquest mode executa:

```bash
node --watch src/server.js
```

## Mode test

La suite de tests fa servir un proveidor DeepSeek simulat localment. No necessita cap clau real.

```bash
npm test
```

Els tests cobreixen salut del servidor, autenticacio per contrasenya, Google OAuth, aprovacio de registres, recuperacio d'identitats, quotes, administracio, rutes OpenAI-compatible, routing de proveidors, concurrencia i streaming.

## Mode produccio

En produccio convé instal.lar nomes dependencies necessaries:

```bash
npm install --omit=dev
cp settings.env.example settings.env
```

Edita `settings.env` amb valors reals i segurs:

```env
PORT=3000
DATABASE_PATH=./data/agents_proxy.sqlite

DEFAULT_PROVIDER_API_KEY=dummy_deepseek_api_key_replace_me
DEFAULT_PROVIDER_BASE_URL=https://api.deepseek.com
DEFAULT_PROVIDER_SLUG=deepseek
DEFAULT_PROVIDER_NAME=DeepSeek
DEFAULT_UPSTREAM_MODEL=deepseek-chat
PUBLIC_MODEL_NAME=active-model
PUBLIC_BASE_URL=https://your-public-domain.example

ADMIN_USERNAME=admin
ADMIN_PASSWORD=replace_with_a_strong_password
ADMIN_PASSWORD_HASH=
SESSION_SECRET=replace_with_a_long_random_session_secret

GOOGLE_OAUTH_ENABLED=false
GOOGLE_OAUTH_CLIENT_ID=
GOOGLE_OAUTH_CLIENT_SECRET=
GOOGLE_OAUTH_ALLOWED_DOMAINS=xtec.cat,iesesteveterradas.cat
GOOGLE_OAUTH_AUTO_REGISTER=true

MAX_REQUESTS_PER_MINUTE=1000
MAX_TOKENS_PER_REQUEST=8192
DEFAULT_DAILY_TOKEN_LIMIT=10000000
DEFAULT_MODEL_CONTEXT_LIMIT=90000
DEFAULT_MODEL_OUTPUT_LIMIT=8192
MAX_IMAGES_PER_REQUEST=4
MAX_IMAGE_BYTES=8000000
MAX_TOTAL_IMAGE_BYTES=16000000
ALLOW_VIDEO_INPUT=false

ENABLE_STREAMING=true
LOG_REQUEST_BODY=false
REQUEST_TIMEOUT_MS=120000
STREAM_INACTIVITY_TIMEOUT_MS=600000
```

`REQUEST_TIMEOUT_MS` limits the upstream connection and non-streaming request. Once a streaming response starts, `STREAM_INACTIVITY_TIMEOUT_MS` is reset whenever an upstream chunk arrives, so an active agent run is not aborted merely because its total duration exceeds the request timeout.

From the provider edit page, **Autoconfigure** queries the standard OpenAI-compatible `/v1/models` catalog. It imports the selected upstream model ID and, when published by servers such as vLLM, `max_model_len`. Provider-specific capabilities, output limits, and runtime flags remain explicit administrator settings because the OpenAI-compatible model catalog does not standardize them.

Inicialitza la base de dades:

```bash
npm run init-db
```

En produccio, arrenca el proces amb PM2:

```bash
npm install -g pm2
npm run pm2:start
npm run pm2:save
```

Els scripts PM2 fan servir `ecosystem.config.cjs` i mantenen el nom de proces `app`, compatible amb els scripts de desplegament existents.

Comandes habituals:

```bash
npm run pm2:list
npm run pm2:logs
npm run pm2:restart
npm run pm2:stop
```

Si no vols PM2, l'entrypoint directe continua sent `node src/server.js`.

En produccio, fes servir HTTPS davant del servidor, per exemple amb un reverse proxy.

## Configuracio important

La configuracio es llegeix de `settings.env` a traves de `src/config.js`.

Valors principals:

- `PORT`: port HTTP local.
- `DATABASE_PATH`: ruta del fitxer SQLite.
- `DEFAULT_PROVIDER_API_KEY`: clau inicial del proveidor per sembrar la primera base de dades.
- `DEFAULT_PROVIDER_BASE_URL`: URL base del proveidor OpenAI-compatible.
- `PUBLIC_MODEL_NAME`: nom de model que veuran els clients, per defecte `active-model`.
- `PUBLIC_BASE_URL`: origen HTTPS public i canonic de l'aplicacio web, sense `/v1` ni una barra final. Es fa servir per generar enllaços com `https://agents.ieti.site/invite/...` i les URL de descarrega. Quan existeix a `settings.env`, preval sobre el valor desat anteriorment a la taula `settings`.
- `PROXY_AGENTS_BASE_URL`: URL base de l'API, normalment acabada en `/v1`, que els scripts `set_agents_opencode.sh` i `set_agents_opencode.ps1` accepten com a override quan s'executen. No s'ha de confondre amb `PUBLIC_BASE_URL`, que identifica l'aplicacio web i construeix els enllaços d'invitacio.
- `ADMIN_USERNAME`, `ADMIN_PASSWORD`, `ADMIN_PASSWORD_HASH`: credencials d'administracio.
- `SESSION_SECRET`: secret de sessio Express. Ha de ser llarg i aleatori.
- `GOOGLE_OAUTH_ENABLED`: activa l'inici de sessio Google OpenID Connect per als usuaris.
- `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`: credencials d'un client OAuth de tipus **Web application**.
- `GOOGLE_OAUTH_ALLOWED_DOMAINS`: dominis Google Workspace admesos, separats per comes. El valor unic `*` admet qualsevol compte Google amb correu verificat.
- `GOOGLE_OAUTH_AUTO_REGISTER`: crea com a pendent un estudiant OAuth desconegut; no rep grup, models ni claus fins que l'administrador l'aprova.
- `MAX_REQUESTS_PER_MINUTE`: rate limit per usuari.
- `MAX_TOKENS_PER_REQUEST`: maxim de `max_tokens` de sortida que pot demanar una peticio. Els tokens reals es registren a partir del `usage` del proveidor quan existeix.
- `DEFAULT_DAILY_TOKEN_LIMIT`: limit global per defecte del servidor.

`DEFAULT_PROVIDER_API_KEY`, `DEFAULT_PROVIDER_BASE_URL`, `DEFAULT_PROVIDER_SLUG`, `DEFAULT_PROVIDER_NAME` i `DEFAULT_UPSTREAM_MODEL` nomes s'usen per crear el primer proveidor en una base de dades nova. Un cop creada la base de dades, els proveidors es gestionen des de l'administracio.

## Enllaços d'invitacio

Quan l'administrador crea un usuari, **Enabled** esta seleccionat per defecte i el servidor genera un enllaç d'invitacio individual d'un sol ús. L'enllaç es mostra a la fitxa de l'usuari perquè l'administrador el copiï i el comparteixi manualment. **Regenerate invitation key** invalida l'enllaç anterior i en genera un de nou.

Quan l'usuari obre l'enllaç i desa la primera contrasenya, la invitacio queda consumida, la sessio es regenera i l'usuari entra directament al portal.

## Inici de sessio amb Google

El portal admet Google OpenID Connect sense canviar l'autenticacio de l'API `/v1`, que continua fent servir claus `ieti_sk_...`. Crea un client OAuth a Google Cloud de tipus **Web application** i registra exactament aquesta URI de redireccio:

```text
https://your-public-domain.example/auth/google/callback
```

La URI es deriva de `PUBLIC_BASE_URL`, que ha de ser HTTPS en produccio. El servidor demana nomes els scopes `openid email profile`, valida `state`, `nonce`, PKCE, signatura, audiencia, correu verificat i el claim `hd` dels dominis configurats. No desa access tokens ni refresh tokens de Google.

Si el correu verificat ja existeix, la identitat Google s'enllaca al mateix usuari sense crear duplicats i qualsevol invitacio pendent queda invalidada. Si no existeix i `GOOGLE_OAUTH_AUTO_REGISTER=true`, es crea un usuari pendent sense grup ni clau. El portal mostra que el compte espera aprovacio fins que l'administrador selecciona **Assign group and approve**.

El rol d'usuari (`student` o `teacher`) es tria des de l'administracio en crear o editar un compte, inclosa l'aprovacio d'un registre OAuth pendent. El rol no limita l'inici de sessio Google: qualsevol compte existent, habilitat i aprovat pot enllacar la seva identitat. Els registres OAuth desconeguts es creen inicialment com a `student` pendent fins que l'administrador n'assigna el rol i el grup.

Si Google recrea un compte institucional amb el mateix correu i un `sub` diferent, la peticio apareix a **OAuth reviews**. L'administrador pot conservar tot el compte i substituir-ne la identitat, reiniciar-lo com un usuari pendent nou, o rebutjar la peticio. El reinici elimina claus, configuracio, converses i missatges; els registres d'us queden anonimitzats.

## Us amb OpenCode

Cada usuari pot executar des del portal la comanda del seu sistema operatiu. La comanda descarrega `set_agents_opencode.sh` o `set_agents_opencode.ps1` des del mateix servidor i executa l'script en el directori actual. L'script:

- detecta automaticament el domini i port publicats pel portal i els utilitza com a URL per defecte;
- reutilitza la URL de `provider.ieti-agents.options.baseURL` si ja existeix a `opencode.json` i nomes la demana si no la pot trobar;
- demana la clau API nomes la primera vegada, si no existeix `.secrets/agents_server_key`;
- crea `.secrets/agents_server_key` amb permisos restrictius i reutilitza la clau existent en execucions posteriors, sense tornar-la a demanar;
- consulta `GET /v1/model-capabilities` amb la clau autenticada per obtenir els models i les seves capacitats;
- genera o actualitza automaticament el proveidor `ieti-agents` i els models visibles a l'`opencode.json` local;
- valida la connexio abans de modificar la configuracio i no desa la clau en cap variable d'entorn;
- no inicia ni obre OpenCode.

El portal mostra una comanda copiable per a cada sistema operatiu. A macOS/Linux té aquesta forma:

```bash
bash -c "$(curl -fsSL 'https://your-public-domain.example/downloads/set_agents_opencode.sh?default_base_url=https%3A%2F%2Fyour-public-domain.example%2Fv1')"
```

El valor de `default_base_url` s'injecta automaticament en generar la comanda. També es pot indicar manualment per a una execució no interactiva:

```bash
PROXY_AGENTS_BASE_URL=https://agents.ieti.site/v1 ./set_agents_opencode.sh
```

Exemple de configuracio generada:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "ieti-agents": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "IETI Agents",
      "options": {
        "baseURL": "https://your-public-domain.example/v1",
        "apiKey": "{file:.secrets/agents_server_key}",
        "timeout": 900000,
        "chunkTimeout": 600000
      },
      "models": {
        "active-model": {
          "limit": {
            "context": 90000,
            "output": 8192
          },
          "tool_call": true,
          "reasoning": true,
          "modalities": {
            "input": ["text", "image"],
            "output": ["text"]
          }
        }
      }
    }
  },
  "model": "ieti-agents/active-model"
}
```

`GET /v1/model-capabilities` publica, amb autenticacio Bearer, el cataleg dinamic de models virtuals assignat a l'usuari. El contracte IETI inclou `schema_version`, limits de context i sortida, modalitats, eines i raonament; es manté separat de l'endpoint OpenAI estandard `GET /v1/models`. Cada model pot publicar també `reasoning_efforts`, `default_reasoning_effort` i `supports_chat_template_kwargs`.

Els nivells de raonament es configuren per mapping des de l'administracio. Si no se'n selecciona cap, el client no envia `reasoning_effort` i es conserva el comportament per defecte del proveidor. Si el model no admet raonament, OpenCode no mostra variants. Si n'admet, el llançador crea variants nomes per als nivells publicats i desactiva explicitament els nivells generics no compatibles.

El proxy accepta `reasoning_effort` a Chat Completions i `reasoning.effort` a Responses. Per als servidors vLLM que ho necessitin es pot habilitar el pas restringit de `chat_template_kwargs`; nomes s'accepten `enable_thinking`, `preserve_thinking` i `reasoning_effort`. Un nivell o override no declarat pel mapping es rebutja abans de contactar el proveidor.

L'script substitueix exclusivament els models de `provider.ieti-agents` pels models disponibles per a aquella clau. Conserva la resta de l'`opencode.json`, inclosos altres proveidors, MCPs, plugins, permisos i opcions personalitzades. Sempre acaba despres d'actualitzar la configuracio; per iniciar OpenCode, executa'l per separat.

```bash
./set_agents_opencode.sh
```

El portal mostra una comanda per a cada sistema operatiu. La comanda descarrega l'script des del domini i port publics de la peticio —o des de `PUBLIC_BASE_URL`— i inclou automaticament la URL de l'API com a valor per defecte. L'usuari encara pot substituir-la quan l'executa.

A Windows, `set_agents_opencode.ps1` ofereix el mateix flux des de PowerShell i comparteix `.secrets/agents_server_key` i `opencode.json` amb la versio Bash. Encara que el fitxer `.ps1` es descarregui temporalment a `%TEMP%`, les dades es llegeixen i s'escriuen en el directori actual; per tant, una clau existent es reutilitza correctament:

```powershell
.\set_agents_opencode.ps1
```

Les dues versions nomes configuren el proveidor `ieti-agents`; no obren ni executen el binari d'OpenCode.

### BuildLite

El portal també ofereix una comanda separada per instal·lar el BuildLite harness. La comanda descarrega `buildlite_harness.zip` a la carpeta actual, extreu el seu contingut directament a l'arrel del projecte —mantenint `.agents/` i `AGENTS.md` fora d'una carpeta contenidora— i crea l'enllaç que necessita OpenCode:

- macOS/Linux: enllaç simbòlic `.opencode -> .agents`;
- Windows: junction de directoris amb `mklink /J .opencode .agents`.

Els scripts són `set_harness_buildlite.sh` i `set_harness_buildlite.ps1`. El portal mostra la comanda corresponent per a cada sistema operatiu.

Cada usuari pot tenir diverses claus API actives. Des de `Settings`, **Add API key** obre el popup de creacio, on l'usuari copia la clau i defineix un nom unic per al seu compte. El boto **Add key** nomes s'activa quan el nom no esta buit i no existeix encara, sense distingir majuscules i minuscules. Les claus es mostren emmascarades a la llista i es poden eliminar individualment; tant l'alta com la baixa tornen a `Settings` i el popup de la clau nova no apareix al dashboard.

## Us amb Codex

Codex fa servir la Responses API. El mateix servidor publica el cataleg i les capacitats dels models virtuals a `GET /v1/models?client_version=...`; Codex consulta aquest endpoint automaticament. Els limits de context publicats son el minim segur entre els proveidors del pool que poden servir cada alias virtual.

Configuracio minima de `~/.codex/config.toml`:

```toml
model = "active-model"
model_provider = "ieti-agents"
show_raw_agent_reasoning = true

[model_providers.ieti-agents]
name = "IETI Agents"
base_url = "https://your-public-domain.example/v1"
wire_api = "responses"
stream_idle_timeout_ms = 600000

[model_providers.ieti-agents.auth]
command = "/usr/bin/printenv"
args = ["PROXY_AGENTS_KEY"]
refresh_interval_ms = 0
```

La clau de Codex es proporciona amb una variable d'entorn del sistema:

```bash
export PROXY_AGENTS_KEY="ieti_sk_..."
```

No cal configurar manualment `model_context_window`, `model_auto_compact_token_limit` ni `model_catalog_json`: el servidor genera aquestes metadades a partir dels models i pools assignats a cada grup. L'helper `printenv` no canvia l'autenticacio remota: Codex continua enviant la mateixa clau com a Bearer token, pero aquesta modalitat permet que el client actualitzi el cataleg remot automaticament. `show_raw_agent_reasoning` mostra el raonament brut quan l'endpoint seleccionat el proporciona.

Cada `public_model` es publica una sola vegada. El balanceig es fa entre tots els endpoints assignats al grup que publiquen el mateix `public_model`; cada endpoint pot traduir-lo a un `upstream_model` diferent. El context publicat es el minim segur del pool, mentre que les capacitats de text, imatge, eines, raonament i eines paral.leles s'agreguen. En cada peticio, el proxy descarta els endpoints que no suporten les capacitats requerides abans d'aplicar el balanceig.

## API

Autenticacio d'usuari:

```txt
Authorization: Bearer <user_api_key>
```

Endpoints principals:

- `GET /health`: comprovacio de salut.
- `GET /v1/models`: models disponibles per a OpenCode i altres clients OpenAI-compatible.
- `GET /v1/models?client_version=...`: cataleg dinamic de models virtuals i capacitats per a Codex.
- `POST /v1/chat/completions`: entrada Chat Completions usada per OpenCode.
- `POST /v1/responses`: entrada Responses API usada per Codex; es tradueix al mateix encaminament intern de Chat Completions.

## Com es guarden les dades

El projecte guarda les dades en SQLite amb `better-sqlite3`. Per defecte el fitxer es crea a:

```txt
./data/agents_proxy.sqlite
```

La carpeta `data/` no s'ha de versionar, perque conte dades d'execucio i pot incloure informacio personal, registres d'us i credencials de proveidors.

Taules principals:

- `users`: usuaris, email, rol, estat, hash de contrasenya i hash de clau API.
- `providers`: proveidors OpenAI-compatible, URL base, clau API, estat i limits de concurrencia.
- `provider_models`: mapatge entre model public i model real del proveidor.
- `groups`: grups d'usuaris amb quotes de crides i tokens.
- `user_groups`: assignacio d'usuaris a grups.
- `group_providers`: proveidors disponibles per grup.
- `usage_logs`: registre de peticions, tokens, estat i errors.
- `settings`: configuracio editable des del servidor.
- `conversations` i `messages`: reservades per futures funcionalitats.

Les claus API d'usuaris i els tokens d'invitacio es mostren una sola vegada i es guarden com a hash. En canvi, les claus dels proveidors es guarden a la base de dades del servidor per poder reenviar peticions cap al proveidor extern.

## Arquitectura

Entrada del servidor:

```txt
src/server.js -> src/app.js
```

Estructura principal:

- `src/config.js`: llegeix `settings.env` i exporta valors tipats.
- `src/app.js`: crea l'aplicacio Express, middleware, rutes i gestio d'errors.
- `src/db/`: connexio SQLite, esquema, migracions i inicialitzacio.
- `src/routes/`: rutes HTTP del portal, admin, API OpenAI-compatible i salut.
- `src/middleware/`: autenticacio, rate limit i errors.
- `src/services/`: logica de negoci.
- `src/views/`: plantilles HTML server-rendered.
- `src/utils/`: errors, validacio, HTML i estimacio simple de tokens.
- `test/`: tests automatitzats amb proveidor mock.

Serveis destacats:

- `keyService.js`: generacio i verificacio de claus `ieti_sk_...`.
- `studentAuthService.js`: contrasenyes, invitacions i bloqueig per intents fallits.
- `providerService.js`: seleccio de proveidor, concurrencia i proxy HTTP.
- `quotaService.js`: validacio de quotes.
- `usageService.js`: registre i consulta d'us.
- `accessService.js`: grups i proveidors disponibles per usuari.

## Fitxers que no s'han de publicar

El projecte inclou un `.gitignore` per evitar publicar dades locals. No s'han de versionar:

- `settings.env`
- `data/`
- `node_modules/`
- `proxmox/`
- claus privades o certificats: `*.pem`, `*.key`, `*.p12`, `*.crt`
- logs, zips i fitxers generats

Els fitxers `*.env.example` si que es poden publicar per documentar la configuracio esperada, sempre amb valors ficticis.

## Notes de seguretat

- Canvia sempre `ADMIN_PASSWORD` i `SESSION_SECRET` abans de posar el servidor a internet.
- No publiquis la carpeta `data/`.
- No publiquis claus de proveidors ni claus d'estudiants.
- Fes servir HTTPS en produccio.
- Si una clau real s'ha publicat mai, considera-la compromesa i rota-la.
- `LOG_REQUEST_BODY=false` hauria de mantenir-se aixi en produccio per evitar guardar prompts o dades sensibles als logs.
