@echo off
title ATLAS Remote (Cloudflare Tunnel)
cd /d "C:\Users\matbr\atlas"

where cloudflared >nul 2>nul
if errorlevel 1 (
  echo.
  echo   cloudflared is not installed. See remote\REMOTE-ACCESS.md for setup.
  echo.
  pause
  exit /b 1
)

echo Making sure the ATLAS panel is running...
start "" /min cmd /c "set ATLAS_NO_OPEN=1&& pnpm ui"

echo Opening the secure tunnel to atlas.evervibesdigital.com ...
echo Keep this window open while you want remote access. Close it to stop.
cloudflared tunnel run atlas
pause
