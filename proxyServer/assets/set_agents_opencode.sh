#!/usr/bin/env bash
set -euo pipefail
umask 077

# Downloads replace this assignment with the server's public API URL.
DEFAULT_BASE_URL="__IETI_DEFAULT_BASE_URL__"
SYNC_ONLY=0
UNINSTALL=0
for argument in "$@"; do
  case "$argument" in
    --sync-only) SYNC_ONLY=1 ;;
    --uninstall) UNINSTALL=1 ;;
    --help|-h)
      echo 'Usage: set_agents_opencode.sh [--sync-only] [--uninstall]'
      echo 'Installs IETI Agents in the user-wide OpenCode configuration.'
      exit 0 ;;
    *) echo "Error: unknown option: $argument" >&2; exit 1 ;;
  esac
done
if ! command -v node >/dev/null 2>&1; then
  echo 'Error: required command was not found: node' >&2
  exit 1
fi

GLOBAL_SCRIPT="$(cat <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const [operation, ...args] = process.argv.slice(process.argv[1] === '-' ? 3 : 1);

function parseJsonc(source) {
  source = source.replace(/^\uFEFF/, '');
  let clean = '', quoted = false, escaped = false;
  for (let index = 0; index < source.length; index++) {
    const character = source[index];
    if (quoted) {
      clean += character;
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') { quoted = true; clean += character; }
    else if (character === '/' && source[index + 1] === '/') {
      clean += '  '; index += 2;
      while (index < source.length && !'\r\n'.includes(source[index])) { clean += ' '; index++; }
      if (index < source.length) clean += source[index];
    } else if (character === '/' && source[index + 1] === '*') {
      clean += '  '; index += 2;
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) {
        clean += '\r\n'.includes(source[index]) ? source[index] : ' '; index++;
      }
      if (index >= source.length) throw new Error('Unterminated JSON comment.');
      clean += '  '; index++;
    } else clean += character;
  }
  let json = ''; quoted = false; escaped = false;
  for (let index = 0; index < clean.length; index++) {
    const character = clean[index];
    if (quoted) {
      json += character;
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') quoted = false;
    } else if (character === '"') { quoted = true; json += character; }
    else if (character === ',') {
      let next = index + 1;
      while (next < clean.length && /\s/.test(clean[next])) next++;
      if (!['}', ']'].includes(clean[next])) json += character;
    } else json += character;
  }
  return JSON.parse(json);
}
function readConfig(configPath) {
  if (!fs.existsSync(configPath)) return {};
  try {
    const config = parseJsonc(fs.readFileSync(configPath, 'utf8'));
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Expected a JSON object.');
    return config;
  } catch (error) { throw new Error(`Cannot update ${configPath}: ${error.message}`); }
}
function modelsFromCatalog(catalogPath) {
  const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
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
    const capabilities = published?.capabilities || {};
    if (!id || !Number.isFinite(context) || context <= 0 || !Number.isFinite(output) || output <= 0 || Object.hasOwn(models, id)) {
      throw new Error(`Model metadata is incomplete or duplicated for ${id || '<unknown model>'}.`);
    }
    if (['text', 'image', 'tools', 'reasoning', 'parallel_tools'].some(name => typeof capabilities[name] !== 'boolean')) {
      throw new Error(`Model capabilities are incomplete for ${id}.`);
    }
    const inputModalities = Array.isArray(published?.modalities?.input)
      ? published.modalities.input.filter(value => ['text', 'audio', 'image', 'video', 'pdf'].includes(value))
      : [capabilities.text ? 'text' : null, capabilities.image ? 'image' : null].filter(Boolean);
    const publishedEfforts = new Set(Array.isArray(published.reasoning_efforts) ? published.reasoning_efforts : []);
    const reasoningEfforts = capabilities.reasoning ? canonicalReasoningEfforts.filter(effort => publishedEfforts.has(effort)) : [];
    const defaultReasoningEffort = reasoningEfforts.includes(published.default_reasoning_effort) ? published.default_reasoning_effort : null;
    const variants = capabilities.reasoning ? Object.fromEntries(canonicalReasoningEfforts.map(effort => [
      effort, reasoningEfforts.includes(effort) ? { reasoningEffort: effort } : { disabled: true }
    ])) : {};
    models[id] = {
      limit: { context, output }, tool_call: capabilities.tools, reasoning: capabilities.reasoning,
      ...(capabilities.reasoning ? { interleaved: { field: 'reasoning_content' } } : {}),
      modalities: { input: inputModalities, output: ['text'] }, variants,
      ...(defaultReasoningEffort ? { options: { reasoningEffort: defaultReasoningEffort } } : {})
    };
  }
  return models;
}
function snapshot(destination) {
  if (!fs.existsSync(destination)) return { exists: false };
  const stat = fs.statSync(destination);
  if (!stat.isFile()) throw new Error(`Expected a file at ${destination}.`);
  return { exists: true, contents: fs.readFileSync(destination).toString('base64'), mode: stat.mode & 0o777 };
}
function same(left, right) { return left.exists === right.exists && (!left.exists || left.contents === right.contents); }
function temporary(destination) {
  const filename = `${destination}.tmp.${crypto.randomUUID()}`;
  fs.closeSync(fs.openSync(filename, 'wx', 0o600));
  return filename;
}
function remove(filename) { if (filename && fs.existsSync(filename)) fs.unlinkSync(filename); }
function restore(destination, original) {
  if (!original.exists) { remove(destination); return; }
  // Reuse the protected destination where possible, preserving its Windows ACL.
  fs.writeFileSync(destination, Buffer.from(original.contents, 'base64'), { mode: 0o600 });
  if (process.platform !== 'win32') fs.chmodSync(destination, original.mode);
}
try {
  if (operation === 'inspect-config') {
    const config = readConfig(args[0]);
    process.stdout.write(Object.hasOwn(config.provider || {}, 'ieti-agents') ? '1' : '0');
  } else if (operation === 'snapshot-key') {
    fs.writeFileSync(args[1], JSON.stringify(snapshot(args[0])), { mode: 0o600 });
  } else if (operation === 'normalize') {
    const url = new URL(args[0]);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Base URL must be HTTP(S), without credentials, query, or fragment.');
    url.pathname = url.pathname.replace(/\/+$/, '');
    if (!url.pathname.endsWith('/v1')) url.pathname += '/v1';
    process.stdout.write(url.toString().replace(/\/$/, ''));
  } else if (operation === 'fetch') {
    const [baseURL, keyPath, outputPath, timeoutSeconds] = args;
    const url = new URL(`${baseURL}/model-capabilities`);
    const key = fs.readFileSync(keyPath, 'utf8').trim();
    const transport = require(url.protocol === 'https:' ? 'node:https' : 'node:http');
    let completed = false, connectionTimer, requestTimer;
    const finish = (error, status, body) => {
      if (completed) return;
      completed = true;
      clearTimeout(connectionTimer); clearTimeout(requestTimer);
      if (error) { process.stderr.write('Error: Could not connect to the IETI server, or the request timed out. Existing configuration was kept.\n'); process.exitCode = 1; }
      else { fs.writeFileSync(outputPath, body, { mode: 0o600 }); process.stdout.write(String(status)); }
    };
    const request = transport.request(url, { method: 'GET', agent: false, headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' } }, response => {
      clearTimeout(connectionTimer);
      const chunks = []; let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > 16 * 1024 * 1024) { finish(new Error()); request.destroy(); }
        else chunks.push(chunk);
      });
      response.on('error', error => finish(error));
      response.on('aborted', () => finish(new Error()));
      response.on('end', () => finish(null, response.statusCode, Buffer.concat(chunks)));
    });
    request.on('socket', socket => {
      const event = url.protocol === 'https:' ? 'secureConnect' : 'connect';
      socket.once(event, () => clearTimeout(connectionTimer));
    });
    request.on('error', error => finish(error));
    connectionTimer = setTimeout(() => { finish(new Error()); request.destroy(); }, Math.min(10, Number(timeoutSeconds)) * 1000);
    requestTimer = setTimeout(() => { finish(new Error()); request.destroy(); }, Number(timeoutSeconds) * 1000);
    request.end();
  } else if (operation === 'error') {
    try {
      const body = JSON.parse(fs.readFileSync(args[0], 'utf8'));
      const message = String(body?.error?.message || body?.message || 'the server rejected the request');
      process.stdout.write(message.replace(/ieti_sk_[A-Za-z0-9_-]+/g, '[redacted key]'));
    } catch { process.stdout.write('the server rejected the request'); }
  } else if (operation === 'prepare') {
    const [configPath, catalogPath, outputPath, baseURL, keyPath, action] = args;
    const originalSnapshot = snapshot(configPath);
    let config = {};
    if (originalSnapshot.exists) {
      try {
        config = parseJsonc(Buffer.from(originalSnapshot.contents, 'base64').toString('utf8'));
        if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Expected a JSON object.');
      } catch (error) { throw new Error(`Cannot update ${configPath}: ${error.message}`); }
    }
    const originalJson = JSON.stringify(config);
    if (action === 'uninstall') {
      if (config.provider && typeof config.provider === 'object') delete config.provider['ieti-agents'];
      for (const selection of ['model', 'small_model']) {
        if (typeof config[selection] === 'string' && config[selection].startsWith('ieti-agents/')) delete config[selection];
      }
      if (config.agent && typeof config.agent === 'object') {
        for (const agent of Object.values(config.agent)) {
          if (agent && typeof agent === 'object' && typeof agent.model === 'string' && agent.model.startsWith('ieti-agents/')) delete agent.model;
        }
      }
      for (const selection of ['enabled_providers', 'disabled_providers']) {
        if (Array.isArray(config[selection])) config[selection] = config[selection].filter(value => value !== 'ieti-agents');
      }
    } else {
      const models = modelsFromCatalog(catalogPath);
      config.$schema ||= 'https://opencode.ai/config.json';
      config.provider = config.provider && typeof config.provider === 'object' && !Array.isArray(config.provider) ? config.provider : {};
      const existing = config.provider['ieti-agents'];
      const provider = existing && typeof existing === 'object' && !Array.isArray(existing) ? existing : {};
      const existingOptions = provider.options && typeof provider.options === 'object' && !Array.isArray(provider.options) ? provider.options : {};
      config.provider['ieti-agents'] = {
        ...provider, npm: '@ai-sdk/openai-compatible', name: 'IETI Agents',
        options: { ...existingOptions, baseURL, apiKey: `{file:${keyPath.replace(/\\/g, '/')}}`, timeout: 900000, chunkTimeout: 600000 }, models
      };
      if (Array.isArray(config.enabled_providers) && !config.enabled_providers.includes('ieti-agents')) config.enabled_providers.push('ieti-agents');
      if (Array.isArray(config.disabled_providers)) config.disabled_providers = config.disabled_providers.filter(value => value !== 'ieti-agents');
      const selected = typeof config.model === 'string' ? config.model : '';
      const selectedIetiModel = selected.startsWith('ieti-agents/') ? selected.slice('ieti-agents/'.length) : '';
      if (!selected || (selectedIetiModel && !Object.hasOwn(models, selectedIetiModel))) config.model = `ieti-agents/${Object.keys(models)[0]}`;
    }
    const output = action === 'uninstall' && fs.existsSync(configPath) && originalJson === JSON.stringify(config)
      ? Buffer.from(originalSnapshot.contents, 'base64') : `${JSON.stringify(config, null, 2)}\n`;
    fs.writeFileSync(outputPath, output, { mode: 0o600 });
    fs.writeFileSync(`${outputPath}.source`, JSON.stringify(originalSnapshot), { mode: 0o600 });
    if (!fs.existsSync(`${outputPath}.key-source`)) {
      fs.writeFileSync(`${outputPath}.key-source`, JSON.stringify(snapshot(keyPath)), { mode: 0o600 });
    }
  } else if (operation === 'stage') {
    const [configPath, preparedPath, keyPath, candidatePath, manifestPath, action] = args;
    const originalConfig = JSON.parse(fs.readFileSync(`${preparedPath}.source`, 'utf8'));
    if (!same(snapshot(configPath), originalConfig)) throw new Error('Configuration changed during setup. Run the installer again.');
    const originalKey = JSON.parse(fs.readFileSync(`${preparedPath}.key-source`, 'utf8'));
    if (!same(snapshot(keyPath), originalKey)) throw new Error('API key changed during setup. Run the installer again.');
    const contents = fs.readFileSync(preparedPath);
    const configChanged = (action !== 'uninstall' || originalConfig.exists) && (!originalConfig.exists || originalConfig.contents !== contents.toString('base64'));
    const candidate = action === 'uninstall' ? null : fs.readFileSync(candidatePath);
    const keyChanged = action === 'uninstall' ? originalKey.exists : !originalKey.exists || originalKey.contents !== candidate.toString('base64') || originalKey.mode !== 0o600 || process.platform === 'win32';
    const backupPath = `${configPath}.bak`;
    const plan = { configPath, keyPath, backupPath, action, preparedPath, candidatePath, originalConfig, originalKey,
      configChanged, keyChanged, originalBackup: configChanged && originalConfig.exists ? snapshot(backupPath) : null, stages: [] };
    try {
      if (configChanged) {
        fs.mkdirSync(path.dirname(configPath), { recursive: true });
        plan.configStage = temporary(configPath); plan.stages.push(plan.configStage);
        if (originalConfig.exists) { plan.backupStage = temporary(backupPath); plan.stages.push(plan.backupStage); }
      }
      if (keyChanged && action === 'uninstall') plan.keyRollback = `${keyPath}.tmp.rollback.${crypto.randomUUID()}`;
      if (keyChanged && action !== 'uninstall') {
        fs.mkdirSync(path.dirname(keyPath), { recursive: true, mode: 0o700 });
        if (process.platform !== 'win32') fs.chmodSync(path.dirname(keyPath), 0o700);
        plan.keyStage = temporary(keyPath); plan.stages.push(plan.keyStage);
      }
      fs.writeFileSync(manifestPath, JSON.stringify(plan), { mode: 0o600 });
    } catch (error) { for (const stage of plan.stages) remove(stage); throw error; }
  } else if (operation === 'commit') {
    const plan = JSON.parse(fs.readFileSync(args[0], 'utf8'));
    let backupWritten = false, keyWritten = false, configWritten = false, committed = false;
    try {
      if (!same(snapshot(plan.configPath), plan.originalConfig) || !same(snapshot(plan.keyPath), plan.originalKey) ||
          (plan.originalBackup && !same(snapshot(plan.backupPath), plan.originalBackup))) throw new Error('Configuration changed during setup. Run the installer again.');
      if (plan.configStage) fs.writeFileSync(plan.configStage, fs.readFileSync(plan.preparedPath));
      if (plan.backupStage) fs.writeFileSync(plan.backupStage, Buffer.from(plan.originalConfig.contents, 'base64'));
      if (plan.keyStage) fs.writeFileSync(plan.keyStage, fs.readFileSync(plan.candidatePath));
      if (plan.backupStage) { fs.renameSync(plan.backupStage, plan.backupPath); backupWritten = true; }
      if (plan.keyChanged) {
        if (plan.action === 'uninstall') fs.renameSync(plan.keyPath, plan.keyRollback);
        else fs.renameSync(plan.keyStage, plan.keyPath);
        keyWritten = true;
      }
      if (plan.configStage) { fs.renameSync(plan.configStage, plan.configPath); configWritten = true; }
      committed = true;
      process.stdout.write(plan.configChanged || plan.keyChanged ? 'changed' : 'unchanged');
    } catch (error) {
      try {
        if (configWritten) restore(plan.configPath, plan.originalConfig);
        if (keyWritten) {
          if (plan.keyRollback) fs.renameSync(plan.keyRollback, plan.keyPath);
          else restore(plan.keyPath, plan.originalKey);
        }
        if (backupWritten) restore(plan.backupPath, plan.originalBackup);
      } catch (rollbackError) { throw new Error(`${error.message} Rollback failed: ${rollbackError.message}`); }
      throw error;
    } finally {
      for (const stage of plan.stages) remove(stage);
      if (committed) remove(plan.keyRollback);
    }
  } else if (operation === 'cleanup') {
    if (fs.existsSync(args[0])) {
      const plan = JSON.parse(fs.readFileSync(args[0], 'utf8'));
      for (const stage of plan.stages) remove(stage);
    }
  } else throw new Error('Unknown installer operation.');
} catch (error) {
  process.stderr.write(`Error: ${error.message}\n`);
  process.exit(1);
}
NODE
)"
run_node() { node -e "$GLOBAL_SCRIPT" -- "$@"; }

CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
CONFIG_HOME="$(node -e 'process.stdout.write(require("node:path").resolve(process.argv[1]))' "$CONFIG_HOME")"
CONFIG_DIRECTORY="$CONFIG_HOME/opencode"
CONFIG_FILE="$CONFIG_DIRECTORY/opencode.json"
SECRETS_DIRECTORY="$CONFIG_HOME/ieti-agents"
KEY_FILE="$SECRETS_DIRECTORY/agents_server_key"
if [ -e "$CONFIG_FILE" ] && [ -e "$CONFIG_DIRECTORY/opencode.jsonc" ]; then
  echo "Error: both $CONFIG_FILE and $CONFIG_DIRECTORY/opencode.jsonc exist. Consolidate them before running setup." >&2
  exit 1
fi
if [ -e "$CONFIG_DIRECTORY/opencode.jsonc" ]; then CONFIG_FILE="$CONFIG_DIRECTORY/opencode.jsonc"; fi
INSTALLED="$(run_node inspect-config "$CONFIG_FILE")"
if [ -e "$KEY_FILE" ]; then INSTALLED=1; fi
INTERACTIVE=0
if [ "$SYNC_ONLY" -eq 0 ] && [ -t 0 ]; then INTERACTIVE=1; fi

SCRATCH_DIRECTORY=""
cleanup() {
  if [ -n "$SCRATCH_DIRECTORY" ]; then
    run_node cleanup "$SCRATCH_DIRECTORY/transaction.json" >/dev/null 2>&1 || true
    rm -rf "$SCRATCH_DIRECTORY"
  fi
}
trap cleanup EXIT
trap 'echo "Setup cancelled. Existing configuration was kept." >&2; exit 130' INT TERM

