import { type ClawcalSettings, ProviderDriverKind } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";
import { normalizeModelSlug } from "@t3tools/shared/model";

import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

export const DEFAULT_CLAWCAL_OLLAMA_URL = "http://127.0.0.1:11434";
// Clawcal is a local agent with no account: its `acp` mode accepts any
// authenticate call as a no-op, so this id only satisfies the ACP handshake.
const CLAWCAL_AUTH_METHOD_ID = "local";
const CLAWCAL_DRIVER_KIND = ProviderDriverKind.make("clawcal");

type ClawcalAcpRuntimeClawcalSettings = Pick<ClawcalSettings, "binaryPath" | "serverUrl">;

// `resumeSessionId` is deliberately not accepted: Clawcal does not persist
// conversation history (agentCapabilities.loadSession is false), and the
// shared runtime calls `session/load` unconditionally when a resume id is
// present. Every start is a fresh `session/new`.
interface ClawcalAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "clientCapabilities" | "spawn" | "resumeSessionId"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly clawcalSettings: ClawcalAcpRuntimeClawcalSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
}

export function resolveClawcalOllamaUrl(
  clawcalSettings: ClawcalAcpRuntimeClawcalSettings | null | undefined,
): string {
  const configured = clawcalSettings?.serverUrl?.trim();
  return configured || DEFAULT_CLAWCAL_OLLAMA_URL;
}

export function buildClawcalAcpSpawnInput(
  clawcalSettings: ClawcalAcpRuntimeClawcalSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): AcpSessionRuntime.AcpSpawnInput {
  return {
    command: clawcalSettings?.binaryPath || "clawcal",
    args: ["acp", "--ollama-url", resolveClawcalOllamaUrl(clawcalSettings)],
    cwd,
    ...(environment ? { env: environment } : {}),
  };
}

export const makeClawcalAcpRuntime = (
  input: ClawcalAcpRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Scope.Scope
> =>
  Effect.gen(function* () {
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildClawcalAcpSpawnInput(input.clawcalSettings, input.cwd, input.environment),
        authMethodId: CLAWCAL_AUTH_METHOD_ID,
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
      Effect.provide(acpContext),
    );
  });

export function resolveClawcalModelId(model: string | null | undefined): string | undefined {
  return normalizeModelSlug(model, CLAWCAL_DRIVER_KIND) ?? undefined;
}

export function currentClawcalModelIdFromSessionSetup(
  sessionSetupResult:
    | EffectAcpSchema.LoadSessionResponse
    | EffectAcpSchema.NewSessionResponse
    | EffectAcpSchema.ResumeSessionResponse,
): string | undefined {
  return sessionSetupResult.models?.currentModelId?.trim() || undefined;
}

export function applyClawcalAcpModelSelection<E>(input: {
  readonly runtime: Pick<AcpSessionRuntime.AcpSessionRuntime["Service"], "setSessionModel">;
  readonly currentModelId: string | undefined;
  readonly requestedModelId: string | undefined;
  readonly mapError: (cause: EffectAcpErrors.AcpError) => E;
}): Effect.Effect<string | undefined, E> {
  const shouldSwitchModel =
    input.requestedModelId !== undefined && input.requestedModelId !== input.currentModelId;
  if (!shouldSwitchModel) {
    return Effect.succeed(input.currentModelId);
  }
  return input.runtime
    .setSessionModel(input.requestedModelId)
    .pipe(Effect.mapError(input.mapError), Effect.as(input.requestedModelId));
}
