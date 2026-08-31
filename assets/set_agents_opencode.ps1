[CmdletBinding()]
param([switch]$SyncOnly)

$ErrorActionPreference = 'Stop'
$WorkingDirectory = (Get-Location).Path
$ConfigFile = Join-Path $WorkingDirectory 'opencode.json'
$SecretsDirectory = Join-Path $WorkingDirectory '.secrets'
$KeyFile = Join-Path $SecretsDirectory 'agents_server_key'
$DefaultBaseUrl = '__IETI_DEFAULT_BASE_URL__'
$TemporaryFiles = [System.Collections.Generic.List[string]]::new()
$Utf8NoBom = [System.Text.UTF8Encoding]::new($false)

function Protect-LocalFile {
  param([Parameter(Mandatory = $true)][string]$Path)

  if ($env:OS -eq 'Windows_NT') {
    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
    $acl = Get-Acl -LiteralPath $Path
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($rule in @($acl.Access)) { $null = $acl.RemoveAccessRuleAll($rule) }
    $accessRule = [System.Security.AccessControl.FileSystemAccessRule]::new(
      $identity,
      [System.Security.AccessControl.FileSystemRights]::FullControl,
      [System.Security.AccessControl.AccessControlType]::Allow
    )
    $acl.AddAccessRule($accessRule)
    Set-Acl -LiteralPath $Path -AclObject $acl
  } elseif (Get-Command chmod -ErrorAction SilentlyContinue) {
    & chmod 600 $Path
    if ($LASTEXITCODE -ne 0) { throw "Could not restrict permissions for $Path." }
  }
}

function New-AdjacentTemporaryFile {
  param([Parameter(Mandatory = $true)][string]$Destination)
  $path = "$Destination.tmp.$([Guid]::NewGuid().ToString('N'))"
  $TemporaryFiles.Add($path)
  return $path
}

function Read-ConfigBaseUrl {
  if (-not (Test-Path -LiteralPath $ConfigFile -PathType Leaf)) { return $null }
  $readScript = @'
const fs = require('node:fs');
const [configPath] = process.argv.slice(1);
try {
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const baseURL = config?.provider?.['ieti-agents']?.options?.baseURL;
  if (typeof baseURL !== 'string' || !baseURL.trim()) process.exit(1);
  process.stdout.write(baseURL.trim());
} catch {
  process.exit(1);
}
'@
  $value = & node -e $readScript $ConfigFile
  if ($LASTEXITCODE -ne 0) { return $null }
  return ([string]$value).Trim()
}

try {
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw 'Required command was not found: node'
  }

  $BaseUrl = $env:PROXY_AGENTS_BASE_URL
  if ([string]::IsNullOrWhiteSpace($BaseUrl)) {
    $BaseUrl = Read-ConfigBaseUrl
  }
  if ([string]::IsNullOrWhiteSpace($BaseUrl)) {
    if ($DefaultBaseUrl -eq '__IETI_DEFAULT_BASE_URL__') {
      $DefaultBaseUrl = 'https://agents.ieti.site/v1'
    }
    $enteredUrl = Read-Host "IETI Agents base URL [$DefaultBaseUrl]"
    $BaseUrl = if ([string]::IsNullOrWhiteSpace($enteredUrl)) { $DefaultBaseUrl } else { $enteredUrl.Trim() }
  }

  $parsedUrl = $null
  if (-not [Uri]::TryCreate($BaseUrl, [UriKind]::Absolute, [ref]$parsedUrl) -or
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

  $CreateKeyFile = $false
  if (-not (Test-Path -LiteralPath $KeyFile)) {
    $CreateKeyFile = $true
    $secureKey = Read-Host 'Paste your IETI Agents API key' -AsSecureString
    $keyPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)
    try { $IetiApiKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($keyPointer) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($keyPointer) }
  } else {
    $IetiApiKey = ([System.IO.File]::ReadAllText($KeyFile)).Trim()
  }
  if ($IetiApiKey -notmatch '^ieti_sk_[A-Za-z0-9_-]+$') {
    throw 'The API key must start with ieti_sk_ and contain only letters, numbers, underscores, or hyphens.'
  }

  $capabilitiesPath = [System.IO.Path]::GetTempFileName()
  $TemporaryFiles.Add($capabilitiesPath)
  try {
    Invoke-WebRequest -UseBasicParsing -Uri "$ApiBaseUrl/model-capabilities" -OutFile $capabilitiesPath -TimeoutSec 60 -Headers @{
      Authorization = "Bearer $IetiApiKey"
      Accept = 'application/json'
    }
  } catch {
    $statusCode = [int]$_.Exception.Response.StatusCode
    $message = 'the server rejected the request'
    try {
      $body = [System.IO.StreamReader]::new($_.Exception.Response.GetResponseStream()).ReadToEnd() | ConvertFrom-Json
      if ($body.error.message) { $message = $body.error.message }
    } catch {}
    throw "IETI API key validation failed (HTTP $statusCode): $message"
  }

  $configTemporary = New-AdjacentTemporaryFile $ConfigFile
  $mergeScript = @'
const fs = require('node:fs');
const [configPath, capabilitiesPath, outputPath, baseURL] = process.argv.slice(1);
let config = {};
if (fs.existsSync(configPath)) {
  try { config = JSON.parse(fs.readFileSync(configPath, 'utf8')); }
  catch (error) { throw new Error(`Cannot update ${configPath}: ${error.message}`); }
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
  const capabilities = published?.capabilities || {};
  if (!id || !Number.isFinite(context) || context <= 0 || !Number.isFinite(output) || output <= 0) {
    throw new Error(`Model metadata is incomplete for ${id || '<unknown model>'}.`);
  }
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
config.provider = config.provider && typeof config.provider === 'object' && !Array.isArray(config.provider) ? config.provider : {};
const existing = config.provider['ieti-agents'];
const provider = existing && typeof existing === 'object' && !Array.isArray(existing) ? existing : {};
const existingOptions = provider.options && typeof provider.options === 'object' && !Array.isArray(provider.options) ? provider.options : {};
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
fs.writeFileSync(outputPath, `${JSON.stringify(config, null, 2)}\n`);
'@

  & node -e $mergeScript $ConfigFile $capabilitiesPath $configTemporary $ApiBaseUrl
  if ($LASTEXITCODE -ne 0) { throw 'Could not generate the OpenCode configuration.' }
  Protect-LocalFile $configTemporary

  if ($CreateKeyFile) {
    [System.IO.Directory]::CreateDirectory($SecretsDirectory) | Out-Null
    $keyTemporary = New-AdjacentTemporaryFile $KeyFile
    [System.IO.File]::WriteAllText($keyTemporary, "$IetiApiKey`n", $Utf8NoBom)
    Protect-LocalFile $keyTemporary
    Move-Item -LiteralPath $keyTemporary -Destination $KeyFile -Force
    $TemporaryFiles.Remove($keyTemporary) | Out-Null
  } else {
    Protect-LocalFile $KeyFile
  }

  Move-Item -LiteralPath $configTemporary -Destination $ConfigFile -Force
  $TemporaryFiles.Remove($configTemporary) | Out-Null

  Write-Host "IETI API key validated. Updated $ConfigFile."
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
