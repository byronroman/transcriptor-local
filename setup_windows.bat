@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo.
echo === Transcriptor Mi Cami: setup Windows ===
echo.

set "PYTHON_CMD="
for %%C in ("py -3.12" "py -3.11" "python") do (
  %%~C -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 11) else 1)" >nul 2>nul
  if !errorlevel! EQU 0 (
    set "PYTHON_CMD=%%~C"
    goto :python_found
  )
)

echo No encontre Python 3.11 o 3.12.
where winget >nul 2>nul
if %errorlevel% EQU 0 (
  echo Intentando instalar Python 3.12 con winget...
  winget install -e --id Python.Python.3.12
) else (
  echo Instala Python 3.12 desde https://www.python.org/downloads/windows/
  echo Marca la opcion "Add python.exe to PATH" durante la instalacion.
  pause
  exit /b 1
)

for %%C in ("py -3.12" "py -3.11" "python") do (
  %%~C -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 11) else 1)" >nul 2>nul
  if !errorlevel! EQU 0 (
    set "PYTHON_CMD=%%~C"
    goto :python_found
  )
)

echo No pude activar Python despues de instalarlo. Cierra esta ventana y vuelve a ejecutar setup_windows.bat.
pause
exit /b 1

:python_found
echo Usando Python: %PYTHON_CMD%

if exist ".venv\Scripts\python.exe" (
  ".venv\Scripts\python.exe" -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 11) else 1)" >nul 2>nul
  if errorlevel 1 (
    echo Eliminando .venv antiguo porque no usa Python 3.11 o superior...
    rmdir /s /q .venv
  )
)

if not exist ".venv\Scripts\python.exe" (
  echo Creando entorno local .venv...
  %PYTHON_CMD% -m venv .venv
  if errorlevel 1 (
    echo No pude crear .venv.
    pause
    exit /b 1
  )
)

set "VENV_PY=.venv\Scripts\python.exe"

call :ensure_java17

echo Actualizando pip...
"%VENV_PY%" -m pip install --upgrade pip
if errorlevel 1 (
  echo Fallo la actualizacion de pip.
  pause
  exit /b 1
)

echo Instalando dependencias principales...
"%VENV_PY%" -m pip install -r requirements.txt
if errorlevel 1 (
  echo Fallo la instalacion de dependencias principales.
  pause
  exit /b 1
)

echo Instalando diarizacion opcional...
"%VENV_PY%" -m pip install -r requirements_diarization.txt
if errorlevel 1 (
  echo.
  echo Aviso: sherpa-onnx no se pudo instalar. La app funcionara sin diarizacion automatica.
  echo Puedes volver a ejecutar setup_windows.bat mas tarde.
  echo.
)

echo Descargando herramientas y modelos...
"%VENV_PY%" scripts\setup_tools.py --with-diarization --quality-models
if errorlevel 1 (
  echo.
  echo Aviso: alguna descarga fallo. La app puede abrir igual, pero revisa la pantalla de estado.
  echo.
)

echo.
echo Setup terminado.
echo Para abrir la app usa run_windows.bat
echo.
pause
exit /b 0

:ensure_java17
echo Verificando Java 17 o superior para el corrector local...
where java >nul 2>nul
if !errorlevel! EQU 0 (
  "%VENV_PY%" -c "import re,subprocess,sys; p=subprocess.run(['java','-version'],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True); text=(p.stderr or '')+' '+(p.stdout or ''); m=re.search('version[^0-9]*([0-9]+)(?:\\.([0-9]+))?', text); major=(int(m.group(2)) if m and m.group(1)=='1' and m.group(2) else int(m.group(1)) if m else 0); sys.exit(0 if p.returncode==0 and major>=17 else 1)" >nul 2>nul
  if !errorlevel! EQU 0 (
    echo Java 17 o superior disponible.
    exit /b 0
  )
)

echo No encontre Java 17 o superior activo. El corrector local lo necesita.
where winget >nul 2>nul
if !errorlevel! EQU 0 (
  echo Intentando instalar Temurin Java 17 con winget...
  winget install -e --id EclipseAdoptium.Temurin.17.JRE --accept-package-agreements --accept-source-agreements
  "%VENV_PY%" -c "import re,subprocess,sys; p=subprocess.run(['java','-version'],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True); text=(p.stderr or '')+' '+(p.stdout or ''); m=re.search('version[^0-9]*([0-9]+)(?:\\.([0-9]+))?', text); major=(int(m.group(2)) if m and m.group(1)=='1' and m.group(2) else int(m.group(1)) if m else 0); sys.exit(0 if p.returncode==0 and major>=17 else 1)" >nul 2>nul
  if !errorlevel! EQU 0 (
    echo Java 17 o superior disponible.
    exit /b 0
  )
  echo.
  echo Aviso: Java 17 no quedo activo en esta ventana.
  echo Cierra esta ventana y vuelve a ejecutar setup_windows.bat si el corrector sigue no disponible.
  echo.
) else (
  echo.
  echo Aviso: instala Java 17 o superior de 64 bits para usar el corrector local.
  echo Puedes descargar Temurin desde https://adoptium.net/temurin/releases/
  echo.
)
exit /b 0
