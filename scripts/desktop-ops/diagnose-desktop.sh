#!/usr/bin/env bash
# Rassemble un instantané de diagnostic pour T3CodeQC (desktop macOS) :
# statut des providers, dernières lignes de log pertinentes, et la
# config des providerInstances filtrée par LISTE BLANCHE : seules les
# clés non sensibles connues (enabled, binaryPath, serverUrl, etc.)
# sont copiées; tout le reste (serverPassword, tokens, environment)
# est remplacé par "<redacted>".
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

echo "==> Config providerInstances (liste blanche, secrets exclus)"
python3 - "$T3_USERDATA_DIR/settings.json" > "$OUT_DIR/provider-instances.json" 2>&1 <<'PYEOF' || true
import json, sys

p = sys.argv[1]
try:
    d = json.load(open(p))
except Exception as e:
    print('impossible de lire', p, ':', e)
    raise SystemExit(0)

# Structure réelle d'une entrée : {driver, enabled, config: {...}}.
# On ne copie que les clés connues comme non sensibles; toute autre
# valeur (serverPassword, apiKey, environment, ...) est masquée.
SAFE_TOP = {'driver', 'enabled'}
SAFE_CONFIG = {'enabled', 'binaryPath', 'homePath', 'shadowHomePath',
               'apiEndpoint', 'serverUrl', 'launchArgs', 'customModels'}

redacted = {}
for key, entry in d.get('providerInstances', {}).items():
    out = {k: (v if k in SAFE_TOP else '<redacted>')
           for k, v in entry.items() if k != 'config'}
    config = entry.get('config')
    if isinstance(config, dict):
        out['config'] = {k: (v if k in SAFE_CONFIG else '<redacted>')
                         for k, v in config.items()}
    redacted[key] = out
print(json.dumps(redacted, indent=2, ensure_ascii=False))
PYEOF

echo "==> Dernières $LOG_LINES lignes de server-child.log"
tail -n "$LOG_LINES" "$T3_LOG_DIR/server-child.log" > "$OUT_DIR/server-child.tail.log" 2>&1 || true

echo "==> Caches de statut providers"
mkdir -p "$OUT_DIR/provider-caches"
cp "$T3_CACHE_DIR"/*.json "$OUT_DIR/provider-caches/" 2>/dev/null || true

echo
echo "Diagnostic écrit dans : $OUT_DIR"
echo "(ce dossier n'exclut PAS le contenu des modèles/personas ; ne pas partager"
echo " publiquement sans relecture si tes noms de personas sont confidentiels)"
