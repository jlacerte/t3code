export function revealInFileExplorerLabel(platform: string): string {
  const normalized = platform.toLowerCase();
  if (normalized.includes("mac")) return "Afficher dans le Finder";
  if (normalized.includes("win")) return "Afficher dans l'Explorateur de fichiers";
  return "Afficher dans Fichiers";
}