if [ "$UNINSTALL" -eq 0 ] && [ "$INSTALLED" -eq 1 ] && [ "$INTERACTIVE" -eq 1 ]; then
  while true; do
    if ! read -r -p 'IETI Agents is installed globally. Update or uninstall? [Update/uninstall] ' answer; then
      echo 'Setup cancelled. Existing configuration was kept.' >&2; exit 1
    fi
    case "$answer" in
      ''|1|update|Update) break ;;
      2|uninstall|Uninstall) UNINSTALL=1; break ;;
      cancel|Cancel|q|Q) echo 'Setup cancelled. Existing configuration was kept.'; exit 0 ;;
      *) echo 'Enter update, uninstall, or cancel.' ;;
    esac
  done
fi
SCRATCH_DIRECTORY="$(mktemp -d "${TMPDIR:-/tmp}/ieti-opencode.XXXXXX")"
chmod 700 "$SCRATCH_DIRECTORY"
PREPARED_CONFIG="$SCRATCH_DIRECTORY/opencode.json"
CANDIDATE_KEY="$SCRATCH_DIRECTORY/key"
CAPABILITIES_FILE="$SCRATCH_DIRECTORY/capabilities.json"
MANIFEST_FILE="$SCRATCH_DIRECTORY/transaction.json"
run_node snapshot-key "$KEY_FILE" "$PREPARED_CONFIG.key-source"

