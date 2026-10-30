@echo off
rem Double-click: connect Claude Code to OmniRoute (asks for your OmniRoute key).  With "off": undo.
if /I "%~1"=="off" (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0connect-claude-code-to-omniroute.ps1" -Off
) else (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0connect-claude-code-to-omniroute.ps1"
)
echo.
pause
