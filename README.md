# IETI Agents Proxy

Proxy OpenAI-compatible pensat per a cursos d'agents d'IA. Els usuaris fan servir claus internes amb format `ieti_sk_...`, i el servidor reenvia les peticions al proveidor d'IA assignat al grup de cada usuari fent servir credencials guardades al servidor.

L'objectiu és que l'alumnat pugui treballar amb eines compatibles amb OpenAI, com OpenCode, sense rebre directament les claus reals dels proveidors externs.

## Funcionalitats

- API compatible amb OpenAI per a `GET /v1/models` i `POST /v1/chat/completions`.
- Suport per respostes normals JSON i streaming SSE.
- Portal web per a estudiants amb inici de sessio, gestio de clau API i descarrega d'`opencode.json`.
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
DEEPSEEK_API_KEY=your_deepseek_key_here
ADMIN_PASSWORD=replace_with_a_secure_admin_password
SESSION_SECRET=replace_with_a_long_random_session_secret
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

Els tests cobreixen salut del servidor, autenticacio, quotes, administracio, rutes OpenAI-compatible, routing de proveidors, concurrencia i streaming.

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

DEEPSEEK_API_KEY=dummy_provider_api_key_replace_me
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEFAULT_PROVIDER_SLUG=deepseek
DEFAULT_PROVIDER_NAME=DeepSeek
DEFAULT_UPSTREAM_MODEL=deepseek-chat
PUBLIC_MODEL_NAME=active-model
PUBLIC_BASE_URL=https://your-public-domain.example

ADMIN_USERNAME=admin
ADMIN_PASSWORD=replace_with_a_strong_password
ADMIN_PASSWORD_HASH=
SESSION_SECRET=replace_with_a_long_random_session_secret

MAX_REQUESTS_PER_MINUTE=1000
MAX_TOKENS_PER_REQUEST=8192
DEFAULT_DAILY_TOKEN_LIMIT=10000000
DEFAULT_MODEL_CONTEXT_LIMIT=65536
DEFAULT_MODEL_OUTPUT_LIMIT=8192
MAX_IMAGES_PER_REQUEST=4
MAX_IMAGE_BYTES=8000000
MAX_TOTAL_IMAGE_BYTES=16000000
ALLOW_VIDEO_INPUT=false

ENABLE_STREAMING=true
LOG_REQUEST_BODY=false
REQUEST_TIMEOUT_MS=120000
```

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
- `DEEPSEEK_API_KEY`: clau inicial del proveidor per sembrar la primera base de dades.
- `DEEPSEEK_BASE_URL`: URL base del proveidor OpenAI-compatible.
- `PUBLIC_MODEL_NAME`: nom de model que veuran els clients, per defecte `active-model`.
- `PUBLIC_BASE_URL`: URL publica usada per generar l'`opencode.json`.
- `ADMIN_USERNAME`, `ADMIN_PASSWORD`, `ADMIN_PASSWORD_HASH`: credencials d'administracio.
- `SESSION_SECRET`: secret de sessio Express. Ha de ser llarg i aleatori.
- `MAX_REQUESTS_PER_MINUTE`: rate limit per usuari.
- `MAX_TOKENS_PER_REQUEST`: maxim de `max_tokens` de sortida que pot demanar una peticio. Els tokens reals es registren a partir del `usage` del proveidor quan existeix.
- `DEFAULT_DAILY_TOKEN_LIMIT`: limit global per defecte del servidor.

`DEEPSEEK_API_KEY`, `DEEPSEEK_BASE_URL`, `DEFAULT_PROVIDER_SLUG`, `DEFAULT_PROVIDER_NAME` i `DEFAULT_UPSTREAM_MODEL` nomes s'usen per crear el primer proveidor en una base de dades nova. Un cop creada la base de dades, els proveidors es gestionen des de l'administracio.

## Us amb OpenCode

Cada usuari pot descarregar un `opencode.json` personalitzat des del portal. La configuracio fa servir una variable d'entorn per no escriure la clau dins del fitxer:

```bash
export IETI_AGENT_KEY="ieti_sk_..."
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
        "apiKey": "{env:IETI_AGENT_KEY}",
        "timeout": 900000,
        "chunkTimeout": 600000
      },
      "models": {
        "active-model": {
          "name": "active-model",
          "limit": {
            "context": 65536,
            "output": 8192
          },
          "max_tokens": 8192,
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

## API

Autenticacio d'usuari:

```txt
Authorization: Bearer <user_api_key>
```

Endpoints principals:

- `GET /health`: comprovacio de salut.
- `GET /me`: informacio de l'usuari autenticat.
- `GET /v1/models`: models disponibles per a l'usuari.
- `POST /v1/chat/completions`: proxy OpenAI-compatible.

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
- `src/routes/`: rutes HTTP del portal, admin, API OpenAI-compatible, salut i `/me`.
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
- `keys.env`
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