commit_changes() {
  run_node stage "$CONFIG_FILE" "$PREPARED_CONFIG" "$KEY_FILE" "$CANDIDATE_KEY" "$MANIFEST_FILE" "$1"
  run_node commit "$MANIFEST_FILE" >/dev/null
}
if [ "$UNINSTALL" -eq 1 ]; then
  run_node prepare "$CONFIG_FILE" unused "$PREPARED_CONFIG" unused "$KEY_FILE" uninstall
  commit_changes uninstall
  echo "Removed IETI Agents from $CONFIG_FILE and removed $KEY_FILE."
  exit 0
fi
TIMEOUT_SECONDS="${PROXY_AGENTS_REQUEST_TIMEOUT_SECONDS:-30}"
if [[ ! "$TIMEOUT_SECONDS" =~ ^[0-9]+$ ]] || [ "$TIMEOUT_SECONDS" -lt 1 ] || [ "$TIMEOUT_SECONDS" -gt 30 ]; then
  echo 'Error: PROXY_AGENTS_REQUEST_TIMEOUT_SECONDS must be an integer from 1 to 30.' >&2; exit 1
fi
if [ "$DEFAULT_BASE_URL" = '__IETI_''DEFAULT_BASE_URL__' ]; then DEFAULT_BASE_URL='https://agents.ieti.site/v1'; fi
BASE_URL="${PROXY_AGENTS_BASE_URL:-$DEFAULT_BASE_URL}"
if [ "$INTERACTIVE" -eq 1 ]; then
  if ! read -r -p "IETI Agents base URL [$BASE_URL]: " entered_url; then
    echo 'Setup cancelled. Existing configuration was kept.' >&2; exit 1
  fi
  BASE_URL="${entered_url:-$BASE_URL}"
