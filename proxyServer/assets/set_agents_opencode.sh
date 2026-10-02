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
if ! command -v python3 >/dev/null 2>&1; then
  echo 'Error: required command was not found: python3 (Python 3.9+)' >&2
  exit 1
fi

IFS= read -r -d '' GLOBAL_SCRIPT <<'PYTHON' || true
import base64
import http.client
import json
import math
import os
import queue
import re
import ssl
import stat
import sys
import threading
import time
import urllib.parse
import uuid


def reject_constant(value):
    raise ValueError("Invalid JSON constant: " + value)


def finite_json_float(value):
    number = float(value)
    if not math.isfinite(number):
        raise ValueError("Invalid JSON number: " + value)
    return number


def load_json(source):
    return json.loads(source, parse_constant=reject_constant, parse_float=finite_json_float)


def parse_jsonc(source):
    source = source.lstrip("\ufeff")
    clean, quoted, escaped, index = [], False, False, 0
    while index < len(source):
        character = source[index]
        if quoted:
            clean.append(character)
            if escaped:
                escaped = False
            elif character == "\\":
                escaped = True
            elif character == '"':
                quoted = False
        elif character == '"':
            quoted = True
            clean.append(character)
        elif source.startswith("//", index):
            clean.append("  ")
            index += 2
            while index < len(source) and source[index] not in "\r\n":
                clean.append(" ")
                index += 1
            if index < len(source):
                clean.append(source[index])
        elif source.startswith("/*", index):
            clean.append("  ")
            index += 2
            while index < len(source) and not source.startswith("*/", index):
                clean.append(source[index] if source[index] in "\r\n" else " ")
                index += 1
            if index >= len(source):
                raise ValueError("Unterminated JSON comment.")
            clean.append("  ")
            index += 1
        else:
            clean.append(character)
        index += 1
    clean = "".join(clean)
    result, quoted, escaped = [], False, False
    for index, character in enumerate(clean):
        if quoted:
            result.append(character)
            if escaped:
                escaped = False
            elif character == "\\":
                escaped = True
            elif character == '"':
                quoted = False
        elif character == '"':
            quoted = True
            result.append(character)
        elif character == ",":
            next_index = index + 1
            while next_index < len(clean) and clean[next_index].isspace():
                next_index += 1
            if next_index >= len(clean) or clean[next_index] not in "}]":
                result.append(character)
        else:
            result.append(character)
    return load_json("".join(result))


def snapshot(destination):
    try:
        with open(destination, "rb") as source:
            information = os.fstat(source.fileno())
            if not stat.S_ISREG(information.st_mode):
                raise ValueError("Expected a file at " + destination + ".")
            contents = source.read()
    except FileNotFoundError:
        return {"exists": False}
    return {"exists": True, "contents": base64.b64encode(contents).decode("ascii"),
            "mode": stat.S_IMODE(information.st_mode)}


def same(left, right):
    return left["exists"] == right["exists"] and (not left["exists"] or left["contents"] == right["contents"])


def original_bytes(original):
    return base64.b64decode(original["contents"], validate=True)


def read_config(config_path, original=None):
    if original is None:
        original = snapshot(config_path)
    if not original["exists"]:
        return {}
    try:
        config = parse_jsonc(original_bytes(original).decode("utf-8"))
        if not isinstance(config, dict):
            raise ValueError("Expected a JSON object.")
        return config
    except (ValueError, UnicodeError) as error:
        raise ValueError("Cannot update " + config_path + ": " + str(error)) from error


def write_private(destination, contents):
    descriptor = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(descriptor, "wb") as output:
        os.fchmod(output.fileno(), 0o600)
        output.write(contents)


def write_json(destination, value):
    write_private(destination, (json.dumps(value, ensure_ascii=True, allow_nan=False) + "\n").encode("utf-8"))


def read_json(destination):
    with open(destination, "r", encoding="utf-8-sig") as source:
        return load_json(source.read())


