@echo off
rem ATLAS nightly cycle — runs one autonomous day of work and logs the report.
cd /d C:\Users\matbr\atlas
if not exist data\logs mkdir data\logs
echo. >> data\logs\nightly.log
echo ===== ATLAS nightly cycle: %date% %time% ===== >> data\logs\nightly.log
call pnpm cycle >> data\logs\nightly.log 2>&1
