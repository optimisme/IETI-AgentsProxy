#!/usr/bin/env bash
set -euo pipefail

WORKING_DIRECTORY="$(cd "$(dirname "$0")" && pwd)"
CONFIG_FILE="$WORKING_DIRECTORY/opencode.json"
SECRETS_DIRECTORY="$WORKING_DIRECTORY/.secrets"
KEY_FILE="$SECRETS_DIRECTORY/agents_server_key"
DEFAULT_BASE_URL="__IETI_DEFAULT_BASE_URL__"
CAPABILITIES_TMP=""
CONFIG_TMP=""
KEY_TMP=""

cleanup() {
  [ -z "$CAPABILITIES_TMP" ] || rm -f "$CAPABILITIES_TMP"
  [ -z "$CONFIG_TMP" ] || rm -f "$CONFIG_TMP"
  [ -z "$KEY_TMP" ] || rm -f "$KEY_TMP"
}
trap cleanup EXIT

read_masked_key() {
  local character=""
  local value=""

  printf 'Paste your IETI Agents API key: '
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
        if [ -n "$value" ]; then
          value="${value%?}"
          printf '\b \b'
        fi
        ;;
      *)
        value+="$character"
        printf '*'
        ;;
    esac
  done
  echo
  IETI_API_KEY="$value"
}

read_config_base_url() {
  [ -f "$CONFIG_FILE" ] || return 1
  node - "$CONFIG_FILE" <<'NODE'
const fs = require('node:fs');
const [configPath] = process.argv.slice(2);
try {
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const baseURL = config?.provider?.['ieti-agents']?.options?.baseURL;
  if (typeof baseURL !== 'string' || !baseURL.trim()) process.exit(1);
  process.stdout.write(baseURL.trim());
} catch {
  process.exit(1);
}
NODE
}

for command_name in curl node; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "Error: required command was not found: $command_name"
    exit 1
  fi
done

BASE_URL="${PROXY_AGENTS_BASE_URL:-}"
if [ -z "$BASE_URL" ]; then
  BASE_URL="$(read_config_base_url || true)"
fi
if [ -z "$BASE_URL" ]; then
  if [ "$DEFAULT_BASE_URL" = '__IETI_DEFAULT_BASE_URL__' ]; then
    DEFAULT_BASE_URL='https://agents.ieti.site/v1'
  fi
  if [ -t 0 ]; then
    read -r -p "IETI Agents base URL [$DEFAULT_BASE_URL]: " BASE_URL
    BASE_URL="${BASE_URL:-$DEFAULT_BASE_URL}"
  else
    BASE_URL="$DEFAULT_BASE_URL"
  fi
fi

if ! API_BASE_URL="$(node -e '
  try {
    const url = new URL(process.argv[1]);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
    url.pathname = url.pathname.replace(/\/+$/, "");
    if (!url.pathname.endsWith("/v1")) url.pathname += "/v1";
    process.stdout.write(url.toString().replace(/\/$/, ""));
  } catch { process.exit(1); }
' "$BASE_URL")"; then
  echo "Error: PROXY_AGENTS_BASE_URL must be a valid HTTP(S) base URL without credentials, query, or fragment."
  exit 1
fi

IETI_API_KEY=""
CREATE_KEY_FILE=0
if [ -f "$KEY_FILE" ]; then
  IFS= read -r IETI_API_KEY < "$KEY_FILE" || true
  IETI_API_KEY="${IETI_API_KEY%$'\r'}"
else
  CREATE_KEY_FILE=1
  if [ ! -t 0 ]; then
    echo "Error: $KEY_FILE was not found and the API key cannot be requested without an interactive terminal."
    exit 1
  fi
  if ! read_masked_key; then
    echo "Error: API key input was interrupted."
    exit 1
  fi
fi

if [[ ! "$IETI_API_KEY" =~ ^ieti_sk_[A-Za-z0-9_-]+$ ]]; then
  echo "Error: the API key must start with ieti_sk_ and contain only letters, numbers, underscores, or hyphens."
  exit 1
fi

CAPABILITIES_TMP="$(mktemp "${TMPDIR:-/tmp}/ieti-capabilities.XXXXXX")"
if ! HTTP_STATUS="$(curl --silent --show-error \
  --output "$CAPABILITIES_TMP" \
  --write-out '%{http_code}' \
  --connect-timeout 15 \
  --max-time 60 \
  --header "Authorization: Bearer $IETI_API_KEY" \
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
  echo "Error: IETI API key validation failed (HTTP $HTTP_STATUS): $ERROR_MESSAGE"
  exit 1
fi

CONFIG_TMP="$(mktemp "$CONFIG_FILE.tmp.XXXXXX")"
node - "$CONFIG_FILE" "$CAPABILITIES_TMP" "$CONFIG_TMP" "$API_BASE_URL" <<'NODE'
const fs = require('node:fs');
const [configPath, capabilitiesPath, outputPath, baseURL] = process.argv.slice(2);

