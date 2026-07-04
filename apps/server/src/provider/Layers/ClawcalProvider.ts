import {
  type ClawcalSettings,
  type ModelCapabilities,
  ProviderDriverKind,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { causeErrorTag } from "@t3tools/shared/observability";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import {
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  type ProviderMaintenanceCapabilities,
} from "../providerMaintenance.ts";
import { resolveClawcalOllamaUrl } from "../acp/ClawcalAcpSupport.ts";

const CLAWCAL_PRESENTATION = {
  displayName: "Clawcal",
  badgeLabel: "Local",
  showInteractionModeToggle: false,
  requiresNewThreadForModelChange: false,
} as const;
const PROVIDER = ProviderDriverKind.make("clawcal");
const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

const VERSION_PROBE_TIMEOUT_MS = 4_000;
const OLLAMA_TAGS_TIMEOUT_MS = 3_000;

const OllamaTagsResponse = Schema.Struct({
  models: Schema.Array(
    Schema.Struct({
      name: Schema.String,
    }),
  ),
});

const ClawcalPersonaEntry = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  model: Schema.optional(Schema.String),
});
const decodeClawcalPersonas = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Array(ClawcalPersonaEntry)),
);

export function buildInitialClawcalProviderSnapshot(
  clawcalSettings: ClawcalSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = clawcalModelsFromSettings(clawcalSettings.customModels);

    if (!clawcalSettings.enabled) {
      return buildServerProvider({
        presentation: CLAWCAL_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Clawcal est désactivé dans les paramètres de T3 Code.",
        },
      });
    }

    return buildServerProvider({
      presentation: CLAWCAL_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Vérification de la disponibilité de Clawcal...",
      },
    });
  });
}

function clawcalModelsFromSettings(
  customModels: ReadonlyArray<string> | undefined,
  discoveredModels: ReadonlyArray<ServerProviderModel> = [],
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(
    discoveredModels,
    PROVIDER,
    customModels ?? [],
    EMPTY_CAPABILITIES,
  );
}

/**
 * List the locally installed Ollama models via `GET /api/tags`. Failures are
 * surfaced as `Option.none` so the probe can distinguish "Ollama unreachable"
 * from "reachable but empty".
 */
export const fetchOllamaModels = (
  ollamaUrl: string,
): Effect.Effect<Option.Option<ReadonlyArray<ServerProviderModel>>, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const request = HttpClientRequest.get(`${ollamaUrl.replace(/\/+$/, "")}/api/tags`).pipe(
      HttpClientRequest.setHeader("accept", "application/json"),
    );
    const response = yield* client.execute(request).pipe(
      Effect.timeoutOption(OLLAMA_TAGS_TIMEOUT_MS),
      Effect.orElseSucceed(() => Option.none()),
    );
    if (Option.isNone(response)) {
      return Option.none();
    }
    const httpResponse = response.value;
    if (httpResponse.status < 200 || httpResponse.status >= 300) {
      return Option.none();
    }
    const payload = yield* httpResponse.json.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(OllamaTagsResponse)),
      Effect.orElseSucceed(() => null),
    );
    if (payload === null) {
      return Option.none();
    }
    const seen = new Set<string>();
    const models = payload.models
      .map((model): ServerProviderModel | undefined => {
        const slug = model.name.trim();
        if (!slug || seen.has(slug)) {
          return undefined;
        }
        seen.add(slug);
        return {
          slug,
          name: slug,
          isCustom: false,
          capabilities: EMPTY_CAPABILITIES,
        };
      })
      .filter((model): model is ServerProviderModel => model !== undefined);
    return Option.some(models);
  });

const runClawcalCommand = (
  clawcalSettings: ClawcalSettings,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv = process.env,
) =>
  Effect.gen(function* () {
    const command = clawcalSettings.binaryPath || "clawcal";
    const spawnCommand = yield* resolveSpawnCommand(command, args, {
      env: environment,
    });
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: environment,
        shell: spawnCommand.shell,
      }),
    );
  });

const runClawcalVersionCommand = (
  clawcalSettings: ClawcalSettings,
  environment: NodeJS.ProcessEnv = process.env,
) => runClawcalCommand(clawcalSettings, ["--version"], environment);

/**
 * List the personas configured in `~/.clawcal/personas/` via
 * `clawcal personas --json`, mapped to persona:<id> model entries for the
 * catalog. Any failure (older binary without the subcommand, timeout,
 * non-JSON output) resolves to an empty list: personas are an optional
 * enrichment, never a reason to degrade the provider status.
 */
