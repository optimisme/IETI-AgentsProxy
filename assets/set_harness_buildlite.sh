#!/usr/bin/env bash
set -euo pipefail

WORKING_DIRECTORY="$(pwd -P)"
ARCHIVE_FILE="$WORKING_DIRECTORY/buildlite_harness.zip"
DOWNLOAD_URL="__IETI_BUILD_LITE_ZIP_URL__"
DOWNLOAD_TMP="$ARCHIVE_FILE.tmp.$$"
EXTRACT_DIRECTORY="$(mktemp -d "${TMPDIR:-/tmp}/ieti-buildlite.XXXXXX")"
CONFIG_TMP=""

cleanup() {
  rm -f "$DOWNLOAD_TMP"
  rm -f "$CONFIG_TMP"
  rm -rf "$EXTRACT_DIRECTORY"
}
trap cleanup EXIT

for command_name in curl unzip cp; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "Error: required command was not found: $command_name"
    exit 1
  fi
done

if ! command -v node >/dev/null 2>&1; then
  echo "Error: required command was not found: node"
  exit 1
fi

if [ "$DOWNLOAD_URL" = '__IETI_BUILD_LITE_ZIP_URL__' ]; then
  DOWNLOAD_URL='https://agents.ieti.site/downloads/buildlite_harness.zip'
fi

echo "Downloading BuildLite harness..."
curl --fail --silent --show-error --location \
  --connect-timeout 15 --max-time 120 \
  --output "$DOWNLOAD_TMP" "$DOWNLOAD_URL"
mv "$DOWNLOAD_TMP" "$ARCHIVE_FILE"

unzip -q "$ARCHIVE_FILE" -d "$EXTRACT_DIRECTORY"
SOURCE_DIRECTORY="$EXTRACT_DIRECTORY/buildlite_harness"
if [ ! -d "$SOURCE_DIRECTORY" ]; then
  echo "Error: the BuildLite archive does not contain the expected buildlite_harness/ directory."
  exit 1
fi

# Copy the archive contents, excluding its wrapper directory, into the project root.
# This keeps .agents/ and AGENTS.md at the root instead of nesting them below
# buildlite_harness/.
cp -a "$SOURCE_DIRECTORY/." "$WORKING_DIRECTORY/"

if [ ! -d "$WORKING_DIRECTORY/.agents" ] || [ ! -f "$WORKING_DIRECTORY/AGENTS.md" ]; then
  echo "Error: the BuildLite archive did not provide .agents/ and AGENTS.md at the project root."
  exit 1
fi

OPENCODE_DIRECTORY="$WORKING_DIRECTORY/.opencode"
if [ -L "$OPENCODE_DIRECTORY" ]; then
  if [ "$(cd "$OPENCODE_DIRECTORY" && pwd -P)" != "$(cd "$WORKING_DIRECTORY/.agents" && pwd -P)" ]; then
    echo "Error: .opencode already exists but does not point to .agents."
    exit 1
  fi
elif [ -e "$OPENCODE_DIRECTORY" ]; then
  echo "Error: .opencode already exists and is not a symbolic link to .agents. Move it before retrying."
  exit 1
else
  ln -s .agents "$OPENCODE_DIRECTORY"
fi

if [ -f "$WORKING_DIRECTORY/opencode.json" ]; then
  SET_DEFAULT_AGENT=0
  if [ -t 0 ]; then
    read -r -p "Set Build_lite as the default OpenCode agent in opencode.json? [y/N] " answer
    case "$answer" in
      y|Y|yes|YES|Yes) SET_DEFAULT_AGENT=1 ;;
    esac
  else
    echo "opencode.json exists; keeping its default agent because this is a non-interactive run."
  fi

  if [ "$SET_DEFAULT_AGENT" -eq 1 ]; then
    CONFIG_FILE="$WORKING_DIRECTORY/opencode.json"
    CONFIG_TMP="$(mktemp "$CONFIG_FILE.tmp.XXXXXX")"
    node - "$CONFIG_FILE" "$CONFIG_TMP" <<'NODE'
const fs = require('node:fs');
const [configPath, outputPath] = process.argv.slice(2);
let config;
try {
  config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
} catch (error) {
  throw new Error(`Cannot update ${configPath}: ${error.message}`);
}
if (!config || typeof config !== 'object' || Array.isArray(config)) {
  throw new Error(`${configPath} must contain a JSON object.`);
}
config.default_agent = 'build_lite';
fs.writeFileSync(outputPath, `${JSON.stringify(config, null, 2)}\n`);
NODE
    mv "$CONFIG_TMP" "$CONFIG_FILE"
    CONFIG_TMP=""
    echo "Updated $WORKING_DIRECTORY/opencode.json with default_agent=build_lite."
  fi
fi

rm -f "$ARCHIVE_FILE"

echo "BuildLite harness installed in $WORKING_DIRECTORY."
echo "Created or verified .opencode -> .agents."
