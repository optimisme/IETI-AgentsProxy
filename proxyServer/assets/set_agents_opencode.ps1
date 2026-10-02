[CmdletBinding()]
param([switch]$SyncOnly, [switch]$Uninstall)

$ErrorActionPreference = 'Stop'
# Downloads replace this assignment with the server's public API URL.
$DefaultBaseUrl = '__IETI_DEFAULT_BASE_URL__'
$Utf8NoBom = [System.Text.UTF8Encoding]::new($false)
$Stages = [System.Collections.Generic.List[string]]::new()
$OnWindows = [System.Environment]::OSVersion.Platform -eq [System.PlatformID]::Win32NT

function New-Map {
  return ,([System.Collections.Specialized.OrderedDictionary]::new([System.StringComparer]::Ordinal))
}
function Convert-JsonValue {
  param($Value, [string]$StringPrefix = '')
  if ($Value -is [System.Management.Automation.PSCustomObject]) {
    $result = New-Map
    foreach ($property in $Value.PSObject.Properties) {
      $name = $property.Name
      if ($StringPrefix -and $name.StartsWith($StringPrefix, [StringComparison]::Ordinal)) { $name = $name.Substring($StringPrefix.Length) }
      $result[$name] = Convert-JsonValue $property.Value $StringPrefix
    }
    return ,$result
  }
  if ($Value -is [System.Array]) {
    $result = [object[]]::new($Value.Length)
    for ($index = 0; $index -lt $Value.Length; $index++) { $result[$index] = Convert-JsonValue $Value[$index] $StringPrefix }
    return ,$result
  }
  if ($StringPrefix -and $Value -is [string] -and $Value.StartsWith($StringPrefix, [StringComparison]::Ordinal)) { return $Value.Substring($StringPrefix.Length) }
  return ,$Value
}
function ConvertFrom-Jsonc {
  param([string]$Source)
  if ($Source.StartsWith([string][char]0xFEFF, [StringComparison]::Ordinal)) { $Source = $Source.Substring(1) }
  $clean = [System.Text.StringBuilder]::new()
  $quoted = $false; $escaped = $false
  for ($index = 0; $index -lt $Source.Length; $index++) {
    $character = $Source[$index]
    if ($quoted) {
      $null = $clean.Append($character)
      if ($escaped) { $escaped = $false }
      elseif ($character -eq '\') { $escaped = $true }
      elseif ($character -eq '"') { $quoted = $false }
      continue
    }
    if ($character -eq '"') { $quoted = $true; $null = $clean.Append($character) }
    elseif ($character -eq '/' -and $index + 1 -lt $Source.Length -and $Source[$index + 1] -eq '/') {
      $null = $clean.Append('  '); $index += 2
      while ($index -lt $Source.Length -and $Source[$index] -notin @("`r", "`n")) { $null = $clean.Append(' '); $index++ }
      if ($index -lt $Source.Length) { $null = $clean.Append($Source[$index]) }
    } elseif ($character -eq '/' -and $index + 1 -lt $Source.Length -and $Source[$index + 1] -eq '*') {
      $null = $clean.Append('  '); $index += 2
      while ($index -lt $Source.Length -and -not ($Source[$index] -eq '*' -and $index + 1 -lt $Source.Length -and $Source[$index + 1] -eq '/')) {
        if ($Source[$index] -in @("`r", "`n")) { $null = $clean.Append($Source[$index]) }
        else { $null = $clean.Append(' ') }
        $index++
      }
      if ($index -ge $Source.Length) { throw 'Unterminated JSON comment.' }
      $null = $clean.Append('  '); $index++
    } else { $null = $clean.Append($character) }
  }
  $text = $clean.ToString(); $json = [System.Text.StringBuilder]::new()
  $supportsStringDates = (Get-Command ConvertFrom-Json).Parameters.ContainsKey('DateKind')
  $stringPrefix = ''
  # Older native parsers recognize timestamp strings. Prefix JSON strings during
  # parsing, then remove that prefix from decoded keys/values to preserve them.
  if (-not $supportsStringDates) { $stringPrefix = 'ieti-json-' + [Guid]::NewGuid().ToString('N') + ':' }
  $quoted = $false; $escaped = $false
  for ($index = 0; $index -lt $text.Length; $index++) {
    $character = $text[$index]
    if ($quoted) {
      $null = $json.Append($character)
      if ($escaped) { $escaped = $false }
      elseif ($character -eq '\') { $escaped = $true }
      elseif ($character -eq '"') { $quoted = $false }
    } elseif ($character -eq '"') {
      $quoted = $true; $null = $json.Append($character)
      if ($stringPrefix) { $null = $json.Append($stringPrefix) }
    }
    elseif ($character -eq ',') {
      $next = $index + 1
      while ($next -lt $text.Length -and [char]::IsWhiteSpace($text[$next])) { $next++ }
      if ($next -ge $text.Length -or $text[$next] -notin @('}', ']')) { $null = $json.Append($character) }
    } else { $null = $json.Append($character) }
  }
  $parseOptions = @{ InputObject = $json.ToString() }
  if ($supportsStringDates) { $parseOptions.DateKind = 'String' }
  $parsed = ConvertFrom-Json @parseOptions
  return ,(Convert-JsonValue $parsed $stringPrefix)
}
function ConvertTo-Bytes {
  param($Value)
  $json = ConvertTo-Json -InputObject $Value -Depth 100
  return ,$Utf8NoBom.GetBytes("$json`n")
}
function Get-Snapshot {
  param([string]$Path)
  if (-not [System.IO.File]::Exists($Path)) {
    if ([System.IO.Directory]::Exists($Path)) { throw "Expected a file at $Path." }
    return @{ Exists = $false; Bytes = $null }
  }
  $snapshot = @{ Exists = $true; Bytes = [System.IO.File]::ReadAllBytes($Path) }
  if ($OnWindows) { $snapshot.Acl = Get-Acl -LiteralPath $Path }
  elseif ($script:UnixModeGetter) { $snapshot.Mode = $script:UnixModeGetter.Invoke($null, @($Path)) }
  return $snapshot
}
function Test-BytesEqual {
  param([byte[]]$Left, [byte[]]$Right)
  if ($null -eq $Left -or $null -eq $Right) { return $null -eq $Left -and $null -eq $Right }
  if ($Left.Length -ne $Right.Length) { return $false }
  for ($index = 0; $index -lt $Left.Length; $index++) { if ($Left[$index] -ne $Right[$index]) { return $false } }
  return $true
}
function Test-SnapshotEqual {
  param($Left, $Right)
  return $Left.Exists -eq $Right.Exists -and (-not $Left.Exists -or (Test-BytesEqual $Left.Bytes $Right.Bytes))
}
function Protect-LocalFile {
  param([string]$Path)
  if ($OnWindows) {
    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
    $acl = Get-Acl -LiteralPath $Path
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($rule in @($acl.Access)) { $null = $acl.RemoveAccessRuleAll($rule) }
    if ([System.IO.Directory]::Exists($Path)) {
      $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
        $identity, [System.Security.AccessControl.FileSystemRights]::FullControl,
        ([System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit),
        [System.Security.AccessControl.PropagationFlags]::None, [System.Security.AccessControl.AccessControlType]::Allow
      )
    } else {
      $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
        $identity, [System.Security.AccessControl.FileSystemRights]::FullControl, [System.Security.AccessControl.AccessControlType]::Allow
      )
    }
    $acl.AddAccessRule($rule)
    Set-Acl -LiteralPath $Path -AclObject $acl
  } else {
    $mode = 384
    if ([System.IO.Directory]::Exists($Path)) { $mode = 448 }
    if ($script:UnixModeSetter) {
      $typedMode = [System.Enum]::ToObject($script:UnixModeType, $mode)
      $null = $script:UnixModeSetter.Invoke($null, @($Path, $typedMode))
    } elseif ([IetiNativePermissions]::chmod($Path, $mode) -ne 0) { throw "Could not restrict permissions for $Path." }
  }
}
function New-ProtectedFile {
  param([string]$Destination, [byte[]]$Bytes)
  $path = "$Destination.tmp.$([Guid]::NewGuid().ToString('N'))"
  $stream = [System.IO.File]::Open($path, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write)
  $stream.Dispose()
  $Stages.Add($path)
  Protect-LocalFile $path
  [System.IO.File]::WriteAllBytes($path, $Bytes)
  return $path
}
function Move-StagedFile {
  param([string]$Stage, [string]$Destination)
  if ([System.IO.File]::Exists($Destination)) { [System.IO.File]::Replace($Stage, $Destination, [NullString]::Value) }
  else { [System.IO.File]::Move($Stage, $Destination) }
}
function Restore-Snapshot {
  param([string]$Destination, $Snapshot)
  if (-not $Snapshot.Exists) {
    if ([System.IO.File]::Exists($Destination)) { [System.IO.File]::Delete($Destination) }
    return
  }
  $stage = New-ProtectedFile $Destination $Snapshot.Bytes
  Move-StagedFile $stage $Destination
  if ($OnWindows) { Set-Acl -LiteralPath $Destination -AclObject $Snapshot.Acl }
  elseif ($script:UnixModeSetter -and $null -ne $Snapshot.Mode) {
    $null = $script:UnixModeSetter.Invoke($null, @($Destination, $Snapshot.Mode))
  }
}
function Test-ConfigFiles {
  if ([System.IO.File]::Exists($JsonFile) -and [System.IO.File]::Exists($JsoncFile)) {
    throw "Both $JsonFile and $JsoncFile exist. Consolidate them before running setup."
  }
}
function Assert-OriginalFiles {
  Test-ConfigFiles
  if (-not (Test-SnapshotEqual (Get-Snapshot $ConfigFile) $OriginalConfig) -or
      -not (Test-SnapshotEqual (Get-Snapshot $KeyFile) $OriginalKey)) {
    throw 'Configuration or API key changed during setup. Run the installer again.'
  }
}
function Commit-Changes {
  param([byte[]]$ConfigBytes, [byte[]]$KeyBytes, [bool]$Removing)
  Assert-OriginalFiles
  $configChanged = (-not $Removing -or $OriginalConfig.Exists) -and (-not $OriginalConfig.Exists -or -not (Test-BytesEqual $OriginalConfig.Bytes $ConfigBytes))
  # A new protected key stage also tightens permissions when reusing a saved key.
  $keyChanged = -not $Removing -or $OriginalKey.Exists
  $backupPath = "$ConfigFile.bak"
  $originalBackup = $null
  $configStage = $null; $keyStage = $null; $backupStage = $null; $keyRollback = $null
  if ($configChanged) {
    [System.IO.Directory]::CreateDirectory($ConfigDirectory) | Out-Null
    $configStage = New-ProtectedFile $ConfigFile $ConfigBytes
    if ($OriginalConfig.Exists) {
      $originalBackup = Get-Snapshot $backupPath
      $backupStage = New-ProtectedFile $backupPath $OriginalConfig.Bytes
    }
  }
  if ($keyChanged -and -not $Removing) {
    [System.IO.Directory]::CreateDirectory($SecretsDirectory) | Out-Null
    Protect-LocalFile $SecretsDirectory
    $keyStage = New-ProtectedFile $KeyFile $KeyBytes
  }
  Assert-OriginalFiles
  if ($originalBackup -and -not (Test-SnapshotEqual (Get-Snapshot $backupPath) $originalBackup)) { throw 'Configuration backup changed during setup. Run the installer again.' }
  $backupWritten = $false; $keyMoved = $false; $keyWritten = $false; $configWritten = $false
  try {
    if ($backupStage) { Move-StagedFile $backupStage $backupPath; $backupWritten = $true; Protect-LocalFile $backupPath }
    if ($keyChanged) {
      if ($OriginalKey.Exists) {
        $keyRollback = "$KeyFile.tmp.rollback.$([Guid]::NewGuid().ToString('N'))"
        [System.IO.File]::Move($KeyFile, $keyRollback); $keyMoved = $true
      }
      if (-not $Removing) { [System.IO.File]::Move($keyStage, $KeyFile); $keyWritten = $true }
    }
    if ($configStage) { Move-StagedFile $configStage $ConfigFile; $configWritten = $true; Protect-LocalFile $ConfigFile }
    if ($keyRollback) { [System.IO.File]::Delete($keyRollback); $keyRollback = $null }
  } catch {
    $failure = $_.Exception.Message
    try {
      if ($configWritten) { Restore-Snapshot $ConfigFile $OriginalConfig }
      if ($keyMoved) {
        if ([System.IO.File]::Exists($KeyFile)) { [System.IO.File]::Delete($KeyFile) }
        [System.IO.File]::Move($keyRollback, $KeyFile)
      } elseif ($keyWritten) { [System.IO.File]::Delete($KeyFile) }
      if ($backupWritten) { Restore-Snapshot $backupPath $originalBackup }
    } catch { throw "$failure Rollback failed: $($_.Exception.Message). Original key recovery path: $keyRollback" }
    throw $failure
  }
}
function Get-NormalizedUrl {
  param([string]$Value)
  $parsed = $null
  if (-not [Uri]::TryCreate($Value.Trim(), [UriKind]::Absolute, [ref]$parsed) -or
      $parsed.Scheme -notin @('http', 'https') -or $parsed.UserInfo -or $parsed.Query -or $parsed.Fragment) {
    throw 'Base URL must be HTTP(S), without credentials, query, or fragment.'
  }
  $builder = [UriBuilder]::new($parsed)
  $builder.Path = $builder.Path.TrimEnd('/')
  if (-not $builder.Path.EndsWith('/v1', [StringComparison]::Ordinal)) { $builder.Path += '/v1' }
  return $builder.Uri.AbsoluteUri.TrimEnd('/')
}
function Get-ModelCatalog {
  param([string]$ApiKey)
  $handlerType = [System.Net.Http.HttpClient].Assembly.GetType('System.Net.Http.SocketsHttpHandler')
  if ($handlerType) {
    $handler = [Activator]::CreateInstance($handlerType)
    $handler.ConnectTimeout = [TimeSpan]::FromSeconds([Math]::Min(10, $TimeoutSeconds))
  } else { $handler = [System.Net.Http.HttpClientHandler]::new() }
  $handler.AllowAutoRedirect = $false
  $client = [System.Net.Http.HttpClient]::new($handler)
  $client.Timeout = [TimeSpan]::FromSeconds($TimeoutSeconds)
  $client.MaxResponseContentBufferSize = 16 * 1024 * 1024
  $request = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::Get, "$ApiBaseUrl/model-capabilities")
  $request.Headers.Authorization = [System.Net.Http.Headers.AuthenticationHeaderValue]::new('Bearer', $ApiKey)
  $request.Headers.Accept.ParseAdd('application/json')
  $response = $null
  try {
    $response = $client.SendAsync($request).GetAwaiter().GetResult()
    $body = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
    $status = [int]$response.StatusCode
    if ($status -eq 401) { return @{ InvalidKey = $true } }
    if ($status -ne 200) {
      $message = 'the server rejected the request'
      try {
        $errorBody = ConvertFrom-Json -InputObject $body
        if ($errorBody.error.message) { $message = [string]$errorBody.error.message }
        elseif ($errorBody.message) { $message = [string]$errorBody.message }
      } catch {}
      $message = [regex]::Replace($message, 'ieti_sk_[A-Za-z0-9_-]+', '[redacted key]')
      if ($status -eq 403) { throw "IETI account or group access is unavailable (HTTP 403): $message" }
      throw "IETI server rejected model discovery (HTTP $status): $message"
    }
    try { $catalog = Convert-JsonValue (ConvertFrom-Json -InputObject $body) }
    catch { throw 'The server returned an invalid model catalog.' }
    return @{ Catalog = $catalog; InvalidKey = $false }
  } catch {
    if ($_.Exception.Message -match 'HTTP \d+|model catalog') { throw }
    throw 'Could not connect to the IETI server, or the request timed out. Existing configuration was kept.'
  } finally {
    if ($response) { $response.Dispose() }
    $request.Dispose(); $client.Dispose(); $handler.Dispose()
  }
}
function Convert-CatalogModels {
  param($Catalog)
  if ($Catalog -isnot [System.Collections.IDictionary] -or $Catalog['object'] -cne 'ieti.model_capabilities.list' -or
      $Catalog['schema_version'] -ne 1 -or $Catalog['data'] -isnot [System.Array] -or $Catalog['data'].Length -eq 0) {
    throw 'The authenticated server returned no available models.'
  }
  $models = New-Map
  $efforts = @('none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max')
  foreach ($published in $Catalog['data']) {
    if ($published -isnot [System.Collections.IDictionary]) { throw 'Model metadata is incomplete.' }
    $id = ([string]$published['id']).Trim()
    $context = 0.0; $output = 0.0
    $numberStyle = [System.Globalization.NumberStyles]::Float
    $culture = [System.Globalization.CultureInfo]::InvariantCulture
    if (-not $id -or $models.Contains($id) -or
        -not [double]::TryParse([string]$published['context_window'], $numberStyle, $culture, [ref]$context) -or
        -not [double]::TryParse([string]$published['max_output_tokens'], $numberStyle, $culture, [ref]$output) -or
        [double]::IsNaN($context) -or [double]::IsInfinity($context) -or $context -le 0 -or
        [double]::IsNaN($output) -or [double]::IsInfinity($output) -or $output -le 0) { throw "Model metadata is incomplete or duplicated for $id." }
    $capabilities = $published['capabilities']
    if ($capabilities -isnot [System.Collections.IDictionary]) { throw "Model capabilities are incomplete for $id." }
    foreach ($name in @('text', 'image', 'tools', 'reasoning', 'parallel_tools')) {
      if ($capabilities[$name] -isnot [bool]) { throw "Model capabilities are incomplete for $id." }
    }
    $inputModalities = @()
    if ($published['modalities'] -is [System.Collections.IDictionary] -and $published['modalities']['input'] -is [System.Array]) {
      $inputModalities = @($published['modalities']['input'] | Where-Object { $_ -cin @('text', 'audio', 'image', 'video', 'pdf') })
    } else {
      if ($capabilities['text']) { $inputModalities += 'text' }
      if ($capabilities['image']) { $inputModalities += 'image' }
    }
    $publishedEfforts = @()
    if ($published['reasoning_efforts'] -is [System.Array]) { $publishedEfforts = $published['reasoning_efforts'] }
    $supportedEfforts = @(); $variants = New-Map
    if ($capabilities['reasoning']) {
      $supportedEfforts = @($efforts | Where-Object { $_ -cin $publishedEfforts })
      foreach ($effort in $efforts) {
        if ($effort -cin $supportedEfforts) { $variants[$effort] = [ordered]@{ reasoningEffort = $effort } }
        else { $variants[$effort] = [ordered]@{ disabled = $true } }
      }
    }
    $model = [ordered]@{
      limit = [ordered]@{ context = $context; output = $output }
      tool_call = $capabilities['tools']; reasoning = $capabilities['reasoning']
    }
    if ($capabilities['reasoning']) { $model['interleaved'] = [ordered]@{ field = 'reasoning_content' } }
    $model['modalities'] = [ordered]@{ input = [object[]]$inputModalities; output = [object[]]@('text') }
    $model['variants'] = $variants
    if ($capabilities['reasoning'] -and $published['default_reasoning_effort'] -cin $supportedEfforts) {
      $model['options'] = [ordered]@{ reasoningEffort = $published['default_reasoning_effort'] }
    }
    $models[$id] = $model
  }
  return ,$models
}
function Test-ApiKey {
  if ($script:IetiApiKey -cnotmatch '^ieti_sk_[A-Za-z0-9_-]+$') { [Console]::Error.WriteLine('Error: invalid API key format; expected an ieti_sk_ key.'); return 1 }
  try {
    $result = Get-ModelCatalog $script:IetiApiKey
    if ($result.InvalidKey) { [Console]::Error.WriteLine('Error: invalid API key (HTTP 401).'); return 1 }
    $script:Models = Convert-CatalogModels $result.Catalog
  } catch { [Console]::Error.WriteLine("Error: $($_.Exception.Message)"); return 2 }
  return 0
}
function Read-NewKey {
  if (-not $Interactive) { throw "No valid saved API key at $KeyFile. Run interactively or set PROXY_AGENTS_KEY." }
  while ($true) {
    $secureKey = Read-Host 'Paste your IETI Agents API key' -AsSecureString
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)
    try { $script:IetiApiKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
    $status = Test-ApiKey
    if ($status -eq 0) { return }
    if ($status -ne 1) { throw 'Could not validate the API key and model catalog. Existing configuration was kept.' }
    [Console]::Error.WriteLine('The API key is invalid. Paste a valid ieti_sk_ key, or cancel with Ctrl+C.')
  }
}

