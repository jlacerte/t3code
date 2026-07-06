import type { RelayClientDeviceRecord } from "@t3tools/contracts/relay";

const mobileClientUpdatedAtFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

const NOTIFICATION_PREFERENCES = [
  ["notifyOnApproval", "approbations"],
  ["notifyOnInput", "demandes de saisie"],
  ["notifyOnCompletion", "achèvements"],
  ["notifyOnFailure", "échecs"],
] as const satisfies ReadonlyArray<
  readonly [keyof RelayClientDeviceRecord["notifications"], string]
>;

export function mobileClientPlatformLabel(device: RelayClientDeviceRecord): string {
  return `iOS ${device.iosMajorVersion}${device.appVersion ? ` · T3CodeQC ${device.appVersion}` : ""}`;
}

export function mobileClientNotificationDetail(device: RelayClientDeviceRecord): string {
  if (!device.notifications.enabled) {
    return "Les notifications push sont désactivées sur cet appareil.";
  }

  const enabledPreferences = NOTIFICATION_PREFERENCES.flatMap(([preference, label]) =>
    device.notifications[preference] ? [label] : [],
  );
  return enabledPreferences.length > 0
    ? `Alertes activées pour : ${enabledPreferences.join(", ")}.`
    : "Les notifications push sont activées, mais aucun type d'alerte n'est sélectionné.";
}

export function mobileClientUpdatedAtLabel(updatedAt: string): string {
  const date = new Date(updatedAt);
  return Number.isNaN(date.getTime())
    ? "Heure de mise à jour indisponible"
    : `Mis à jour ${mobileClientUpdatedAtFormatter.format(date)}`;
}