let config = {};
if (fs.existsSync(configPath)) {
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (error) {
    throw new Error(`Cannot update ${configPath}: ${error.message}`);
  }
}
if (!config || typeof config !== 'object' || Array.isArray(config)) config = {};

const catalog = JSON.parse(fs.readFileSync(capabilitiesPath, 'utf8'));
if (catalog?.object !== 'ieti.model_capabilities.list' || catalog?.schema_version !== 1 ||
    !Array.isArray(catalog.data) || catalog.data.length === 0) {
  throw new Error('The authenticated server returned no available models.');
}

const canonicalReasoningEfforts = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const models = Object.create(null);
for (const published of catalog.data) {
  const id = String(published?.id || '').trim();
  const context = Number(published?.context_window);
  const output = Number(published?.max_output_tokens);
  if (!id || !Number.isFinite(context) || context <= 0 || !Number.isFinite(output) || output <= 0) {
    throw new Error(`Model metadata is incomplete for ${id || '<unknown model>'}.`);
  }

  const capabilities = published.capabilities || {};
  const requiredCapabilities = ['text', 'image', 'tools', 'reasoning', 'parallel_tools'];
  if (requiredCapabilities.some((name) => typeof capabilities[name] !== 'boolean')) {
    throw new Error(`Model capabilities are incomplete for ${id}.`);
  }

  const inputModalities = Array.isArray(published?.modalities?.input)
    ? published.modalities.input.filter((value) => ['text', 'audio', 'image', 'video', 'pdf'].includes(value))
    : [capabilities.text ? 'text' : null, capabilities.image ? 'image' : null].filter(Boolean);
  const publishedEfforts = new Set(Array.isArray(published.reasoning_efforts) ? published.reasoning_efforts : []);
  const reasoningEfforts = capabilities.reasoning
    ? canonicalReasoningEfforts.filter((effort) => publishedEfforts.has(effort))
    : [];
  const defaultReasoningEffort = reasoningEfforts.includes(published.default_reasoning_effort)
    ? published.default_reasoning_effort
    : null;
  const variants = capabilities.reasoning
    ? Object.fromEntries(canonicalReasoningEfforts.map((effort) => [
        effort,
        reasoningEfforts.includes(effort) ? { reasoningEffort: effort } : { disabled: true }
      ]))
    : {};

  models[id] = {
    limit: { context, output },
    tool_call: capabilities.tools,
    reasoning: capabilities.reasoning,
    modalities: { input: inputModalities, output: ['text'] },
    variants,
    ...(defaultReasoningEffort ? { options: { reasoningEffort: defaultReasoningEffort } } : {})
  };
}

config.$schema ||= 'https://opencode.ai/config.json';
config.provider = config.provider && typeof config.provider === 'object' && !Array.isArray(config.provider)
  ? config.provider
  : {};
const existingProvider = config.provider['ieti-agents'];
const provider = existingProvider && typeof existingProvider === 'object' && !Array.isArray(existingProvider)
  ? existingProvider
  : {};
const existingOptions = provider.options && typeof provider.options === 'object' && !Array.isArray(provider.options)
  ? provider.options
  : {};
config.provider['ieti-agents'] = {
  ...provider,
  npm: '@ai-sdk/openai-compatible',
  name: 'IETI Agents',
  options: {
    ...existingOptions,
    baseURL,
    apiKey: '{file:.secrets/agents_server_key}',
    timeout: 900000,
    chunkTimeout: 600000
  },
  models
};

const selected = typeof config.model === 'string' ? config.model : '';
const selectedIetiModel = selected.startsWith('ieti-agents/') ? selected.slice('ieti-agents/'.length) : '';
if (!selected || (selectedIetiModel && !Object.hasOwn(models, selectedIetiModel))) {
  config.model = `ieti-agents/${Object.keys(models)[0]}`;
}

fs.writeFileSync(outputPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
NODE
chmod 600 "$CONFIG_TMP"

if [ "$CREATE_KEY_FILE" -eq 1 ]; then
  mkdir -p "$SECRETS_DIRECTORY"
  chmod 700 "$SECRETS_DIRECTORY"
  KEY_TMP="$(mktemp "$KEY_FILE.tmp.XXXXXX")"
  printf '%s\n' "$IETI_API_KEY" > "$KEY_TMP"
  chmod 600 "$KEY_TMP"
  mv "$KEY_TMP" "$KEY_FILE"
  KEY_TMP=""
else
  chmod 600 "$KEY_FILE"
fi

mv "$CONFIG_TMP" "$CONFIG_FILE"
CONFIG_TMP=""

MODEL_COUNT="$(node -e 'const c=require(process.argv[1]); process.stdout.write(String(Object.keys(c.provider["ieti-agents"].models).length))' "$CONFIG_FILE")"
echo "IETI API key validated. Updated $CONFIG_FILE with $MODEL_COUNT available model(s)."

# This script intentionally only updates configuration. OpenCode is started separately.
exit 0
