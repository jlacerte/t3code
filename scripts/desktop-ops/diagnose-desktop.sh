#!/usr/bin/env bash
# Rassemble un instantané de diagnostic pour T3CodeQC (desktop macOS) :
# statut des providers, dernières lignes de log pertinentes, et la
# config des providerInstances SANS les secrets (le dossier secrets/,
# les tokens Clerk et toute valeur d'environnement marquée "sensitive"
# sont exclus).
#
# Usage: scripts/desktop-ops/diagnose-desktop.sh [nb_lignes_log]

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
source ./lib.sh

LOG_LINES="${1:-300}"
OUT_DIR="$(mktemp -d)/t3codeqc-diagnostic"
mkdir -p "$OUT_DIR"

echo "==> Statut actuel"
./status-desktop.sh > "$OUT_DIR/status.txt" 2>&1 || true

echo "==> Config providerInstances (secrets exclus)"
python3 -c "
import json
p = '$T3_USERDATA_DIR/settings.json'
try:
    d = json.load(open(p))
except Exception as e:
    print('impossible de lire', p, ':', e)
    raise SystemExit(0)

instances = d.get('providerInstances', {})
redacted = {}
for key, entry in instances.items():
    entry = dict(entry)
    env = entry.get('environment')
    if env:
        entry['environment'] = [
            {**v, 'value': '<redacted>'} if v.get('sensitive') else v
            for v in env
        ]
    redacted[key] = entry
print(json.dumps(redacted, indent=2, ensure_ascii=False))
" > "$OUT_DIR/provider-instances.json" 2>&1 || true

echo "==> Dernières $LOG_LINES lignes de server-child.log"
tail -n "$LOG_LINES" "$T3_LOG_DIR/server-child.log" > "$OUT_DIR/server-child.tail.log" 2>&1 || true

echo "==> Caches de statut providers"
mkdir -p "$OUT_DIR/provider-caches"
cp "$T3_CACHE_DIR"/*.json "$OUT_DIR/provider-caches/" 2>/dev/null || true

echo
echo "Diagnostic écrit dans : $OUT_DIR"
echo "(ce dossier n'exclut PAS le contenu des modèles/personas ; ne pas partager"
echo " publiquement sans relecture si tes noms de personas sont confidentiels)"
