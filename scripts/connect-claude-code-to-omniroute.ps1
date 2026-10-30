# AI Management APP - make Claude Code (terminal, VS Code, Code tab of the Claude app) go through OmniRoute.
# Writes the "env" block of %USERPROFILE%\.claude\settings.json (other settings are kept; a .bak copy is made):
#   ANTHROPIC_BASE_URL = OmniRoute root (Claude Code appends /v1/messages)
#   ANTHROPIC_AUTH_TOKEN = your OmniRoute key (you paste it; it is checked against OmniRoute before saving)
#   CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY = 1 (OmniRoute's models in /model)
# Undo:  connect-claude-code-to-omniroute.cmd off
param([switch]$Off, [string]$BaseUrl = 'http://localhost:20128')
$ErrorActionPreference = 'Stop'
$dir = Join-Path $env:USERPROFILE '.claude'
$file = Join-Path $dir 'settings.json'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$json = if (Test-Path $file) { Get-Content $file -Raw | ConvertFrom-Json } else { $null }
if ($null -eq $json) { $json = [pscustomobject]@{} }
if (-not $json.PSObject.Properties['env']) { $json | Add-Member -NotePropertyName env -NotePropertyValue ([pscustomobject]@{}) }
$names = 'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY'
if ($Off) {
  foreach ($n in $names) { $json.env.PSObject.Properties.Remove($n) }
  Write-Host 'Claude Code goes to Anthropic again (your Claude account).'
} else {
  $sec = Read-Host 'Paste your OmniRoute API key (right-click to paste) and press Enter' -AsSecureString
  $key = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)).Trim()
  if (-not $key) { Write-Host 'No key entered: nothing changed.'; exit 1 }
  try {
    $r = Invoke-RestMethod -Uri "$BaseUrl/v1/models" -Headers @{ Authorization = "Bearer $key" } -TimeoutSec 10
    Write-Host ("OmniRoute accepted the key: {0} models available." -f @($r.data).Count)
  } catch {
    Write-Host "OmniRoute did not accept the key, or is not running at $BaseUrl : $($_.Exception.Message)"
    Write-Host 'Nothing changed.'; exit 1
  }
  $vals = @{ ANTHROPIC_BASE_URL = $BaseUrl; ANTHROPIC_AUTH_TOKEN = $key; CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY = '1' }
  foreach ($n in $names) { $json.env | Add-Member -NotePropertyName $n -NotePropertyValue $vals[$n] -Force }
  Write-Host 'Claude Code now goes through OmniRoute. Restart the Claude app and any Claude Code window.'
}
if (Test-Path $file) { Copy-Item $file "$file.bak" -Force }
# UTF-8 without BOM (Claude Code reads plain JSON).
[IO.File]::WriteAllText($file, ($json | ConvertTo-Json -Depth 20), (New-Object Text.UTF8Encoding $false))
Write-Host "Saved: $file"
