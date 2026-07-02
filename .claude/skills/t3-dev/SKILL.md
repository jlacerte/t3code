---
name: t3-dev
description: >
  Lance (ou relance) le stack de développement T3 Code sous Node 24, récupère le
  token de jumelage dans le log serveur et ouvre l'app dans le navigateur via le
  Chrome DevTools MCP. À utiliser pour démarrer l'app en mode dev, re-choper le
  token de jumelage après un redémarrage `--watch`, ou préparer une vérification
  visuelle de l'interface. Déclencheurs : « lance l'app », « démarre le dev »,
  « ouvre t3code », « token de jumelage », « re-jumeler ».
---

# Lancer le stack de dev T3 Code (Windows)

Fork FR québécois de T3 Code. Clone local : `C:\Users\lokim\t3code`.

## Prérequis d'environnement (pièges Windows)

- **Node système = v22 (trop vieux)** : le projet exige `^24.13.1`. Toujours mettre
  Node 24 (installé via `fnm`) en tête de PATH avant toute commande `pnpm` :

  ```bash
  export PATH="/c/Users/lokim/AppData/Roaming/fnm/node-versions/v24.18.0/installation:$PATH"
  ```

- **NE JAMAIS lancer `pnpm install`** : ça retirerait le binding natif local
  `@voidzero-dev/vite-plus-win32-x64-msvc` (ajouté hors lockfile). Tout est déjà installé.

## Étapes

1. **Lancer le stack** en arrière-plan sous Node 24 :

   ```bash
   export PATH="/c/Users/lokim/AppData/Roaming/fnm/node-versions/v24.18.0/installation:$PATH"
   cd /c/Users/lokim/t3code
   nohup pnpm dev > /tmp/t3code-dev.log 2>&1 &
   ```

   Démarre le back-end (`:13773`, décalé à `:13774`… si occupé) + le web Vite
   (`:5733`, décalé à `:5734`…). Les ports **peuvent être décalés** si les précédents
   sont pris — toujours les lire dans le log, ne pas les coder en dur.

2. **Attendre ~20 s** que le serveur monte, puis lire le log et extraire le token
   (l'URL de jumelage donne le port web ET le token) :

   ```bash
   grep -oE 'pairingUrl: http://localhost:[0-9]+/pair#token=[A-Z0-9]+' /tmp/t3code-dev.log | tail -1
   ```

   Le token **change à chaque redémarrage `--watch`** (donc à chaque édition d'un
   fichier serveur). Toujours re-lire le log après une modif serveur.

3. **Vérifier que le Chrome DevTools MCP est chargé** (outils `mcp__chrome-devtools__*`).
   S'ils manquent, demander à l'utilisateur de redémarrer la session.

4. **Ouvrir l'app** avec l'URL de jumelage complète (port + token du log) :
   `mcp__chrome-devtools__navigate_page` vers `http://localhost:<web>/pair#token=<TOKEN>`.
   Le cold-start Vite sert des centaines de modules → la 1ʳᵉ nav peut « timeout »
   côté MCP alors que la page charge : re-`take_snapshot` après quelques secondes,
   l'app redirige vers `/` une fois jumelée.

## Bruit bénin (à ignorer dans le log)

- `Grok CLI health check failed` (`PlatformError`) : pas de CLI Grok installé.
- `CommandResolutionError` dans « Dernières défaillances » : même origine.

## Gates de validation (AGENTS.md)

Typecheck (sans passer par `vp`) après toute modif :

```bash
pnpm --filter @t3tools/web run typecheck   # web  (tsgo --noEmit)
pnpm --filter t3 run typecheck             # serveur (package name = "t3")
```
