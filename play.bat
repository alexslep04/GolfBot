@echo off
cd /d "%~dp0"
py -3 -I -c "import sys; assert sys.version_info >= (3, 11)" >nul 2>&1
if errorlevel 1 goto try_python
py -3 -I "%~dp0bootstrap.py" %*
if errorlevel 1 goto failed
exit /b 0
:try_python
python -I -c "import sys; assert sys.version_info >= (3, 11)" >nul 2>&1
if errorlevel 1 goto missing_python
python -I "%~dp0bootstrap.py" %*
if errorlevel 1 goto failed
exit /b 0
:missing_python
echo Python 3.11 or newer was not found. Install Python with the launcher
echo or add python.exe to PATH, then run play.bat again.
goto failed
:failed
echo The game could not start. Check the error above.
pause
exit /b 1
