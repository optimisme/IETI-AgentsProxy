# IETI Agents DeepSeek Proxy

**Aim:** OpenAI-compatible proxy server for an educational AI agents course. Students use `ieti_sk_...` API keys with OpenCode; the server forwards requests to the upstream provider assigned to the student's group using server-side credentials.

## Architecture

- **Repository:** `docker/` contains GPU inference profiles; `proxyServer/` contains the proxy application and local deployment tooling.
- **Working directory:** run npm commands from `proxyServer/`. Application paths below (`src/`, `test/`, `settings.env`, etc.) are relative to that directory.

- **Stack:** Node.js (>=24), Express 4, better-sqlite3, bcryptjs
- **Entry:** `src/server.js` → `src/app.js`
- **Config:** `src/config.js` reads from `settings.env`

## Directory Layout (`src/`)

| Path | Purpose |
|------|---------|
| `server.js` | Bootstrap: initializes DB, creates Express app, starts listener |
| `app.js` | Express app factory with middleware, routes, error handlers |
| `config.js` | Reads `settings.env`, exports typed config values |
| `db/` | SQLite connection (`index.js`), schema init/migrations, seed (`init.js`) |
| `services/` | Business logic (see below) |
| `middleware/` | Express middleware (auth student, auth admin, rate limit, error handler) |
| `routes/` | Route handlers (health, openai, studentPortal, googleAuth) and `routes/admin/`, the backoffice split by area |
| `utils/` | Error classes (`errors.js`), token estimation (`tokens.js`) |
| `views/` | Page shells (`*.html` with `{{placeholders}}`) and `views/admin/`, the markup of each admin area as view modules |

## Key Services (`src/services/`)

- **`accessService.js`** — Group membership, and each group's pools with the providers behind them
- **`poolService.js`** — Pools (alias + balanced providers), pool membership, and the pools of a group
- **`adminAuditService.js`** — Records every form an admin submits (`admin_audit_logs`) and lists them for the Activity page
- **`keyService.js`** — API key generation (`ieti_sk_...`), bcrypt hashing/verification
- **`providerService.js`** — Provider selection within a pool, capacity tracking, upstream HTTP proxying
- **`quotaService.js`** — Validates daily/hourly call & token limits per group
- **`settingsService.js`** — Key-value settings CRUD
- **`studentAuthService.js`** — Student password management, invite flow, login with lockout
- **`usageService.js`** — Records and queries usage logs

## Middleware (`src/middleware/`)

- **`authStudent.js`** — Bearer token auth via bcrypt against `api_key_hash`
- **`authAdmin.js`** — Session-based admin auth
- **`rateLimit.js`** — In-memory sliding-window per-user rate limiter
- **`errorHandler.js`** — 404 catch-all + centralized error response

## Routes

| Router | Path | Description |
|--------|------|-------------|
| `routes/health.js` | `GET /health` | Health check |
| `routes/openai.js` | `GET /v1/models`, `POST /v1/chat/completions` | OpenAI-compatible API proxy (with streaming SSE support) |
| `routes/studentPortal.js` | `/`, `/login`, `/logout`, `/portal/*` | Student self-service web UI |
| `routes/admin/` | `/admin/*` | Admin backoffice. `index.js` mounts one router per area: `dashboard`, `users`, `groups`, `pools`, `providers`, `server`, `activity`; `shared.js` holds the page layout and the form path. Route files hold logic only; their markup is in `views/admin/<area>.js` |

## Database

SQLite via `better-sqlite3`. Schema lives in `src/db/index.js`. Key tables:

