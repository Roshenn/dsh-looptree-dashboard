@echo off
rem 双击启动轮转闭环树 dev-host（Windows）。等价于 npm run dev -> node scripts/dev-host.mjs
rem 与 start.command（macOS）对位；真实 DSH GUI 里的入口走 profile 安装，不靠本脚本。
setlocal
cd /d "%~dp0"
if not defined PORT set "PORT=4180"
echo [looptree] dev-host  http://127.0.0.1:%PORT%/rotation/app/
node scripts/dev-host.mjs
if errorlevel 1 pause
