import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as EffectAcpErrors from "effect-acp/errors";

import {
  applyClawcalAcpModelSelection,
  buildClawcalAcpSpawnInput,
  DEFAULT_CLAWCAL_OLLAMA_URL,
  resolveClawcalModelId,
  resolveClawcalOllamaUrl,
} from "./ClawcalAcpSupport.ts";

describe("resolveClawcalOllamaUrl", () => {
  it("falls back to the default local Ollama URL", () => {
    expect(resolveClawcalOllamaUrl(undefined)).toBe(DEFAULT_CLAWCAL_OLLAMA_URL);
    expect(resolveClawcalOllamaUrl({ binaryPath: "clawcal", serverUrl: "" })).toBe(
      DEFAULT_CLAWCAL_OLLAMA_URL,
    );
    expect(resolveClawcalOllamaUrl({ binaryPath: "clawcal", serverUrl: "   " })).toBe(
      DEFAULT_CLAWCAL_OLLAMA_URL,
    );
  });

  it("keeps a configured server URL", () => {
    expect(
      resolveClawcalOllamaUrl({ binaryPath: "clawcal", serverUrl: "http://192.168.1.10:11434" }),
    ).toBe("http://192.168.1.10:11434");
  });
});

describe("resolveClawcalModelId", () => {
  it("trims Ollama model tags and drops empty values", () => {
    expect(resolveClawcalModelId(undefined)).toBeUndefined();
    expect(resolveClawcalModelId("   ")).toBeUndefined();
    expect(resolveClawcalModelId("  qwen3:14b  ")).toBe("qwen3:14b");
  });
});

describe("buildClawcalAcpSpawnInput", () => {
  it("spawns the acp subcommand with the resolved Ollama URL", () => {
    const spawn = buildClawcalAcpSpawnInput(
      { binaryPath: "/opt/clawcal/bin/clawcal", serverUrl: "http://127.0.0.1:11500" },
      "/tmp/project",
      { PATH: "/usr/bin" },
    );

    expect(spawn).toEqual({
      command: "/opt/clawcal/bin/clawcal",
      args: ["acp", "--ollama-url", "http://127.0.0.1:11500"],
      cwd: "/tmp/project",
      env: { PATH: "/usr/bin" },
    });
  });

  it("defaults the binary and the Ollama URL", () => {
    const spawn = buildClawcalAcpSpawnInput(undefined, "/tmp/project");

    expect(spawn).toEqual({
      command: "clawcal",
      args: ["acp", "--ollama-url", DEFAULT_CLAWCAL_OLLAMA_URL],
      cwd: "/tmp/project",
    });
  });
});

describe("applyClawcalAcpModelSelection", () => {
  const makeRecordingRuntime = (failure?: EffectAcpErrors.AcpError) => {
    const modelCalls: Array<string> = [];
    const runtime = {
      setSessionModel: (modelId: string) =>
        Effect.gen(function* () {
          modelCalls.push(modelId);
          if (failure) return yield* failure;
          return {};
        }),
    };
    return { runtime, modelCalls };
  };

  it.effect("calls session/set_model when the requested model differs from current", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls } = makeRecordingRuntime();
      const result = yield* applyClawcalAcpModelSelection({
        runtime,
        currentModelId: "qwen3:14b",
        requestedModelId: "llama3.1:8b",
        mapError: (cause) => cause.message,
      });
      expect(modelCalls).toEqual(["llama3.1:8b"]);
      expect(result).toBe("llama3.1:8b");
    }),
  );

  it.effect("skips set_model when requested matches current", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls } = makeRecordingRuntime();
      const result = yield* applyClawcalAcpModelSelection({
        runtime,
        currentModelId: "qwen3:14b",
        requestedModelId: "qwen3:14b",
        mapError: (cause) => cause.message,
      });
      expect(modelCalls).toEqual([]);
      expect(result).toBe("qwen3:14b");
    }),
  );

  it.effect("propagates session/set_model failures via mapError", () =>
    Effect.gen(function* () {
      const failure = EffectAcpErrors.AcpRequestError.invalidParams("session id not known");
      const { runtime } = makeRecordingRuntime(failure);
      const error = yield* Effect.flip(
        applyClawcalAcpModelSelection({
          runtime,
          currentModelId: "qwen3:14b",
          requestedModelId: "llama3.1:8b",
          mapError: (cause) => cause.message,
        }),
      );
      expect(error).toBe(failure.message);
    }),
  );
});
