import type { ServerProvider, ServerProviderVersionAdvisory } from "@t3tools/contracts";

/**
 * Visual treatment for each server-reported provider status. Centralized so
 * the default-driver card and per-instance cards share the same language.
 */
export const PROVIDER_STATUS_STYLES = {
  disabled: {
    dot: "bg-amber-400",
  },
  error: {
    dot: "bg-destructive",
  },
  ready: {
    dot: "bg-success",
  },
  warning: {
    dot: "bg-warning",
  },
} as const;

export type ProviderStatusKey = keyof typeof PROVIDER_STATUS_STYLES;

/**
 * Derive the headline + detail copy shown under a provider's name in the
 * settings page. Prefers `provider.message` for server-supplied detail and
 * falls back to generic phrasing when the server has not yet reported any
 * state — which happens before the first probe or when an instance names a
 * driver this build does not ship.
 */
export function getProviderSummary(provider: ServerProvider | undefined) {
  if (!provider) {
    return {
      headline: "Vérification du statut du fournisseur",
      detail: "En attente des détails d'installation et d'authentification du serveur.",
    };
  }
  if (!provider.enabled) {
    return {
      headline: "Désactivé",
      detail:
        provider.message ??
        "Ce fournisseur est installé mais désactivé pour les nouvelles sessions dans T3CodeQC.",
    };
  }
  if (!provider.installed) {
    return {
      headline: "Introuvable",
      detail: provider.message ?? "CLI non détecté dans le PATH.",
    };
  }
  if (provider.auth.status === "authenticated") {
    const authLabel = provider.auth.label ?? provider.auth.type;
    return {
      headline: authLabel ? `Authentifié · ${authLabel}` : "Authentifié",
      detail: provider.message ?? null,
    };
  }
  if (provider.auth.status === "unauthenticated") {
    return {
      headline: "Non authentifié",
      detail: provider.message ?? null,
    };
  }
  if (provider.status === "warning") {
    return {
      headline: "Attention requise",
      detail:
        provider.message ??
        "Le fournisseur est installé, mais le serveur n'a pas pu le vérifier complètement.",
    };
  }
  if (provider.status === "error") {
    return {
      headline: "Indisponible",
      detail: provider.message ?? "Le fournisseur a échoué à ses vérifications de démarrage.",
    };
  }
  return {
    headline: "Disponible",
    detail: provider.message ?? "Installé et prêt, mais l'authentification n'a pas pu être vérifiée.",
  };
}

/**
 * Normalize a version string for display. Adds the `v` prefix when the
 * driver reported a bare version (e.g. `1.2.3`) so cards render
 * consistently regardless of driver.
 */
export function getProviderVersionLabel(version: string | null | undefined) {
  if (!version) return null;
  return version.startsWith("v") ? version : `v${version}`;
}

export function getProviderVersionAdvisoryPresentation(
  advisory: ServerProviderVersionAdvisory | undefined,
): {
  readonly detail: string;
  readonly updateCommand: string | null;
  readonly emphasis: "normal" | "strong";
} | null {
  if (!advisory || advisory.status === "current" || advisory.status === "unknown") {
    return null;
  }

  const label = "Mise à jour disponible";
  const version = advisory.latestVersion;
  const versionLabel = getProviderVersionLabel(version);

  return {
    detail:
      advisory.message ??
      (versionLabel
        ? `${label} : installe ${versionLabel}.`
        : `${label} : installe la dernière version du fournisseur.`),
    updateCommand: advisory.updateCommand,
    emphasis: "normal" as const,
  };
}
