@echo off
rem dsh-config-sync 一键升级。
rem 脚本读 profile 里这个插件的安装形态：link: 就拉仓库，github: 就 pnpm update。
rem 结束后回到 DeepSeek Harness，点窗口右上角的刷新按钮（或重启 App）才生效。
chcp 65001 >nul
cd /d "%~dp0"
node scripts\update.mjs %*
echo.
pause
