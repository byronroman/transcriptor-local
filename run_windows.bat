@echo off
setlocal
cd /d "%~dp0"

if not exist ".venv\Scripts\python.exe" (
  echo No existe .venv. Ejecuta setup_windows.bat primero.
  pause
  exit /b 1
)

".venv\Scripts\python.exe" -m app.main
pause
