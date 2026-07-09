# ATLAS remote setup — run AFTER:
#   1) cloudflared tunnel login
#   2) cloudflared tunnel create atlas
# This finds your 'atlas' tunnel, writes ~/.cloudflared/config.yml, and routes
# atlas.evervibesdigital.com to it. Then start it with Start-ATLAS-Remote.bat.

$ErrorActionPreference = "Stop"
$cfDir = Join-Path $env:USERPROFILE ".cloudflared"

$tunnels = cloudflared tunnel list --output json | ConvertFrom-Json
$atlas = $tunnels | Where-Object { $_.name -eq "atlas" } | Select-Object -First 1
if (-not $atlas) {
  Write-Host "No tunnel named 'atlas' found." -ForegroundColor Red
  Write-Host "Run first:  cloudflared tunnel login   then   cloudflared tunnel create atlas"
  exit 1
}

$id = $atlas.id
$cred = Join-Path $cfDir "$id.json"

$config = @"
tunnel: atlas
credentials-file: $cred

ingress:
  - hostname: atlas.evervibesdigital.com
    service: http://127.0.0.1:4317
  - service: http_status:404
"@

Set-Content -Path (Join-Path $cfDir "config.yml") -Value $config -Encoding utf8
Write-Host "Wrote $cfDir\config.yml (tunnel $id)" -ForegroundColor Green

cloudflared tunnel route dns atlas atlas.evervibesdigital.com
Write-Host ""
Write-Host "Done! Now double-click  remote\Start-ATLAS-Remote.bat" -ForegroundColor Green
Write-Host "Then open  https://atlas.evervibesdigital.com  on your phone." -ForegroundColor Green