- `users` — Students (bcrypt password hash, `api_key_hash`, invite tokens, lockout tracking)
- `providers` — Upstream AI providers (DeepSeek, vLLM, etc.) with API keys, concurrency limits
- `provider_models` — One active mapping per provider (upstream model name, limits, capabilities)
- `pools` — A model alias students see; `pool_providers` lists the providers balanced under it (a provider may be in several pools)
- `groups` — Student groups with daily/hourly call & token quotas; `group_pools` lists the pools a group can use
- `user_groups` — Many-to-many (enforced one-group-per-user)
- `usage_logs` — Per-request token usage, provider, status
- `settings` — Key-value server settings
- `admin_audit_logs` — One row per submitted admin form: admin, action, record, result and the submitted values without secrets
- `conversations` / `messages` — Reserved for future conversation tracking

## Scripts

| Script | Command |
|--------|---------|
| `start` | `node src/server.js` |
| `dev` | `node --watch src/server.js` |
| `init-db` | `node src/db/init.js` |
| `test` | `node --test test/*.test.js` |

## Testing

Tests that send requests should use a server bound to 127.0.0.1 (`test/helpers/server.js`): when supertest is given the app it opens a wildcard-address server per request, which on macOS can share a port number with another local listener and receive that listener's answer.

Test suite at `test/` uses a local mock DeepSeek server. Run with `npm test`. Existing tests cover: health, auth, `/v1/models`, quotas, admin CRUD, provider routing, streaming.

## Key Design Decisions

- Proxy is **stateless per request** (no conversation memory) — OpenCode sends full context each time
- One **group per user** — group defines the pools its students can use and their quotas
- **Pools** own the model alias and the balancing: a request for an alias is served by the least busy enabled provider of that pool, with each provider's own active mapping. A group gets whole pools, never single providers of one. A provider's concurrency limit is shared by every pool it is in
- **A group's pools are ordered** (`group_pools.position`, edited with the arrows on the group page): the first pool is the group's default model in the OpenCode configuration, the setup script and the portal chat, and `/v1/models` lists models in that order. A group whose pools were never ordered keeps the order its models had before, by serving provider (priority, then name)
- **Capabilities** (limits, images, tools, reasoning) are defined only on providers. What students see under an alias is computed: the smallest limits and the capabilities every serving provider of the pool has. The pool page shows that result and flags a provider as not aligned when it offers less than another one in the pool; nothing copies capabilities between providers
- **Admin markup is written with the `html` template tag** (`utils/html.js`): every interpolated value is escaped unless it is markup already (another `html` result, `joinHtml`, `trustedHtml`). Never build admin HTML with plain strings or call `escapeHtml` in a view: a plain string is treated as text and shown escaped. Values written inside `<script>` use `jsLiteral`. View functions receive their data as arguments and do not query the database
- **Admin forms share one refusal path** (`formRoute` in `routes/admin/shared.js`): a handler refuses a submission by throwing a validation error (`apiError(400, 'invalid_form', …)`, as the helpers in `utils/validation.js` do) or `formConflict(code, message, notice)` for a value another record already has. The same page is then shown again with the typed values and the reason, with status 400 or 409, and nothing is saved. Requests that ask for JSON get the error as JSON. Each form has a `show…` function that renders its page from stored data or from the submitted values
- **Admin changes are traced**: `adminAuditService.auditAdminChanges` is mounted on the admin router and records every POST an admin makes, with the record's name looked up before the handler runs. Checks that change nothing (provider tests, autoconfigure previews) are skipped, and secret fields are stored as `[provided]`. A new admin route needs a label in `ACTION_LABELS` to read well on the Activity page
- **Old access data is gone**: `provider_models.public_model`, `group_providers` and `groups.provider_id` described access before pools. `migratePools` in `src/db/index.js` converts a database that still has them, once, and then removes them by rebuilding the two tables. Tests build such a database with `test/helpers/oldAccess.js`; other tests set up access with `test/helpers/pools.js`
- **Rate limiting** is in-memory (not persisted), resets on server restart. Failed logins are also limited in memory per address and per address+login
- **Quota reservations** for in-flight requests and the per-user concurrency limit (`MAX_CONCURRENT_REQUESTS_PER_USER`) are in-memory and assume a single server process
- **Token estimation** is character-based (`Math.ceil(text.length / 4)`) — not a real tokenizer. It feeds quota reservations, so a request whose real input exceeds the estimate can overshoot the quota by that difference
- **Media** must be inline `data:` URLs; remote URLs are rejected so inference hosts never fetch student-supplied addresses. Content parts must be objects with a string `type`, and `image_url`/`video_url`/`audio_url` fields are only accepted on parts of the matching type
- **Image count limits** are per provider model (`provider_models.max_images`, NULL = unlimited, only editable while Image input is enabled). The proxy skips providers whose cap is too low and returns 413 `too_many_images` when none fits; byte limits stay global server settings
- **Internet-facing servers** (`NODE_ENV=production` or an HTTPS `PUBLIC_BASE_URL`) refuse to start with default or placeholder `ADMIN_PASSWORD`/`SESSION_SECRET`
- **Cross-site POSTs** to cookie-authenticated routes are rejected by `middleware/sameOrigin.js`; large JSON bodies are only parsed on the completion routes after auth (`middleware/bodyParsers.js`)
- **API keys** and **invite tokens** are only shown once at creation; API keys are stored as SHA-256 digests (older bcrypt hashes still verify), invite nonces as digests, and pending one-time secrets live in process memory (`utils/pendingSecrets.js`), never in the session store
- **Pricing** is configurable per model in `provider_models` table or via env defaults
- Admin auth is session-based; student auth is Bearer token (API key)
- Maintenance mode blocks non-admin, non-health routes

