#!/bin/bash
set -euo pipefail

ORIGINAL_DIR=$(pwd)
DEPLOY_AGENT_STARTED=0
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROXY_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(git -C "$PROXY_DIR" rev-parse --show-toplevel)"

cleanup() {
  if [[ "$DEPLOY_AGENT_STARTED" == "1" ]]; then ssh-agent -k 2>/dev/null || true; fi
  cd "$ORIGINAL_DIR" 2>/dev/null || true
}
trap cleanup EXIT

source "$SCRIPT_DIR/config.env"

DEPLOY_USER=${1:-$DEFAULT_USER}
RSA_PATH=${2:-"$DEFAULT_RSA_PATH"}
SERVER_PORT=${3:-$DEFAULT_SERVER_PORT}
RSA_PATH="${RSA_PATH%$'\r'}"

HOST="${DEFAULT_HOST:-}"
PORT_SSH="${DEFAULT_SSH_PORT:-}"
ZIP_NAME="server-package.zip"

if [[ -z "$HOST" || -z "$PORT_SSH" ]]; then
  echo "Error: configura DEFAULT_HOST i DEFAULT_SSH_PORT a proxmox/config.env abans de desplegar."
  exit 1
fi

if [[ ! -f "$RSA_PATH" ]]; then
  echo "Error: No s'ha trobat la clau privada: $RSA_PATH"
  exit 1
fi

cd "$PROXY_DIR"

CURRENT_BRANCH="$(git branch --show-current)"
if [[ "$CURRENT_BRANCH" != "main" ]]; then
  echo "Error: el deploy només es permet des de la branca main (branca actual: ${CURRENT_BRANCH:-detached HEAD})."
  exit 1
fi

LOCAL_HEAD="$(git rev-parse HEAD)"
REMOTE_MAIN="$(git ls-remote origin refs/heads/main | awk 'NR == 1 { print $1 }')"
if [[ -z "$REMOTE_MAIN" || "$LOCAL_HEAD" != "$REMOTE_MAIN" ]]; then
  echo "Error: main local no coincideix amb origin/main. Fes push o restaura main abans de desplegar."
  echo "Local:  $LOCAL_HEAD"
  echo "Remot:  ${REMOTE_MAIN:-no disponible}"
  exit 1
fi

# This deployment is intentionally pinned to the pre-Authenticator application.
# Refuse a future main commit that reintroduces any TOTP implementation.
if git -C "$REPO_ROOT" grep -I -n -i -E \
  'totp|authenticator|otpauth|user_totp_credentials|user_security_flows|user_security_events' \
  "$LOCAL_HEAD" -- proxyServer/src proxyServer/test proxyServer/package.json; then
  echo "Error: s'ha detectat codi Authenticator/TOTP a main; deploy cancel·lat."
  exit 1
fi

rm -f "$ZIP_NAME"

# Archive only the committed application subtree, without a proxyServer/ wrapper.
# Sibling directories are outside the release; local edits and secrets stay local.
git -C "$REPO_ROOT" archive --format=zip --output="$PROXY_DIR/$ZIP_NAME" "$LOCAL_HEAD:proxyServer" -- . \
  ':(exclude)proxmox' \
  ':(exclude)data' \
  ':(exclude)node_modules' \
  ':(exclude).gitignore' \
  ':(exclude)settings.env' \
  ':(exclude)keys.env' \
  ':(exclude)run_opencode_settings.env'

if unzip -Z1 "$ZIP_NAME" | grep -E \
  '(^|/)settings\.env$|(^|/)keys\.env$|(^|/)data(/|$)|(^|/)node_modules(/|$)|(^|/)\.git(/|$)' >/dev/null; then
  echo "Error: el paquet conté configuració o dades de runtime; deploy cancel·lat."
  rm -f "$ZIP_NAME"
  exit 1
fi

echo "Desplegant main $LOCAL_HEAD (settings.env i data/ es conservaran al servidor)."

if [[ "${DEPLOY_DRY_RUN:-0}" == "1" ]]; then
  echo "✔️  Paquet verificat en mode dry-run; no s'ha contactat ni modificat el servidor."
  rm -f "$ZIP_NAME"
  exit 0
fi

