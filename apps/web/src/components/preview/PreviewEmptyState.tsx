import type { EnvironmentId } from "@t3tools/contracts";
import { Globe, RadioTower } from "lucide-react";

import { Empty, EmptyDescription, EmptyMedia, EmptyTitle } from "~/components/ui/empty";

import { PreviewLocalServerCard } from "./PreviewLocalServerCard";
import { useDiscoveredLocalServers } from "./useDiscoveredLocalServers";

interface Props {
  environmentId: EnvironmentId;
  configuredUrls?: ReadonlyArray<string> | undefined;
  recentlySeenUrls?: ReadonlyArray<string> | undefined;
  onOpenUrl: (url: string) => void;
}

export function PreviewEmptyState({
  environmentId,
  configuredUrls,
  recentlySeenUrls,
  onOpenUrl,
}: Props) {
  const servers = useDiscoveredLocalServers({
    environmentId,
    configuredUrls,
    recentlySeenUrls,
  });

  if (servers.length === 0) {
    return (
      <Empty>
        <EmptyMedia variant="icon">
          <Globe className="size-4.5 text-muted-foreground" />
        </EmptyMedia>
        <EmptyTitle>Aucun aperçu pour l'instant</EmptyTitle>
        <EmptyDescription>
          Entre une URL ci-dessus, ou lance un script de dev. Les ports localhost en écoute
          apparaîtront ici automatiquement.
        </EmptyDescription>
      </Empty>
    );
  }

  return (
    <div className="flex h-full min-h-0 overflow-y-auto px-5 py-8">
      <div className="m-auto flex w-full max-w-xl flex-col gap-3">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <RadioTower className="size-4 shrink-0" />
          <h2 className="font-medium">Serveurs locaux</h2>
        </div>
        <div className="flex flex-col divide-y divide-border/60 overflow-hidden rounded-xl border border-border/70 bg-background">
          {servers.map((server) => (
            <PreviewLocalServerCard
              key={`${server.host}:${server.port}`}
              server={server}
              onOpen={() => onOpenUrl(server.url)}
            />
          ))}
        </div>
        <p className="px-1 text-xs text-muted-foreground">
          Sélectionne un port en écoute pour l'ouvrir dans cet onglet du navigateur.
        </p>
      </div>
    </div>
  );
}
