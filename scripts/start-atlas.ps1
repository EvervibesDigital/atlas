# ATLAS one-click launcher.
# Double-click ATLAS.bat on the Desktop -> this script:
#   1. starts Ollama (local free brain) if it isn't running
#   2. starts the ATLAS server if it isn't running
#   3. waits until it answers, then opens the control panel in your browser
param([switch]$NoBrowser)

$ErrorActionPreference = "SilentlyContinue"
$root = "C:\Users\matbr\atlas"
$healthUrl = "http://localhost:4317/api/health"

function Test-Atlas {
    try { (Invoke-WebRequest -Uri $healthUrl -UseBasicParsing -TimeoutSec 2).StatusCode -eq 200 } catch { $false }
}
function Test-Ollama {
    try { (Invoke-WebRequest -Uri "http://127.0.0.1:11434/api/tags" -UseBasicParsing -TimeoutSec 2).StatusCode -eq 200 } catch { $false }
}

# 1. Local brain first, so ATLAS always has a free unlimited model.
if (-not (Test-Ollama)) {
    Start-Process -FilePath "ollama" -ArgumentList "serve" -WindowStyle Hidden
    Start-Sleep -Seconds 3
}

# 2. ATLAS server.
if (-not (Test-Atlas)) {
    Start-Process -FilePath "cmd.exe" -ArgumentList "/c pnpm ui" -WorkingDirectory $root -WindowStyle Hidden
    $up = $false
    for ($i = 0; $i -lt 40; $i++) {
        Start-Sleep -Seconds 2
        if (Test-Atlas) { $up = $true; break }
    }
    if (-not $up) {
        # Visible fallback so a failure is never silent.
        Start-Process -FilePath "cmd.exe" -ArgumentList "/k cd /d $root && pnpm ui"
        Start-Sleep -Seconds 15
    }
}

# 3. Open the control panel.
if (-not $NoBrowser) { Start-Process "http://localhost:4317" }
