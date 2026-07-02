import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { ClawcalSettings } from "@t3tools/contracts";

import {
  buildInitialClawcalProviderSnapshot,
  checkClawcalProviderStatus,
  fetchOllamaModels,
} from "./ClawcalProvider.ts";

const decodeClawcalSettings = Schema.decodeSync(ClawcalSettings);

const ollamaTagsHttpClient = (models: ReadonlyArray<string>) =>
  HttpClient.make((request) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        Response.json({ models: models.map((name) => ({ name, model: name })) }),
      ),
    ),
  );

const unreachableOllamaHttpClient = HttpClient.make((request) =>
  Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status: 503 }))),
);

class FakeConnectionError extends Data.TaggedError("FakeConnectionError")<{
  readonly detail: string;
}> {}

describe("buildInitialClawcalProviderSnapshot", () => {
  it.effect("returns a disabled snapshot when settings.enabled is false", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialClawcalProviderSnapshot(decodeClawcalSettings({}));
      expect(snapshot.enabled).toBe(false);
      expect(snapshot.status).toBe("disabled");
      expect(snapshot.installed).toBe(false);
      expect(snapshot.message).toContain("désactivé");
    }),
  );

  it.effect("returns a pending snapshot when enabled", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialClawcalProviderSnapshot(
        decodeClawcalSettings({ enabled: true }),
      );
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("warning");
      expect(snapshot.version).toBeNull();
      expect(snapshot.message).toContain("Vérification");
      expect(snapshot.requiresNewThreadForModelChange).toBe(false);
    }),
  );
});

describe("fetchOllamaModels", () => {
  it.effect("lists and dedupes installed Ollama models", () =>
    Effect.gen(function* () {
      const models = yield* fetchOllamaModels("http://127.0.0.1:11434/").pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          ollamaTagsHttpClient(["qwen3:14b", "llama3.1:8b", "qwen3:14b"]),
        ),
      );
      expect(Option.isSome(models)).toBe(true);
      if (Option.isSome(models)) {
        expect(models.value.map((model) => model.slug)).toEqual(["qwen3:14b", "llama3.1:8b"]);
      }
    }),
  );

  it.effect("returns none when Ollama responds with an error status", () =>
    Effect.gen(function* () {
      const models = yield* fetchOllamaModels("http://127.0.0.1:11434").pipe(
        Effect.provideService(HttpClient.HttpClient, unreachableOllamaHttpClient),
      );
      expect(Option.isNone(models)).toBe(true);
    }),
  );

  it.effect("returns none when the request itself fails", () =>
    Effect.gen(function* () {
      const models = yield* fetchOllamaModels("http://127.0.0.1:11434").pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make(
            () => Effect.fail(new FakeConnectionError({ detail: "connection refused" })) as never,
          ),
        ),
      );
      expect(Option.isNone(models)).toBe(true);
    }),
  );
});

it.layer(NodeServices.layer)("checkClawcalProviderStatus", (it) => {
  it.effect("reports the binary as missing when the binary path does not resolve", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkClawcalProviderStatus(
        decodeClawcalSettings({
          enabled: true,
          binaryPath: "/definitely/not/installed/clawcal-binary",
        }),
      ).pipe(Effect.provideService(HttpClient.HttpClient, ollamaTagsHttpClient(["qwen3:14b"])));
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(false);
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toContain("introuvable");
    }),
  );

  it.effect("reports an installed CLI as unhealthy when --version exits non-zero", () =>
    Effect.gen(function* () {
      const secretStderr = "broken clawcal install: secret-token-value";
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-clawcal-version-" });
          const clawcalPath = path.join(dir, "clawcal");
          yield* fs.writeFileString(
            clawcalPath,
            ["#!/bin/sh", `printf "%s\\n" "${secretStderr}" >&2`, "exit 2", ""].join("\n"),
          );
          yield* fs.chmod(clawcalPath, 0o755);

          return yield* checkClawcalProviderStatus(
            decodeClawcalSettings({ enabled: true, binaryPath: clawcalPath }),
          ).pipe(Effect.provideService(HttpClient.HttpClient, ollamaTagsHttpClient(["qwen3:14b"])));
        }),
      );

      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toBe("Le binaire clawcal est installé mais n'a pas pu s'exécuter.");
      expect(snapshot.message).not.toContain(secretStderr);
    }),
  );

  it.effect("reports a warning with the URL when Ollama is unreachable", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-clawcal-ollama-" });
          const clawcalPath = path.join(dir, "clawcal");
          yield* fs.writeFileString(
            clawcalPath,
            ["#!/bin/sh", 'printf "clawcal 0.1.0\\n"', "exit 0", ""].join("\n"),
          );
          yield* fs.chmod(clawcalPath, 0o755);

          return yield* checkClawcalProviderStatus(
            decodeClawcalSettings({
              enabled: true,
              binaryPath: clawcalPath,
              serverUrl: "http://127.0.0.1:11500",
            }),
          ).pipe(Effect.provideService(HttpClient.HttpClient, unreachableOllamaHttpClient));
        }),
      );

      expect(snapshot.status).toBe("warning");
      expect(snapshot.installed).toBe(true);
      expect(snapshot.version).toBe("0.1.0");
      expect(snapshot.message).toContain("http://127.0.0.1:11500");
      expect(snapshot.message).toContain("injoignable");
    }),
  );

  it.effect("reports ready with the discovered Ollama model catalog", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-clawcal-ready-" });
          const clawcalPath = path.join(dir, "clawcal");
          yield* fs.writeFileString(
            clawcalPath,
            ["#!/bin/sh", 'printf "clawcal 0.1.0\\n"', "exit 0", ""].join("\n"),
          );
          yield* fs.chmod(clawcalPath, 0o755);

          return yield* checkClawcalProviderStatus(
            decodeClawcalSettings({ enabled: true, binaryPath: clawcalPath }),
          ).pipe(
            Effect.provideService(
              HttpClient.HttpClient,
              ollamaTagsHttpClient(["qwen3:14b", "llama3.1:8b"]),
            ),
          );
        }),
      );

      expect(snapshot.status).toBe("ready");
      expect(snapshot.installed).toBe(true);
      expect(snapshot.version).toBe("0.1.0");
      expect(snapshot.models.map((model) => model.slug)).toEqual(["qwen3:14b", "llama3.1:8b"]);
      expect(snapshot.message).toBeUndefined();
    }),
  );

  it.effect("warns when Ollama is reachable but has no installed models", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-clawcal-empty-" });
          const clawcalPath = path.join(dir, "clawcal");
          yield* fs.writeFileString(
            clawcalPath,
            ["#!/bin/sh", 'printf "clawcal 0.1.0\\n"', "exit 0", ""].join("\n"),
          );
          yield* fs.chmod(clawcalPath, 0o755);

          return yield* checkClawcalProviderStatus(
            decodeClawcalSettings({ enabled: true, binaryPath: clawcalPath }),
          ).pipe(Effect.provideService(HttpClient.HttpClient, ollamaTagsHttpClient([])));
        }),
      );

      expect(snapshot.status).toBe("warning");
      expect(snapshot.message).toContain("Aucun modèle");
    }),
  );
});
