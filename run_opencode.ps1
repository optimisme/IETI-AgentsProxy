[CmdletBinding()]
param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$OpenCodeArguments
)

$ErrorActionPreference = 'Stop'
$ScriptDirectory = $PSScriptRoot
$SettingsFile = Join-Path $ScriptDirectory 'run_opencode_settings.env'
$ConfigFile = Join-Path $ScriptDirectory 'opencode.json'
$ModelsDirectory = Join-Path $ScriptDirectory '.opencode'
$ModelsFile = Join-Path $ModelsDirectory 'ieti-models.json'
$CreateSettingsFile = -not (Test-Path -LiteralPath $SettingsFile)
$TemporaryFiles = [System.Collections.Generic.List[string]]::new()
$Utf8NoBom = [System.Text.UTF8Encoding]::new($false)

function Read-MaskedValue {
  param([Parameter(Mandatory = $true)][string]$Prompt)

  Write-Host -NoNewline $Prompt
  $value = [System.Text.StringBuilder]::new()
  while ($true) {
    $key = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown')
    if ($key.VirtualKeyCode -eq 13) {
      break
    }
    if ($key.VirtualKeyCode -eq 8) {
      if ($value.Length -gt 0) {
        $null = $value.Remove($value.Length - 1, 1)
        Write-Host -NoNewline "`b `b"
      }
      continue
    }
    if (-not [char]::IsControl($key.Character)) {
      $null = $value.Append($key.Character)
      Write-Host -NoNewline '*'
    }
  }
  Write-Host
  return $value.ToString()
}

function Import-ProxySettings {
  param([Parameter(Mandatory = $true)][string]$Path)

  foreach ($line in [System.IO.File]::ReadAllLines($Path)) {
    if ($line -notmatch '^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$') {
      continue
    }
    $name = $Matches[1]
    $value = $Matches[2].Trim()
    if ($value.Length -ge 2 -and (($value[0] -eq '"' -and $value[-1] -eq '"') -or ($value[0] -eq "'" -and $value[-1] -eq "'"))) {
      $value = $value.Substring(1, $value.Length - 2)
    }
    [System.Environment]::SetEnvironmentVariable($name, $value, 'Process')
  }
}

function Protect-LocalFile {
  param([Parameter(Mandatory = $true)][string]$Path)

  if ($env:OS -eq 'Windows_NT') {
    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
    $acl = Get-Acl -LiteralPath $Path
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($rule in @($acl.Access)) {
      $null = $acl.RemoveAccessRuleAll($rule)
    }
    $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
      $identity,
      [System.Security.AccessControl.FileSystemRights]::FullControl,
      [System.Security.AccessControl.AccessControlType]::Allow
    )
    $acl.AddAccessRule($rule)
    Set-Acl -LiteralPath $Path -AclObject $acl
  } elseif (Get-Command chmod -ErrorAction SilentlyContinue) {
    & chmod 600 $Path
    if ($LASTEXITCODE -ne 0) {
      throw "Could not restrict permissions for $Path."
    }
  }
}

function New-AdjacentTemporaryFile {
  param([Parameter(Mandatory = $true)][string]$Destination)
  return "$Destination.tmp.$([Guid]::NewGuid().ToString('N'))"
}

