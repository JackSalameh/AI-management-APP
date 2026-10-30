@echo off
rem Same as the .vbs launcher but keeps a console open (useful to read errors).
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js 22+ is required: https://nodejs.org & pause & exit /b 1)
node server.mjs --open
pause
