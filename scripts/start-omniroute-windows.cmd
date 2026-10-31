@echo off
rem AI Management APP - start OmniRoute (http://localhost:20128) and record what it prints.
rem Logs: <folder above the app>\AppData\logs\omniroute.log (checks) and omniroute-server.log (what OmniRoute prints).
setlocal EnableExtensions
chcp 65001 >nul
for %%I in ("%~dp0..\..") do set "BASE=%%~fI"
set "LOGDIR=%BASE%\AppData\logs"
set "LOG=%LOGDIR%\omniroute.log"
set "SLOG=%LOGDIR%\omniroute-server.log"
if not exist "%LOGDIR%\" mkdir "%LOGDIR%"

> "%LOG%" echo ==== %DATE% %TIME% start-omniroute
>>"%LOG%" echo PATH=%PATH%
>>"%LOG%" echo --- node:
where node >>"%LOG%" 2>&1
node --version >>"%LOG%" 2>&1
>>"%LOG%" echo --- npm prefix:
call npm prefix -g >>"%LOG%" 2>&1
>>"%LOG%" echo --- omniroute:
where omniroute >>"%LOG%" 2>&1
if errorlevel 1 (
  echo OmniRoute is not installed: installing it with npm...
  >>"%LOG%" echo --- npm install -g omniroute
  call npm install -g omniroute >>"%LOG%" 2>&1
)
call npm ls -g omniroute >>"%LOG%" 2>&1

rem Already running?
powershell -NoProfile -Command "try { (Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 http://localhost:20128/api/health).StatusCode } catch { if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { 0 } }" > "%TEMP%\omni-status.txt" 2>nul
set /p STATUS=<"%TEMP%\omni-status.txt"
>>"%LOG%" echo --- port 20128 answers: %STATUS%
if not "%STATUS%"=="0" if not "%STATUS%"=="" (
  echo OmniRoute is already running: http://localhost:20128
  >>"%LOG%" echo already running
  goto :done
)
>>"%LOG%" echo --- netstat 20128:
netstat -ano | findstr ":20128" >>"%LOG%" 2>&1

echo Starting OmniRoute in a minimised window (keep it open while you use it)...
>>"%LOG%" echo ==== omniroute --no-open
start "OmniRoute (keep open)" /min cmd /c "omniroute --no-open > "%SLOG%" 2>&1"

for /l %%i in (1,1,60) do (
  powershell -NoProfile -Command "try { $null = Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 http://localhost:20128/api/health; exit 0 } catch { if ($_.Exception.Response) { exit 0 } else { exit 1 } }" >nul 2>&1 && goto :up
  timeout /t 2 /nobreak >nul
)
echo OmniRoute did not answer within 2 minutes. What it printed is in:
echo   %SLOG%
goto :done

:up
echo OmniRoute is running: http://localhost:20128
>>"%LOG%" echo ==== running

:done
echo.
pause
