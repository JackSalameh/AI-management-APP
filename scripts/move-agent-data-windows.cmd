@echo off
rem AI Management APP - keep Claude Code and Codex sessions on another drive (Windows).
rem
rem Claude Code keeps its sessions in %USERPROFILE%\.claude and Codex in %USERPROFILE%\.codex. This script moves
rem both folders to the target (default: the AppData folder next to the app's folder, e.g. D:\Claude\AppData)
rem and leaves a directory junction at the old place, so Claude Code (terminal, VS Code, the Code tab of the
rem Claude desktop app), Codex and AI Management APP keep working and every new session is written on the target.
rem A junction needs no administrator rights. Run it again at any time: what is already done is skipped.
rem
rem Usage: double-click, or  move-agent-data-windows.cmd [target folder]
setlocal EnableExtensions
chcp 65001 >nul

set "TARGET=%~1"
if "%TARGET%"=="" for %%I in ("%~dp0..\..") do set "TARGET=%%~fI\AppData"
echo.
echo Target folder: %TARGET%
echo Close Claude Code and Codex first (terminals, VS Code). The Claude desktop app may stay open.
echo.
pause

if not exist "%TARGET%\" mkdir "%TARGET%" || goto :fail

call :move .claude || goto :fail
call :move .codex  || goto :fail

echo.
echo Done. New Claude Code and Codex sessions are now written in %TARGET%.
echo Folders that held data before were kept as "%USERPROFILE%\.claude.old-on-C" / ".codex.old-on-C":
echo delete them after checking that your conversations open in the app.
echo.
pause
exit /b 0

:move
set "NAME=%~1"
set "SRC=%USERPROFILE%\%NAME%"
set "DST=%TARGET%\%NAME%"
rem Already a junction: nothing to do.
dir /AL /B "%USERPROFILE%" 2>nul | findstr /I /X /C:"%NAME%" >nul && (echo %NAME%: already on %DST% & exit /b 0)
if exist "%SRC%\" (
  echo %NAME%: copying to %DST% ...
  robocopy "%SRC%" "%DST%" /E /COPY:DAT /DCOPY:DAT /R:1 /W:1 /NFL /NDL /NP /NJH
  if errorlevel 8 (echo %NAME%: the copy failed - nothing was changed on C:. & exit /b 1)
  ren "%SRC%" "%NAME%.old-on-C" || (echo %NAME%: still in use - close Claude Code / Codex and run this again. & exit /b 1)
) else (
  if not exist "%DST%\" mkdir "%DST%" || exit /b 1
)
mklink /J "%SRC%" "%DST%" || (echo %NAME%: could not create the link. & exit /b 1)
echo %NAME%: now on %DST%
exit /b 0

:fail
echo.
echo Stopped. Nothing else was changed.
pause
exit /b 1
