@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if %errorlevel%==0 (
  node bin\norouter.js %*
  exit /b %errorlevel%
)

rem Fallback for machines without Node.js: the ZCode desktop app ships an
rem Electron runtime that behaves like Node when ELECTRON_RUN_AS_NODE=1.
set "ELECTRON_RUN_AS_NODE=1"
set "ZCODE_EXE=%LOCALAPPDATA%\Programs\ZCode\ZCode.exe"
if exist "%ZCODE_EXE%" (
  echo Node.js not found on PATH - using the ZCode Electron runtime instead.
  "%ZCODE_EXE%" bin\norouter.js %*
  exit /b %errorlevel%
)

echo Node.js 22.5+ is required. Install it from https://nodejs.org
exit /b 1
