@echo off
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (
    echo Creating a local Python environment...
    py -m venv .venv
    if errorlevel 1 goto failed
)
".venv\Scripts\python.exe" -c "import pygame" >nul 2>&1
if errorlevel 1 (
    ".venv\Scripts\python.exe" -m pip install -r requirements.txt
    if errorlevel 1 goto failed
)
".venv\Scripts\python.exe" game.py
if errorlevel 1 goto failed
exit /b 0
:failed
echo The game could not start. Check the error above.
pause
exit /b 1