eval "$(ssh-agent -s)" >/dev/null
DEPLOY_AGENT_STARTED=1
ssh-add "$RSA_PATH" >/dev/null

scp -P "$PORT_SSH" "$ZIP_NAME" "$DEPLOY_USER@$HOST:~/server-package.zip"
rm -f "$ZIP_NAME"

ssh -T -p "$PORT_SSH" -o UpdateHostKeys=no \
  "$DEPLOY_USER@$HOST" \
  bash -s -- "$SERVER_PORT" "$LOCAL_HEAD" << 'EOF'
set -euo pipefail

SERVER_PORT="$1"
RELEASE_SHA="$2"
APP_DIR="$HOME/nodejs_server"
PKG="$HOME/server-package.zip"
TMP_DIR="$(mktemp -d)"
BACKUP_DIR="$(mktemp -d)"
REMOTE_USER="$(id -un)"
APP_STOPPED=0
RUNTIME_BACKUP_DIR=""
VALIDATION_DIR=""

# Update only release-owned entries. Existing unrelated directories at the app
# root are retained; obsolete files inside release directories are still removed.
sync_release() {
  local source_dir="$1" entry name
  while IFS= read -r -d '' entry; do
    name="${entry##*/}"
    case "$name" in data|settings.env) continue ;; esac
    if [[ -d "$entry" && ! -L "$entry" ]]; then
      [[ ! -L "$APP_DIR/$name" ]] || return 1
      mkdir -p "$APP_DIR/$name"
      rsync -a --delete "$entry/" "$APP_DIR/$name/" || return
    else
      rsync -a "$entry" "$APP_DIR/" || return
    fi
  done < <(find "$source_dir" -mindepth 1 -maxdepth 1 -print0)
}

cleanup_remote() {
  status=$?
  if [[ "$status" -ne 0 && "$APP_STOPPED" -eq 1 && -f "$BACKUP_DIR/package.json" ]]; then
    echo "⚠️  El deploy ha fallat; restaurant la versió anterior sense tocar data/ ni settings.env."
    pm2 delete app >/dev/null 2>&1 || true
    sync_release "$BACKUP_DIR" || true
    cd "$APP_DIR"
    pm2 start src/server.js --name app --update-env >/dev/null 2>&1 || true
    pm2 save >/dev/null 2>&1 || true
  fi
  if [[ -n "$VALIDATION_DIR" ]]; then rm -rf "$VALIDATION_DIR"; fi
  rm -rf "$TMP_DIR" "$BACKUP_DIR"
  if [[ -n "$RUNTIME_BACKUP_DIR" ]]; then echo "Runtime backup retained: $RUNTIME_BACKUP_DIR"; fi
  exit "$status"
}
trap cleanup_remote EXIT

export PATH="$HOME/.npm-global/bin:/usr/local/bin:$PATH"

mkdir -p "$APP_DIR"

# Prepare and validate the new release before stopping the running app.
test -f "$PKG"
unzip -q -o "$PKG" -d "$TMP_DIR"
rm -f "$PKG"

if [[ -f "$TMP_DIR/package.json" ]]; then
  PROJECT_DIR="$TMP_DIR"
elif [[ -f "$TMP_DIR/nodejs_server/package.json" ]]; then
  PROJECT_DIR="$TMP_DIR/nodejs_server"
elif [[ -f "$TMP_DIR/nodejs_web/package.json" ]]; then
  PROJECT_DIR="$TMP_DIR/nodejs_web"
else
  echo "Error: no trobo package.json dins del zip"
  exit 1
fi

cd "$PROJECT_DIR"
if [[ -f package-lock.json ]]; then
  npm ci --omit=dev
else
  npm install --omit=dev
fi
test -f src/server.js
find src -type f -name '*.js' -print0 | xargs -0 -n1 node --check

# Resolve the production database without importing startup/migration code.
cd "$APP_DIR"
DATABASE_RELATIVE="$(node - <<'NODE'
const fs = require('fs'), path = require('path');
const env = require('dotenv').parse(fs.readFileSync('settings.env'));
const file = path.resolve(process.cwd(), env.DATABASE_PATH || './data/agents_proxy.sqlite');
if (!file.startsWith(path.resolve('data') + path.sep) || !fs.existsSync(file)) {
  throw new Error('Production database must exist inside the preserved data directory.');
}
process.stdout.write(path.relative(process.cwd(), file));
NODE
)"

