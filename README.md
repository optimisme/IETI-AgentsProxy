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

El repositori separa `docker/` (inferencia GPU) i `proxyServer/` (aplicacio web,
API, tests i eines Proxmox). Les comandes npm i les rutes de l'aplicacio que
apareixen a continuacio parteixen de `proxyServer/`.

Des de l'arrel del repositori, entra a l'aplicacio i instal.la dependencies:

```bash
cd proxyServer
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
PUBLIC_MODEL_NAME=
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

Provider settings include **Provider enabled** and a **Keep warm calling** select box with **Never**, **1 min**, and **5 min**. **Never** is the default for new providers and existing installations without a warm-up setting, and sends no warm-up calls. Previous checked Keep warm settings migrate to **1 min**. While the proxy server is running, it sends a tiny non-streaming chat completion at startup and then at the selected interval to each enabled provider with an enabled text model mapping. Saved changes are checked every minute without a server restart. Warm-up calls never count against student quotas or appear in student usage logs; the upstream provider may bill for them.

Warm-up requests use the upstream model and server-side API key, request at most eight output tokens, and time out after the shorter of the provider/server timeout and 30 seconds. They share provider capacity and never overlap for the same provider. Intervals with in-flight traffic are skipped because that traffic already keeps the provider warm. Failures are logged without credentials and retried at the next selected interval.

The built-in Node timer requires no cron job or scheduling library. Whether a completion prevents sleeping depends on the upstream host's idle policy. Run one proxy process to avoid duplicate warm-up calls from multiple workers.

From the provider edit page, **Autoconfigure** reads the standard OpenAI-compatible `/v1/models` catalog, then tests only the selected model. Published settings (including vLLM's `max_model_len`) always take priority. Tests use small synthetic requests for text, assistant history, tool calls and their results, image input, and streamed assistant history. They may incur provider charges; they never execute real tools or use student conversations. Inference testing is limited to three minutes total, with up to 60 seconds per request. Slow or truncated responses are inconclusive.

The preview reports each test's outcome, HTTP status and upstream error, with credentials redacted. Explicit capability rejections can disable a capability; authentication errors, timeouts, rate limits, outages and ignored parameters cannot. Unknown values preserve existing settings, which still need manual review. Tests cannot infer maximum output tokens or every reasoning control. The popup shows a determinate progress bar, the current stage out of six (catalog, text, assistant history, tools, images and streaming), the running request and elapsed time. Retries stay within the same stage. Outside clicks and Escape cannot dismiss it. Cancel aborts pending requests; Apply and save persists the reviewed settings in one step. Changing the selected model runs fresh tests for that model.

For providers rejecting assistant history without a thinking field, Autoconfigure verifies a retry using `reasoning_content` before proposing the **Reasoning history field** setting. The proxy preserves real reasoning and fills missing history with an empty string only for providers with this setting enabled. This does not reconstruct reasoning missing from old conversations. Streaming and JSON chat responses expose vLLM's `reasoning` as `reasoning_content` as well, so OpenCode can retain it for later turns.

Both `set_agents_opencode.sh` and `set_agents_opencode.ps1` generate `interleaved: { "field": "reasoning_content" }` when published reasoning is enabled. Save the provider settings and rerun the script to refresh `opencode.json`; unrelated providers, settings and existing custom options are preserved. Start a new conversation if earlier reasoning was already lost. A group alias shared by several providers publishes their common capabilities and lowest limits; use separate public aliases to expose different feature sets.

Docker inference profiles are self-contained YAML files in `docker/models/`, operated directly with Docker Compose. See [Docker operations](docker/README.md) for switching profiles and deleting caches. No Metadata URL or development-only vLLM endpoint is required. Autoconfigure uses the served `/v1/models` ID for both the upstream model and the OpenCode model alias when applied.

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

Les eines de desplegament son a `proxyServer/proxmox/` des de l'arrel del
repositori. El paquet conte nomes els fitxers versionats de `proxyServer/`,
sense aquesta carpeta contenidora, i exclou configuracio privada, dades,
dependencies locals i les eines Proxmox. La carpeta germana `docker/` queda
fora del paquet. Cal que la reorganitzacio estigui commitejada i publicada a
`origin/main` abans de desplegar.

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

La configuracio es llegeix de `proxyServer/settings.env` a traves de `proxyServer/src/config.js` (rutes des de l'arrel del repositori).

Valors principals:

- `PORT`: port HTTP local.
- `DATABASE_PATH`: ruta del fitxer SQLite.
- `DEFAULT_PROVIDER_API_KEY`: clau inicial del proveidor per sembrar la primera base de dades.
- `DEFAULT_PROVIDER_BASE_URL`: URL base del proveidor OpenAI-compatible.
- `PUBLIC_MODEL_NAME`: nom public per a la primera configuracio de la base de dades; si es buit, fa servir `DEFAULT_UPSTREAM_MODEL` (per defecte `deepseek-chat`). Autoconfigure desa la identitat detectada del servidor com a nom public i upstream.
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

## Gestio d'usuaris deshabilitats

A `/admin/users`, el filtre **Filter by registration status** mostra **approved/enabled** per defecte. Les opcions son **approved/enabled**, **approved/disabled**, **pending**, **rejected** i **All users**. Es combina amb la cerca i el grup, i es conserva en canviar de pagina.

El boto **Delete** de la fitxa nomes apareix quan l'usuari porta mes de 30 dies seguits deshabilitat. El servidor comprova el mateix requisit en eliminar-lo, encara que no tingui historial d'us. L'eliminacio es manual i permanent: elimina el compte, les claus, les invitacions i les dades dependents; conserva els registres d'us sense vincle amb el compte.

La data `disabled_at` es registra en deshabilitar el compte i es mostra en UTC. Editar altres dades no reinicia el termini; tornar a habilitar el compte si que el reinicia. Per als comptes que ja estaven deshabilitats abans d'aquesta actualitzacio, el termini comença en aplicar la migracio, ja que no es coneix la data original.

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

## Chat del portal

La seccio **Chat**, entre Dashboard i Settings, utilitza la sessio de l'usuari i nomes els seus models actius, amb les mateixes quotes, limitacio de peticions i registre d'us que l'API. No cal introduir una clau API.

- Una unica conversa temporal en memoria de la pagina. **Reset** cancel·la les peticions i elimina la conversa, el resum i les imatges; recarregar la pagina tambe inicia una conversa nova. No es guarden missatges al navegador ni a SQLite.
- La pagina genera un `conversation_id` opac nomes en memoria per afavorir el mateix servidor d'inferencia quan els servidors elegibles estan igual de carregats. **Reset** i recarregar la pagina generen una identitat nova; **Compact** i canviar de model la conserven. El servidor separa l'afinitat per usuari autenticat, model i pool autoritzat.
- **Compact** resumeix la conversa a peticio de l'usuari. La compactacio automatica s'activa abans d'enviar un missatge quan la projeccio arriba al **65% del pressupost d'entrada**, reservant espai per a la resposta i les instruccions. La projeccio de tokens es aproximada; els resums conserven els missatges recents i nomes substitueixen el context anterior si tenen exit i alliberen espai. A la pantalla, un unic resum actualitzat substitueix els missatges antics; se n'alliberen el text, les imatges i els elements HTML per evitar acumular historial al navegador. Cada resum consumeix una peticio i tokens de la quota.
- Els models amb visio permeten adjuntar PNG, JPEG o WebP amb els limits de quantitat i mida del servidor. Les imatges es processen en memoria, sense crear fitxers al servidor.
- Els missatges de l'usuari, les respostes i els resums mostren Markdown amb taules i blocs de codi. Marked i DOMPurify es distribueixen localment a `assets/vendor/`, amb les seves llicencies; no cal cap framework, CDN ni servei addicional.
- **Copy request** i **Copy response** copien el text Markdown complet de la peticio o resposta, sense incloure el raonament ni les imatges adjuntes. Els blocs de codi tenen un boto **Copy** que copia nomes el codi i les taules un boto que copia el seu Markdown original. La confirmacio **Copied** torna al text original al cap de dos segons.
- Les instruccions fixes expliquen que es una interfície web amb Markdown i sense eines, terminal, fitxers ni navegacio. Es mantenen en compactar. **Stop** o Reset cancel·len la generacio; les peticions que ja han consumit recursos es compten a les quotes i estadistiques.
- **Enter** envia el missatge i **Majuscules + Enter** insereix una nova linia. El cercle al costat del model es verd quan es pot continuar i vermell durant una peticio o si hi ha un error; els detalls dels errors continuen visibles.

## Configuracio global d'OpenCode

El portal ofereix `set_agents_opencode.sh` (Linux/macOS) i `set_agents_opencode.ps1` (Windows). Configuren el proveidor `ieti-agents` globalment per a l'usuari actual, sense crear fitxers al projecte ni iniciar OpenCode.

- **Linux/macOS:** Bash i Python 3.9 o superior (`python3`), nomes amb la biblioteca estandard. La comanda del portal utilitza curl per descarregar l'script i Bash l'executa nomes si la descarrega te exit, sense crear fitxers temporals. L'instal·lador utilitza Python; no necessita Node.js, npm ni pip.
- **Windows:** PowerShell 5.1 o superior, amb HTTP i JSON natius de PowerShell/.NET; no necessita cap runtime ni paquet addicional.

Python s'executa directament, sense crear cap entorn virtual ni cache de bytecode. Els fitxers temporals de validacio i preparacio s'eliminen en acabar, tambe en cas d'error o cancel·lacio; nomes es conserven la configuracio global, la clau i les copies `.bak` de la configuracio.

```bash
./proxyServer/assets/set_agents_opencode.sh
```

```powershell
.\proxyServer\assets\set_agents_opencode.ps1
```

L'script descarregat des del portal incorpora la URL publica del servidor. En instal·lar o actualitzar, mostra aquesta URL per confirmar-la: Enter l'accepta i un altre valor la substitueix. `PROXY_AGENTS_BASE_URL` permet proporcionar una URL alternativa; s'accepta tant l'arrel del servidor com una URL acabada en `/v1`.

Si ja existeix una configuracio IETI o la seva clau global, l'script ofereix **Update** (per defecte) o **Uninstall**. L'actualitzacio valida la clau desada amb `GET /v1/model-capabilities`. Si falta o es invalida, en demana una amb entrada oculta. Si funciona, ofereix **Keep** (per defecte) o **Replace**. Una clau substituta es valida abans de desar-la.

La peticio de validacio te un limit de 30 segons; Bash i PowerShell modern limiten tambe la connexio a 10 segons. PowerShell 5.1 aplica el limit total de 30 segons. Un error de xarxa, timeout, limit de peticions, compte deshabilitat, autenticacio, cataleg o JSON conserva la configuracio i la clau anteriors. Un error temporal del servidor no es tracta com una clau invalida. Les dades nomes s'escriuen despres de validar la resposta i preparar tots els canvis.

| Fitxer global | Contingut |
|---|---|
| `~/.config/opencode/opencode.json` | Proveidor `ieti-agents`, models, limits, modalitats i variants de raonament |
| `~/.config/ieti-agents/agents_server_key` | Clau reutilitzable; OpenCode la referencia amb una ruta absoluta |

A Windows, `~` correspon a `%USERPROFILE%`. Es respecta `XDG_CONFIG_HOME` quan esta definit. Si existeix `opencode.jsonc`, s'actualitza aquest fitxer; els comentaris es conserven a la copia `.bak`, i la configuracio actualitzada s'escriu com a JSON. Si existeixen alhora `opencode.json` i `opencode.jsonc`, cal consolidar-los abans.

Es conserven altres proveidors, MCPs, plugins, permisos i opcions personalitzades. Els models d'IETI es substitueixen pel cataleg actual. Es conserva el model seleccionat d'un altre proveidor; un model IETI que ja no esta disponible es substitueix per un del cataleg. Els fitxers de configuracio canviats tenen una copia `.bak`; les claus i els fitxers generats tenen permisos restrictius (`0600` a Unix, ACL de l'usuari a Windows).

La desinstal·lacio funciona sense connexio al servidor. Elimina nomes el proveidor IETI, les seleccions `model` i `small_model` que l'utilitzen i la seva clau global; conserva la resta de la configuracio d'OpenCode. Tambe es pot executar directament:

```bash
./proxyServer/assets/set_agents_opencode.sh --uninstall
```

```powershell
.\proxyServer\assets\set_agents_opencode.ps1 -Uninstall
```

`--sync-only` (Bash) o `-SyncOnly` (PowerShell) impedeixen preguntes interactives i reutilitzen la clau desada. `PROXY_AGENTS_KEY` permet proporcionar una clau nova per a una execucio sense preguntes; no s'ha de posar la clau a la URL ni desar-la al repositori.

```bash
PROXY_AGENTS_BASE_URL=https://agents.ieti.site/v1 ./proxyServer/assets/set_agents_opencode.sh --sync-only
```

Les configuracions locals d'OpenCode tenen prioritat sobre la global: un `opencode.json` creat per una versio anterior de l'script pot requerir retirar-ne manualment el proveidor IETI per utilitzar la configuracio global. Reinicieu OpenCode despres dels canvis i reexecuteu l'script quan canviin els models o capacitats del grup.

`GET /v1/model-capabilities` publica, amb autenticacio Bearer, el cataleg dinamic de models virtuals assignat a l'usuari. El contracte IETI inclou `schema_version`, limits de context i sortida, modalitats, eines i raonament; es manté separat de l'endpoint OpenAI estandard `GET /v1/models`. Cada model pot publicar també `reasoning_efforts`, `default_reasoning_effort` i `supports_chat_template_kwargs`.

Els nivells de raonament es configuren per mapping des de l'administracio. Si no se'n selecciona cap, el client no envia `reasoning_effort` i es conserva el comportament per defecte del proveidor. Si el model no admet raonament, OpenCode no mostra variants. Si n'admet, l'script crea variants per als nivells publicats i desactiva explicitament els nivells generics no compatibles.

El proxy accepta `reasoning_effort` a Chat Completions i `reasoning.effort` a Responses. Per als servidors vLLM que ho necessitin es pot habilitar el pas restringit de `chat_template_kwargs`; nomes s'accepten `enable_thinking`, `preserve_thinking` i `reasoning_effort`. Un nivell o override no declarat pel mapping es rebutja abans de contactar el proveidor.

Cada usuari pot tenir diverses claus API actives. Des de `Settings`, **Add API key** obre el popup de creacio, on l'usuari copia la clau i defineix un nom unic per al seu compte. El boto **Add key** nomes s'activa quan el nom no esta buit i no existeix encara, sense distingir majuscules i minuscules. Les claus es mostren emmascarades a la llista i es poden eliminar individualment; tant l'alta com la baixa tornen a `Settings` i el popup de la clau nova no apareix al dashboard.

## Us amb Codex

Codex fa servir la Responses API. El mateix servidor publica el cataleg i les capacitats dels models virtuals a `GET /v1/models?client_version=...`; Codex consulta aquest endpoint automaticament. Els limits de context publicats son el minim segur entre els proveidors del pool que poden servir cada alias virtual.

Configuracio minima de `~/.codex/config.toml`:

```toml
model = "deepseek-chat"
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

