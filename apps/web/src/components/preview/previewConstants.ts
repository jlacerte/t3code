/** Cap for the per-thread "recently seen" URL list shown in the empty state. */
export const PREVIEW_RECENT_URL_LIMIT = 10;

/**
 * Common Chromium error codes mapped to a short human label. Used by the
 * unreachable view to drop the raw `ERR_*` code in favour of friendlier copy.
 */
export const PREVIEW_ERROR_CODE_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  ERR_NAME_NOT_RESOLVED: "Adresse DNS introuvable",
  ERR_NAME_RESOLUTION_FAILED: "Adresse DNS introuvable",
  ERR_CONNECTION_REFUSED: "Connexion refusée",
  ERR_CONNECTION_RESET: "Connexion réinitialisée",
  ERR_CONNECTION_CLOSED: "Connexion fermée",
  ERR_CONNECTION_TIMED_OUT: "Délai de connexion dépassé",
  ERR_INTERNET_DISCONNECTED: "Aucune connexion Internet",
  ERR_TIMED_OUT: "Délai de connexion dépassé",
  ERR_CERT_AUTHORITY_INVALID: "Autorité de certification non fiable",
  ERR_CERT_COMMON_NAME_INVALID: "Le nom d'hôte du certificat ne correspond pas",
  ERR_CERT_DATE_INVALID: "Certificat expiré ou pas encore valide",
  ERR_TOO_MANY_REDIRECTS: "Trop de redirections",
});
