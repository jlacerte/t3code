> **OBSOLÈTE (2026-10-29)** — L'écart avec l'upstream est passé de 105 à 6394 commits
> (0.0.28 → v0.1.5). Le merge unique proposé ici n'est plus réaliste. Remplacé par le
> projet Archon « T3 Code (RTX) — mise à niveau v0.1.x et fork T3CodeQC »
> (id 07dadfbc-c092-4fb6-ad30-91df68e7a45f).

# 21 — Stratégie de synchronisation avec l'upstream (pingdotgg/t3code)

## Contexte

Notre fork (`jlacerte/t3code`, rebrandé **T3CodeQC**) a divergé de l'upstream officiel
(`pingdotgg/t3code`) il y a 27 commits. Depuis, l'upstream a avancé de 105 commits.

- Point de divergence (merge-base) : `7b9eef7ac2`
- Notre `HEAD` : `cce4a3b16`
- Upstream `HEAD` : `1735e27d9`

Question : est-ce que synchroniser avec l'upstream va casser nos customisations
(rebranding T3CodeQC + intégration Clawcal) ?

## Ce qu'on a mesuré (pas deviné)

Comparaison des fichiers touchés de part et d'autre depuis le point de divergence :

| | Fichiers modifiés |
|---|---|
| Nous (fork) | 193 |
| Upstream | 752 |
| **Intersection (risque de conflit)** | **48** |

### Zones 100% isolées (aucun risque de conflit)

- **Clawcal** (`apps/server/src/provider/{Drivers,Layers,Services,acp}/Clawcal*`,
  `apps/server/src/textGeneration/Clawcal*`) — fichiers entièrement nouveaux, jamais
  touchés par l'upstream. Un `merge`/`rebase` ne les affectera pas.
- **Branding** (`README.md`, `apps/web/index.html`, `apps/web/src/branding.ts`,
  `apps/web/src/branding.test.ts`) — aucun overlap avec l'upstream.
- **`scripts/desktop-ops/`** — nos scripts d'exploitation desktop, isolés.

Conclusion : ta prémisse est correcte, le clacard (Clawcal) est déjà largement isolé.

### Zones à faible risque (petits diffs, probablement des renommages/strings)

Fichiers avec &lt;20 lignes changées de notre côté — probablement juste des
remplacements de nom de marque ou petits ajustements :

`apps/desktop/package.json`, `apps/desktop/src/window/DesktopWindow.ts`,
`apps/desktop/src/wsl/DesktopWslEnvironment.ts`, `ClaudeProvider.ts`,
`CodexProvider.ts`, `CursorProvider.ts` (+test), `GrokProvider.ts`,
`ProviderRegistry.test.ts`, `linkEnvironment.ts`, `AppSidebarLayout.tsx`,
`connection/platform.ts`, `routes/__root.tsx`, `routes/_chat.index.tsx`,
`agentAwareness.ts` (+test), `build-desktop-artifact.ts` (+test)

Un rebase automatique devrait absorber ces conflits en quelques minutes de résolution
manuelle par fichier.

### Zones à risque réel (gros diffs — vraies divergences fonctionnelles)

Fichiers où on a substantiellement réécrit la logique, probablement pour brancher
Clawcal dans l'UI existante :

| Fichier | Lignes changées |
|---|---|
| `settings/ConnectionsSettings.tsx` | 570 |
| `Sidebar.tsx` | 307 |
| `settings/SettingsPanels.tsx` | 268 |
| `GitActionsControl.tsx` | 198 |
| `settings/DiagnosticsSettings.tsx` | 172 |
| `GitActionsControl.logic.test.ts` | 112 |
| `DiffPanel.tsx` | 88 |
| `ChatView.tsx` | 83 |
| `ChatMarkdown.tsx` | 58 |
| `chat/MessagesTimeline.tsx` | 58 |

Ce sont les fichiers où un `git merge`/`rebase` va probablement générer de vrais
conflits de contenu, pas juste des divergences de forme. C'est là que sera le vrai
travail.

## Options

1. **Rebase complet sur upstream/main** — le plus propre à terme, mais 105 commits
   à rejouer par-dessus nos 27 ; risque de conflits répétés sur les ~10 gros fichiers
   ci-dessus à chaque commit upstream qui les touche.
2. **Merge upstream/main dans notre main** — un seul point de résolution de conflits
   au lieu de 105, plus simple à gérer, historique moins linéaire (acceptable pour
   un fork perso).
3. **Sync sélectif par sous-système** — ne merger que certains dossiers upstream
   (ex. providers, correctifs desktop) via `git checkout upstream/main -- <path>`,
   en laissant les 10 gros fichiers de côté pour l'instant. Rapide, mais on
   accumule une dette de sync sur les fichiers exclus.
4. **Ne rien faire** — rester sur notre branche, accepter de perdre les futures
   features upstream tant qu'on n'a pas de fenêtre pour absorber le merge.

## Recommandation

Option 2 (merge unique) est probablement le meilleur rapport effort/risque pour un
fork perso activement customisé : un seul passage de résolution de conflits,
concentré sur les ~10 fichiers à risque réel identifiés ci-dessus. Les zones Clawcal
et branding ne bougeront pas.

## Prochaine étape (si on va de l'avant)

- Créer une branche `sync/upstream-<date>` à partir de `main`
- `git merge <upstream>/main` sur cette branche
- Résoudre les conflits fichier par fichier, en commençant par les gros (table
  ci-dessus) — probablement en gardant notre structure et en réintégrant la logique
  upstream par-dessus
- Faire tourner `pnpm test` + `pnpm typecheck` avant de merger dans `main`