# Keep a rollback copy of the current code. Runtime data stays in place.
if [[ -f "$APP_DIR/package.json" ]]; then
  rsync -a --delete --exclude 'data/' --exclude 'settings.env' "$APP_DIR/" "$BACKUP_DIR/"
fi

if command -v pm2 >/dev/null 2>&1; then
  pm2 delete app >/dev/null 2>&1 || true
fi
APP_STOPPED=1

for i in {1..10}; do
  PORT_LISTENERS="$(ss -H -ltn "sport = :$SERVER_PORT")"
  [[ -n "$PORT_LISTENERS" ]] && sleep 1 || break
done
PORT_LISTENERS="$(ss -H -ltn "sport = :$SERVER_PORT")"
if [[ -n "$PORT_LISTENERS" ]]; then
  echo "Error: el port $SERVER_PORT continua ocupat; deploy cancel·lat abans de tocar les dades."
  exit 1
fi

# Snapshot the complete data directory, including any SQLite WAL, with all
# application writers stopped. Keep this backup outside the deployment target.
mkdir -p "$HOME/proxy-deploy-backups"
chmod 700 "$HOME/proxy-deploy-backups"
RUNTIME_BACKUP_DIR="$(mktemp -d "$HOME/proxy-deploy-backups/$(date -u +%Y%m%dT%H%M%SZ)-${RELEASE_SHA:0:8}-XXXXXX")"
rsync -a "$APP_DIR/data" "$APP_DIR/settings.env" "$RUNTIME_BACKUP_DIR/"
python3 - "$APP_DIR" "$RUNTIME_BACKUP_DIR" "$DATABASE_RELATIVE" <<'PYTHON'
import hashlib, json, pathlib, sqlite3, sys
app, backup = map(pathlib.Path, sys.argv[1:3])
protected = [app / 'settings.env', app / 'data', *(app / 'data').rglob('*')]
assert not any(p.is_symlink() for p in protected), 'Runtime symlinks require independent target backups; deployment cancelled'
def manifest(root):
    files = [root / 'settings.env', *sorted((root / 'data').rglob('*'))]
    return {str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in files if p.is_file()}