fi
API_BASE_URL="$(run_node normalize "$BASE_URL")"

read_masked_key() {
  local character='' value=''
  printf 'Paste your IETI Agents API key: '
  while true; do
    if ! IFS= read -r -s -n 1 character; then echo; return 1; fi
    if [ -z "$character" ] || [ "$character" = $'\r' ]; then break; fi
    case "$character" in
      $'\177'|$'\b') if [ -n "$value" ]; then value="${value%?}"; printf '\b \b'; fi ;;
      *) value+="$character"; printf '*' ;;
    esac
  done
  echo
  IETI_API_KEY="$value"
}
valid_key_format() { [[ "$IETI_API_KEY" =~ ^ieti_sk_[A-Za-z0-9_-]+$ ]]; }
validate_key() {
  if ! valid_key_format; then echo 'Error: invalid API key format; expected an ieti_sk_ key.' >&2; return 1; fi
  printf '%s\n' "$IETI_API_KEY" > "$CANDIDATE_KEY"
  local http_status error_message
  if ! http_status="$(run_node fetch "$API_BASE_URL" "$CANDIDATE_KEY" "$CAPABILITIES_FILE" "$TIMEOUT_SECONDS")"; then
    return 2
  fi
  if [ "$http_status" = 401 ]; then echo 'Error: invalid API key (HTTP 401).' >&2; return 1; fi
  if [ "$http_status" != 200 ]; then
    error_message="$(run_node error "$CAPABILITIES_FILE")"
    if [ "$http_status" = 403 ]; then
      echo "Error: IETI account or group access is unavailable (HTTP 403): $error_message" >&2
    else
      echo "Error: IETI server rejected model discovery (HTTP $http_status): $error_message" >&2
    fi
    return 2
  fi
  if ! run_node prepare "$CONFIG_FILE" "$CAPABILITIES_FILE" "$PREPARED_CONFIG" "$API_BASE_URL" "$KEY_FILE" update; then return 2; fi
  return 0
}
prompt_for_key() {
  if [ "$INTERACTIVE" -ne 1 ]; then
    echo "Error: no valid saved API key at $KEY_FILE. Run interactively or set PROXY_AGENTS_KEY." >&2
    return 1
  fi
  while true; do
    if ! read_masked_key; then echo 'Setup cancelled. Existing configuration was kept.' >&2; return 1; fi
    if validate_key; then return 0; else
      local validation_status=$?
      if [ "$validation_status" -ne 1 ]; then return "$validation_status"; fi
      echo 'The API key is invalid. Paste a valid ieti_sk_ key, or cancel with Ctrl+C.' >&2
    fi
  done
}

