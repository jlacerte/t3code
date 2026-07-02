// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeFSP from "node:fs/promises";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import {
  ApprovalRequestId,
  ClawcalSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";

import { ServerConfig } from "../../config.ts";
import { clawcalPromptSettlementBelongsToContext, makeClawcalAdapter } from "./ClawcalAdapter.ts";
const decodeClawcalSettings = Schema.decodeSync(ClawcalSettings);

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../../scripts/acp-mock-agent.ts");
const mockAgentCommand = process.execPath;

async function makeMockClawcalWrapper(extraEnv?: Record<string, string>) {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "clawcal-acp-mock-"));
  const wrapperPath = NodePath.join(dir, "fake-clawcal.sh");
  const envExports = Object.entries(extraEnv ?? {})
    .map(([key, value]) => `export ${key}=${JSON.stringify(value)}`)
    .join("\n");
  const script = `#!/bin/sh
${envExports}
exec ${JSON.stringify(mockAgentCommand)} ${JSON.stringify(mockAgentPath)} "$@"
`;
  await NodeFSP.writeFile(wrapperPath, script, "utf8");
  await NodeFSP.chmod(wrapperPath, 0o755);
  return wrapperPath;
}

function waitForFileContent(
  filePath: string,
  attempts = 40,
  expectedContent?: string,
): Effect.Effect<string> {
  const readAttempt = (remainingAttempts: number): Effect.Effect<string> =>
    Effect.gen(function* () {
      if (remainingAttempts <= 0) {
        return yield* Effect.die(new Error(`Timed out waiting for file content at ${filePath}`));
      }
      const raw = yield* Effect.tryPromise(() => NodeFSP.readFile(filePath, "utf8")).pipe(
        Effect.orElseSucceed(() => ""),
      );
      if (
        raw.trim().length > 0 &&
        (expectedContent === undefined || raw.includes(expectedContent))
      ) {
        return raw;
      }
      // Real-time delay: `it.effect` runs on the TestClock, where
      // `Effect.sleep` would suspend forever while the mock agent writes in
      // wall-clock time.
      // @effect-diagnostics-next-line globalTimers:off
      yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 25)));
      return yield* readAttempt(remainingAttempts - 1);
    });
  return readAttempt(attempts);
}

