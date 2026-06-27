# IETI Agents DeepSeek Proxy

**Aim:** OpenAI-compatible proxy server for an educational AI agents course. Students use `ieti_sk_...` API keys with OpenCode; the server forwards requests to the upstream provider assigned to the student's group using server-side credentials.

## Architecture

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
| `services/` | Business logic (8 files, see below) |
| `middleware/` | Express middleware (auth student, auth admin, rate limit, error handler) |
| `routes/` | Route handlers (admin, health, me, openai, studentPortal) |
| `utils/` | Error classes (`errors.js`), token estimation (`tokens.js`) |
| `views/` | Server-rendered HTML templates for admin/portal UI |

## Key Services (`src/services/`)

- **`accessService.js`** — Group membership, provider slug per user
- **`keyService.js`** — API key generation (`ieti_sk_...`), bcrypt hashing/verification
- **`providerService.js`** — Provider selection, capacity tracking, upstream HTTP proxying
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
| `routes/admin.js` | `/admin/*` | Admin backoffice (users, groups, providers, settings) |

## Database

SQLite via `better-sqlite3`. Schema lives in `src/db/index.js`. Key tables:

- `users` — Students (bcrypt password hash, `api_key_hash`, invite tokens, lockout tracking)
- `providers` — Upstream AI providers (DeepSeek, vLLM, etc.) with API keys, concurrency limits
- `provider_models` — Model mappings (public alias → upstream model name, limits, pricing)
- `groups` — Student groups with daily/hourly call & token quotas, optional provider assignment
- `user_groups` — Many-to-many (enforced one-group-per-user)
- `usage_logs` — Per-request token usage, provider, status
- `settings` — Key-value server settings
- `conversations` / `messages` — Reserved for future conversation tracking

## Scripts

| Script | Command |
|--------|---------|
| `start` | `node src/server.js` |
| `dev` | `node --watch src/server.js` |
| `init-db` | `node src/db/init.js` |
| `test` | `node --test test/*.test.js` |

## Testing

Test suite at `test/` uses a local mock DeepSeek server. Run with `npm test`. Existing tests cover: health, auth, `/v1/models`, quotas, admin CRUD, provider routing, streaming.

## Key Design Decisions

- Proxy is **stateless per request** (no conversation memory) — OpenCode sends full context each time
- One **group per user** — group defines the upstream provider and quotas
- **Rate limiting** is in-memory (not persisted), resets on server restart
- **Token estimation** is character-based (`Math.ceil(text.length / 4)`) — not a real tokenizer
- **API keys** and **invite tokens** are only shown once at creation; only bcrypt hashes are stored
- **Pricing** is configurable per model in `provider_models` table or via env defaults
- Admin auth is session-based; student auth is Bearer token (API key)
- Maintenance mode blocks non-admin, non-health routes

## Remote Deployment (Proxmox VM)

The server can deploy to a Proxmox container over SSH. Keep real hostnames, ports,
usernames, and private key paths in local configuration only.

### Prerequisites (one-time)

1. Copy `proxmox/config.env.example` to `proxmox/config.env` and fill in your SSH user and private key path.
2. Run `proxmox/proxmoxInstall.sh` to provision the container (installs Node.js, npm, pm2, MySQL; takes ~40 min).

### Deploy

```bash
cd proxmox
./proxmoxDeploy.sh [user] [rsa_path] [port]
```

Default port is `3000`. The script:
- Zips the project (excluding `proxmox/`, `node_modules/`, `data/`)
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
