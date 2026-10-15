#!/bin/zsh
cd "$(dirname "$0")" || exit 1
runtime_python="${HOME}/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3"
if python3 -c 'import hashlib; assert hasattr(hashlib, "scrypt")' 2>/dev/null; then
  exec python3 -B server.py --port 4173
elif [[ -x "$runtime_python" ]] && "$runtime_python" -c 'import hashlib; assert hasattr(hashlib, "scrypt")' 2>/dev/null; then
  exec "$runtime_python" -B server.py --port 4173
else
  echo 'Instale Python 3.11 ou superior com suporte a hashlib.scrypt para iniciar.'
  exit 1
fi
