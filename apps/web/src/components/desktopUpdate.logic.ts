import type { DesktopUpdateActionResult, DesktopUpdateState } from "@t3tools/contracts";

export type DesktopUpdateButtonAction = "download" | "install" | "none";

export function resolveDesktopUpdateButtonAction(
  state: DesktopUpdateState,
): DesktopUpdateButtonAction {
  if (state.downloadedVersion) {
    return "install";
  }
  if (state.status === "available") {
    return "download";
  }
  if (state.status === "error") {
    if (state.errorContext === "download" && state.availableVersion) {
      return "download";
    }
  }
  return "none";
}

export function shouldShowDesktopUpdateButton(state: DesktopUpdateState | null): boolean {
  if (!state || !state.enabled) {
    return false;
  }
  if (state.status === "downloading") {
    return true;
  }
  return resolveDesktopUpdateButtonAction(state) !== "none";
}

export function shouldShowArm64IntelBuildWarning(state: DesktopUpdateState | null): boolean {
  return state?.hostArch === "arm64" && state.appArch === "x64";
}

export function isDesktopUpdateButtonDisabled(state: DesktopUpdateState | null): boolean {
  return state?.status === "downloading";
}

export function getArm64IntelBuildWarningDescription(state: DesktopUpdateState): string {
  if (!shouldShowArm64IntelBuildWarning(state)) {
    return "Cette installation utilise la bonne architecture.";
  }

  const action = resolveDesktopUpdateButtonAction(state);
  if (action === "download") {
    return "Ce Mac a un processeur Apple Silicon, mais T3CodeQC utilise encore la version Intel sous Rosetta. Télécharge la mise à jour disponible pour passer à la version native Apple Silicon.";
  }
  if (action === "install") {
    return "Ce Mac a un processeur Apple Silicon, mais T3CodeQC utilise encore la version Intel sous Rosetta. Redémarre pour installer la version Apple Silicon téléchargée.";
  }
  return "Ce Mac a un processeur Apple Silicon, mais T3CodeQC utilise encore la version Intel sous Rosetta. La prochaine mise à jour de l'application la remplacera par la version native Apple Silicon.";
}

export function getDesktopUpdateButtonTooltip(state: DesktopUpdateState): string {
  if (state.status === "available") {
    return `Mise à jour ${state.availableVersion ?? "disponible"} prête à télécharger`;
  }
  if (state.status === "downloading") {
    const progress =
      typeof state.downloadPercent === "number" ? ` (${Math.floor(state.downloadPercent)}%)` : "";
    return `Téléchargement de la mise à jour${progress}`;
  }
  if (state.status === "downloaded") {
    return `Mise à jour ${state.downloadedVersion ?? state.availableVersion ?? "prête"} téléchargée. Clique pour redémarrer et installer.`;
  }
  if (state.status === "error") {
    if (state.errorContext === "download" && state.availableVersion) {
      return `Échec du téléchargement pour ${state.availableVersion}. Clique pour réessayer.`;
    }
    if (state.errorContext === "install" && state.downloadedVersion) {
      return `Échec de l'installation pour ${state.downloadedVersion}. Clique pour réessayer.`;
    }
    return state.message ?? "Échec de la mise à jour";
  }
  return "À jour";
}

export function getDesktopUpdateInstallConfirmationMessage(
  state: Pick<DesktopUpdateState, "availableVersion" | "downloadedVersion">,
): string {
  const version = state.downloadedVersion ?? state.availableVersion;
  return `Installer la mise à jour${version ? ` ${version}` : ""} et redémarrer T3CodeQC?\n\nToutes les tâches en cours seront interrompues. Assure-toi d'être prêt avant de continuer.`;
}

export function getDesktopUpdateActionError(result: DesktopUpdateActionResult): string | null {
  if (!result.accepted || result.completed) return null;
  if (typeof result.state.message !== "string") return null;
  const message = result.state.message.trim();
  return message.length > 0 ? message : null;
}

export function shouldToastDesktopUpdateActionResult(result: DesktopUpdateActionResult): boolean {
  return getDesktopUpdateActionError(result) !== null;
}

export function shouldHighlightDesktopUpdateError(state: DesktopUpdateState | null): boolean {
  if (!state || state.status !== "error") return false;
  return state.errorContext === "download" || state.errorContext === "install";
}

export function canCheckForUpdate(state: DesktopUpdateState | null): boolean {
  if (!state || !state.enabled) return false;
  return (
    state.status !== "checking" &&
    state.status !== "downloading" &&
    state.status !== "downloaded" &&
    state.status !== "disabled"
  );
}
