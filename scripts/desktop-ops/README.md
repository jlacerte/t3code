# desktop-ops

Scripts de gestion locale pour l'app desktop T3CodeQC sur macOS (redémarrage
propre, statut, diagnostic). Nés du débogage du 2026-07-06 : un `Cmd+Q` seul
peut laisser un processus backend fantôme avec une config obsolète.

- `restart-desktop.sh` — arrête tous les processus T3CodeQC (avec `kill -9`
  en dernier recours), puis relance l'app et attend que le backend écoute
  sur le port 3773. À utiliser après tout changement de config provider.
- `status-desktop.sh` — affiche les processus en cours, l'état du port
  backend, et le statut de chaque provider (ready/disabled/erreur) à partir
  des caches dans `~/.t3/caches`.
- `diagnose-desktop.sh [nb_lignes]` — capture un instantané complet (statut,
  config providerInstances filtrée par liste blanche de clés non sensibles,
  logs récents, caches) dans un dossier temporaire, pour appuyer une future
  session de débogage.

Ces scripts respectent `T3CODE_HOME` s'il est défini, sinon utilisent
`~/.t3` par défaut. La config exportée par le diagnostic est filtrée par
liste blanche : toute clé inconnue (`serverPassword`, tokens, etc.) est
remplacée par `<redacted>`; `secrets/` et `clerk-tokens.json` ne sont
jamais lus.