const fetchClawcalPersonas = (
  clawcalSettings: ClawcalSettings,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.Effect<
  ReadonlyArray<ServerProviderModel>,
  never,
  ChildProcessSpawner.ChildProcessSpawner
> =>
  Effect.gen(function* () {
    const result = yield* runClawcalCommand(
      clawcalSettings,
      ["personas", "--json"],
      environment,
    ).pipe(Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS), Effect.result);
    if (Result.isFailure(result) || Option.isNone(result.success)) {
      return [];
    }
    const output = result.success.value;
    if (output.code !== 0) {
      return [];
    }
    const entries = yield* decodeClawcalPersonas(output.stdout.trim()).pipe(
      Effect.orElseSucceed(() => null),
    );
    if (entries === null) {
      return [];
    }
    const seen = new Set<string>();
    return entries.flatMap((entry): ReadonlyArray<ServerProviderModel> => {
      const slug = entry.id.trim();
      const name = entry.name.trim();
      if (!slug || !name || seen.has(slug)) {
        return [];
      }
      seen.add(slug);
      return [{ slug, name, isCustom: false, capabilities: EMPTY_CAPABILITIES }];
    });
  });

export const checkClawcalProviderStatus = Effect.fn("checkClawcalProviderStatus")(function* (
  clawcalSettings: ClawcalSettings,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | HttpClient.HttpClient
> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallbackModels = clawcalModelsFromSettings(clawcalSettings.customModels);

  if (!clawcalSettings.enabled) {
    return buildServerProvider({
      presentation: CLAWCAL_PRESENTATION,
      enabled: false,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Clawcal est désactivé dans les paramètres de T3 Code.",
      },
    });
  }

  const versionResult = yield* runClawcalVersionCommand(clawcalSettings, environment).pipe(
    Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(versionResult)) {
    const error = versionResult.failure;
    yield* Effect.logWarning("Clawcal CLI health check failed.", {
      errorTag: error._tag,
    });
    return buildServerProvider({
      presentation: CLAWCAL_PRESENTATION,
      enabled: clawcalSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? "Le binaire clawcal est introuvable. Installez Clawcal, puis vérifiez le chemin du binaire dans les réglages."
          : "La vérification de disponibilité de Clawcal a échoué.",
      },
    });
  }

  if (Option.isNone(versionResult.success)) {
    return buildServerProvider({
      presentation: CLAWCAL_PRESENTATION,
      enabled: clawcalSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "Le binaire clawcal ne répond pas (délai dépassé sur `clawcal --version`).",
      },
    });
  }

  const versionOutput = versionResult.success.value;
  const version = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
  if (versionOutput.code !== 0) {
    yield* Effect.logWarning("Clawcal version probe exited with a non-zero status.", {
      exitCode: versionOutput.code,
      stdoutLength: versionOutput.stdout.length,
      stderrLength: versionOutput.stderr.length,
    });
    return buildServerProvider({
      presentation: CLAWCAL_PRESENTATION,
      enabled: clawcalSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "Le binaire clawcal est installé mais n'a pas pu s'exécuter.",
      },
    });
  }

  const personaModels = yield* fetchClawcalPersonas(clawcalSettings, environment);
  const ollamaUrl = resolveClawcalOllamaUrl(clawcalSettings);
  const discoveredModels = yield* fetchOllamaModels(ollamaUrl);
  if (Option.isNone(discoveredModels)) {
    return buildServerProvider({
      presentation: CLAWCAL_PRESENTATION,
      enabled: clawcalSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "warning",
        auth: { status: "unknown" },
        message: `Ollama est injoignable à ${ollamaUrl}. Démarrez Ollama ou corrigez l'URL du serveur dans les réglages.`,
      },
    });
  }

  if (discoveredModels.value.length === 0 && fallbackModels.length === 0) {
    return buildServerProvider({
      presentation: CLAWCAL_PRESENTATION,
      enabled: clawcalSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "warning",
        auth: { status: "unknown" },
        message: `Aucun modèle installé dans Ollama à ${ollamaUrl}. Téléchargez-en un, par exemple : ollama pull qwen3:14b.`,
      },
    });
  }

  return buildServerProvider({
    presentation: CLAWCAL_PRESENTATION,
    enabled: clawcalSettings.enabled,
    checkedAt,
    models: [
      ...personaModels,
      ...clawcalModelsFromSettings(clawcalSettings.customModels, discoveredModels.value),
    ],
    probe: {
      installed: true,
      version,
      status: "ready",
      auth: { status: "unknown" },
    },
  });
});

export const enrichClawcalSnapshot = (input: {
  readonly snapshot: ServerProvider;
  readonly maintenanceCapabilities: ProviderMaintenanceCapabilities;
  readonly enableProviderUpdateChecks?: boolean;
  readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
  readonly httpClient: HttpClient.HttpClient;
}): Effect.Effect<void> => {
  const { snapshot, publishSnapshot } = input;

  return enrichProviderSnapshotWithVersionAdvisory(snapshot, input.maintenanceCapabilities, {
    enableProviderUpdateChecks: input.enableProviderUpdateChecks,
  }).pipe(
    Effect.provideService(HttpClient.HttpClient, input.httpClient),
    Effect.flatMap((enrichedSnapshot) => publishSnapshot(enrichedSnapshot)),
    Effect.catchCause((cause) =>
      Effect.logWarning("Clawcal version advisory enrichment failed", {
        errorTag: causeErrorTag(cause),
      }),
    ),
    Effect.asVoid,
  );
};
