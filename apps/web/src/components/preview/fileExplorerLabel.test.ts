import { describe, expect, it } from "vite-plus/test";

import { revealInFileExplorerLabel } from "./fileExplorerLabel";

describe("revealInFileExplorerLabel", () => {
  it.each([
    ["MacIntel", "Afficher dans le Finder"],
    ["Win32", "Afficher dans l'Explorateur de fichiers"],
    ["Linux x86_64", "Afficher dans Fichiers"],
  ])("maps %s to %s", (platform, expected) => {
    expect(revealInFileExplorerLabel(platform)).toBe(expected);
  });
});
