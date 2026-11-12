#!/bin/bash
# Copies the production runtime state (SQLite database, the rest of data/ and
# settings.env) into proxyServer/backups/<UTC timestamp>/, which git ignores.
# Read-only on the server: the app keeps running and the database is copied
# through SQLite's online backup API, so the snapshot is consistent even while
# requests are writing.
#
#   ./proxmoxBackup.sh [user] [rsa_path]
#
# BACKUP_DIR overrides the local destination folder.
# BACKUP_SOURCE_DIR=<dir> runs the server-side part against a local folder
# instead of the server (for testing the script without SSH).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROXY_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BACKUP_ROOT="${BACKUP_DIR:-$PROXY_DIR/backups}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DEST="$BACKUP_ROOT/$STAMP"
PARTIAL="$DEST.partial"

# Server-side part: stages a consistent copy in a private temp folder and
# streams it as a tar archive on stdout. Messages go to stderr.
REMOTE_SCRIPT=$(cat <<'REMOTE'
set -euo pipefail
APP_DIR="$1"
export PATH="$HOME/.npm-global/bin:/usr/local/bin:$PATH"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
chmod 700 "$STAGE"
cd "$APP_DIR"
test -f settings.env || { echo "Error: no hi ha settings.env a $APP_DIR" >&2; exit 1; }

# Same database resolution as proxmoxDeploy.sh, without loading app code.
DB_REL="$(node - <<'NODE'
const fs = require('fs'), path = require('path');
const env = require('dotenv').parse(fs.readFileSync('settings.env'));
const file = path.resolve(process.cwd(), env.DATABASE_PATH || './data/agents_proxy.sqlite');
if (!file.startsWith(path.resolve('data') + path.sep) || !fs.existsSync(file)) {
  throw new Error('The database must exist inside data/.');
}
process.stdout.write(path.relative(process.cwd(), file));
NODE
)"

# Everything in data/ except the live database files, which are snapshotted below.
DB_IN_DATA="${DB_REL#data/}"
mkdir -p "$STAGE/data"
rsync -a \
  --exclude "/$DB_IN_DATA" --exclude "/$DB_IN_DATA-wal" \
  --exclude "/$DB_IN_DATA-shm" --exclude "/$DB_IN_DATA-journal" \
  data/ "$STAGE/data/"
cp -p settings.env "$STAGE/settings.env"

python3 - "$APP_DIR/$DB_REL" "$STAGE/$DB_REL" <<'PYTHON'
import pathlib, sqlite3, sys
src = sqlite3.connect(pathlib.Path(sys.argv[1]).as_uri() + '?mode=ro', uri=True)
dst = sqlite3.connect(sys.argv[2])
src.backup(dst)
src.close()
dst.execute('PRAGMA journal_mode=DELETE')
assert dst.execute('PRAGMA integrity_check').fetchall() == [('ok',)], 'SQLite integrity check failed on the snapshot'
counts = {t: dst.execute(f'SELECT COUNT(*) FROM "{t}"').fetchone()[0]
          for (t,) in dst.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")}
dst.close()
print('Snapshot OK: ' + ', '.join(f'{t}={n}' for t, n in counts.items()), file=sys.stderr)
PYTHON

cd "$STAGE"
printf 'created_utc=%s\nhost=%s\napp_dir=%s\ndatabase=%s\n' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(hostname)" "$APP_DIR" "$DB_REL" > BACKUP_INFO.txt
if command -v sha256sum >/dev/null 2>&1; then SUM="sha256sum"; else SUM="shasum -a 256"; fi
find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 $SUM > SHA256SUMS
tar -C "$STAGE" -czf - .
REMOTE
)

cleanup() { rm -rf "$PARTIAL"; }
trap cleanup EXIT

umask 077
mkdir -p "$BACKUP_ROOT" "$PARTIAL"
chmod 700 "$BACKUP_ROOT"

if [[ -n "${BACKUP_SOURCE_DIR:-}" ]]; then
  echo "Mode prova: còpia des de $BACKUP_SOURCE_DIR (sense SSH)."
  bash -s -- "$BACKUP_SOURCE_DIR" <<<"$REMOTE_SCRIPT" | tar -xzf - -C "$PARTIAL"
else
  source "$SCRIPT_DIR/config.env"
  BACKUP_USER=${1:-$DEFAULT_USER}
  RSA_PATH=${2:-"$DEFAULT_RSA_PATH"}
  RSA_PATH="${RSA_PATH%$'\r'}"
  HOST="${DEFAULT_HOST:-}"
  PORT_SSH="${DEFAULT_SSH_PORT:-}"
  if [[ -z "$HOST" || -z "$PORT_SSH" ]]; then
    echo "Error: configura DEFAULT_HOST i DEFAULT_SSH_PORT a proxmox/config.env."
    exit 1
  fi
  if [[ ! -f "$RSA_PATH" ]]; then
    echo "Error: No s'ha trobat la clau privada: $RSA_PATH"
    exit 1
  fi
  echo "Copiant dades i configuració de $BACKUP_USER@$HOST..."
  ssh -T -i "$RSA_PATH" -p "$PORT_SSH" -o UpdateHostKeys=no "$BACKUP_USER@$HOST" \
    bash -s -- '$HOME/nodejs_server' <<<"$REMOTE_SCRIPT" | tar -xzf - -C "$PARTIAL"
fi

# Verify locally what arrived before keeping it.
(cd "$PARTIAL" && shasum -a 256 -c --quiet SHA256SUMS)
DB_REL="$(sed -n 's/^database=//p' "$PARTIAL/BACKUP_INFO.txt")"
python3 -I - "$PARTIAL/$DB_REL" <<'PYTHON'
import pathlib, sqlite3, sys
db = sqlite3.connect(pathlib.Path(sys.argv[1]).as_uri() + '?mode=ro', uri=True)
assert db.execute('PRAGMA integrity_check').fetchall() == [('ok',)], 'Local SQLite integrity check failed'
db.close()
PYTHON

mv "$PARTIAL" "$DEST"
echo "✔️  Còpia verificada a $DEST"
du -sh "$DEST" | cut -f1 | sed 's/^/   Mida: /'
