#!/usr/bin/env bash
# Éteint proprement T3CodeQC (desktop macOS) et le relance.
#
# Un simple Cmd+Q peut laisser un processus fantôme en mémoire avec
# l'ancienne configuration (observé le 2026-07-06 : le toggle Clawcal
# ne se rechargeait pas tant qu'un vieux processus backend restait vivant).
# Ce script force l'arrêt complet avant de relancer, pour garantir que
# l'app démarre avec la configuration actuelle de settings.json.
#
# Usage: scripts/desktop-ops/restart-desktop.sh

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
source ./lib.sh

echo "==> Arrêt de T3CodeQC..."
pids=$(list_t3_pids)
if [ -n "$pids" ]; then
  # shellcheck disable=SC2086
  kill $pids 2>/dev/null || true
  sleep 2
  pids=$(list_t3_pids)
  if [ -n "$pids" ]; then
    echo "    processus restants, arrêt forcé (kill -9)"
    # shellcheck disable=SC2086
    kill -9 $pids 2>/dev/null || true
    sleep 1
  fi
else
  echo "    déjà arrêté"
fi

if [ -n "$(list_t3_pids)" ]; then
  echo "ERREUR: des processus T3CodeQC survivent, abandon." >&2
  list_t3_pids >&2
  exit 1
fi

app_path=$(resolve_app_path) || {
  echo "ERREUR: impossible de trouver T3CodeQC.app (ni build local, ni /Applications)." >&2
  exit 1
}

echo "==> Relance de $app_path"
open "$app_path"

echo "==> Attente du backend sur le port $T3_BACKEND_PORT..."
for _ in $(seq 1 20); do
  if lsof -i ":$T3_BACKEND_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "    backend prêt."
    exit 0
  fi
  sleep 1
done

echo "AVERTISSEMENT: le backend n'a pas ouvert le port $T3_BACKEND_PORT après 20s." >&2
exit 1
