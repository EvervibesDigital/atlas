@echo off
title ATLAS Control Panel
cd /d "%~dp0"

where pnpm >nul 2>nul
if errorlevel 1 (
  echo.
  echo   pnpm was not found. Install Node.js from https://nodejs.org
  echo   then run: npm install -g pnpm
  echo.
  pause
  exit /b 1
)

if not exist node_modules (
  echo First-time setup - installing dependencies, please wait...
  call pnpm install
)

echo.
echo   Starting ATLAS... your browser will open automatically.
echo   Keep this window open while you use ATLAS. Close it to stop.
echo.
call pnpm ui
pause