before = manifest(app)
assert before == manifest(backup), 'Runtime backup differs from production files'
(backup / 'files-before.json').write_text(json.dumps(before, indent=2))
(backup / 'database-relative-path.txt').write_text(sys.argv[3])
# Validate the backup, not the live database, before replacing any code.
db = sqlite3.connect((backup / sys.argv[3]).as_uri() + '?mode=ro', uri=True)
assert db.execute('PRAGMA integrity_check').fetchall() == [('ok',)], 'SQLite integrity check failed'
assert db.execute('PRAGMA foreign_key_check').fetchall() == [], 'SQLite foreign key check failed'
tables = [r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")]
states = {}
for table in tables:
    quoted = '"' + table.replace('"', '""') + '"'
    cursor = db.execute('SELECT * FROM ' + quoted)
    columns = [c[0] for c in cursor.description]
    rows = []
    for row in cursor:
        values = dict(zip(columns, row))
        # Startup refreshes this setting's timestamp even if its value is unchanged.
        if table == 'settings' and values.get('key') == 'public_base_url':
            values.pop('updated_at', None)
        rows.append(json.dumps(values, sort_keys=True, default=lambda v: v.hex()))
    states[table] = {'count': len(rows), 'sha256': hashlib.sha256('\n'.join(sorted(rows)).encode()).hexdigest()}
(backup / 'database-before.json').write_text(json.dumps(states, indent=2))
db.close()
print('Consistent runtime backup verified; SQLite integrity and foreign keys are valid.')
PYTHON

# Exercise the release's real startup migrations against an independent copy.
# Keep it outside the release tree and force DATABASE_PATH after loading the
# production settings so configuration can never direct validation to live data.
VALIDATION_DIR="$(mktemp -d)"
rsync -a "$RUNTIME_BACKUP_DIR/data" "$RUNTIME_BACKUP_DIR/settings.env" "$VALIDATION_DIR/"
cd "$PROJECT_DIR"
node - "$VALIDATION_DIR/settings.env" "$VALIDATION_DIR/$DATABASE_RELATIVE" <<'NODE'
try {
  require('dotenv').config({ path: process.argv[2], override: true, quiet: true });
  process.env.DATABASE_PATH = process.argv[3];
  const { getDb, closeDb } = require('./src/db');
  try { getDb(); } finally { closeDb(); }
} catch {
  console.error('New release database initialization failed on the isolated backup; production data was not changed.');
  process.exitCode = 1;
}
NODE
python3 - "$VALIDATION_DIR/$DATABASE_RELATIVE" "$RUNTIME_BACKUP_DIR/database-before.json" <<'PYTHON'
import hashlib, json, pathlib, sqlite3, sys
db = sqlite3.connect(pathlib.Path(sys.argv[1]).as_uri() + '?mode=ro', uri=True)
assert db.execute('PRAGMA integrity_check').fetchall() == [('ok',)], 'Release startup failed SQLite integrity validation'
assert db.execute('PRAGMA foreign_key_check').fetchall() == [], 'Release startup failed SQLite foreign key validation'
states = {}
tables = [r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")]
for table in tables:
    quoted = '"' + table.replace('"', '""') + '"'
    cursor = db.execute('SELECT * FROM ' + quoted)
    columns = [c[0] for c in cursor.description]
    rows = []
    for row in cursor:
        values = dict(zip(columns, row))
        if table == 'settings' and values.get('key') == 'public_base_url':
            values.pop('updated_at', None)
        rows.append(json.dumps(values, sort_keys=True, default=lambda v: v.hex()))
    states[table] = {'count': len(rows), 'sha256': hashlib.sha256('\n'.join(sorted(rows)).encode()).hexdigest()}
db.close()
assert states == json.loads(pathlib.Path(sys.argv[2]).read_text()), 'Release startup would change production records; deployment cancelled'
print('New release startup preserves every database table and record on the isolated backup.')
PYTHON
rm -rf "$VALIDATION_DIR"
VALIDATION_DIR=""

sync_release "$PROJECT_DIR"

# Prove replacement of application code did not change or delete runtime files.
python3 - "$APP_DIR" "$RUNTIME_BACKUP_DIR" <<'PYTHON'
import hashlib, json, pathlib, sys
app, backup = map(pathlib.Path, sys.argv[1:3])
files = [app / 'settings.env', *sorted((app / 'data').rglob('*'))]
after = {str(p.relative_to(app)): hashlib.sha256(p.read_bytes()).hexdigest()
         for p in files if p.is_file()}
assert after == json.loads((backup / 'files-before.json').read_text()), 'Runtime files changed during deployment'
print('All data files and settings.env are byte-for-byte unchanged before restart.')
PYTHON

cd "$APP_DIR"
test -f package.json

# Start app with PM2
pm2 start src/server.js --name app --update-env

HEALTHY=0
for i in {1..20}; do
  if curl -fsS "http://127.0.0.1:$SERVER_PORT/health" >/dev/null 2>&1; then
    HEALTHY=1
    break
  fi
  sleep 1
done

if [[ "$HEALTHY" -ne 1 ]]; then
  echo "Error: la nova versió no ha superat el health check; restaurant l'anterior."
  pm2 logs app --lines 40 --nostream || true
  exit 1
fi

pm2 save
APP_STOPPED=0

# Configure PM2 to restart the app after a machine reboot
if command -v systemctl >/dev/null 2>&1; then
  if sudo -n true 2>/dev/null; then
    sudo env PATH="$PATH" pm2 startup systemd -u "$REMOTE_USER" --hp "$HOME"
    pm2 save
    echo "✔️  PM2 configurat per iniciar-se automàticament després d'un reinici."
  else
    echo "⚠️  Deploy correcte, però no s'ha pogut configurar l'arrencada automàtica."
    echo "⚠️  Cal executar manualment al servidor:"
    echo "sudo env PATH=$PATH pm2 startup systemd -u $REMOTE_USER --hp $HOME"
    echo "pm2 save"
  fi
else
  echo "⚠️  No s'ha trobat systemd. No s'ha configurat l'arrencada automàtica amb PM2."
fi

echo "✔️  Deploy correcte. Estat PM2:"
pm2 status
EOF