async function readJsonLines(filePath: string) {
  const raw = await NodeFSP.readFile(filePath, "utf8");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

const clawcalAdapterTestLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-clawcal-adapter-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

const makeTestAdapter = (binaryPath: string, options?: Parameters<typeof makeClawcalAdapter>[1]) =>
  makeClawcalAdapter(decodeClawcalSettings({ enabled: true, binaryPath }), options).pipe(
    Effect.orDie,
  );

it("requires a settlement to match the live Clawcal turn", () => {
  const staleTurnId = TurnId.make("stale-turn");
  const replacementTurnId = TurnId.make("replacement-turn");

  assert.isFalse(
    clawcalPromptSettlementBelongsToContext({
      liveAcpSessionId: "session-1",
      expectedAcpSessionId: "session-1",
      liveActiveTurnId: replacementTurnId,
      liveSessionActiveTurnId: replacementTurnId,
      turnId: staleTurnId,
    }),
  );
  assert.isFalse(
    clawcalPromptSettlementBelongsToContext({
      liveAcpSessionId: "replacement-session",
      expectedAcpSessionId: "stale-session",
      liveActiveTurnId: staleTurnId,
      liveSessionActiveTurnId: staleTurnId,
      turnId: staleTurnId,
    }),
  );
  assert.isTrue(
    clawcalPromptSettlementBelongsToContext({
      liveAcpSessionId: "session-1",
      expectedAcpSessionId: "session-1",
      liveActiveTurnId: staleTurnId,
      liveSessionActiveTurnId: staleTurnId,
      turnId: staleTurnId,
    }),
  );
});

it.layer(clawcalAdapterTestLayer)("ClawcalAdapterLive", (it) => {
  it.effect("starts a session and maps mock ACP prompt flow to runtime events", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("clawcal-mock-thread");
      const wrapperPath = yield* Effect.promise(() => makeMockClawcalWrapper());
      const adapter = yield* makeTestAdapter(wrapperPath);

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const turnCompleted = yield* Deferred.make<void>();
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }).pipe(
          Effect.andThen(
            event.type === "turn.completed"
              ? Deferred.succeed(turnCompleted, undefined)
              : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild);

      const session = yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("clawcal"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: {
          instanceId: ProviderInstanceId.make("clawcal"),
          model: "grok-mock-alt",
        },
      });

      assert.equal(session.provider, "clawcal");
      assert.equal(session.model, "grok-mock-alt");
      assert.deepStrictEqual(session.resumeCursor, {
        schemaVersion: 1,
        sessionId: "mock-session-1",
      });

      yield* adapter.sendTurn({
        threadId,
        input: "hello clawcal",
        attachments: [],
      });

      yield* Deferred.await(turnCompleted);
      yield* Fiber.interrupt(runtimeEventsFiber);
      const types = runtimeEvents.map((e) => e.type);

      assert.includeMembers(types, [
        "session.started",
        "session.state.changed",
        "thread.started",
        "turn.started",
        "item.started",
        "content.delta",
        "turn.completed",
      ] as const);

      const delta = runtimeEvents.find((e) => e.type === "content.delta");
      assert.isDefined(delta);
      if (delta?.type === "content.delta") {
        assert.equal(delta.payload.delta, "hello from mock");
      }

      const completed = runtimeEvents.find((e) => e.type === "turn.completed");
      if (completed?.type === "turn.completed") {
        assert.equal(completed.payload.state, "completed");
        assert.equal(completed.payload.stopReason, "end_turn");
      }

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("always starts a fresh ACP session even when a resume cursor is provided", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("clawcal-resume-ignored");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "clawcal-resume-log-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      yield* Effect.promise(() => NodeFSP.writeFile(requestLogPath, "", "utf8"));

      // The mock would fail a session/load outright; Clawcal must never send
      // one because it does not persist history.
      const wrapperPath = yield* Effect.promise(() =>
        makeMockClawcalWrapper({
          T3_ACP_REQUEST_LOG_PATH: requestLogPath,
          T3_ACP_FAIL_LOAD_SESSION: "1",
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      const session = yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("clawcal"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        resumeCursor: { schemaVersion: 1, sessionId: "previous-session" },
        modelSelection: { instanceId: ProviderInstanceId.make("clawcal"), model: "grok-build" },
      });

      assert.deepStrictEqual(session.resumeCursor, {
        schemaVersion: 1,
        sessionId: "mock-session-1",
      });

      yield* waitForFileContent(requestLogPath, 40, "session/new");
      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
      assert.isTrue(requests.some((entry) => entry.method === "session/new"));
      assert.isFalse(requests.some((entry) => entry.method === "session/load"));

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("closes the ACP child process when a session stops", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("clawcal-stop-session-close");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "clawcal-adapter-exit-log-")),
      );
      const exitLogPath = NodePath.join(tempDir, "exit.log");

      const wrapperPath = yield* Effect.promise(() =>
        makeMockClawcalWrapper({
          T3_ACP_EXIT_LOG_PATH: exitLogPath,
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("clawcal"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("clawcal"), model: "grok-build" },
      });

      yield* adapter.stopSession(threadId);

      const exitLog = yield* waitForFileContent(exitLogPath);
      assert.include(exitLog, "SIGTERM");
    }),
  );

  it.effect("routes tool permission requests through the approval flow", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("clawcal-approval-flow");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockClawcalWrapper({
          T3_ACP_EMIT_TOOL_CALLS: "1",
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);
      const requestOpened =
        yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "request.opened" }>>();
      const requestResolved =
        yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "request.resolved" }>>();
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        event.type === "request.opened"
          ? Deferred.succeed(requestOpened, event).pipe(Effect.ignore)
          : event.type === "request.resolved"
            ? Deferred.succeed(requestResolved, event).pipe(Effect.ignore)
            : Effect.void,
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("clawcal"),
        cwd: process.cwd(),
        runtimeMode: "approval-required",
        modelSelection: { instanceId: ProviderInstanceId.make("clawcal"), model: "grok-build" },
      });

      const sendTurnFiber = yield* adapter
        .sendTurn({ threadId, input: "run a tool", attachments: [] })
        .pipe(Effect.forkChild);
      const requestOpenedEvent = yield* Deferred.await(requestOpened);

      const runningSessions = yield* adapter.listSessions();
      const runningSession = runningSessions.find((session) => session.threadId === threadId);
      assert.equal(runningSession?.status, "running");
      assert.isDefined(runningSession?.activeTurnId);

      yield* adapter.respondToRequest(
        threadId,
        ApprovalRequestId.make(String(requestOpenedEvent.requestId)),
        "accept",
      );
      const requestResolvedEvent = yield* Deferred.await(requestResolved);
      assert.equal(requestResolvedEvent.payload.decision, "accept");
      yield* Fiber.join(sendTurnFiber);

      const readySessions = yield* adapter.listSessions();
      const readySession = readySessions.find((session) => session.threadId === threadId);
      assert.equal(readySession?.status, "ready");
      assert.isUndefined(readySession?.activeTurnId);

      yield* Fiber.interrupt(eventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("cancels pending approvals and marks the turn cancelled when interrupted", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("clawcal-interrupt-flow");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "clawcal-interrupt-log-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      yield* Effect.promise(() => NodeFSP.writeFile(requestLogPath, "", "utf8"));
      const wrapperPath = yield* Effect.promise(() =>
        makeMockClawcalWrapper({
          T3_ACP_REQUEST_LOG_PATH: requestLogPath,
          T3_ACP_EMIT_TOOL_CALLS: "1",
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      const requestResolvedReady =
        yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "request.resolved" }>>();
      const turnCompletedReady =
        yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "turn.completed" }>>();
      let interrupted = false;

      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.gen(function* () {
          if (String(event.threadId) !== String(threadId)) {
            return;
          }
          if (event.type === "request.opened" && !interrupted) {
            interrupted = true;
            yield* adapter.interruptTurn(threadId);
            return;
          }
          if (event.type === "request.resolved") {
            yield* Deferred.succeed(requestResolvedReady, event).pipe(Effect.ignore);
            return;
          }
          if (event.type === "turn.completed") {
            yield* Deferred.succeed(turnCompletedReady, event).pipe(Effect.ignore);
          }
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("clawcal"),
        cwd: process.cwd(),
        runtimeMode: "approval-required",
        modelSelection: { instanceId: ProviderInstanceId.make("clawcal"), model: "grok-build" },
      });

      const sendTurnFiber = yield* adapter
        .sendTurn({
          threadId,
          input: "cancel this turn",
          attachments: [],
        })
        .pipe(Effect.forkChild);

      const requestResolved = yield* Deferred.await(requestResolvedReady);
      const turnCompleted = yield* Deferred.await(turnCompletedReady);
      yield* Fiber.join(sendTurnFiber);
      yield* Fiber.interrupt(runtimeEventsFiber);

      assert.equal(requestResolved.payload.decision, "cancel");
      assert.equal(turnCompleted.payload.state, "cancelled");
      assert.equal(turnCompleted.payload.stopReason, "cancelled");

      yield* waitForFileContent(requestLogPath, 80, "session/cancel");
      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
      assert.isTrue(requests.some((entry) => entry.method === "session/cancel"));

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("auto-approves permission requests in full-access mode", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("clawcal-full-access-auto-approve");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockClawcalWrapper({
          T3_ACP_EMIT_TOOL_CALLS: "1",
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const turnCompleted = yield* Deferred.make<void>();
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }).pipe(
          Effect.andThen(
            event.type === "turn.completed"
              ? Deferred.succeed(turnCompleted, undefined)
              : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("clawcal"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("clawcal"), model: "grok-build" },
      });

      yield* adapter.sendTurn({ threadId, input: "run a tool", attachments: [] });
      yield* Deferred.await(turnCompleted);
      yield* Fiber.interrupt(runtimeEventsFiber);

      const types = runtimeEvents.map((event) => event.type);
      assert.notInclude(types, "request.opened");
      assert.include(types, "turn.completed");

      yield* adapter.stopSession(threadId);
    }),
  );
});
