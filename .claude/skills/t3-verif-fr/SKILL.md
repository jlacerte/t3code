---
name: t3-verif-fr
description: >
  Vérifie visuellement la traduction française québécoise de l'interface T3 Code en
  pilotant l'app avec le Chrome DevTools MCP : parcourt les pages, prend des captures
  et signale toute chaîne restée en anglais ou toute formulation à corriger. À utiliser
  pour contrôler les traductions FR, chasser l'anglais résiduel, ou valider l'UI après
  des modifs. Déclencheurs : « vérif visuelle », « chaînes en anglais », « contrôle les
  traductions », « screenshot les paramètres ».
---

# Vérification visuelle des traductions FR (québécois)

Fork FR québécois de T3 Code (traduction en dur, **pas d'i18n**). Le but est de
débusquer les chaînes anglaises résiduelles dans l'UI et les formulations qui sonnent mal.

## Prérequis

- App lancée et jumelée (voir la skill **`t3-dev`** pour lancer le stack + obtenir le token).
- Chrome DevTools MCP chargé (`mcp__chrome-devtools__*`).

## Méthode

1. **Naviguer** vers chaque page avec `mcp__chrome-devtools__navigate_page`
   (`http://localhost:<web>/…`), puis `take_snapshot` (arbre a11y = tout le texte
   affiché) et `take_screenshot` pour le rendu visuel.

2. **Pages à couvrir** (les chaînes vivent surtout dans les Paramètres) :
   - Coquille / sidebar : `/` (états vides, étiquettes, notifications/toasts)
   - `/settings/general`, `/settings/keybindings`, `/settings/providers`,
     `/settings/connections`, `/settings/source-control`, `/settings/diagnostics`,
     `/settings/archived`
   - Chat / composer, aperçu (preview)

3. **Repérer l'anglais** : si le snapshot est volumineux, il est sauvegardé sur disque —
   grep-er le fichier pour des mots anglais typiques et vérifier chaque hit :

   ```
   Settings | Loading | No .* yet | Refresh | Resize | Dismiss | Failed | Save | Cancel
   | Search | Add | Remove | Enable | Disable | Loading… | Retry | Close
   ```

   Attention aux **aria-label** (boutons icônes) et **placeholders** : souvent oubliés.

4. **Localiser la source** d'une chaîne EN avec Grep dans `apps/web/src` (ou `apps/desktop/src`),
   puis traduire en **français québécois** cohérent avec l'existant (ex. « Settings » →
   « Paramètres », « Resize/Toggle Sidebar » → « Redimensionner/Basculer la barre latérale »,
   « Dismiss notification » → « Ignorer la notification »).

5. **Ne PAS traduire** : les messages d'erreur système bruts (`CommandResolutionError`,
   noms de tags d'erreur), le contenu des logs, les identifiants techniques.

## Après correction

- Typecheck web : `pnpm --filter @t3tools/web run typecheck` (Node 24 en tête de PATH).
- Recharger la page dans Chrome MCP et re-screenshoter pour confirmer le rendu FR.
- Si des tests asseraient sur les chaînes EN, aligner les assertions sur le texte FR.
