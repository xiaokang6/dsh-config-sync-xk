@echo off
rem One-click upgrade for the link:-installed dsh-config-sync.
rem Double-click this file (or run it from a terminal) after a new version is out.
chcp 65001 >nul
cd /d "%~dp0"
node scripts\update.mjs %*
echo.
pause
