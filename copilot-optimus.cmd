@echo off
setlocal
powershell -ExecutionPolicy Bypass -File "%~dp0copilot-optimus.ps1" %*
exit /b %ERRORLEVEL%