try {
  Set-Location -LiteralPath $ScriptDirectory

  if ($CreateSettingsFile) {
    Write-Host 'run_opencode_settings.env was not found.'
    if ([string]::IsNullOrWhiteSpace($env:PROXY_AGENTS_BASE_URL)) {
      $enteredUrl = Read-Host 'IETI Agents base URL [https://agents.ieti.site/v1]'
      $env:PROXY_AGENTS_BASE_URL = if ([string]::IsNullOrWhiteSpace($enteredUrl)) {
        'https://agents.ieti.site/v1'
      } else {
        $enteredUrl.Trim()
      }
    }
    if ([string]::IsNullOrWhiteSpace($env:PROXY_AGENTS_KEY)) {
      $env:PROXY_AGENTS_KEY = Read-MaskedValue 'Paste your IETI Agents API key: '
    }
  } else {
    Protect-LocalFile $SettingsFile
    Import-ProxySettings $SettingsFile
  }

  if ([string]::IsNullOrWhiteSpace($env:PROXY_AGENTS_BASE_URL)) {
    throw 'PROXY_AGENTS_BASE_URL is not defined in run_opencode_settings.env.'
  }
  if ([string]::IsNullOrWhiteSpace($env:PROXY_AGENTS_KEY)) {
    throw 'PROXY_AGENTS_KEY is not defined in run_opencode_settings.env.'
  }
  if ($env:PROXY_AGENTS_KEY -notmatch '^ieti_sk_[A-Za-z0-9_-]+$') {
    throw 'The API key must start with ieti_sk_ and contain only letters, numbers, underscores, or hyphens.'
  }
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw 'Required command was not found: node'
  }

  $parsedUrl = $null
  if (-not [Uri]::TryCreate($env:PROXY_AGENTS_BASE_URL, [UriKind]::Absolute, [ref]$parsedUrl) -or
      $parsedUrl.Scheme -notin @('http', 'https') -or
      -not [string]::IsNullOrEmpty($parsedUrl.UserInfo) -or
      -not [string]::IsNullOrEmpty($parsedUrl.Query) -or
      -not [string]::IsNullOrEmpty($parsedUrl.Fragment)) {
    throw 'PROXY_AGENTS_BASE_URL must be a valid HTTP(S) base URL without credentials, query, or fragment.'
  }
  $urlBuilder = [UriBuilder]::new($parsedUrl)
  $urlBuilder.Path = $urlBuilder.Path.TrimEnd('/')
  if (-not $urlBuilder.Path.EndsWith('/v1', [StringComparison]::OrdinalIgnoreCase)) {
    $urlBuilder.Path += '/v1'
  }
  $ApiBaseUrl = $urlBuilder.Uri.AbsoluteUri.TrimEnd('/')

  $CapabilitiesTemporary = [System.IO.Path]::GetTempFileName()
  $TemporaryFiles.Add($CapabilitiesTemporary)
  $ModelsDevTemporary = [System.IO.Path]::GetTempFileName()
  $TemporaryFiles.Add($ModelsDevTemporary)

  $downloadScript = @'
const fs = require('node:fs');
const [url, output, token] = process.argv.slice(1);
(async () => {
  const headers = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(60000) });
  const body = await response.text();
  if (!response.ok) {
    let message = 'the server rejected the request';
    try {
      const parsed = JSON.parse(body);
      message = String(parsed?.error?.message || parsed?.message || message);
    } catch {}
    throw new Error(`HTTP ${response.status}: ${message}`);
  }
  fs.writeFileSync(output, body);
})().catch((error) => { console.error(error.message); process.exit(1); });
'@

  & node -e $downloadScript "$ApiBaseUrl/model-capabilities" $CapabilitiesTemporary $env:PROXY_AGENTS_KEY
  if ($LASTEXITCODE -ne 0) {
    throw 'PROXY_AGENTS_KEY is not valid or the model catalog is unavailable.'
  }

  $ModelsDevApiUrl = if ([string]::IsNullOrWhiteSpace($env:IETI_MODELS_DEV_API_URL)) {
    'https://models.dev/api.json'
  } else {
    $env:IETI_MODELS_DEV_API_URL
  }
  & node -e $downloadScript $ModelsDevApiUrl $ModelsDevTemporary ''
  if ($LASTEXITCODE -ne 0) {
    throw "Could not download the Models.dev catalog from $ModelsDevApiUrl."
  }

  [System.IO.Directory]::CreateDirectory($ModelsDirectory) | Out-Null
  $ConfigTemporary = New-AdjacentTemporaryFile $ConfigFile
  $TemporaryFiles.Add($ConfigTemporary)
  $ModelsTemporary = New-AdjacentTemporaryFile $ModelsFile
  $TemporaryFiles.Add($ModelsTemporary)

  $mergeScript = @'