## Remote Deployment (Proxmox VM)

The server can deploy to a Proxmox container over SSH. Keep real hostnames, ports,
usernames, and private key paths in local configuration only.

### Prerequisites (one-time)

1. Copy `proxyServer/proxmox/config.env.example` to `proxyServer/proxmox/config.env` and fill in your SSH user and private key path.
2. Run `proxyServer/proxmox/proxmoxInstall.sh` to provision the container (installs Node.js, npm, pm2, MySQL; takes ~40 min).

### Deploy

```bash
cd proxyServer/proxmox
./proxmoxDeploy.sh [user] [rsa_path] [port]
```

Default port is `3000`. The script:
- Backs up `data/` and `settings.env`, then runs the release's migrations on a copy and cancels if any existing record would change. Allowed exceptions: new tables (reported in the output), new columns that stay NULL, and what the script lists as retired on purpose (`RETIRED_SETTINGS`, `RETIRED_TABLES`, `RETIRED_COLUMNS`)
- Archives the committed `proxyServer/` subtree without a directory wrapper (excluding deployment tooling, private settings, `node_modules/`, and `data/`); sibling `docker/` is outside its scope
- SCPs the zip to the remote host
- Stops the existing pm2 process
- Unzips into `~/nodejs_server`
- Runs `npm install --omit=dev`
- Starts with pm2 as `app`

### Port 80 Redirect

```bash
./proxmoxSetupRedirect80.sh   # NAT port 80 → SERVER_PORT
./proxmoxSetupRedirectUndo.sh # undo the redirect
```

### MySQL Tunnel

```bash
./proxmoxTunelStart.sh    # forward local:3307 → remote:3306
./proxmoxTunelStatus.sh   # check if tunnel is up
./proxmoxTunelStop.sh     # close tunnel
```

### Useful Scripts

| Script | Purpose |
|--------|---------|
| `proxmoxConnect.sh` | Quick SSH to the container |
| `proxmoxSendFile.sh` | SCP a single file to `~` on the remote |
| `proxmoxDeploy.sh` | Full deploy (zip + transfer + npm install + pm2 restart) |
| `proxmoxBackup.sh` | Read-only copy of production `data/` (SQLite via online backup) and `settings.env` into git-ignored `proxyServer/backups/<UTC stamp>/`, checksum- and integrity-verified |

Only `proxmoxDeploy.sh`, `proxmoxBackup.sh` and `config.env.example` are tracked; other files in `proxmox/` stay local.
