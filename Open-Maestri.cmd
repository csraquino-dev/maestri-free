@echo off
rem Launches open-maestri (Windows) from the project folder without a console window.
cd /d "%~dp0"
if not exist "node_modules\electron\dist\electron.exe" (
  echo Dependencies are missing. Run:  npm install  ^&^&  node node_modules\electron\install.js
  pause
  exit /b 1
)
start "" "node_modules\electron\dist\electron.exe" .
