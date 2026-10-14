@echo off
rem Drag supported audio files or folders here; forward all inputs to one window.
rem ASCII-only for cmd.exe code-page compatibility.
setlocal
set "EXE=%~dp0QQMusicUnlocker.exe"
if not exist "%EXE%" (
  echo [ERROR] QQMusicUnlocker.exe not found next to this script.
  pause
  exit /b 1
)
start "" "%EXE%" %*
