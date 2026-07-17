#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SETTINGS_FILE="$SCRIPT_DIR/run_opencode_settings.env"
CONFIG_FILE="$SCRIPT_DIR/opencode.json"
MODELS_DIR="$SCRIPT_DIR/.opencode"
MODELS_FILE="$MODELS_DIR/ieti-models.json"
CAPABILITIES_TMP=""
UPSTREAM_CATALOG_TMP=""
MODELS_TMP=""
CONFIG_TMP=""
SETTINGS_TMP=""
CREATE_SETTINGS_FILE=0

read_masked() {
  local prompt="$1"
  local character=""
  local secret=""

  printf '%s' "$prompt"
  while true; do
    if ! IFS= read -r -s -n 1 character; then
      echo
      return 1
    fi
    if [ -z "$character" ]; then
      break
    fi
    case "$character" in
      $'\177'|$'\b')
        if [ -n "$secret" ]; then
          secret="${secret%?}"
          printf '\b \b'
        fi
        ;;
      *)
        secret+="$character"
        printf '*'
        ;;
    esac
  done
  echo
  PROXY_AGENTS_KEY="$secret"
}

cleanup() {
  [ -z "$CAPABILITIES_TMP" ] || rm -f "$CAPABILITIES_TMP"
  [ -z "$UPSTREAM_CATALOG_TMP" ] || rm -f "$UPSTREAM_CATALOG_TMP"
  [ -z "$MODELS_TMP" ] || rm -f "$MODELS_TMP"
  [ -z "$CONFIG_TMP" ] || rm -f "$CONFIG_TMP"
  [ -z "$SETTINGS_TMP" ] || rm -f "$SETTINGS_TMP"
}
trap cleanup EXIT

cd "$SCRIPT_DIR"

if [ ! -f "$SETTINGS_FILE" ]; then
  CREATE_SETTINGS_FILE=1
  if [ -t 0 ]; then
    echo "run_opencode_settings.env was not found."
    read -r -p "IETI Agents base URL [https://agents.ieti.site/v1]: " PROXY_AGENTS_BASE_URL
    PROXY_AGENTS_BASE_URL="${PROXY_AGENTS_BASE_URL:-https://agents.ieti.site/v1}"
    if ! read_masked "Paste your IETI Agents API key: "; then
      echo "Error: API key input was interrupted."
      exit 1
    fi
  elif [ -z "${PROXY_AGENTS_BASE_URL:-}" ] || [ -z "${PROXY_AGENTS_KEY:-}" ]; then
    echo "Error: run_opencode_settings.env was not found and settings cannot be requested without an interactive terminal."
    echo "Run this script from a terminal or define PROXY_AGENTS_BASE_URL and PROXY_AGENTS_KEY for this invocation."
    exit 1
  fi
else
  chmod 600 "$SETTINGS_FILE"

  set -a
  # shellcheck disable=SC1090
  source "$SETTINGS_FILE"
  set +a
fi

if [ -z "${PROXY_AGENTS_BASE_URL:-}" ]; then
  echo "Error: PROXY_AGENTS_BASE_URL is not defined in run_opencode_settings.env."
  exit 1
fi

if [ -z "${PROXY_AGENTS_KEY:-}" ]; then
  echo "Error: PROXY_AGENTS_KEY is not defined in run_opencode_settings.env."
  exit 1
fi

if [[ ! "$PROXY_AGENTS_KEY" =~ ^ieti_sk_[A-Za-z0-9_-]+$ ]]; then
  echo "Error: the API key must start with ieti_sk_ and contain only letters, numbers, underscores, or hyphens."
  exit 1
fi

for command_name in curl node; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "Error: required command was not found: $command_name"
    exit 1
  fi
done

if ! API_BASE_URL="$(node -e '
  try {
    const url = new URL(process.argv[1]);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
    url.pathname = url.pathname.replace(/\/+$/, "");
    if (!url.pathname.endsWith("/v1")) url.pathname += "/v1";
    process.stdout.write(url.toString().replace(/\/$/, ""));
  } catch { process.exit(1); }
' "$PROXY_AGENTS_BASE_URL")"; then
  echo "Error: PROXY_AGENTS_BASE_URL must be a valid HTTP(S) base URL without credentials, query, or fragment."
  exit 1
fi