const fs = require('node:fs');
const [configPath, capabilitiesPath, upstreamCatalogPath, configOutputPath, modelsOutputPath, baseURL] = process.argv.slice(1);
let config = {};
if (fs.existsSync(configPath)) {
  try { config = JSON.parse(fs.readFileSync(configPath, 'utf8')); }
  catch (error) { throw new Error(`Cannot update ${configPath}: ${error.message}`); }
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
    modalities: { input: inputModalities, output: ['text'] }
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
fs.writeFileSync(configOutputPath, `${JSON.stringify(config, null, 2)}\n`);
fs.writeFileSync(modelsOutputPath, `${JSON.stringify(modelsDevCatalog)}\n`);
'@

  & node -e $mergeScript $ConfigFile $CapabilitiesTemporary $ModelsDevTemporary $ConfigTemporary $ModelsTemporary $ApiBaseUrl
  if ($LASTEXITCODE -ne 0) {
    throw 'Could not generate the OpenCode configuration and model catalog.'
  }
  Protect-LocalFile $ConfigTemporary
  Protect-LocalFile $ModelsTemporary

  if ($CreateSettingsFile) {
    $SettingsTemporary = New-AdjacentTemporaryFile $SettingsFile
    $TemporaryFiles.Add($SettingsTemporary)
    $settingsContents = "PROXY_AGENTS_BASE_URL=$ApiBaseUrl`nPROXY_AGENTS_KEY=$($env:PROXY_AGENTS_KEY)`n"
    [System.IO.File]::WriteAllText($SettingsTemporary, $settingsContents, $Utf8NoBom)
    Protect-LocalFile $SettingsTemporary
    Move-Item -LiteralPath $SettingsTemporary -Destination $SettingsFile -Force
    $TemporaryFiles.Remove($SettingsTemporary) | Out-Null
    Write-Host "Created $SettingsFile with restricted permissions."
  }

  Move-Item -LiteralPath $ConfigTemporary -Destination $ConfigFile -Force
  $TemporaryFiles.Remove($ConfigTemporary) | Out-Null
  Move-Item -LiteralPath $ModelsTemporary -Destination $ModelsFile -Force
  $TemporaryFiles.Remove($ModelsTemporary) | Out-Null

  $modelCountScript = 'const c=require(process.argv[1]); process.stdout.write(String(Object.keys(c["ieti-agents"].models).length))'
  $ModelCount = & node -e $modelCountScript $ModelsFile
  if ($LASTEXITCODE -ne 0) {
    throw 'Could not read the generated model catalog.'
  }
  Write-Host "IETI API key validated. Updated $ConfigFile and $ModelsFile with $ModelCount available model(s)."

  if ($OpenCodeArguments.Count -gt 0 -and $OpenCodeArguments[0] -eq '--sync-only') {
    exit 0
  }

  $env:OPENCODE_MODELS_PATH = $ModelsFile

  if ($OpenCodeArguments.Count -gt 0 -and $OpenCodeArguments[0] -eq 'desktop') {
    $remainingArguments = @($OpenCodeArguments | Select-Object -Skip 1)
    $desktopCandidates = @(
      (Join-Path $env:LOCALAPPDATA 'Programs\OpenCode\OpenCode.exe'),
      (Join-Path $env:LOCALAPPDATA 'OpenCode\OpenCode.exe'),
      'opencode-desktop',
      'OpenCode'
    ) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
    foreach ($candidate in $desktopCandidates) {
      if ((Test-Path -LiteralPath $candidate) -or (Get-Command $candidate -ErrorAction SilentlyContinue)) {
        & $candidate @remainingArguments
        exit $LASTEXITCODE
      }
    }
    throw 'OpenCode desktop executable was not found.'
  }

  if (-not (Get-Command opencode -ErrorAction SilentlyContinue)) {
    throw 'OpenCode executable was not found.'
  }
  & opencode @OpenCodeArguments
  exit $LASTEXITCODE
} catch {
  [Console]::Error.WriteLine("Error: $($_.Exception.Message)")
  exit 1
} finally {
  foreach ($temporaryFile in $TemporaryFiles) {
    if (Test-Path -LiteralPath $temporaryFile) {
      Remove-Item -LiteralPath $temporaryFile -Force -ErrorAction SilentlyContinue
    }
  }
}
