#!/usr/bin/env bash
# Fonctions partagées par les scripts desktop-ops.
# Ne pas exécuter directement — ce fichier est sourcé par les autres scripts.

set -euo pipefail

T3_USERDATA_DIR="${T3CODE_HOME:-$HOME/.t3}/userdata"
T3_LOG_DIR="$T3_USERDATA_DIR/logs"
T3_CACHE_DIR="${T3CODE_HOME:-$HOME/.t3}/caches"
T3_BACKEND_PORT=3773

# Chemin du build local packagé, avec repli sur /Applications si absent.
resolve_app_path() {
  local staged="$HOME/t3codeqc/t3code/release/staged/T3CodeQC.app"
  if [ -d "$staged" ]; then
    echo "$staged"
    return 0
  fi
  local installed
  installed=$(ls -d /Applications/T3*.app 2>/dev/null | head -1 || true)
  if [ -n "$installed" ]; then
    echo "$installed"
    return 0
  fi
  return 1
}

list_t3_pids() {
  # Restreint au binaire dans le bundle .app pour ne pas matcher (et tuer)
  # un processus quelconque dont la ligne de commande contient "T3CodeQC"
  # (ex.: un tail -f sur un log, un éditeur ouvert sur ce chemin).
  pgrep -f "T3CodeQC\.app/Contents/" 2>/dev/null || true
}
