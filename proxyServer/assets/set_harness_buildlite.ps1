[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$WorkingDirectory = (Get-Location).Path
$ArchiveFile = Join-Path $WorkingDirectory 'buildlite_harness.zip'
$DownloadUrl = '__IETI_BUILD_LITE_ZIP_URL__'
$DownloadTemporary = "$ArchiveFile.tmp.$([Guid]::NewGuid().ToString('N'))"
$ExtractDirectory = Join-Path ([System.IO.Path]::GetTempPath()) "ieti-buildlite-$([Guid]::NewGuid().ToString('N'))"

$ConfigTemporary = $null

try {
  Get-Command node -ErrorAction Stop | Out-Null
  if ($DownloadUrl -eq '__IETI_BUILD_LITE_ZIP_URL__') {
    $DownloadUrl = 'https://agents.ieti.site/downloads/buildlite_harness.zip'
  }

  New-Item -ItemType Directory -Path $ExtractDirectory -Force | Out-Null
  Write-Host 'Downloading BuildLite harness...'
  Invoke-WebRequest -UseBasicParsing -Uri $DownloadUrl -OutFile $DownloadTemporary
  Move-Item -LiteralPath $DownloadTemporary -Destination $ArchiveFile -Force

  Expand-Archive -LiteralPath $ArchiveFile -DestinationPath $ExtractDirectory -Force
  $SourceDirectory = Join-Path $ExtractDirectory 'buildlite_harness'
  if (-not (Test-Path -LiteralPath $SourceDirectory -PathType Container)) {
    throw 'The BuildLite archive does not contain the expected buildlite_harness/ directory.'
  }

  $AgentsDirectory = Join-Path $WorkingDirectory '.agents'
  $AgentsFile = Join-Path $WorkingDirectory 'AGENTS.md'
  $SourceAgentsFile = Join-Path $SourceDirectory 'AGENTS.md'
  if (-not (Test-Path -LiteralPath (Join-Path $SourceDirectory '.agents') -PathType Container) -or
      -not (Test-Path -LiteralPath $SourceAgentsFile -PathType Leaf)) {
    throw 'The BuildLite archive did not provide .agents/ and AGENTS.md.'
  }

  # Reject a conflicting OpenCode directory before changing project files.
  $OpenCodeDirectory = Join-Path $WorkingDirectory '.opencode'
  $OpenCodeItem = Get-Item -LiteralPath $OpenCodeDirectory -Force -ErrorAction SilentlyContinue
  if ($null -ne $OpenCodeItem) {
    if (-not ($OpenCodeItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
      throw '.opencode already exists and is not a directory junction to .agents. Move it before retrying.'
    }
    $checkLinkScript = @'
const fs = require('node:fs');
const [a, b] = process.argv.slice(1);
process.exit(fs.realpathSync(a) === fs.realpathSync(b) ? 0 : 1);
'@
    & node -e $checkLinkScript $OpenCodeDirectory $AgentsDirectory
    if ($LASTEXITCODE -ne 0) {
      throw '.opencode already exists but does not point to .agents.'
    }
  }

  # Keep project instructions and replace only the managed harness block on reinstall.
  $mergeInstructionsScript = @'
const fs = require('node:fs');
const [existingPath, sourcePath] = process.argv.slice(1);
// Strip macOS archive metadata only from the temporary harness before copying.
const path = require('node:path');
const macosNames = new Set(['__MACOSX', '.DS_Store', '.AppleDouble', '.LSOverride']);
function removeMacosMetadata(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (macosNames.has(entry.name) || entry.name.startsWith('._')) {
      fs.rmSync(target, { recursive: true, force: true });
    } else if (entry.isDirectory()) {
      removeMacosMetadata(target);
    }
  }
}
removeMacosMetadata(path.dirname(sourcePath));
const start = '<!-- buildlite:start -->';
const end = '<!-- buildlite:end -->';
const incoming = fs.readFileSync(sourcePath, 'utf8').trimEnd();
const block = `${start}\n${incoming}\n${end}`;
let existing = fs.existsSync(existingPath) ? fs.readFileSync(existingPath, 'utf8') : '';
// Replace only the exact unmodified legacy harness; retain customized project rules.
const legacyHash = '22a0fbcd315576a52e3fb0a447766e9328982e51aac8da3e8a4bfe7954bd59c3';
if (require('node:crypto').createHash('sha256').update(existing).digest('hex') === legacyHash) existing = '';
const from = existing.indexOf(start);
const to = existing.indexOf(end);
let merged;
if (from === -1 && to === -1) {
  merged = existing + (existing ? '\n\n' : '') + block + '\n';
} else {
  if (from === -1 || to < from || existing.indexOf(start, from + start.length) !== -1 ||
      existing.indexOf(end, to + end.length) !== -1) {
    throw new Error('AGENTS.md has malformed BuildLite markers; repair them before reinstalling.');
  }
  merged = existing.slice(0, from) + block + existing.slice(to + end.length);
}
// Stage the merge before copying anything into the project.
fs.writeFileSync(sourcePath, merged);
'@
  & node -e $mergeInstructionsScript $AgentsFile $SourceAgentsFile
  if ($LASTEXITCODE -ne 0) { throw 'Could not preserve project instructions in AGENTS.md.' }
  foreach ($Item in Get-ChildItem -LiteralPath $SourceDirectory -Force) {
    Copy-Item -LiteralPath $Item.FullName -Destination $WorkingDirectory -Force -Recurse
  }
  if ($null -eq $OpenCodeItem) {
    $MklinkCommand = 'mklink /J "{0}" "{1}"' -f $OpenCodeDirectory, $AgentsDirectory
    & cmd.exe /d /c $MklinkCommand | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Could not create the .opencode directory junction.' }
  }

  $ConfigFile = Join-Path $WorkingDirectory 'opencode.json'
  if (Test-Path -LiteralPath $ConfigFile -PathType Leaf) {
    $SetDefaultAgent = $false
    if (-not [Console]::IsInputRedirected) {
      $answer = Read-Host 'Set Build_lite as the default OpenCode agent in opencode.json? [y/N]'
      $SetDefaultAgent = $answer -match '^(?i:y|yes)$'
    } else {
      Write-Host 'opencode.json exists; keeping its default agent because this is a non-interactive run.'
    }

    if ($SetDefaultAgent) {
      $ConfigTemporary = "$ConfigFile.tmp.$([Guid]::NewGuid().ToString('N'))"
      $defaultAgentScript = @'
const fs = require('node:fs');
const [configPath, outputPath] = process.argv.slice(1);
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
'@
      & node -e $defaultAgentScript $ConfigFile $ConfigTemporary
      if ($LASTEXITCODE -ne 0) { throw 'Could not update opencode.json.' }
      Move-Item -LiteralPath $ConfigTemporary -Destination $ConfigFile -Force
      $ConfigTemporary = $null
      Write-Host "Updated $ConfigFile with default_agent=build_lite."
    }
  }

  Remove-Item -LiteralPath $ArchiveFile -Force
  Write-Host "BuildLite harness installed in $WorkingDirectory."
  Write-Host 'Created or verified .opencode as a junction to .agents.'
} catch {
  [Console]::Error.WriteLine("Error: $($_.Exception.Message)")
  exit 1
} finally {
  if ($ConfigTemporary -and (Test-Path -LiteralPath $ConfigTemporary)) {
    Remove-Item -LiteralPath $ConfigTemporary -Force -ErrorAction SilentlyContinue
  }
  if (Test-Path -LiteralPath $DownloadTemporary) {
    Remove-Item -LiteralPath $DownloadTemporary -Force -ErrorAction SilentlyContinue
  }
  if (Test-Path -LiteralPath $ExtractDirectory) {
    Remove-Item -LiteralPath $ExtractDirectory -Recurse -Force -ErrorAction SilentlyContinue
  }
}