IETI_API_KEY="${PROXY_AGENTS_KEY:-}"
if [ -n "$IETI_API_KEY" ]; then
  if ! validate_key; then
    echo 'Error: the supplied API key or model catalog could not be validated. Existing configuration was kept.' >&2; exit 1
  fi
else
  SAVED_VALID=0
  if [ -f "$KEY_FILE" ]; then
    IETI_API_KEY="$(node -e 'process.stdout.write(require("node:fs").readFileSync(process.argv[1], "utf8").trim())' "$KEY_FILE")"
    if validate_key; then SAVED_VALID=1; else
      validation_status=$?
      if [ "$validation_status" -ne 1 ]; then exit 1; fi
      echo 'The saved API key is invalid.' >&2
    fi
  fi
  if [ "$SAVED_VALID" -eq 1 ]; then
    if [ "$INTERACTIVE" -eq 1 ]; then
      while true; do
        if ! read -r -p 'Saved API key is valid. Keep or replace? [Keep/replace] ' answer; then
          echo 'Setup cancelled. Existing configuration was kept.' >&2; exit 1
        fi
        case "$answer" in
          ''|1|keep|Keep) break ;;
          2|replace|Replace) prompt_for_key; break ;;
          cancel|Cancel|q|Q) echo 'Setup cancelled. Existing configuration was kept.'; exit 0 ;;
          *) echo 'Enter keep, replace, or cancel.' ;;
        esac
      done
    fi
  else
    prompt_for_key
  fi
fi
commit_changes update
MODEL_COUNT="$(node -e 'const fs=require("node:fs"); const c=JSON.parse(fs.readFileSync(process.argv[1], "utf8")); process.stdout.write(String(Object.keys(c.provider["ieti-agents"].models).length))' "$PREPARED_CONFIG")"
echo "IETI API key validated. Updated global $CONFIG_FILE with $MODEL_COUNT available model(s)."
echo "API key stored at $KEY_FILE. Restart OpenCode to load the configuration."