CAPABILITIES_TMP="$(mktemp "${TMPDIR:-/tmp}/ieti-capabilities.XXXXXX")"
if ! HTTP_STATUS="$(curl --silent --show-error \
  --output "$CAPABILITIES_TMP" \
  --write-out '%{http_code}' \
  --connect-timeout 15 \
  --max-time 60 \
  --header "Authorization: Bearer $PROXY_AGENTS_KEY" \
  --header 'Accept: application/json' \
  "$API_BASE_URL/model-capabilities")"; then
  echo "Error: could not connect to the IETI model capabilities endpoint."
  exit 1
fi

if [ "$HTTP_STATUS" != "200" ]; then
  ERROR_MESSAGE="$(node -e '
    try {
      const body = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
      process.stdout.write(String(body?.error?.message || body?.message || "the server rejected the request"));
    } catch { process.stdout.write("the server rejected the request"); }
  ' "$CAPABILITIES_TMP")"
  echo "Error: PROXY_AGENTS_KEY is not valid or the model catalog is unavailable (HTTP $HTTP_STATUS): $ERROR_MESSAGE"
  exit 1
fi

MODELS_DEV_API_URL="${IETI_MODELS_DEV_API_URL:-https://models.dev/api.json}"
UPSTREAM_CATALOG_TMP="$(mktemp "${TMPDIR:-/tmp}/models-dev.XXXXXX")"
if ! curl --fail --silent --show-error \
  --output "$UPSTREAM_CATALOG_TMP" \
  --connect-timeout 15 \
  --max-time 60 \
  --header 'Accept: application/json' \
  "$MODELS_DEV_API_URL"; then
  echo "Error: could not download the Models.dev catalog from $MODELS_DEV_API_URL."
  exit 1
fi

mkdir -p "$MODELS_DIR"
MODELS_TMP="$(mktemp "$MODELS_FILE.tmp.XXXXXX")"
CONFIG_TMP="$(mktemp "$CONFIG_FILE.tmp.XXXXXX")"
node - "$CONFIG_FILE" "$CAPABILITIES_TMP" "$UPSTREAM_CATALOG_TMP" "$CONFIG_TMP" "$MODELS_TMP" "$API_BASE_URL" <<'NODE'
const fs = require('node:fs');
const [configPath, capabilitiesPath, upstreamCatalogPath, configOutputPath, modelsOutputPath, baseURL] = process.argv.slice(2);

let config = {};
if (fs.existsSync(configPath)) {
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (error) {
    throw new Error(`Cannot update ${configPath}: ${error.message}`);
  }
}

const catalog = JSON.parse(fs.readFileSync(capabilitiesPath, 'utf8'));
if (catalog?.object !== 'ieti.model_capabilities.list' || catalog?.schema_version !== 1 || !Array.isArray(catalog.data) || catalog.data.length === 0) {
  throw new Error('The authenticated server returned no available models.');
}

const modelsDevCatalog = JSON.parse(fs.readFileSync(upstreamCatalogPath, 'utf8'));
if (!modelsDevCatalog || typeof modelsDevCatalog !== 'object' || Array.isArray(modelsDevCatalog)) {
  throw new Error('Models.dev returned an invalid catalog.');
}

const models = {};
const today = new Date().toISOString().slice(0, 10);
for (const published of catalog.data) {
  const id = String(published?.id || '').trim();
  const context = Number(published?.context_window);
  const output = Number(published?.max_output_tokens);
  if (!id || !Number.isFinite(context) || context <= 0 || !Number.isFinite(output) || output <= 0) {
    throw new Error(`Model metadata is incomplete for ${id || '<unknown model>'}.`);
  }
  const capabilities = published.capabilities || {};
  const capabilityNames = ['text', 'image', 'tools', 'reasoning', 'parallel_tools'];
  if (capabilityNames.some((name) => typeof capabilities[name] !== 'boolean')) {
    throw new Error(`Model capabilities are incomplete for ${id}.`);
  }
  const inputModalities = Array.isArray(published?.modalities?.input)
    ? published.modalities.input.filter((value) => ['text', 'audio', 'image', 'video', 'pdf'].includes(value))
    : [capabilities.text === false ? null : 'text', capabilities.image ? 'image' : null].filter(Boolean);
  models[id] = {
    id,
    name: String(published?.name || id),
    release_date: today,
    last_updated: today,
    attachment: capabilities.image === true,
    temperature: true,
    limit: { context, output },
    tool_call: capabilities.tools === true,
    reasoning: capabilities.reasoning === true,
    open_weights: false,
    modalities: {
      input: inputModalities,
      output: ['text']
    }
  };
}

