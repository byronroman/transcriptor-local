#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

echo
echo "=== Transcriptor Mi Cami: setup Mac ==="
echo

PYTHON_CMD=""
for candidate in python3.12 python3.11 python3; do
  if command -v "$candidate" >/dev/null 2>&1; then
    if "$candidate" - <<'PY' >/dev/null 2>&1
import sys
raise SystemExit(0 if sys.version_info >= (3, 11) else 1)
PY
    then
      PYTHON_CMD="$candidate"
      break
    fi
  fi
done

if [ -z "$PYTHON_CMD" ]; then
  if command -v brew >/dev/null 2>&1; then
    echo "Instalando Python 3.12 con Homebrew..."
    brew install python@3.12
    if command -v python3.12 >/dev/null 2>&1; then
      PYTHON_CMD="python3.12"
    else
      echo "No pude encontrar python3.12 despues de instalarlo."
      exit 1
    fi
  else
    echo "Instala Python 3.11 o 3.12 y vuelve a ejecutar este script."
    echo "Con Homebrew: brew install python@3.12"
    exit 1
  fi
fi

if ! command -v ffmpeg >/dev/null 2>&1; then
  if command -v brew >/dev/null 2>&1; then
    echo "Instalando ffmpeg con Homebrew..."
    brew install ffmpeg
  else
    echo "Falta ffmpeg. Instala Homebrew y luego: brew install ffmpeg"
    exit 1
  fi
fi

if ! command -v whisper-cli >/dev/null 2>&1 && ! command -v whisper-cpp >/dev/null 2>&1; then
  if command -v brew >/dev/null 2>&1; then
    echo "Instalando whisper-cpp con Homebrew..."
    brew install whisper-cpp
  else
    echo "Falta whisper.cpp. Instala Homebrew y luego: brew install whisper-cpp"
    exit 1
  fi
fi

if ! java -version >/dev/null 2>&1; then
  if command -v brew >/dev/null 2>&1; then
    echo "Instalando Java para corrector local LanguageTool..."
    brew install --cask temurin
  else
    echo "Aviso: falta Java. El corrector local no funcionara hasta instalar Java."
    echo "Con Homebrew: brew install --cask temurin"
  fi
fi

if [ -x ".venv/bin/python" ]; then
  if ! ".venv/bin/python" - <<'PY' >/dev/null 2>&1
import sys
raise SystemExit(0 if sys.version_info >= (3, 11) else 1)
PY
  then
    echo "Eliminando .venv antiguo porque no usa Python 3.11 o superior..."
    rm -rf .venv
  fi
fi

if [ ! -x ".venv/bin/python" ]; then
  echo "Creando entorno local .venv..."
  "$PYTHON_CMD" -m venv .venv
fi

VENV_PY=".venv/bin/python"
"$VENV_PY" -m pip install --upgrade pip
"$VENV_PY" -m pip install -r requirements.txt

echo "Instalando diarizacion opcional..."
if ! "$VENV_PY" -m pip install -r requirements_diarization.txt; then
  echo "Aviso: sherpa-onnx no se pudo instalar. La app funcionara sin diarizacion automatica."
fi

echo "Descargando modelos para Mac: small, medium, large-v3-turbo, large-v3 q5_0 y large-v3 completo..."
"$VENV_PY" scripts/setup_tools.py --with-diarization --quality-models --max-quality-model --best-quality-model

echo
echo "Setup terminado. Para abrir la app usa ./run_mac.sh"
