[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$WorkingDirectory = (Get-Location).Path
$ArchiveFile = Join-Path $WorkingDirectory 'buildlite_harness.zip'
$DownloadUrl = '__IETI_BUILD_LITE_ZIP_URL__'
$DownloadTemporary = "$ArchiveFile.tmp.$([Guid]::NewGuid().ToString('N'))"
$ExtractDirectory = Join-Path ([System.IO.Path]::GetTempPath()) "ieti-buildlite-$([Guid]::NewGuid().ToString('N'))"

try {
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

  # Copy the archive contents, excluding its wrapper directory, into the project root.
  # This keeps .agents/ and AGENTS.md at the root instead of nesting them below
  # buildlite_harness/.
  foreach ($Item in Get-ChildItem -LiteralPath $SourceDirectory -Force) {
    Copy-Item -LiteralPath $Item.FullName -Destination $WorkingDirectory -Force -Recurse
  }

  $AgentsDirectory = Join-Path $WorkingDirectory '.agents'
  $AgentsFile = Join-Path $WorkingDirectory 'AGENTS.md'
  if (-not (Test-Path -LiteralPath $AgentsDirectory -PathType Container) -or
      -not (Test-Path -LiteralPath $AgentsFile -PathType Leaf)) {
    throw 'The BuildLite archive did not provide .agents/ and AGENTS.md at the project root.'
  }

  $OpenCodeDirectory = Join-Path $WorkingDirectory '.opencode'
  if (Test-Path -LiteralPath $OpenCodeDirectory) {
    $OpenCodeItem = Get-Item -LiteralPath $OpenCodeDirectory -Force
    if (-not ($OpenCodeItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
      throw '.opencode already exists and is not a directory junction to .agents. Move it before retrying.'
    }
    $ResolvedOpenCode = (Resolve-Path -LiteralPath $OpenCodeDirectory).Path
    $ResolvedAgents = (Resolve-Path -LiteralPath $AgentsDirectory).Path
    if ($ResolvedOpenCode -ne $ResolvedAgents) {
      throw '.opencode already exists but does not point to .agents.'
    }
  } else {
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
      $TemporaryFiles.Remove($ConfigTemporary) | Out-Null
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
  if (Test-Path -LiteralPath $DownloadTemporary) {
    Remove-Item -LiteralPath $DownloadTemporary -Force -ErrorAction SilentlyContinue
  }
  if (Test-Path -LiteralPath $ExtractDirectory) {
    Remove-Item -LiteralPath $ExtractDirectory -Recurse -Force -ErrorAction SilentlyContinue
  }
}