def temporary(destination):
    filename = destination + ".tmp." + uuid.uuid4().hex
    descriptor = os.open(filename, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    os.close(descriptor)
    return filename


def remove(filename):
    if filename:
        try:
            os.unlink(filename)
        except FileNotFoundError:
            pass


def restore(destination, original):
    if not original["exists"]:
        remove(destination)
        return
    filename = temporary(destination)
    try:
        write_private(filename, original_bytes(original))
        os.chmod(filename, original["mode"])
        os.replace(filename, destination)
    finally:
        remove(filename)


def positive_number(value):
    if isinstance(value, bool) or value is None:
        raise ValueError("Invalid model limit.")
    number = float(value)
    if not math.isfinite(number) or number <= 0:
        raise ValueError("Invalid model limit.")
    return int(number) if number.is_integer() else number


def models_from_catalog(catalog_path):
    try:
        catalog = read_json(catalog_path)
    except (ValueError, UnicodeError) as error:
        raise ValueError("The server returned an invalid model catalog.") from error
    if not isinstance(catalog, dict) or catalog.get("object") != "ieti.model_capabilities.list" or \
            type(catalog.get("schema_version")) is not int or catalog["schema_version"] != 1 or \
            not isinstance(catalog.get("data"), list) or not catalog["data"]:
        raise ValueError("The authenticated server returned no available models.")
    efforts = ["none", "minimal", "low", "medium", "high", "xhigh", "max"]
    models = {}
    for published in catalog["data"]:
        if not isinstance(published, dict):
            raise ValueError("Model metadata is incomplete.")
        model_id = published.get("id", "")
        model_id = model_id.strip() if isinstance(model_id, str) else ""
        try:
            context = positive_number(published.get("context_window"))
            output = positive_number(published.get("max_output_tokens"))
            if not model_id or model_id in models:
                raise ValueError()
        except (ValueError, TypeError, OverflowError):
            raise ValueError("Model metadata is incomplete or duplicated for " + (model_id or "<unknown model>") + ".")
        capabilities = published.get("capabilities")
        if not isinstance(capabilities, dict) or any(type(capabilities.get(name)) is not bool
                for name in ["text", "image", "tools", "reasoning", "parallel_tools"]):
            raise ValueError("Model capabilities are incomplete for " + model_id + ".")
        modalities = published.get("modalities")
        if isinstance(modalities, dict) and isinstance(modalities.get("input"), list):
            inputs = [value for value in modalities["input"] if isinstance(value, str)
                      and value in ["text", "audio", "image", "video", "pdf"]]
        else:
            inputs = (["text"] if capabilities["text"] else []) + (["image"] if capabilities["image"] else [])
        published_efforts = published.get("reasoning_efforts")
        published_efforts = published_efforts if isinstance(published_efforts, list) else []
        supported = [effort for effort in efforts if capabilities["reasoning"] and effort in published_efforts]
        variants = {effort: ({"reasoningEffort": effort} if effort in supported else {"disabled": True})
                    for effort in efforts} if capabilities["reasoning"] else {}
        model = {"limit": {"context": context, "output": output}, "tool_call": capabilities["tools"],
                 "reasoning": capabilities["reasoning"]}
        if capabilities["reasoning"]:
            model["interleaved"] = {"field": "reasoning_content"}
        model["modalities"] = {"input": inputs, "output": ["text"]}
        model["variants"] = variants
        default_effort = published.get("default_reasoning_effort")
        if default_effort in supported:
            model["options"] = {"reasoningEffort": default_effort}
        models[model_id] = model
    return models


def normalize_url(value):
    parsed = urllib.parse.urlsplit(value.strip())
    if parsed.scheme.lower() not in ["http", "https"] or not parsed.hostname or \
            parsed.username is not None or parsed.password is not None or parsed.query or parsed.fragment:
        raise ValueError("Base URL must be HTTP(S), without credentials, query, or fragment.")
    port = parsed.port
    hostname = parsed.hostname.encode("idna").decode("ascii").lower()
    netloc = "[" + hostname + "]" if ":" in hostname else hostname
    if port is not None and port != (443 if parsed.scheme.lower() == "https" else 80):
        netloc += ":" + str(port)
    pathname = parsed.path.rstrip("/")
    if not pathname.endswith("/v1"):
        pathname += "/v1"
    pathname = urllib.parse.quote(pathname, safe="/%:@!$&'()*+,;=-._~")
    return urllib.parse.urlunsplit((parsed.scheme.lower(), netloc, pathname, "", ""))


def fetch(base_url, key_path, output_path, timeout_seconds):
    timeout = float(timeout_seconds)
    deadline = time.monotonic() + timeout
    parsed = urllib.parse.urlsplit(base_url + "/model-capabilities")
    with open(key_path, "r", encoding="utf-8-sig") as source:
        key = source.read().strip()
    connection_type = http.client.HTTPSConnection if parsed.scheme == "https" else http.client.HTTPConnection
    options = {"timeout": min(10.0, timeout)}
    if parsed.scheme == "https":
        options["context"] = ssl.create_default_context()
    connection = connection_type(parsed.hostname, parsed.port, **options)
    connected = threading.Event()
    result = queue.Queue(maxsize=1)

    def worker():
        try:
            # A separate daemon worker bounds DNS resolution and TLS connection
            # time too; neither can extend the main thread's absolute deadline.
            connection.connect()
            connected.set()
            connection.sock.settimeout(max(0.001, deadline - time.monotonic()))
            path = urllib.parse.urlunsplit(("", "", parsed.path, parsed.query, ""))
            connection.request("GET", path, headers={"Authorization": "Bearer " + key, "Accept": "application/json"})
            response = connection.getresponse()
            chunks, size = [], 0
            while True:
                connection.sock.settimeout(max(0.001, deadline - time.monotonic())) if connection.sock else None
                chunk = response.read(65536)
                if not chunk:
                    break
                size += len(chunk)
                if size > 16 * 1024 * 1024:
                    raise ValueError("Model catalog response exceeded 16 MiB.")
                chunks.append(chunk)
            result.put((response.status, b"".join(chunks), None))
        except Exception as error:
            result.put((None, None, error))
        finally:
            connected.set()
            connection.close()

    threading.Thread(target=worker, daemon=True).start()
    try:
        if not connected.wait(min(10.0, max(0.001, deadline - time.monotonic()))):
            raise TimeoutError()
        status_code, body, error = result.get(timeout=max(0.001, deadline - time.monotonic()))
        if error is not None:
            raise error
        write_private(output_path, body)
        sys.stdout.write(str(status_code))
    except (Exception, KeyboardInterrupt) as error:
        # Only the worker closes the response: closing here can block on its
        # BufferedReader lock while a peer keeps sending a slow response.
        if isinstance(error, KeyboardInterrupt):
            raise
        raise ValueError("Could not connect to the IETI server, or the request timed out. Existing configuration was kept.") from error


def prepare(config_path, catalog_path, output_path, base_url, key_path, action):
    original = snapshot(config_path)
    config = read_config(config_path, original)
    original_json = json.dumps(config, ensure_ascii=True, allow_nan=False)
    if action == "uninstall":
        if isinstance(config.get("provider"), dict):
            config["provider"].pop("ieti-agents", None)
        for selection in ["model", "small_model"]:
            if isinstance(config.get(selection), str) and config[selection].startswith("ieti-agents/"):
                del config[selection]
        if isinstance(config.get("agent"), dict):
            for agent in config["agent"].values():
                if isinstance(agent, dict) and isinstance(agent.get("model"), str) and agent["model"].startswith("ieti-agents/"):
                    del agent["model"]
        for selection in ["enabled_providers", "disabled_providers"]:
            if isinstance(config.get(selection), list):
                config[selection] = [value for value in config[selection] if value != "ieti-agents"]
    else:
        models = models_from_catalog(catalog_path)
        if not config.get("$schema"):
            config["$schema"] = "https://opencode.ai/config.json"
        if not isinstance(config.get("provider"), dict):
            config["provider"] = {}
        provider = config["provider"].get("ieti-agents")
        provider = provider.copy() if isinstance(provider, dict) else {}
        options = provider.get("options")
        options = options.copy() if isinstance(options, dict) else {}
        options.update({"baseURL": base_url, "apiKey": "{file:" + key_path.replace("\\", "/") + "}",
                        "timeout": 900000, "chunkTimeout": 600000})
        provider.update({"npm": "@ai-sdk/openai-compatible", "name": "IETI Agents", "options": options, "models": models})
        config["provider"]["ieti-agents"] = provider
        if isinstance(config.get("enabled_providers"), list) and "ieti-agents" not in config["enabled_providers"]:
            config["enabled_providers"].append("ieti-agents")
        if isinstance(config.get("disabled_providers"), list):
            config["disabled_providers"] = [value for value in config["disabled_providers"] if value != "ieti-agents"]
        selected = config.get("model", "")
        selected = selected if isinstance(selected, str) else ""
        selected_ieti = selected[len("ieti-agents/"):] if selected.startswith("ieti-agents/") else ""
        if not selected or (selected_ieti and selected_ieti not in models):
            config["model"] = "ieti-agents/" + next(iter(models))
    if action == "uninstall" and original["exists"] and original_json == json.dumps(config, ensure_ascii=True, allow_nan=False):
        contents = original_bytes(original)
    else:
        contents = (json.dumps(config, indent=2, ensure_ascii=True, allow_nan=False) + "\n").encode("utf-8")
    write_private(output_path, contents)
    write_json(output_path + ".source", original)
    if not os.path.exists(output_path + ".key-source"):
        write_json(output_path + ".key-source", snapshot(key_path))


def make_directories(directory, created):
    missing, current = [], os.path.abspath(directory)
    while not os.path.exists(current):
        missing.append(current)
        current = os.path.dirname(current)
    for destination in reversed(missing):
        try:
            os.mkdir(destination, 0o700)
        except FileExistsError:
            if not os.path.isdir(destination):
                raise
        else:
            created.append(destination)


def cleanup_directories(plan):
    for directory in reversed(plan.get("createdDirectories", [])):
        try:
            os.rmdir(directory)
        except FileNotFoundError:
            pass
        except OSError:
            # Successful configuration or another process may now own contents.
            # Never remove nonempty directories or their unrelated files.
            pass


def stage(config_path, prepared_path, key_path, candidate_path, manifest_path, action):
    original_config = read_json(prepared_path + ".source")
    if not same(snapshot(config_path), original_config):
        raise ValueError("Configuration changed during setup. Run the installer again.")
    original_key = read_json(prepared_path + ".key-source")
    if not same(snapshot(key_path), original_key):
        raise ValueError("API key changed during setup. Run the installer again.")
    with open(prepared_path, "rb") as source:
        contents = source.read()
    config_changed = (action != "uninstall" or original_config["exists"]) and \
        (not original_config["exists"] or original_bytes(original_config) != contents)
    candidate = None
    if action != "uninstall":
        with open(candidate_path, "rb") as source:
            candidate = source.read()
    key_changed = original_key["exists"] if action == "uninstall" else \
        not original_key["exists"] or original_bytes(original_key) != candidate or original_key["mode"] != 0o600
    backup_path = config_path + ".bak"
    plan = {"configPath": config_path, "keyPath": key_path, "backupPath": backup_path, "action": action,
            "preparedPath": prepared_path, "candidatePath": candidate_path, "originalConfig": original_config,
            "originalKey": original_key, "configChanged": config_changed, "keyChanged": key_changed,
            "originalBackup": snapshot(backup_path) if config_changed and original_config["exists"] else None,
            "stages": [], "createdDirectories": []}
    try:
        if config_changed:
            make_directories(os.path.dirname(config_path), plan["createdDirectories"])
            plan["configStage"] = temporary(config_path)
            plan["stages"].append(plan["configStage"])
            if original_config["exists"]:
                plan["backupStage"] = temporary(backup_path)
                plan["stages"].append(plan["backupStage"])
        if key_changed and original_key["exists"]:
            plan["keyRollback"] = key_path + ".tmp.rollback." + uuid.uuid4().hex
        if key_changed and action != "uninstall":
            make_directories(os.path.dirname(key_path), plan["createdDirectories"])
            os.chmod(os.path.dirname(key_path), 0o700)
            plan["keyStage"] = temporary(key_path)
            plan["stages"].append(plan["keyStage"])
        write_json(manifest_path, plan)
    except BaseException:
        for filename in plan["stages"]:
            remove(filename)
        cleanup_directories(plan)
        raise


def commit(manifest_path):
    plan = read_json(manifest_path)
    backup_written = key_moved = key_written = config_written = False
    try:
        if not same(snapshot(plan["configPath"]), plan["originalConfig"]) or \
                not same(snapshot(plan["keyPath"]), plan["originalKey"]) or \
                (plan["originalBackup"] is not None and not same(snapshot(plan["backupPath"]), plan["originalBackup"])):
            raise ValueError("Configuration changed during setup. Run the installer again.")
        if plan.get("configStage"):
            with open(plan["preparedPath"], "rb") as source:
                write_private(plan["configStage"], source.read())
        if plan.get("backupStage"):
            write_private(plan["backupStage"], original_bytes(plan["originalConfig"]))
        if plan.get("keyStage"):
            with open(plan["candidatePath"], "rb") as source:
                write_private(plan["keyStage"], source.read())
        if plan.get("backupStage"):
            os.replace(plan["backupStage"], plan["backupPath"])
            backup_written = True
        if plan["keyChanged"]:
            if plan.get("keyRollback"):
                os.replace(plan["keyPath"], plan["keyRollback"])
                key_moved = True
            if plan["action"] != "uninstall":
                os.replace(plan["keyStage"], plan["keyPath"])
                key_written = True
        if plan.get("configStage"):
            os.replace(plan["configStage"], plan["configPath"])
            config_written = True
        remove(plan.get("keyRollback"))
        sys.stdout.write("changed" if plan["configChanged"] or plan["keyChanged"] else "unchanged")
    except BaseException as error:
        try:
            if config_written:
                restore(plan["configPath"], plan["originalConfig"])
            if key_moved:
                if os.path.exists(plan["keyRollback"]):
                    os.replace(plan["keyRollback"], plan["keyPath"])
                else:
                    restore(plan["keyPath"], plan["originalKey"])
            elif key_written:
                restore(plan["keyPath"], plan["originalKey"])
            if backup_written:
                restore(plan["backupPath"], plan["originalBackup"])
        except BaseException as rollback_error:
            raise ValueError(str(error) + " Rollback failed: " + str(rollback_error)) from rollback_error
        raise
    finally:
        for filename in plan["stages"]:
            remove(filename)
        cleanup_directories(plan)


def main(operation, args):
    if operation == "inspect-config":
        provider = read_config(args[0]).get("provider")
        sys.stdout.write("1" if isinstance(provider, dict) and "ieti-agents" in provider else "0")
    elif operation == "snapshot-key":
        write_json(args[1], snapshot(args[0]))
    elif operation == "normalize":
        sys.stdout.write(normalize_url(args[0]))
    elif operation == "fetch":
        fetch(*args)
    elif operation == "error":
        try:
            body = read_json(args[0])
            error = body.get("error", {}) if isinstance(body, dict) else {}
            message = error.get("message") if isinstance(error, dict) else None
            message = message or (body.get("message") if isinstance(body, dict) else None) or "the server rejected the request"
            sys.stdout.write(re.sub(r"ieti_sk_[A-Za-z0-9_-]+", "[redacted key]", str(message)))
        except Exception:
            sys.stdout.write("the server rejected the request")
    elif operation == "prepare":
        prepare(*args)
    elif operation == "stage":
        stage(*args)
    elif operation == "commit":
        commit(*args)
    elif operation == "cleanup":
        if os.path.exists(args[0]):
            plan = read_json(args[0])
            for filename in plan["stages"]:
                remove(filename)
            cleanup_directories(plan)
    elif operation == "absolute":
        sys.stdout.write(os.path.abspath(args[0]))
    elif operation == "read-key":
        with open(args[0], "r", encoding="utf-8-sig") as source:
            sys.stdout.write(source.read().strip())
    elif operation == "model-count":
        sys.stdout.write(str(len(read_json(args[0])["provider"]["ieti-agents"]["models"])))
    else:
        raise ValueError("Unknown installer operation.")


try:
    if sys.version_info < (3, 9):
        raise ValueError("Python 3.9 or newer is required.")
    main(sys.argv[1], sys.argv[2:])
except KeyboardInterrupt:
    sys.stderr.write("Setup cancelled. Existing configuration was kept.\n")
    sys.exit(130)
except Exception as error:
    message = re.sub(r"ieti_sk_[A-Za-z0-9_-]+", "[redacted key]", str(error))
    sys.stderr.write("Error: " + message + "\n")
    sys.exit(1)
PYTHON
run_python() { python3 -I -B -c "$GLOBAL_SCRIPT" "$@"; }

CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
CONFIG_HOME="$(run_python absolute "$CONFIG_HOME")"
CONFIG_DIRECTORY="$CONFIG_HOME/opencode"
CONFIG_FILE="$CONFIG_DIRECTORY/opencode.json"
SECRETS_DIRECTORY="$CONFIG_HOME/ieti-agents"
KEY_FILE="$SECRETS_DIRECTORY/agents_server_key"
if [ -e "$CONFIG_FILE" ] && [ -e "$CONFIG_DIRECTORY/opencode.jsonc" ]; then
  echo "Error: both $CONFIG_FILE and $CONFIG_DIRECTORY/opencode.jsonc exist. Consolidate them before running setup." >&2
  exit 1
fi
if [ -e "$CONFIG_DIRECTORY/opencode.jsonc" ]; then CONFIG_FILE="$CONFIG_DIRECTORY/opencode.jsonc"; fi
INSTALLED="$(run_python inspect-config "$CONFIG_FILE")"
if [ -e "$KEY_FILE" ]; then INSTALLED=1; fi
INTERACTIVE=0
if [ "$SYNC_ONLY" -eq 0 ] && [ -t 0 ]; then INTERACTIVE=1; fi

SCRATCH_DIRECTORY=""
cleanup() {
  if [ -n "$SCRATCH_DIRECTORY" ]; then
    run_python cleanup "$SCRATCH_DIRECTORY/transaction.json" >/dev/null 2>&1 || true
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
run_python snapshot-key "$KEY_FILE" "$PREPARED_CONFIG.key-source"

commit_changes() {
  run_python stage "$CONFIG_FILE" "$PREPARED_CONFIG" "$KEY_FILE" "$CANDIDATE_KEY" "$MANIFEST_FILE" "$1"
  run_python commit "$MANIFEST_FILE" >/dev/null
}
if [ "$UNINSTALL" -eq 1 ]; then
  run_python prepare "$CONFIG_FILE" unused "$PREPARED_CONFIG" unused "$KEY_FILE" uninstall
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
API_BASE_URL="$(run_python normalize "$BASE_URL")"

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
  if ! http_status="$(run_python fetch "$API_BASE_URL" "$CANDIDATE_KEY" "$CAPABILITIES_FILE" "$TIMEOUT_SECONDS")"; then
    return 2
  fi
  if [ "$http_status" = 401 ]; then echo 'Error: invalid API key (HTTP 401).' >&2; return 1; fi
  if [ "$http_status" != 200 ]; then
    error_message="$(run_python error "$CAPABILITIES_FILE")"
    if [ "$http_status" = 403 ]; then
      echo "Error: IETI account or group access is unavailable (HTTP 403): $error_message" >&2
    else
      echo "Error: IETI server rejected model discovery (HTTP $http_status): $error_message" >&2
    fi
    return 2
  fi
  if ! run_python prepare "$CONFIG_FILE" "$CAPABILITIES_FILE" "$PREPARED_CONFIG" "$API_BASE_URL" "$KEY_FILE" update; then return 2; fi
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
    IETI_API_KEY="$(run_python read-key "$KEY_FILE")"
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
MODEL_COUNT="$(run_python model-count "$PREPARED_CONFIG")"
echo "IETI API key validated. Updated global $CONFIG_FILE with $MODEL_COUNT available model(s)."
echo "API key stored at $KEY_FILE. Restart OpenCode to load the configuration."
