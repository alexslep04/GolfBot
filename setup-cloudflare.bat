@echo off
cd /d "%~dp0"
powershell.exe -NoProfile -File "%~dp0share.ps1" -Setup %*
if errorlevel 1 pause