config.$schema ||= 'https://opencode.ai/config.json';
config.provider = config.provider && typeof config.provider === 'object' ? config.provider : {};
config.provider['ieti-agents'] = {
  npm: '@ai-sdk/openai-compatible',
  name: 'IETI Agents',
  options: {
    baseURL,
    apiKey: '{env:PROXY_AGENTS_KEY}',
    timeout: 900000,
    chunkTimeout: 600000
  }
};

const selected = typeof config.model === 'string' ? config.model : '';
const selectedIetiModel = selected.startsWith('ieti-agents/') ? selected.slice('ieti-agents/'.length) : '';
if (!selected || (selectedIetiModel && !models[selectedIetiModel])) {
  config.model = `ieti-agents/${Object.keys(models)[0]}`;
}

modelsDevCatalog['ieti-agents'] = {
  id: 'ieti-agents',
  name: 'IETI Agents',
  env: ['PROXY_AGENTS_KEY'],
  npm: '@ai-sdk/openai-compatible',
  api: baseURL,
  models
};

fs.writeFileSync(configOutputPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
fs.writeFileSync(modelsOutputPath, `${JSON.stringify(modelsDevCatalog)}\n`, { mode: 0o600 });
NODE

chmod 600 "$CONFIG_TMP"
chmod 600 "$MODELS_TMP"

if [ "$CREATE_SETTINGS_FILE" -eq 1 ]; then
  SETTINGS_TMP="$(mktemp "$SETTINGS_FILE.tmp.XXXXXX")"
  chmod 600 "$SETTINGS_TMP"
  printf 'PROXY_AGENTS_BASE_URL=%q\nPROXY_AGENTS_KEY=%q\n' "$API_BASE_URL" "$PROXY_AGENTS_KEY" > "$SETTINGS_TMP"
  mv "$SETTINGS_TMP" "$SETTINGS_FILE"
  SETTINGS_TMP=""
  echo "Created $SETTINGS_FILE with permissions 600."
fi

mv "$CONFIG_TMP" "$CONFIG_FILE"
CONFIG_TMP=""
mv "$MODELS_TMP" "$MODELS_FILE"
MODELS_TMP=""

MODEL_COUNT="$(node -e 'const c=require(process.argv[1]); process.stdout.write(String(Object.keys(c["ieti-agents"].models).length))' "$MODELS_FILE")"
echo "IETI API key validated. Updated $CONFIG_FILE and $MODELS_FILE with $MODEL_COUNT available model(s)."

if [ "${1:-}" = "--sync-only" ]; then
  exit 0
fi

export OPENCODE_MODELS_PATH="$MODELS_FILE"

if [ "${1:-}" = "desktop" ]; then
  shift
  OS="$(uname -s)"

  if [ "$OS" = "Darwin" ]; then
    APP="/Applications/OpenCode.app"
    if [ ! -d "$APP" ]; then
      echo "Error: OpenCode.app was not found in /Applications"
      exit 1
    fi
    BIN=""
    for candidate in "$APP/Contents/MacOS/"*; do
      if [ -f "$candidate" ]; then
        BIN="$candidate"
        break
      fi
    done
    if [ -z "$BIN" ]; then
      echo "Error: OpenCode desktop binary was not found."
      exit 1
    fi
    exec "$BIN" "$@"
  elif [ "$OS" = "Linux" ]; then
    if command -v opencode-desktop >/dev/null 2>&1; then
      exec opencode-desktop "$@"
    fi
    if command -v OpenCode >/dev/null 2>&1; then
      exec OpenCode "$@"
    fi
    if command -v opencode >/dev/null 2>&1; then
      echo "Warning: opencode desktop binary was not found. Falling back to CLI opencode."
      exec opencode "$@"
    fi
    echo "Error: OpenCode desktop executable was not found."
    exit 1
  else
    echo "Error: unsupported OS: $OS"
    exit 1
  fi
fi

if ! command -v opencode >/dev/null 2>&1; then
  echo "Error: opencode executable was not found."
  exit 1
fi

exec opencode "$@"
