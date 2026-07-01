#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -x ".venv/bin/python" ]; then
  echo "No existe .venv. Ejecuta ./setup_mac.sh primero."
  exit 1
fi

".venv/bin/python" -m app.main
