@echo off
rem One-click upgrade for dsh-config-sync, whichever way it was installed.
rem The script reads the profile's dependency spec: link: pulls this checkout,
rem github: runs "pnpm update" in the profile.
rem Afterwards press the refresh button at the top right of DeepSeek Harness
rem (or restart the app) so the host drops its cached modules.
rem Keep this file ASCII-only: cmd.exe parses a batch file with the codepage that
rem was active when it started, so UTF-8 text here turns into broken commands.
chcp 65001 >nul
cd /d "%~dp0"
node scripts\update.mjs %*
echo.
pause
