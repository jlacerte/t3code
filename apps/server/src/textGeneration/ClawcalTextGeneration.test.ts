// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeURL from "node:url";
import * as NodeFS from "node:fs";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { createModelSelection } from "@t3tools/shared/model";
import { expect } from "vite-plus/test";
import { ClawcalSettings, ProviderInstanceId } from "@t3tools/contracts";

import * as ServerConfig from "../config.ts";
import * as TextGeneration from "./TextGeneration.ts";
import { makeClawcalTextGeneration } from "./ClawcalTextGeneration.ts";
const decodeClawcalSettings = Schema.decodeSync(ClawcalSettings);

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../scripts/acp-mock-agent.ts");

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

const ClawcalTextGenerationTestLayer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-clawcal-text-generation-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

function makeAcpClawcalWrapper(dir: string, env: Record<string, string>): string {
  const binDir = NodePath.join(dir, "bin");
  const clawcalPath = NodePath.join(binDir, "clawcal");
  NodeFS.mkdirSync(binDir, { recursive: true });
  NodeFS.writeFileSync(
    clawcalPath,
    [
      "#!/bin/sh",
      ...Object.entries(env).map(([key, value]) => `export ${key}=${shellSingleQuote(value)}`),
      'if [ "$1" != "acp" ] || [ "$2" != "--ollama-url" ]; then',
      '  printf "%s\\n" "unexpected args: $*" >&2',
      "  exit 11",
      "fi",
      `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(mockAgentPath)}`,
      "",
    ].join("\n"),
    "utf8",
  );
  NodeFS.chmodSync(clawcalPath, 0o755);
  return clawcalPath;
}

function withFakeAcpClawcal<A, E, R>(
  env: Record<string, string>,
  effectFn: (textGeneration: TextGeneration.TextGeneration["Service"]) => Effect.Effect<A, E, R>,
) {
  return Effect.gen(function* () {
    const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-clawcal-text-acp-"));
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        NodeFS.rmSync(tempDir, { recursive: true, force: true });
      }),
    );
    const binaryPath = makeAcpClawcalWrapper(tempDir, env);
    const config = decodeClawcalSettings({ enabled: true, binaryPath });
    const textGeneration = yield* makeClawcalTextGeneration(config);
    return yield* effectFn(textGeneration);
  }).pipe(Effect.scoped);
}

function readJsonRpcRequests(
  filePath: string,
): ReadonlyArray<{ readonly method?: string; readonly params?: Record<string, unknown> }> {
  return NodeFS.readFileSync(filePath, "utf8")
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as { method?: string; params?: Record<string, unknown> });
}

it.layer(ClawcalTextGenerationTestLayer)("ClawcalTextGeneration", (it) => {
  it.effect("uses ACP with disabled tool capabilities and forwards the requested model id", () => {
    const requestLogDir = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t3code-clawcal-text-log-"),
    );
    const requestLogPath = NodePath.join(requestLogDir, "requests.ndjson");

    return withFakeAcpClawcal(
      {
        T3_ACP_REQUEST_LOG_PATH: requestLogPath,
        T3_ACP_PROMPT_RESPONSE_TEXT: JSON.stringify({
          subject: "Add Clawcal provider",
          body: "Wire up the ACP runtime and headless text generation path.",
        }),
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateCommitMessage({
            cwd: process.cwd(),
            branch: "feature/clawcal",
            stagedSummary: "M apps/server/src/provider/Drivers/ClawcalDriver.ts",
            stagedPatch: "diff --git a/.../ClawcalDriver.ts b/.../ClawcalDriver.ts",
            modelSelection: createModelSelection(
              ProviderInstanceId.make("clawcal"),
              "grok-mock-alt",
            ),
          });

          expect(generated.subject).toBe("Add Clawcal provider");
          expect(generated.body).toBe("Wire up the ACP runtime and headless text generation path.");

          const requests = readJsonRpcRequests(requestLogPath);
          expect(
            requests.find((request) => request.method === "initialize")?.params?.clientCapabilities,
          ).toMatchObject({
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          });
          expect(
            requests.some(
              (request) =>
                request.method === "session/set_model" &&
                request.params?.modelId === "grok-mock-alt",
            ),
          ).toBe(true);
        }),
    );
  });

  it.effect("extracts the JSON object when the model wraps it in conversational text", () =>
    withFakeAcpClawcal(
      {
        T3_ACP_PROMPT_RESPONSE_TEXT:
          "Sure! Here's a thread title:\n\n" +
          JSON.stringify({ title: "Investigate failing CI" }) +
          "\n\nLet me know if you need anything else.",
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateThreadTitle({
            cwd: process.cwd(),
            message: "the lint job is red",
            modelSelection: createModelSelection(
              ProviderInstanceId.make("clawcal"),
              "grok-mock-alt",
            ),
          });
          expect(generated.title).toBe("Investigate failing CI");
        }),
    ),
  );

  it.effect("surfaces model selection failures as text generation errors", () =>
    withFakeAcpClawcal(
      {
        T3_ACP_PROMPT_RESPONSE_TEXT: JSON.stringify({ branch: "unreachable" }),
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const error = yield* Effect.flip(
            textGeneration.generateBranchName({
              cwd: process.cwd(),
              message: "wire up clawcal",
              modelSelection: createModelSelection(
                ProviderInstanceId.make("clawcal"),
                "missing-ollama-model",
              ),
            }),
          );
          expect(error._tag).toBe("TextGenerationError");
          expect(error.detail).toContain("Clawcal model");
        }),
    ),
  );

  it.effect("fails with TextGenerationError when output is empty", () =>
    withFakeAcpClawcal(
      {
        T3_ACP_PROMPT_RESPONSE_TEXT: "   \n  ",
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const error = yield* Effect.flip(
            textGeneration.generateThreadTitle({
              cwd: process.cwd(),
              message: "anything",
              modelSelection: createModelSelection(
                ProviderInstanceId.make("clawcal"),
                "grok-build",
              ),
            }),
          );
          expect(error._tag).toBe("TextGenerationError");
          expect(error.detail).toMatch(/empty/i);
        }),
    ),
  );

  it.effect("fails with TextGenerationError when output is unparseable JSON", () =>
    withFakeAcpClawcal(
      {
        T3_ACP_PROMPT_RESPONSE_TEXT: "totally not json output from a confused model",
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const error = yield* Effect.flip(
            textGeneration.generateThreadTitle({
              cwd: process.cwd(),
              message: "anything",
              modelSelection: createModelSelection(
                ProviderInstanceId.make("clawcal"),
                "grok-build",
              ),
            }),
          );
          expect(error._tag).toBe("TextGenerationError");
          expect(error.detail).toMatch(/invalid structured output/i);
        }),
    ),
  );
});
