# Plan — T3 Code version québécoise francophone

## Contexte
- Repo original : https://github.com/pingdotgg/t3code (par t3code, créateur suivi sur YouTube)
- Fork perso : https://github.com/jlacerte/t3code
- Clone local : C:\Users\lokim\t3code-quebec
- Remotes configurés : `origin` (fork) + `upstream` (repo original)
- Le projet upstream n'accepte pas encore de contributions publiques (PR) — ce fork restera indépendant pour l'instant.

## Objectif
Adapter T3 Code (GUI desktop pour agents de codage IA : Codex, Claude, Cursor, OpenCode) en français québécois pour ma communauté.
- Traduction + adaptation culturelle (ton, expressions québécoises), pas juste une traduction littérale.
- Remplacement direct en dur du texte anglais par du français québécois (pas de système i18n bilingue — décision assumée : rend les futurs merges avec upstream plus difficiles, mais plus rapide à livrer).
- Périmètre initial : app desktop seulement (pas mobile, web public, marketing pour l'instant).

## Ce qu'on sait de la stack (scoping fait)
- App desktop = shell Electron 41 (`apps/desktop/src`) qui charge en renderer l'app React 19 qui vit dans `apps/web` (`@t3tools/web`) — TanStack Router, Base UI, Lexical, Vite.
- Aucun système i18n existant (pas de react-i18next/react-intl/next-intl). Tout le texte est en dur dans le JSX/TS.
- Zones de texte à traduire :
  - `apps/web/src/components/**/*.tsx` — ~182 fichiers, estimation 120-150 avec du texte utilisateur (chat, sidebar, diffs, files, preview, command palette, etc.)
  - `apps/desktop/src/window/DesktopApplicationMenu.ts` + `apps/desktop/src/electron/ElectronMenu.ts` — menus natifs OS (File, View, Check for Updates…)
  - `apps/desktop/src/electron/ElectronUpdater.ts` — messages de notification ("You're up to date!", etc.)
  - `apps/desktop/src/electron/ElectronDialog.ts` — dialogues natifs
  - À vérifier : `packages/shared/terminalLabels.ts` et `chatList.ts` (labels possibles)
  - À vérifier : `packages/contracts` (probablement des schémas IPC, pas du texte UI, mais à confirmer)

## Tableau de bord — progression

| Étape | Statut | Progression |
|---|---|---|
| 1. Vérifier terminalLabels.ts / chatList.ts / packages/contracts | ✅ Terminé | [██████████] 100% |
| 2. Inventaire complet des fichiers avec texte utilisateur | ✅ Terminé | [██████████] 100% |
| 3. Convention de ton (tutoiement, glossaire technique) | ✅ Terminé | [██████████] 100% |
| 4. Traduction par lots (par dossier de composants) | ✅ Terminé | [██████████] ~100% |
| 5. Rebranding (optionnel, hors scope actuel) | ⬜ Non planifié | [░░░░░░░░░░] 0% |

### Détail — Lot 4 (traduction par lots), suivi par lot

| Lot | Fichiers | Chaînes ~ | Statut |
|---|---|---|---|
| 1 — Settings | 11 | ~448 (réel) | ✅ Terminé |
| 2 — Coquille principale / navigation | 13 | ~359 (réel) | ✅ Terminé |
| 3 — Chat/composer | 36 | ~164 (réel) | ✅ Terminé |
| 4 — Preview | 13 | ~71 (réel) | ✅ Terminé |
| 5 — Menus/dialogues Electron desktop | 2 | ~12 (réel) | ✅ Terminé |
| 6 — Divers/résiduel (auth/clerk/cloud/files/sidebar/diffs) | 11 | ~74 (réel) | ✅ Terminé |
| 7 — Fichiers `.logic.ts` découverts en cours de traduction | 12 | ~99 (réel) | ✅ Terminé (2 cas reportés, voir ci-dessous) |

**Total traduit à ce jour : ~1227 chaînes.**

### Passe 2 (2026-07-02) — résidus traités ✅
Un balayage complet du périmètre desktop a révélé plus de résidus anglais que prévu (le tableau « Lot 4 ~100% » était optimiste). Tous traités et **typecheck vert** (web + shared + desktop) :
- `Sidebar.logic.ts` : labels de statut traduits via une fonction de mappage `getThreadStatusDisplayLabel` (clé anglaise gardée stable pour la logique/tests) ; appliquée dans `ThreadStatusIndicators.tsx` et `Sidebar.tsx`.
- `ProviderUpdateLaunchNotification.logic.ts` : chaînes de secours anglaises (`Provider update failed`) traduites.
- `errorCodeMessages` / `previewConstants.ts` : messages d'erreur Chromium de l'aperçu traduits.
- `ChatView.logic.ts` : accord pluriel corrigé dans `buildExpiredTerminalContextToastCopy` (verbe + pronoms).
- `Sidebar.tsx` : bloc de connexion des backends secondaires (`Connecting`/`Couldn't connect`/`The backend didn't respond`).
- `packages/shared` : `agentAwareness.ts` (headlines de statut agent), `toolActivity.ts` (résumés timeline), `previewViewport.ts` (`Fill panel`).
- Fichiers entièrement anglais : `settings/providerStatus.ts`, `desktop/SshPasswordPromptDialog.tsx`, `preview/fileExplorerLabel.ts`, `preview/openTerminalLinkInPreview.ts` (labels de menu).
- `ChatMarkdown.tsx` : bloc complet (aria-labels tableau/code, menus Copier, toasts « Impossible d'ouvrir », labels de menu contextuel).
- Divers : `MessagesTimeline.tsx` (alt), `ProviderUpdateEnvironmentRows.tsx`, `ChatView.tsx` (erreurs de script), `SidebarUpdatePill.tsx` (« Build » → « Version »).
- Desktop natif : `DesktopWindow.ts` (menu contextuel clic droit), `DesktopServerExposure.ts` (labels de points d'accès).

### Reste à couvrir (non bloquant)
- **`Terminal ${N}`** (`terminalLabels.ts`) : « Terminal » identique en français — laissé tel quel (jargon).
- **Labels de groupe de fournisseurs** `DesktopServerExposure.ts` : `"Desktop"` (L50) et `"Manual"` (L57) — faible confiance qu'ils soient affichés ; à trancher.
- **Messages diagnostiques « borderline »** (généralement `console.error`/`.message` d'erreurs loggées, pas de l'UI traduite) : `schemaJson.ts`, getters `.message` des `TaggedError` (`ElectronDialog.ts`, `previewAutomationErrors.ts`, `Net.ts`, `openTerminalLinkInPreview.ts`), `ChatView.tsx` L1974.
- **`ui/` (primitives shadcn) et fichiers `.test`** : hors scope. ⚠️ Voir la note sur les tests ci-dessous.

### Note sur les tests (`vp test`) — ✅ corrigés (2026-07-02)
Les fichiers `.test` assertaient encore les chaînes **anglaises** d'origine (dérive dès le 1er commit de traduction). **Corrigé** : assertions alignées sur la sortie française (commit `98fa31e68`). État final : **web 1278/1278 · desktop entièrement vert · shared OK**. Restent **5 échecs shared pré-existants et environnementaux** (`relayClient` = binaire cloudflared/chemins Windows ; `logging` = rotation de fichier) — aucun lien avec la traduction, déjà rouges au tout premier run.

### Passe 3 (2026-07-02) — exécution & vérification en direct ✅
- **Commits poussés** sur `jlacerte/t3code` (`main`) : `bd2d4d2cc` (traductions passe 2) + `98fa31e68` (tests FR).
- **Environnement dev réparé** (voir la mémoire `t3code-quebec` pour les commandes exactes) :
  - Node du système = v22 (trop vieux pour `dev-runner.ts` et corepack) → **Node 24.18 installé via `fnm`**.
  - `pnpm` installé via `npm -g` (corepack cassé) ; binding natif `vp` Windows ajouté localement (NON committé).
  - Le stack complet démarre avec `pnpm dev` **sous Node 24** (serveur back-end `:13773` + web Vite `:5733`), câblage de ports par `dev-runner`.
  - L'app exige un **jumelage** : ouvrir `http://localhost:5733/pair#token=<TOKEN>` (le token est dans le log serveur ; change à chaque redémarrage `--watch`).
- **Vérification visuelle réussie** : app pairée, interface FR confirmée en production. Le pill « fournisseur encore désuet » (Codex) rend correctement en français — validation bout-en-bout d'une zone traduite.
- **Chrome DevTools MCP installé** (scope utilisateur, `~/.claude.json`) mais nécessite un **redémarrage de session** pour être chargé → permettra d'inspecter la console navigateur et de screenshoter l'app côté client (le point aveugle du log serveur).

### Ajustements au glossaire (décidés en cours de traduction)
- "Worktree" : gardé en anglais (jargon git, comme "branch"/"commit").
- "Working tree" : traduit par "Arbre de travail" (à valider, faute de meilleure option).
- "ref"/"refs" (Git) : traduit par "réf"/"réfs".
- "Repository" (nom de champ générique) : traduit par "Repo" (pas "Dépôt") pour cohérence avec le jargon Git conservé.

Légende : ⬜ à faire · 🔄 en cours · ✅ terminé
Mettre à jour cette section à chaque étape complétée.

## Inventaire des chaînes à traduire (résultat étape 1-2)

- `packages/shared/terminalLabels.ts` : 1 seule chaîne (`Terminal ${N}`).
- `packages/shared/chatList.ts` : aucun texte utilisateur (logique pure).
- `packages/contracts/**` (29 fichiers) : aucun texte UI — schémas IPC uniquement. **Exclu du travail.**
- `apps/desktop/src/window/DesktopApplicationMenu.ts` : ~10 chaînes (menu natif + dialogues de mise à jour).
- `apps/desktop/src/electron/ElectronDialog.ts` : 1 chaîne (`["No", "Yes"]`).
- `apps/desktop/src/electron/ElectronMenu.ts`, `ElectronUpdater.ts` : aucune chaîne en dur.
- `apps/web/src/components/**/*.tsx` (158 fichiers avec texte) : ~430 chaînes, réparties en 6 lots (voir tableau de bord ci-dessus).

Top fichiers prioritaires (le plus de texte) : `ConnectionsSettings.tsx` (~62), `SettingsPanels.tsx` (~51), `DiagnosticsSettings.tsx` (~48), `KeybindingsSettings.tsx` (~24), `Sidebar.tsx` (~23), `ProjectScriptsControl.tsx` (~17), `SourceControlSettings.tsx` (~14), `ProviderInstanceCard.tsx` (~12), `DiffPanel.tsx` (~12), `CommandPalette.tsx` (~12).

## Prochaines étapes proposées (à valider/ajuster au retour)
1. ~~Vérifier `packages/shared/terminalLabels.ts`, `chatList.ts`, et `packages/contracts` pour d'autres chaînes UI.~~ ✅
2. ~~Faire l'inventaire complet des fichiers avec texte utilisateur.~~ ✅
3. Décider d'une convention de ton (ex: tutoiement, expressions québécoises à utiliser/éviter, glossaire de termes techniques à garder en anglais vs traduire — ex: "commit", "pull request", "branch").
4. Traduire par lots (par dossier de composants), en testant l'app au fur et à mesure.
5. Optionnel : renommer l'app (nom/logo) si on va vers un vrai rebranding plus tard — pas dans le scope actuel.

## Convention de ton et glossaire (étape 3 ✅)

**Ton** : tutoiement partout. Expressions québécoises naturelles, pas de joual caricatural (ex: "peser sur", "c'est correct", "présentement").

**Garder en anglais** (jargon technique standard) : commit, pull request, branch, merge, diff, repo, stash, rebase, checkout, terminal, prompt, token, agent.

**Traduire** : Settings → Paramètres · File/View/Edit → Fichier/Affichage/Édition · Check for Updates → Vérifier les mises à jour · Send/Cancel/Save → Envoyer/Annuler/Enregistrer · Preview → Aperçu. Labels visibles à l'utilisateur toujours traduits ; noms de composants/props internes non touchés.

## Décisions déjà prises
- Fork + clone : fait.
- Approche : remplacement direct (pas de couche i18n).
- Ton : traduction + adaptation culturelle québécoise.
- Périmètre v1 : app desktop uniquement.

## Note sur le mode de travail
L'utilisateur veut moins de questions de validation à chaque étape — procéder avec des choix raisonnables par défaut et résumer à la fin plutôt que de tout valider en cours de route. Les prompts de permission d'outils (bash/edit) sont un sujet séparé, contrôlé par le mode de permission de la session Claude Code (pas par les choix de design) — l'utilisateur prévoit de redémarrer en mode moins restrictif ("dangerous"/bypass permissions).