try {
  $script:UnixModeSetter = $null; $script:UnixModeGetter = $null; $script:UnixModeType = $null
  if (-not $OnWindows) {
    $script:UnixModeType = [System.IO.File].Assembly.GetType('System.IO.UnixFileMode')
    if ($script:UnixModeType) {
      $script:UnixModeSetter = [System.IO.File].GetMethod('SetUnixFileMode', [type[]]@([string], $script:UnixModeType))
      $script:UnixModeGetter = [System.IO.File].GetMethod('GetUnixFileMode', [type[]]@([string]))
    }
    if (-not $script:UnixModeSetter) {
      Add-Type -TypeDefinition @'
using System.Runtime.InteropServices;
public static class IetiNativePermissions {
  [DllImport("libc", SetLastError = true)] public static extern int chmod(string path, uint mode);
}
'@
    }
  }
  $ConfigHome = $env:XDG_CONFIG_HOME
  if ([string]::IsNullOrWhiteSpace($ConfigHome)) { $ConfigHome = Join-Path $HOME '.config' }
  $ConfigHome = [System.IO.Path]::GetFullPath($ConfigHome)
  $ConfigDirectory = Join-Path $ConfigHome 'opencode'
  $JsonFile = Join-Path $ConfigDirectory 'opencode.json'
  $JsoncFile = Join-Path $ConfigDirectory 'opencode.jsonc'
  $ConfigFile = $JsonFile
  $SecretsDirectory = Join-Path $ConfigHome 'ieti-agents'
  $KeyFile = Join-Path $SecretsDirectory 'agents_server_key'
  Test-ConfigFiles
  if ([System.IO.File]::Exists($JsoncFile)) { $ConfigFile = $JsoncFile }
  # These exact bytes are used for parsing and for both commit conflict checks.
  $OriginalConfig = Get-Snapshot $ConfigFile
  $OriginalKey = Get-Snapshot $KeyFile
  $Config = New-Map
  if ($OriginalConfig.Exists) {
    try { $Config = ConvertFrom-Jsonc ($Utf8NoBom.GetString($OriginalConfig.Bytes)) }
    catch { throw "Cannot update ${ConfigFile}: $($_.Exception.Message)" }
    if ($Config -isnot [System.Collections.IDictionary]) { throw "Cannot update ${ConfigFile}: expected a JSON object." }
  }
  $Installed = $OriginalKey.Exists -or ($Config['provider'] -is [System.Collections.IDictionary] -and $Config['provider'].Contains('ieti-agents'))
  $Interactive = $false
  if (-not $SyncOnly) {
    try { $Interactive = -not [Console]::IsInputRedirected }
    catch { $Interactive = $Host.Name -eq 'ConsoleHost' }
  }
  if (-not $Uninstall -and $Installed -and $Interactive) {
    while ($true) {
      $answer = Read-Host 'IETI Agents is installed globally. Update or uninstall? [Update/uninstall]'
      if ([string]::IsNullOrEmpty($answer) -or $answer -in @('1', 'update')) { break }
      if ($answer -in @('2', 'uninstall')) { $Uninstall = $true; break }
      if ($answer -in @('cancel', 'q')) { Write-Host 'Setup cancelled. Existing configuration was kept.'; return }
      Write-Host 'Enter update, uninstall, or cancel.'
    }
  }
  if ($Uninstall) {
    $originalJson = ConvertTo-Json -InputObject $Config -Depth 100
    if ($Config['provider'] -is [System.Collections.IDictionary]) { $Config['provider'].Remove('ieti-agents') }
    foreach ($selection in @('model', 'small_model')) {
      if ($Config[$selection] -is [string] -and $Config[$selection].StartsWith('ieti-agents/', [StringComparison]::Ordinal)) { $Config.Remove($selection) }
    }
    if ($Config['agent'] -is [System.Collections.IDictionary]) {
      foreach ($agent in $Config['agent'].Values) {
        if ($agent -is [System.Collections.IDictionary] -and $agent['model'] -is [string] -and $agent['model'].StartsWith('ieti-agents/', [StringComparison]::Ordinal)) { $agent.Remove('model') }
      }
    }
    foreach ($selection in @('enabled_providers', 'disabled_providers')) {
      if ($Config[$selection] -is [System.Array]) { $Config[$selection] = [object[]]@($Config[$selection] | Where-Object { $_ -cne 'ieti-agents' }) }
    }
    $bytes = ConvertTo-Bytes $Config
    if ($OriginalConfig.Exists -and $originalJson -ceq (ConvertTo-Json -InputObject $Config -Depth 100)) { $bytes = $OriginalConfig.Bytes }
    Commit-Changes $bytes $null $true
    Write-Host "Removed IETI Agents from $ConfigFile and removed $KeyFile."
    return
  }
  Add-Type -AssemblyName System.Net.Http
  if ($OnWindows) { [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.ServicePointManager]::SecurityProtocol -bor [System.Net.SecurityProtocolType]::Tls12 }
  $TimeoutSeconds = 30
  if (-not [string]::IsNullOrWhiteSpace($env:PROXY_AGENTS_REQUEST_TIMEOUT_SECONDS)) {
    if (-not [int]::TryParse($env:PROXY_AGENTS_REQUEST_TIMEOUT_SECONDS, [ref]$TimeoutSeconds) -or $TimeoutSeconds -lt 1 -or $TimeoutSeconds -gt 30) { throw 'PROXY_AGENTS_REQUEST_TIMEOUT_SECONDS must be an integer from 1 to 30.' }
  }
  if ($DefaultBaseUrl -eq ('__IETI_' + 'DEFAULT_BASE_URL__')) { $DefaultBaseUrl = 'https://agents.ieti.site/v1' }
  $BaseUrl = $env:PROXY_AGENTS_BASE_URL
  if ([string]::IsNullOrWhiteSpace($BaseUrl)) { $BaseUrl = $DefaultBaseUrl }
  if ($Interactive) {
    $enteredUrl = Read-Host "IETI Agents base URL [$BaseUrl]"
    if (-not [string]::IsNullOrWhiteSpace($enteredUrl)) { $BaseUrl = $enteredUrl.Trim() }
  }
  $ApiBaseUrl = Get-NormalizedUrl $BaseUrl
  $script:IetiApiKey = $env:PROXY_AGENTS_KEY
  if (-not [string]::IsNullOrEmpty($script:IetiApiKey)) {
    if ((Test-ApiKey) -ne 0) { throw 'The supplied API key or model catalog could not be validated. Existing configuration was kept.' }
  } else {
    $savedValid = $false
    if ($OriginalKey.Exists) {
      $script:IetiApiKey = $Utf8NoBom.GetString($OriginalKey.Bytes).Trim()
      $status = Test-ApiKey
      if ($status -eq 0) { $savedValid = $true }
      elseif ($status -ne 1) { throw 'Could not validate the saved key and model catalog. Existing configuration was kept.' }
      else { [Console]::Error.WriteLine('The saved API key is invalid.') }
    }
    if ($savedValid) {
      if ($Interactive) {
        while ($true) {
          $answer = Read-Host 'Saved API key is valid. Keep or replace? [Keep/replace]'
          if ([string]::IsNullOrEmpty($answer) -or $answer -in @('1', 'keep')) { break }
          if ($answer -in @('2', 'replace')) { Read-NewKey; break }
          if ($answer -in @('cancel', 'q')) { Write-Host 'Setup cancelled. Existing configuration was kept.'; return }
          Write-Host 'Enter keep, replace, or cancel.'
        }
      }
    } else { Read-NewKey }
  }
  if (-not $Config['$schema']) { $Config['$schema'] = 'https://opencode.ai/config.json' }
  if ($Config['provider'] -isnot [System.Collections.IDictionary]) { $Config['provider'] = New-Map }
  $provider = $Config['provider']['ieti-agents']
  if ($provider -isnot [System.Collections.IDictionary]) { $provider = New-Map }
  $options = $provider['options']
  if ($options -isnot [System.Collections.IDictionary]) { $options = New-Map }
  $provider['npm'] = '@ai-sdk/openai-compatible'; $provider['name'] = 'IETI Agents'
  $options['baseURL'] = $ApiBaseUrl; $options['apiKey'] = '{file:' + $KeyFile.Replace('\', '/') + '}'
  $options['timeout'] = 900000; $options['chunkTimeout'] = 600000
  $provider['options'] = $options; $provider['models'] = $script:Models
  $Config['provider']['ieti-agents'] = $provider
  if ($Config['enabled_providers'] -is [System.Array] -and 'ieti-agents' -cnotin $Config['enabled_providers']) { $Config['enabled_providers'] += 'ieti-agents' }
  if ($Config['disabled_providers'] -is [System.Array]) { $Config['disabled_providers'] = [object[]]@($Config['disabled_providers'] | Where-Object { $_ -cne 'ieti-agents' }) }
  $selected = ''
  if ($Config['model'] -is [string]) { $selected = $Config['model'] }
  if (-not $selected -or ($selected.StartsWith('ieti-agents/', [StringComparison]::Ordinal) -and -not $script:Models.Contains($selected.Substring(12)))) {
    $Config['model'] = 'ieti-agents/' + @($script:Models.Keys)[0]
  }
  Commit-Changes (ConvertTo-Bytes $Config) ($Utf8NoBom.GetBytes("$script:IetiApiKey`n")) $false
  Write-Host "IETI API key validated. Updated global $ConfigFile with $($script:Models.Count) available model(s)."
  Write-Host "API key stored at $KeyFile. Restart OpenCode to load the configuration."
} catch {
  [Console]::Error.WriteLine("Error: $($_.Exception.Message)")
  exit 1
} finally {
  foreach ($stage in $Stages) {
    if ([System.IO.File]::Exists($stage)) { [System.IO.File]::Delete($stage) }
  }
}
