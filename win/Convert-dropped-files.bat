@echo off
rem ---------------------------------------------------------------------------
rem Drag .mgg / .mflac files (or a folder) onto this file to convert them.
rem
rem Why this exists: dropping files onto QQMusicUnlocker.exe itself does not
rem pass their paths to a PyInstaller program on Windows, so this script
rem forwards the dropped paths as command line arguments instead.
rem (Pure ASCII on purpose: cmd.exe reads .bat in the OEM codepage before any
rem  chcp takes effect, so non-ASCII source text would show up as garbage.)
rem ---------------------------------------------------------------------------
setlocal

set "EXE=%~dp0QQMusicUnlocker.exe"
if not exist "%EXE%" (
  echo [ERROR] QQMusicUnlocker.exe not found in this folder.
  echo         Please keep this file inside the extracted folder.
  echo.
  pause
  exit /b 1
)

if "%~1"=="" (
  "%EXE%"
  exit /b 0
)

:loop
if "%~1"=="" goto done
echo Converting: %~nx1
"%EXE%" "%~f1"
shift
goto loop

:done
echo.
echo Finished. Output folder: Desktop by default.
pause
