---
name: t3-build-win
description: >
  Build et empaquette l'application desktop T3 Code pour Windows (installeur NSIS)
  sous Node 24, avec les prérequis et pièges connus. À utiliser pour produire
  l'app Windows packagée, générer l'installeur, ou diagnostiquer un échec de build
  desktop Windows. Déclencheurs : « build windows », « package l'app », « installeur
  NSIS », « dist:desktop:win », « génère l'exe ».
---

# Builder l'app desktop Windows (installeur NSIS)

Fork FR québécois de T3 Code. Clone local : `C:\Users\lokim\t3code`.
Stack desktop : Electron 41 + electron-builder 26 (cible NSIS pour Windows).

## Prérequis d'environnement

- **Node 24 obligatoire** en tête de PATH (le Node système v22 est trop vieux) :

  ```bash
  export PATH="/c/Users/lokim/AppData/Roaming/fnm/node-versions/v24.18.0/installation:$PATH"
  ```

- **NE PAS lancer `pnpm install`** (retirerait le binding vp local `@voidzero-dev/vite-plus-win32-x64-msvc`).
- **Python + toolchain MSVC** peuvent être requis pour compiler les modules natifs
  (node-gyp). Le script cherche Python dans `%LOCALAPPDATA%\Programs\Python\Python31x\python.exe`
  ou via `python` sur le PATH.

## Séquence de build

Le packaging Windows se fait en **deux temps** :

1. **Builder les bundles** (web + serveur + desktop) — prérequis obligatoire, sinon
   le packaging échoue avec `MissingDesktopBuildInputError` (« Run 'vp run build:desktop' first ») :

   ```bash
   export PATH="/c/Users/lokim/AppData/Roaming/fnm/node-versions/v24.18.0/installation:$PATH"
   cd /c/Users/lokim/t3code
   pnpm build:desktop
   ```

2. **Empaqueter l'installeur NSIS** (script `scripts/build-desktop-artifact.ts`) :

   ```bash
   pnpm dist:desktop:win          # arch par défaut de l'hôte
   # ou explicitement :
   pnpm dist:desktop:win:x64
   pnpm dist:desktop:win:arm64
   ```

   Sortie : dossier **`release/`** à la racine du repo (ou `release-mock/` avec
   `--mock-updates`). Artefact nommé `T3-Code-<version>-<arch>.exe`.

   Build long → lancer en arrière-plan et suivre le log :

   ```bash
   nohup pnpm dist:desktop:win > /tmp/t3code-build-win.log 2>&1 &
   ```

## Pièges Windows connus (spécificités de ce build)

- **Backend WSL embarqué** : les artefacts Windows embarquent AUSSI un backend Linux
  qui tourne via `wsl.exe -- node`. Il charge des deps natives Linux (glibc) à
  l'exécution (ex. `@yuuang/ffi-rs-linux-x64-gnu`, node-pty). Le staging tire donc les
  variantes `linux`/`glibc` en plus de l'hôte Windows (voir `createStageWorkspaceConfig`).
  Un `pty.node` Linux prébuilt peut être fourni via `T3CODE_DESKTOP_WSL_PREBUILD`
  pour éviter une compilation chez l'utilisateur.
- **ASAR unpack** : le bundle serveur + tout `node_modules` sont dépaquetés de l'asar
  (le backend WSL ne sait pas lire dans un asar). Ne pas s'étonner de la taille.
- **Deps natives à empaqueter** : node-pty, `@clerk/electron-passkeys-win32-<arch>-msvc`,
  `@ff-labs/fff-bin-win32-<arch>`. Un package manquant → `ClerkPasskeyNativePackageMissingError`
  ou échec de résolution fff.
- **Signature** : `--signed` déclenche la signature (Azure Trusted Signing via variables
  `AZURE_TRUSTED_SIGNING_*`). Par défaut le build est **non signé** — normal en dev local.

## Flags utiles de `build-desktop-artifact.ts`

- `--skip-build` : réutilise les bundles déjà buildés (évite de rebuilder à l'étape 1).
- `--keep-stage` : conserve le dossier de staging pour inspection après échec.
- `--verbose` : logs détaillés (utile pour diagnostiquer node-gyp / electron-builder).
- `--mock-updates` : build pointant vers un faux serveur de MAJ (tests d'auto-update).

## Validation

Après build, vérifier la présence de l'installeur :

```bash
ls -la /c/Users/lokim/t3code/release/*.exe
```

Puis, pour un test runtime réel, installer/lancer l'exe et vérifier le comportement
Windows (comme la page Diagnostics, sensible aux specificités PowerShell/WSL).