## Balanceig i afinitat de conversa

El criteri principal continua sent el nombre de peticions en curs: una conversa nova va a un proveidor elegible amb la carrega minima. En torns posteriors, el proveidor anterior te preferencia nomes entre els proveidors amb aquesta mateixa carrega minima. Si esta mes ocupat, deshabilitat, temporalment indisponible, ple o no admet el model, les capacitats o el pool del grup, es tria un altre. Sense afinitat aprofitable, es conserven la prioritat configurada i la seleccio aleatoria en empat. La reserva de concurrencia dura fins que acaba o es cancel·la tota la resposta, inclosos els streams.

Els clients poden enviar un identificador opac i estable per conversa amb `X-Conversation-ID` o el camp JSON `conversation_id` a Chat Completions i Responses. Genereu una identitat nova per una conversa independent o una branca que vulgueu encaminar independentment; conserveu-la durant una compactacio si voleu mantenir l'afinitat. L'identificador nomes es una pista d'encaminament: no dona permisos ni es reenvia al proveidor. L'abast inclou l'usuari autenticat, el model i el pool autoritzat; una clau API o un ID d'usuari no identifica una conversa.

OpenCode envia el context complet a `/v1/chat/completions`; la configuracio generada no fixa cap identificador comu per a totes les sessions. Sense identificador explicit, el proxy fa un reconeixement prudent de prefixes de missatges continuats mitjançant hashes. Un prompt de sistema compartit o una primera pregunta comuna no son suficients. Historials identics del mateix usuari, model i pool poden ser indistinguibles sense un identificador; les branques o compactacions que canvien el prefix poden perdre aquesta afinitat estimada. El proxy no reconstrueix context omes a Responses: el client ha de continuar enviant el context complet.

L'afinitat conserva com a maxim 10.000 entrades amb caducitat de 30 minuts des de l'ultim us. El seguiment d'errors conserva fins a 1.024 proveidors durant cinc minuts i aplica una pausa exponencial d'1 a 30 segons, sense consultar salut abans de cada peticio. Nomes es guarden metadades en memoria del proces: hashes, identificadors de proveidor i marques de temps. No es guarden prompts, imatges, respostes ni historial de conversa, i un reinici elimina les pistes.

Els errors transitoris abans de lliurar sortida poden provocar un segon intent, com a maxim, en un altre proveidor elegible; un stream que ja ha lliurat sortida mai es repeteix. La quota de crides compta una peticio logica, no els seus intents. Els intents rebutjats nomes afegeixen tokens si el proveidor n'informa explicitament; les generacions cancel·lades o fallides que ja han consumit recursos mantenen el registre i el carrec corresponents.

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
