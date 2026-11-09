@echo off
setlocal
rem Runs omaestri.js with the Node runtime bundled in open-maestri (Electron as Node),
rem falling back to a system "node" when MAESTRI_NODE is not set.
if defined MAESTRI_NODE (
  set ELECTRON_RUN_AS_NODE=1
  "%MAESTRI_NODE%" "%~dp0omaestri.js" %*
) else (
  node "%~dp0omaestri.js" %*
)
exit /b %ERRORLEVEL%
