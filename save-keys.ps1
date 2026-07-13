# Save API keys to ATLAS's encrypted vault — the REAL flow.
# Unlocks the vault, gets a session token, saves keys via /api/secrets/bulk,
# which triggers rebuildAtlas() so the new brain adapters go live immediately.
#
# Usage:
#   .\save-keys.ps1
# You'll be prompted for your master password and each key (nothing is stored
# in this file or on disk in plaintext).

$AtlasUrl = "http://localhost:4317"

Write-Host ""
Write-Host "=== ATLAS: Save keys to encrypted vault ==="
Write-Host ""

# 1. Master password (secure prompt — not echoed, not logged)
$secPw = Read-Host "Master password" -AsSecureString
$pw = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto(
  [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secPw))

# 2. Unlock → token
try {
  $unlock = Invoke-RestMethod -Uri "$AtlasUrl/api/unlock" -Method POST `
    -Body (@{ masterPassword = $pw } | ConvertTo-Json) -ContentType "application/json" -TimeoutSec 15
  $token = $unlock.token
  if (-not $token) { throw "no token returned" }
  Write-Host "[OK] Vault unlocked"
} catch {
  Write-Host "[ERROR] Unlock failed: $_"
  Write-Host "  (If the vault was never created, open $AtlasUrl and set a master password first.)"
  exit 1
}

# 3. Collect keys (secure prompts). Leave blank to skip a key.
$lines = @()
foreach ($k in @("GEMINI_API_KEY", "HUGGINGFACE_API_KEY", "GROQ_API_KEY")) {
  $secVal = Read-Host "$k (blank to skip)" -AsSecureString
  $val = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto(
    [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secVal))
  if ($val) { $lines += "$k=$val" }
}

if ($lines.Count -eq 0) {
  Write-Host "[INFO] No keys entered — nothing to save."
  exit 0
}

# 4. Save via bulk endpoint (auth-gated; triggers rebuildAtlas)
try {
  $body = @{ text = ($lines -join "`n") } | ConvertTo-Json
  $resp = Invoke-RestMethod -Uri "$AtlasUrl/api/secrets/bulk" -Method POST `
    -Headers @{ "x-atlas-token" = $token } -Body $body -ContentType "application/json" -TimeoutSec 30
  Write-Host "[OK] Saved $($resp.saved) key(s): $($resp.names -join ', ')"
  Write-Host "[OK] ATLAS rebuilt — the matching brain adapters are now live."
} catch {
  Write-Host "[ERROR] Save failed: $_"
  exit 1
}

Write-Host ""
Write-Host "Done. Verify live providers at: $AtlasUrl (unlock, then Status)."
Write-Host ""
