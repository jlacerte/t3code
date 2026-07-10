#!/usr/bin/env bash
# Affiche l'état actuel de T3CodeQC (desktop macOS) : processus, port
# backend, et statut de chaque provider (ready/disabled/erreur).
#
# Usage: scripts/desktop-ops/status-desktop.sh

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
source ./lib.sh

echo "== Processus =="
pids=$(list_t3_pids)
if [ -n "$pids" ]; then
  # shellcheck disable=SC2086
  ps -o pid,lstart,command -p $pids
else
  echo "aucun processus T3CodeQC en cours"
fi

echo
echo "== Backend (port $T3_BACKEND_PORT) =="
if lsof -i ":$T3_BACKEND_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "en écoute"
else
  echo "fermé"
fi

echo
echo "== Statut des providers =="
if [ -d "$T3_CACHE_DIR" ]; then
  for f in "$T3_CACHE_DIR"/*.json; do
    [ -e "$f" ] || continue
    python3 - "$f" <<'PYEOF'
import json, sys

f = sys.argv[1]
try:
    d = json.load(open(f))
except Exception as e:
    print(f'{f}: illisible ({e})')
    sys.exit(0)
name = d.get('displayName', f)
status = d.get('status', '?')
nmodels = len(d.get('models', []))
message = d.get('message')
line = f'{name:<12} {status:<10} {nmodels} modèle(s)'
if message:
    line += f'  -- {message}'
print(line)
PYEOF
  done
else
  echo "aucun cache de provider trouvé ($T3_CACHE_DIR)"
fi
