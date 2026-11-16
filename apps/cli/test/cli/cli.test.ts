import { fixturePromptPolicy } from "../support/prompt-policy.js";
import { closeSync, openSync, readFileSync, writeSync } from "node:fs";
import { join } from "node:path";

import {
  CLIENT_PROTOCOL_VERSION,
  PRIVATE_STATE_KEYS,
  parseClientEvent,
  type ClientEvent,
  type ModelEvent,
  type ModelOutcome,
  type ModelPort,
  type ModelRequest,
} from "@tavi/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { composeTaviRuntime } from "../../src/runtime/composition.js";
import type { TaviRuntime, TaviRuntimeOptions } from "../../src/runtime/types.js";
import { createInMemoryReceiptRepository } from "@tavi/test-support/fakes";
import { ModelConfigService } from "@tavi/runtime";
import { capture, temporaryDirectories } from "@tavi/test-support";
import { sse, textChunk, toolCallChunk } from "@tavi/test-support/openai-stub";
import { SqliteStore } from "../support/database-fixture.js";
import { reconcileCheckpointReceipts } from "../../src/runtime/checkpoints.js";
import { EXIT, main } from "../../src/main.js";
import { resolveModelTarget } from "../../src/cli/run-target.js";
import type { RuntimeFactory } from "../../src/cli/runtime-options.js";
import { formatVersion } from "../../src/cli/help.js";
import { fittedText } from "../../src/shared/terminal-text.js";
import type { RunCommandOptions } from "../../src/features/run/parse.js";
import { checkoutRevision } from "../../src/cli/checkout-revision.js";
import { AGENTS_USAGE } from "../../src/features/agents/parse.js";
import { APPROVALS_USAGE } from "../../src/features/approvals/parse.js";
import { ARTIFACTS_USAGE } from "../../src/features/artifacts/parse.js";
import { BINDINGS_USAGE } from "../../src/features/bindings/parse.js";
import { CANCEL_USAGE, RECOVER_USAGE } from "../../src/features/tasks/parse.js";
import { CREDENTIALS_USAGE } from "../../src/features/credentials/parse.js";
import { MEMORY_USAGE } from "../../src/features/memory/parse.js";
import { MODELS_USAGE } from "../../src/features/models/parse.js";
import { PROJECTS_USAGE } from "../../src/features/projects/parse.js";
import { REPORTS_USAGE } from "../../src/features/reports/parse.js";
import { RUN_USAGE } from "../../src/features/run/parse.js";
import { SCHEDULES_USAGE } from "../../src/features/schedules/parse.js";
import { SERVE_USAGE } from "../../src/server/parse.js";
import { SERVICE_USAGE } from "../../src/features/service/parse.js";
import { SKILLS_USAGE } from "../../src/features/skills/parse.js";

const directories = temporaryDirectories({ prefix: "tavi-cli-" });

// These tests drive `main()` with the real composition, and the scripted model calls
// `fixture.echo`, which only composition's devFixtureTools option registers.
vi.mock("../../src/runtime/composition.js", async (original) =>
  (await import("../support/dev-fixture-tool.js")).withFixtureTools(await original()),
);

afterEach(() => directories.cleanup());

/** A model that asks for the read-only fixture tool once, then answers. */
function scriptedModel(calls: { count: number } = { count: 0 }): ModelPort {
  return {
    async stream(
      request: ModelRequest,
      options: { readonly signal: AbortSignal; readonly onEvent: (event: ModelEvent) => void },
    ): Promise<ModelOutcome> {
      calls.count += 1;
      if (calls.count === 1) {
        options.onEvent({
          type: "text.delta",
          attemptId: request.attemptId,
          blockId: "b1",
          text: "checking… ",
        });
        return {
          status: "completed",
          attemptId: request.attemptId,
          text: "",
          toolCalls: [{ id: "call-1", name: "fixture.echo", input: { message: "ping", uppercase: true } }],
          usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4 },
        };
      }
      for (const chunk of ["the tool ", "said PING"]) {
        options.onEvent({ type: "text.delta", attemptId: request.attemptId, blockId: "b2", text: chunk });
      }
      return {
        status: "completed",
        attemptId: request.attemptId,
        text: "the tool said PING",
        toolCalls: [],
        usage: { inputTokens: 5, outputTokens: 4, totalTokens: 9 },
      };
    },
  };
}

/**
 * Build a runtime through the CLI's own composition root, substituting only the
 * model transport. Everything else — plugin host, SQLite, LangGraph saver, tool
 * registry, policy — is the real stack.
 */
function factoryWith(model: ModelPort, captureRuntimes: TaviRuntime[] = []): RuntimeFactory {
  return async (options: TaviRuntimeOptions, overrides): Promise<TaviRuntime> => {
    const runtime = await composeTaviRuntime(
      { ...options, logger: { level: "error", sink: () => {} } },
      { ...overrides, modelOverride: model },
    );
    captureRuntimes.push(runtime);
    return runtime;
  };
}

function runArgs(dataDirectory: string, extra: readonly string[] = []): string[] {
  return ["run", "please echo ping", "--connection", "fixture", "--model", "fixture-model", "--data-dir", dataDirectory, ...extra];
}

const workspaceGrant = {
  workspaceId: "default",
  principalId: "operator",
  permissions: ["tools.invoke", "models.invoke", "runs.create"],
};

describe("configured workspace default", () => {
  it("uses `tavi models set-default` for a run with no --connection/--model", async () => {
    const directory = directories.create();

    // Configure exactly as an operator would, then never mention the target again.
    const add = capture();
    expect(
      await main(
        [
          "models",
          "add",
          "configured",
          "--base-url",
          "http://127.0.0.1:9/v1",
          "--credential",
          "configured.apiKey",
          "--data-dir",
          directory,
        ],
        { io: add.io },
      ),
    ).toBe(EXIT.ok);
    const setDefault = capture();
    expect(
      await main(["models", "set-default", "--connection", "configured", "--model", "configured-model", "--data-dir", directory], {
        io: setDefault.io,
      }),
    ).toBe(EXIT.ok);

    const seen: TaviRuntimeOptions[] = [];
    const captured = capture();
    const runtimes: TaviRuntime[] = [];
    const factory: RuntimeFactory = async (options, overrides) => {
      seen.push(options);
      const runtime = await composeTaviRuntime(
        { ...options, logger: { level: "error", sink: () => {} } },
        { ...overrides, modelOverride: scriptedModel() },
      );
      runtimes.push(runtime);
      return runtime;
    };

    const code = await main(["run", "hello", "--data-dir", directory], { io: captured.io, runtimeFactory: factory });

    expect(code).toBe(EXIT.ok);
    expect(seen[0]?.defaultConnectionId).toBe("configured");
    expect(seen[0]?.defaultModel).toBe("configured-model");
    // The connection's own stored endpoint is used, not `TAVI_BASE_URL`.
    expect(seen[0]?.providers[0]?.baseUrl).toBe("http://127.0.0.1:9/v1");
    expect(seen[0]?.providers[0]?.credentialRef).toBe("configured.apiKey");
    for (const runtime of runtimes) await runtime.close();
  });

  it("prefers an explicit --connection/--model over the configured default", async () => {
    const directory = directories.create();
    const add = capture();
    await main(
      ["models", "add", "configured", "--base-url", "http://127.0.0.1:9/v1", "--credential", "configured.apiKey", "--data-dir", directory],
      { io: add.io },
    );
    await main(["models", "set-default", "--connection", "configured", "--model", "configured-model", "--data-dir", directory], {
      io: capture().io,
    });

    const seen: TaviRuntimeOptions[] = [];
    const runtimes: TaviRuntime[] = [];
    const code = await main(["run", "hello", "--connection", "explicit", "--model", "explicit-model", "--data-dir", directory], {
      io: capture().io,
      runtimeFactory: async (options, overrides) => {
        seen.push(options);
        const runtime = await composeTaviRuntime(
          { ...options, logger: { level: "error", sink: () => {} } },
          { ...overrides, modelOverride: scriptedModel() },
        );
        runtimes.push(runtime);
        return runtime;
      },
    });

    expect(code).toBe(EXIT.ok);
    expect(seen[0]?.defaultConnectionId).toBe("explicit");
    expect(seen[0]?.defaultModel).toBe("explicit-model");
    for (const runtime of runtimes) await runtime.close();
  });

  it("carries the configured connection's stored headers into the runtime", async () => {
    const directory = directories.create();
    await main(
      [
        "models",
        "add",
        "configured",
        "--base-url",
        "http://127.0.0.1:9/v1",
        "--credential",
        "configured.apiKey",
        "--header",
        "x-tenant=acme",
        "--data-dir",
        directory,
      ],
      { io: capture().io },
    );
    await main(["models", "set-default", "--connection", "configured", "--model", "configured-model", "--data-dir", directory], {
      io: capture().io,
    });

    const seen: TaviRuntimeOptions[] = [];
    const runtimes: TaviRuntime[] = [];
    await main(["run", "hello", "--data-dir", directory], {
      io: capture().io,
      runtimeFactory: async (options, overrides) => {
        seen.push(options);
        const runtime = await composeTaviRuntime(
          { ...options, logger: { level: "error", sink: () => {} } },
          { ...overrides, modelOverride: scriptedModel() },
        );
        runtimes.push(runtime);
        return runtime;
      },
    });
    // Stored headers are transport facts (`tavi models add --header`), so the
    // default path must not silently drop them.
    expect(seen[0]?.providers[0]?.headers).toMatchObject({ "x-tenant": "acme" });
    for (const runtime of runtimes) await runtime.close();
  });

  it("reports a mistyped --connection on the resolve path as unavailable, not internal", async () => {
    const directory = directories.create();
    await main(
      ["models", "add", "configured", "--base-url", "http://127.0.0.1:9/v1", "--credential", "configured.apiKey", "--data-dir", directory],
      { io: capture().io },
    );
    await main(["models", "set-default", "--connection", "configured", "--model", "configured-model", "--data-dir", directory], {
      io: capture().io,
    });

    const captured = capture();
    // `--model` is omitted, so the resolve path runs; the typo is the operator
    // error the exit-code table calls "target not found" (4).
    expect(await main(["run", "hello", "--connection", "typo", "--data-dir", directory], { io: captured.io })).toBe(EXIT.unavailable);
    expect(captured.stderr()).toContain("typo");
  });

  it("resolves a bare `serve` default, and keeps placeholders only when nothing is configured", async () => {
    const configured = directories.create();
    await main(
      ["models", "add", "configured", "--base-url", "http://127.0.0.1:9/v1", "--credential", "configured.apiKey", "--data-dir", configured],
      { io: capture().io },
    );
    await main(["models", "set-default", "--connection", "configured", "--model", "configured-model", "--data-dir", configured], {
      io: capture().io,
    });

    const bare: RunCommandOptions = {
      prompt: "",
      format: "text",
      workspaceId: "default",
      principalId: "operator",
      approval: "deny",
      quiet: true,
      inMemory: false,
      dataDirectory: configured,
    };
    const withDefault = await resolveModelTarget(bare, { requireTarget: false });
    expect(withDefault.options.connectionId).toBe("configured");
    expect(withDefault.options.model).toBe("configured-model");
    expect(withDefault.connection?.baseUrl).toBe("http://127.0.0.1:9/v1");

    // Nothing configured: `serve` still starts, on the historical placeholders.
    const unresolved = await resolveModelTarget({ ...bare, dataDirectory: directories.create() }, { requireTarget: false });
    expect(unresolved.options.connectionId).toBeUndefined();
    expect(unresolved.connection).toBeUndefined();

    // Role main's binding comes before the default, with its fallback.
    await main(
      ["models", "add", "backup", "--base-url", "http://127.0.0.1:10/v1", "--credential", "backup.apiKey", "--data-dir", configured],
      { io: capture().io },
    );
    await main(
      [
        "models",
        "set-role",
        "main",
        "--connection",
        "configured",
        "--model",
        "main-model",
        "--fallback",
        "backup/backup-model",
        "--data-dir",
        configured,
      ],
      { io: capture().io },
    );
    const withRole = await resolveModelTarget(bare);
    expect([withRole.source, withRole.options.connectionId, withRole.options.model]).toEqual(["role", "configured", "main-model"]);
    expect(withRole.options.explicitModelSelection).toBe(false);
    expect((await resolveModelTarget({ ...bare, model: "explicit" })).options.explicitModelSelection).toBe(true);
    expect((await resolveModelTarget({ ...bare, connectionId: "configured" })).options.explicitModelSelection).toBe(true);
    expect(withRole.fallback).toEqual([
      {
        connectionId: "backup",
        model: "backup-model",
        connection: { baseUrl: "http://127.0.0.1:10/v1", credentialRef: "backup.apiKey", kind: "openai-compatible" },
      },
    ]);
  });

  it("refuses a run whose every configured target is unusable, naming why and where to look", async () => {
    const directory = directories.create();
    await main(
      [
        "models",
        "add",
        "gone",
        "--base-url",
        "http://127.0.0.1:9/v1",
        "--credential",
        "gone.apiKey",
        "--model",
        "m",
        "--data-dir",
        directory,
      ],
      { io: capture().io },
    );
    await main(["models", "set-role", "main", "--connection", "gone", "--model", "m", "--data-dir", directory], { io: capture().io });
    // The catalog says the model is unavailable: resolution passes it over, and nothing is left.
    const store = await SqliteStore.open({
      databasePath: join(directory, "tavi.sqlite"),
      artifactsDirectory: join(directory, "artifacts"),
    });
    new ModelConfigService(store.asPort()).replaceCatalog("gone", [{ modelId: "m", provenance: "manual", state: "unavailable" }]);
    await store.close();
    const refused = capture();
    expect(await main(["run", "hello", "--data-dir", directory], { io: refused.io })).toBe(EXIT.usage);
    expect(refused.stderr()).toContain("Every configured target for role main is unusable");
    expect(refused.stderr()).toContain("`tavi models roles` shows what each role resolves to");
    // `serve` resolves at startup the same way, and is refused the same way rather than starting on nothing usable.
    const serveRefused = capture();
    expect(await main(["serve", "--data-dir", directory], { io: serveRefused.io })).toBe(EXIT.usage);
    expect(serveRefused.stderr()).toContain("Every configured target for role main is unusable");
    // A connection with no model to run is a usage error naming --model.
    await main(["models", "add", "bare", "--base-url", "http://127.0.0.1:9/v1", "--credential", "bare.apiKey", "--data-dir", directory], {
      io: capture().io,
    });
    const bare = capture();
    expect(await main(["run", "hello", "--connection", "bare", "--data-dir", directory], { io: bare.io })).toBe(EXIT.usage);
    expect(bare.stderr()).toContain("connection bare has no default model: pass --model");
  });

  it("resolves a named connection's own default model when no workspace default exists", async () => {
    const directory = directories.create();
    await main(
      [
        "models",
        "add",
        "named",
        "--base-url",
        "http://127.0.0.1:9/v1",
        "--credential",
        "named.apiKey",
        "--model",
        "named-model",
        "--data-dir",
        directory,
      ],
      { io: capture().io },
    );

    const resolved = await resolveModelTarget(
      {
        prompt: "hi",
        format: "text",
        workspaceId: "default",
        principalId: "operator",
        connectionId: "named",
        approval: "ask",
        quiet: true,
        inMemory: false,
        dataDirectory: directory,
      },
      { requireTarget: false },
    );
    // Naming a connection must resolve it even with no workspace-default row.
    expect(resolved.options.model).toBe("named-model");
    expect(resolved.connection?.credentialRef).toBe("named.apiKey");
  });
});

describe("tavi run end to end", () => {
  it("completes a model → tool → model round trip and exits 0", async () => {
    const directory = directories.create();
    const captured = capture();
    const runtimes: TaviRuntime[] = [];

    const code = await main(runArgs(directory), { io: captured.io, runtimeFactory: factoryWith(scriptedModel(), runtimes) });

    expect(code).toBe(EXIT.ok);
    expect(captured.stdout()).toContain("the tool said PING");
    expect(captured.stdout()).toContain("[tool] fixture.echo");
    for (const runtime of runtimes) await runtime.close();
  });

  it("persists the run and its terminal status", async () => {
    const directory = directories.create();
    const captured = capture();
    const runtimes: TaviRuntime[] = [];
    await main(runArgs(directory), { io: captured.io, runtimeFactory: factoryWith(scriptedModel(), runtimes) });

    const reopened = await composeTaviRuntime(
      {
        dataDirectory: directory,
        workspaces: [workspaceGrant],
        providers: [],
        credentials: {},
        defaultConnectionId: "fixture",
        defaultModel: "fixture-model",
      },
      { requireModelTransport: false },
    );
    const tasks = await reopened.store.listTasks(10);
    const origin = (await reopened.store.asPort().repositories.tasks.get((await tasks)[0]?.taskId ?? ""))?.origin;
    await reopened.close();
    for (const runtime of runtimes) await runtime.close();

    expect(tasks).toHaveLength(1);
    expect((await tasks)[0]?.status).toBe("completed");
    expect((await tasks)[0]?.finalText).toBe("the tool said PING");
    // The operator's own foreground run is recorded as such.
    expect(origin).toBe("cli");
  });

  it("writes LangGraph checkpoints into the shared database", async () => {
    const directory = directories.create();
    const captured = capture();
    const runtimes: TaviRuntime[] = [];
    await main(runArgs(directory), { io: captured.io, runtimeFactory: factoryWith(scriptedModel(), runtimes) });
    for (const runtime of runtimes) await runtime.close();

    // Reopen the same data directory: the checkpoints must be durable, and the
    // pinned saver tables must have been created next to the application tables.
    const reopened = await composeTaviRuntime(
      {
        dataDirectory: directory,
        workspaces: [workspaceGrant],
        providers: [],
        credentials: {},
        defaultConnectionId: "fixture",
        defaultModel: "fixture-model",
      },
      { requireModelTransport: false },
    );
    expect(await reopened.checkpointCount()).toBeGreaterThan(0);
    expect([...(await reopened.store.listSaverTables())].sort()).toEqual(["checkpoints", "writes"]);
    expect(await reopened.store.listApplicationTables()).toContain("tavi_tasks");
    expect(await reopened.store.listApplicationTables()).toContain("tavi_admissions");
    await reopened.close();
  });

  it("records the tool result in the model-facing transcript for the second turn", async () => {
    const directory = directories.create();
    const captured = capture();
    const seen: ModelRequest[] = [];
    const inner = scriptedModel();
    const recorder: ModelPort = {
      async stream(request, options): Promise<ModelOutcome> {
        seen.push(request);
        return inner.stream(request, options);
      },
    };

    const runtimes: TaviRuntime[] = [];
    await main(runArgs(directory), { io: captured.io, runtimeFactory: factoryWith(recorder, runtimes) });

    const secondTurn = seen[1];
    const toolMessage = secondTurn?.messages.find((message) => message.role === "tool");
    expect(toolMessage?.toolResults?.[0]?.output).toMatchObject({ echoed: "PING" });
    expect(JSON.stringify(secondTurn?.messages)).toContain("call-1");
    for (const runtime of runtimes) await runtime.close();
  });

  it("emits runtime-validated JSON events with a monotonic sequence", async () => {
    const directory = directories.create();
    const captured = capture();
    const runtimes: TaviRuntime[] = [];
    const code = await main(runArgs(directory, ["--format", "json"]), {
      io: captured.io,
      runtimeFactory: factoryWith(scriptedModel(), runtimes),
    });
    expect(code).toBe(EXIT.ok);

    const events = parseEvents(captured.stdout());

    expect(events[0]?.kind).toBe("run.started");
    expect(events.at(-1)?.kind).toBe("task.completed");
    expect(events.map((event) => event.sequence)).toEqual(events.map((_, index) => index));
    for (const event of events) {
      expect(event.epoch).toBe(events[0]?.epoch);
      expect(event.runId).toBe(events[0]?.runId);
      expect(event.protocolVersion).toBe(CLIENT_PROTOCOL_VERSION);
    }
    for (const runtime of runtimes) await runtime.close();
  });

  it("keeps private transport fields and credential values out of the event stream", async () => {
    const directory = directories.create();
    const captured = capture();
    const runtimes: TaviRuntime[] = [];
    await main(runArgs(directory, ["--format", "json"]), { io: captured.io, runtimeFactory: factoryWith(scriptedModel(), runtimes) });
    for (const key of PRIVATE_STATE_KEYS) expect(captured.stdout()).not.toContain(key);
    expect(captured.stdout()).not.toContain("apiKey");
    for (const runtime of runtimes) await runtime.close();
  });

  it("never emits a tool.started/tool.completed client event for a call the operator denied", async () => {
    // The test above only proves absence of fields this codebase's ModelEvent
    // contract has no producer for at all — it can't fail even if a real leak
    // path existed. This proves actual filtering: the model streams a real
    // `ModelEvent` (`tool.input.started`/`tool.completed`) through
    // `onModelEvent`, but the call is denied, so the graph's own governed
    // dispatcher never runs it. `approval.required` is SUPPOSED to show the
    // input (the operator needs to see what they're approving) — what must
    // never happen is a client `tool.started`/`tool.completed` event, which
    // only `onGraphToolEvent` (post-approval, post-dispatch) may produce. A
    // model that answers with final text after one denied turn (instead of
    // looping) keeps this test's event stream small enough to inspect
    // directly rather than tripping the bounded-loop guard.
    const directory = directories.create();
    const captured = capture();
    const runtimes: TaviRuntime[] = [];
    let calls = 0;
    const model: ModelPort = {
      async stream(
        request: ModelRequest,
        options: { readonly signal: AbortSignal; readonly onEvent: (event: ModelEvent) => void },
      ): Promise<ModelOutcome> {
        calls += 1;
        if (calls === 1) {
          options.onEvent({ type: "tool.input.started", attemptId: request.attemptId, blockId: "b1", toolName: "fixture.echo" });
          options.onEvent({
            type: "tool.completed",
            attemptId: request.attemptId,
            blockId: "b1",
            toolName: "fixture.echo",
            callId: "call-1",
            input: { message: "ping" },
          });
          return {
            status: "completed",
            attemptId: request.attemptId,
            text: "",
            toolCalls: [{ id: "call-1", name: "fixture.echo", input: { message: "ping" } }],
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          };
        }
        return {
          status: "completed",
          attemptId: request.attemptId,
          text: "acknowledged the denial",
          toolCalls: [],
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        };
      },
    };
    const factory: RuntimeFactory = async (options, overrides) => {
      const runtime = await composeTaviRuntime(
        { ...options, approvalRequiredFor: ["read-only", "mutating", "external"], logger: { level: "error", sink: () => {} } },
        { ...overrides, modelOverride: model },
      );
      captureRuntimesPush(runtimes, runtime);
      return runtime;
    };

    const code = await main(runArgs(directory, ["--approval", "deny", "--format", "json"]), { io: captured.io, runtimeFactory: factory });

    expect(code, captured.stderr()).toBe(EXIT.ok);
    const events = parseEvents(captured.stdout());
    expect(events.some((event) => event.kind === "approval.required")).toBe(true);
    expect(events.some((event) => event.kind === "tool.started" || event.kind === "tool.completed")).toBe(false);
    for (const runtime of runtimes) await runtime.close();
  });

  it("emits attempt.replaced when a new attempt supersedes the one awaiting approval", async () => {
    const directory = directories.create();
    const captured = capture();
    const runtimes: TaviRuntime[] = [];
    const factory: RuntimeFactory = async (options, overrides) => {
      const runtime = await composeTaviRuntime(
        { ...options, approvalRequiredFor: ["read-only", "mutating", "external"], logger: { level: "error", sink: () => {} } },
        { ...overrides, modelOverride: scriptedModel() },
      );
      captureRuntimesPush(runtimes, runtime);
      return runtime;
    };

    const code = await main(runArgs(directory, ["--approval", "approve", "--format", "json"]), {
      io: captured.io,
      runtimeFactory: factory,
    });

    expect(code, captured.stderr()).toBe(EXIT.ok);
    const events = parseEvents(captured.stdout());
    const replaced = events.find((event) => event.kind === "attempt.replaced");
    expect(replaced).toBeDefined();
    if (replaced?.kind === "attempt.replaced") {
      expect(replaced.supersededAttemptId).not.toBe(replaced.attemptId);
      const approvalIndex = events.findIndex((event) => event.kind === "approval.required");
      const replacedIndex = events.indexOf(replaced);
      // The replacement is reported after the approval was requested, before
      // the resumed turn's own events (a real ordering claim, not just
      // presence).
      expect(replacedIndex).toBeGreaterThan(approvalIndex);
    }
    for (const runtime of runtimes) await runtime.close();
  });

  it("surfaces a transport failure as a task.failed event and a failing exit code", async () => {
    const directory = directories.create();
    const captured = capture();
    const failing: ModelPort = {
      async stream(request): Promise<ModelOutcome> {
        return {
          status: "failed",
          attemptId: request.attemptId,
          text: "",
          toolCalls: [],
          usage: {},
          error: { code: "provider", message: "upstream exploded", retryable: true },
        };
      },
    };
    const runtimes: TaviRuntime[] = [];
    const code = await main(runArgs(directory, ["--format", "json"]), { io: captured.io, runtimeFactory: factoryWith(failing, runtimes) });

    expect(code).toBe(EXIT.taskFailed);
    const failed = parseEvents(captured.stdout()).at(-1);
    expect(failed?.kind).toBe("task.failed");
    expect(JSON.stringify(failed)).toContain("upstream exploded");
    for (const runtime of runtimes) await runtime.close();
  });

  it("does not treat a missing TTY as approval", async () => {
    const directory = directories.create();
    const captured = capture(false);
    const runtimes: TaviRuntime[] = [];
    // Gate the read-only fixture too, so the approval path is exercised.
    const factory: RuntimeFactory = async (options, overrides) => {
      const runtime = await composeTaviRuntime(
        {
          ...options,
          approvalRequiredFor: ["read-only", "mutating", "external"],
          logger: { level: "error", sink: () => {} },
        },
        { ...overrides, modelOverride: scriptedModel() },
      );
      captureRuntimesPush(runtimes, runtime);
      return runtime;
    };

    const code = await main(runArgs(directory, ["--approval", "ask", "--format", "json"]), { io: captured.io, runtimeFactory: factory });

    expect(code).toBe(EXIT.approvalRequired);
    expect(captured.stderr()).toContain("not interactive");
    for (const runtime of runtimes) await runtime.close();
  });

  it("runs a gated effect when the caller approves explicitly", async () => {
    const directory = directories.create();
    const captured = capture();
    const runtimes: TaviRuntime[] = [];
    const factory: RuntimeFactory = async (options, overrides) => {
      const runtime = await composeTaviRuntime(
        {
          ...options,
          approvalRequiredFor: ["read-only", "mutating", "external"],
          logger: { level: "error", sink: () => {} },
        },
        { ...overrides, modelOverride: scriptedModel() },
      );
      captureRuntimesPush(runtimes, runtime);
      return runtime;
    };

    const code = await main(runArgs(directory, ["--approval", "approve", "--format", "json"]), {
      io: captured.io,
      runtimeFactory: factory,
    });
    expect(code).toBe(EXIT.ok);
    expect(parseEvents(captured.stdout()).some((event) => event.kind === "approval.required")).toBe(true);
    expect(captured.stdout()).toContain("said PING");
    for (const runtime of runtimes) await runtime.close();
  });

  it("records a denial without running the effect and still completes", async () => {
    const directory = directories.create();
    const captured = capture();
    const runtimes: TaviRuntime[] = [];
    const factory: RuntimeFactory = async (options, overrides) => {
      const runtime = await composeTaviRuntime(
        {
          ...options,
          approvalRequiredFor: ["read-only", "mutating", "external"],
          logger: { level: "error", sink: () => {} },
        },
        { ...overrides, modelOverride: scriptedModel() },
      );
      captureRuntimesPush(runtimes, runtime);
      return runtime;
    };

    const code = await main(runArgs(directory, ["--approval", "deny"]), { io: captured.io, runtimeFactory: factory });
    expect(code).toBe(EXIT.ok);
    expect(captured.stdout()).toContain("said PING");
    for (const runtime of runtimes) await runtime.close();
  });
});

function captureRuntimesPush(runtimes: TaviRuntime[], runtime: TaviRuntime): void {
  runtimes.push(runtime);
}

/** Parse a JSON event stream through the contract's own decoder. */
function parseEvents(stdout: string): ClientEvent[] {
  return stdout
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => parseClientEvent(line));
}

describe("tavi doctor, tasks and usage", () => {
  it("reports a corrupt database instead of crashing, and exits unavailable", async () => {
    // `PRAGMA integrity_check` on a damaged database can *throw* (SQLITE_CORRUPT)
    // rather than return rows, and an unguarded throw would make `doctor` exit 70
    // with no report at all — bypassing the very branch the verdict is for.
    const directory = directories.create();
    expect(await main(["doctor", "--data-dir", directory], { io: capture().io })).toBe(EXIT.ok);
    const databasePath = join(directory, "tavi.sqlite");
    // Corrupt a known non-configuration table page. A file midpoint moves
    // after migrations and can hit configuration needed before doctor runs.
    const inspection = await SqliteStore.open({ databasePath });
    const pageSize = inspection.handle.pragma("page_size", { simple: true }) as number;
    const { rootpage } = inspection.handle.prepare("SELECT rootpage FROM sqlite_master WHERE name='tavi_memory_revisions'").get() as {
      rootpage: number;
    };
    await inspection.close();
    const descriptor = openSync(databasePath, "r+");
    try {
      // Leave the header and configuration readable; the integrity check
      // must diagnose this malformed b-tree page.
      const scribble = Buffer.alloc(pageSize, 0x5a);
      writeSync(descriptor, scribble, 0, scribble.length, (rootpage - 1) * pageSize);
    } finally {
      closeSync(descriptor);
    }

    const captured = capture();
    expect(await main(["doctor", "--data-dir", directory], { io: captured.io }), captured.stderr()).toBe(EXIT.unavailable);
    const report = JSON.parse(captured.stdout()) as { integrity: { ok: boolean; problems: string[] } };
    expect(report.integrity.ok).toBe(false);
    expect(report.integrity.problems.length).toBeGreaterThan(0);
  });

  it("serve forwards the allowlists it parses (a daemon used to ignore every one of them)", async () => {
    // `serve --help` documented `--http-allow-host`, `--http-request-header`,
    // `--browser-allow-host`, `--messaging-allow-destination` and
    // `--http-credential-host` while `serveCommand` built its run options without
    // any of them, so the daemon started with no egress, no destinations and no
    // browser policy. This drives the parser and the
    // mapping rather than a live socket: `serveCommand` would block, so the fields
    // are asserted where they are still visible — the parsed command.
    const { parseArgs } = await import("../../src/cli/parse.js");
    const parsed = parseArgs([
      "serve",
      "--connection",
      "fixture",
      "--model",
      "fixture-model",
      "--http-allow-host",
      "api.example.com",
      "--http-request-header",
      "idempotency-key",
      "--browser-allow-host",
      "example.com",
      "--messaging-allow-destination",
      "telegram-main:8346819670",
      "--http-credential-host",
      "acme.key=api.example.com",
      "--allow",
      "web_search",
      "--retention-sweep-artifacts",
    ]);
    expect(parsed.serve).toMatchObject({
      allowTools: ["web_search"],
      httpAllowHosts: ["api.example.com"],
      httpRequestHeaders: ["idempotency-key"],
      browserAllowHosts: ["example.com"],
      messagingAllowDestinations: ["telegram-main:8346819670"],
      httpCredentialHosts: ["acme.key=api.example.com"],
      retentionSweepArtifacts: true,
    });
    // …and every one of them survives into the runtime options `serve` composes
    // with, which is where the mapping was dropping them.
    const { runtimeOptionsFor } = await import("../../src/main.js");
    const options = runtimeOptionsFor(
      { ...parsed.serve, workspaceId: "default", dataDirectory: directories.create() } as never,
      {},
      undefined,
    );
    expect(options.httpAllowedHosts).toEqual(["api.example.com"]);
    expect(options.httpAllowedRequestHeaders).toEqual(["idempotency-key"]);
    expect(options.browserAllowedHosts).toEqual(["example.com"]);
    expect(options.messagingAllowedDestinations).toEqual(["telegram-main:8346819670"]);
    expect(options.httpCredentialHosts).toEqual({ "acme.key": ["api.example.com"] });
    expect(options.approvalExemptTools).toEqual(["web_search"]);
  });

  it("serve --allow names tools, never a wildcard", async () => {
    const { parseArgs } = await import("../../src/cli/parse.js");
    expect(() => parseArgs(["serve", "--allow", "*"])).toThrow(/--allow '\*' is refused/);
    expect(() => parseArgs(["serve", "--allow", "not a tool"])).toThrow(/is not a tool id/);
    expect(() => parseArgs(["serve", "--allow", "web.search"])).toThrow(/web_search, web_fetch, or web_\*/);
  });

  it("reports a saver schema recorded by a different build instead of overwriting it", async () => {
    // The marker is written only when absent, and a disagreement is reported:
    // stamping the composition's own version on every open would make `matches`
    // a tautology, so a directory last used by another pin would report `true`.
    const directory = directories.create();
    expect(await main(["doctor", "--data-dir", directory], { io: capture().io })).toBe(EXIT.ok);
    const store = await SqliteStore.open({
      databasePath: join(directory, "tavi.sqlite"),
      artifactsDirectory: join(directory, "artifacts"),
      checkpointMode: "inspect",
    });
    try {
      await store.setMeta("saver.schema_version", "999", "2026-01-01T00:00:00.000Z");
    } finally {
      await store.close();
    }

    const captured = capture();
    expect(await main(["doctor", "--data-dir", directory], { io: captured.io }), captured.stderr()).toBe(EXIT.ok);
    const report = JSON.parse(captured.stdout()) as {
      saverSchema: { expected: number; recorded: string | null; matches: boolean; missingColumns: Record<string, string[]> };
    };
    expect(report.saverSchema.matches).toBe(false);
    expect(report.saverSchema.recorded).toBe("999");
    expect(report.saverSchema.missingColumns).toEqual({});

    const after = await SqliteStore.open({
      databasePath: join(directory, "tavi.sqlite"),
      artifactsDirectory: join(directory, "artifacts"),
      checkpointMode: "inspect",
    });
    try {
      // Kept, not silently resolved: `CREATE TABLE IF NOT EXISTS` cannot reshape
      // tables that already exist, so the operator has to see the disagreement.
      expect(await after.getMeta("saver.schema_version")).toBe("999");
    } finally {
      await after.close();
    }
  });

  it.each(["writes", "checkpoints"])("doctor preserves and reports a missing %s table", async (table) => {
    const directory = directories.create();
    expect(await main(["doctor", "--data-dir", directory], { io: capture().io })).toBe(EXIT.ok);
    const store = await SqliteStore.open({ databasePath: join(directory, "tavi.sqlite") });
    store.handle.exec(`DROP TABLE ${table}`);
    await store.close();
    const captured = capture();
    expect(await main(["doctor", "--data-dir", directory], { io: captured.io })).toBe(EXIT.ok);
    const report = JSON.parse(captured.stdout()) as {
      saverTables: string[];
      saverSchema: { matches: boolean; missingColumns: Record<string, string[]> };
    };
    expect(report.saverSchema.matches).toBe(false);
    expect(report.saverSchema.missingColumns[table]?.length).toBeGreaterThan(0);
    expect(report.saverTables).not.toContain(table);
    const inspected = await SqliteStore.open({ databasePath: join(directory, "tavi.sqlite"), checkpointMode: "inspect" });
    try {
      expect(await inspected.listSaverTables()).not.toContain(table);
    } finally {
      await inspected.close();
    }
  });

  it("prints task history for the configured data directory", async () => {
    const directory = directories.create();
    const captured = capture();
    const runtimes: TaviRuntime[] = [];
    await main(runArgs(directory), { io: captured.io, runtimeFactory: factoryWith(scriptedModel(), runtimes) });
    for (const runtime of runtimes) await runtime.close();

    const tasksCapture = capture();
    process.env["TAVI_DATA_DIR"] = directory;
    try {
      expect(await main(["tasks"], { io: tasksCapture.io })).toBe(EXIT.ok);
    } finally {
      delete process.env["TAVI_DATA_DIR"];
    }
    expect(JSON.parse(tasksCapture.stdout())).toMatchObject({ dataDirectory: directory });
    expect(tasksCapture.stdout()).toContain("completed");
  });

  it("shows one task's full timeline by id, and refuses an unknown id with NOT_FOUND", async () => {
    const directory = directories.create();
    const runCaptured = capture();
    const runtimes: TaviRuntime[] = [];
    await main(runArgs(directory), { io: runCaptured.io, runtimeFactory: factoryWith(scriptedModel(), runtimes) });
    for (const runtime of runtimes) await runtime.close();

    const listCapture = capture();
    process.env["TAVI_DATA_DIR"] = directory;
    let taskId: string;
    try {
      expect(await main(["tasks"], { io: listCapture.io })).toBe(EXIT.ok);
      const document = JSON.parse(listCapture.stdout()) as { tasks: { taskId: string }[] };
      taskId = document.tasks[0]?.taskId ?? "";
      expect(taskId).not.toBe("");

      const shown = capture();
      expect(await main(["tasks", taskId], { io: shown.io })).toBe(EXIT.ok);
      const detail = JSON.parse(shown.stdout()) as {
        found: boolean;
        task: { taskId: string; status: string } | null;
        executions: unknown[];
        admissions: unknown[];
      };
      expect(detail.found).toBe(true);
      expect(detail.task?.taskId).toBe(taskId);
      expect(detail.task?.status).toBe("completed");
      expect(Array.isArray(detail.executions)).toBe(true);
      expect(Array.isArray(detail.admissions)).toBe(true);
      // Not the bounded 50-task list's shape: a single-task document, not an array.
      expect(shown.stdout()).not.toContain('"tasks":');

      const missing = capture();
      const missingCode = await main(["tasks", "not-a-real-task-id"], { io: missing.io });
      expect(missingCode).toBe(EXIT.unavailable);
      expect(missing.stderr()).toContain("NOT_FOUND");
    } finally {
      delete process.env["TAVI_DATA_DIR"];
    }
  });

  it("refuses a reserved --operation-key as a usage error, before any task is touched", async () => {
    // Raised any later, the refusal surfaced inside a resume's failure path —
    // which writes `failed` onto a merely-waiting task — or escaped `main()`.
    const directory = directories.create();
    for (const argv of [
      ["run", "hello", "--operation-key", "schedule:forged", "--data-dir", directory],
      ["approvals", "approve", "task-x", "--operation-key", "schedule:forged", "--data-dir", directory],
      ["artifacts", "approve", "art-x", "--operation-key", "schedule:forged", "--data-dir", directory],
    ]) {
      const captured = capture();
      await expect(main(argv, { io: captured.io })).resolves.toBe(EXIT.usage);
      expect(captured.stderr()).toContain("reserved prefix schedule:");
    }
  });

  it("refuses --label on tasks: there is no outcome label to record", async () => {
    const captured = capture();
    expect(await main(["tasks", "some-task", "--label", "success"], { io: captured.io })).toBe(EXIT.usage);
    expect(captured.stderr()).toContain("Unexpected argument --label");
  });

  it("prints the build id and usage", async () => {
    const version = capture();
    expect(await main(["--version"], { io: version.io })).toBe(EXIT.ok);
    // The CLI package's own version, read at startup: never a literal that goes stale.
    const packaged = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string };
    // From a checkout it names the commit too; from a source archive, the version alone.
    expect(version.stdout()).toBe(`${formatVersion(packaged.version, checkoutRevision())}\n`);
    expect(packaged.version).not.toBe("");

    const help = capture();
    expect(await main(["--help"], { io: help.io })).toBe(EXIT.ok);
    expect(help.stdout()).toContain("tavi run");
    // Every family the CLI actually has, so the root page is a usable index.
    for (const line of [
      "tavi schedules <action>",
      "tavi projects <action>",
      "tavi service <action>",
      "tavi credentials <action>",
      "tavi reports <action>",
    ]) {
      expect(help.stdout()).toContain(line);
    }
  });

  it("answers --help after a subcommand with that subcommand's page, not the root page", async () => {
    // A family falling through to the root help would show the operator asking
    // about `schedules` the whole CLI. Driven from the exported constants by
    // identity, so a mismatched constant cannot pass.
    const families: readonly (readonly [readonly string[], string])[] = [
      [["models", "--help"], MODELS_USAGE],
      [["memory", "--help"], MEMORY_USAGE],
      [["skills", "--help"], SKILLS_USAGE],
      [["reports", "--help"], REPORTS_USAGE],
      [["credentials", "--help"], CREDENTIALS_USAGE],
      [["bindings", "--help"], BINDINGS_USAGE],
      [["artifacts", "--help"], ARTIFACTS_USAGE],
      [["approvals", "--help"], APPROVALS_USAGE],
      [["serve", "--help"], SERVE_USAGE],
      [["recover", "--help"], RECOVER_USAGE],
      [["cancel", "--help"], CANCEL_USAGE],
      [["service", "--help"], SERVICE_USAGE],
      [["projects", "--help"], PROJECTS_USAGE],
      [["agents", "--help"], AGENTS_USAGE],
      [["schedules", "--help"], SCHEDULES_USAGE],
      [["run", "--help"], RUN_USAGE],
      // The in-loop site: `--help` after an action, not just after the family.
      [["artifacts", "list", "--help"], ARTIFACTS_USAGE],
      [["memory", "list", "--help"], MEMORY_USAGE],
    ];
    // `list` runs over IPC under a live owner (CLI.md, the live owner's table): the help says so, not that it refuses.
    expect(ARTIFACTS_USAGE).not.toMatch(/refuses while/);
    expect(ARTIFACTS_USAGE).toMatch(/`list`, `approve` and\s+`reject` run on the running `tavi serve`/);
    for (const [argv, usage] of families) {
      const shown = capture();
      expect(await main([...argv], { io: shown.io }), argv.join(" ")).toBe(EXIT.ok);
      expect(shown.stdout(), argv.join(" ")).toBe(fittedText(usage, 80));
    }
  });

  it("answers an unknown command in one line pointing at the command index, not with a page", async () => {
    // The error is what the operator needs; the index is one `tavi --help` away.
    const shown = capture();
    expect(await main(["frobnicate"], { io: shown.io })).toBe(EXIT.usage);
    expect(shown.stderr()).toBe('Unknown command "frobnicate". See `tavi --help`.\n');
  });

  it("treats a missing action as a usage error in every family, never as silent success", async () => {
    // A bare `tavi credentials`/`tavi reports` printing the *root* help and
    // exiting 0 would make a forgotten action look like success. The rule is
    // uniform across families, because a split rule is indistinguishable from
    // the outside.
    const families: readonly (readonly [string, string])[] = [
      ["models", MODELS_USAGE],
      ["memory", MEMORY_USAGE],
      ["skills", SKILLS_USAGE],
      ["reports", REPORTS_USAGE],
      ["credentials", CREDENTIALS_USAGE],
      ["bindings", BINDINGS_USAGE],
      ["artifacts", ARTIFACTS_USAGE],
      ["approvals", APPROVALS_USAGE],
      ["service", SERVICE_USAGE],
      ["projects", PROJECTS_USAGE],
      ["agents", AGENTS_USAGE],
      ["schedules", SCHEDULES_USAGE],
    ];
    for (const [command, usage] of families) {
      const shown = capture();
      expect(await main([command], { io: shown.io }), command).toBe(EXIT.usage);
      expect(shown.stderr(), command).toContain(`${command} needs an action`);
      // One line pointing at its own page — not the root page, and not another family's.
      expect(
        shown
          .stderr()
          .split("\n")
          .filter((line) => line !== ""),
        command,
      ).toHaveLength(1);
      expect(shown.stderr(), command).toMatch(new RegExp(`See \`tavi ${command} --help\`\\.\\n$`));
      expect(usage, command).toContain(`tavi ${command}`);
    }
  });

  it("points a flag placed before the command at the root page, not the run page", async () => {
    // `tavi --data-dir X models add` must not answer with the *run* usage page,
    // which is the one document that could not help with the mistake.
    const shown = capture();
    expect(await main(["--data-dir", "X", "models", "add"], { io: shown.io })).toBe(EXIT.usage);
    expect(shown.stderr()).toContain('Unknown option "--data-dir" before a command');
    expect(shown.stderr()).toMatch(/See `tavi --help`\.\n$/);
  });
});

describe("argument validation", () => {
  const cases: readonly [string, readonly string[], string][] = [
    ["unknown command", ["frobnicate"], "Unknown command"],
    ["missing prompt", ["run", "--connection", "c", "--model", "m"], "requires a prompt"],
    // Neither model flag is individually required: with no configured
    // workspace default to fall back to, the run reports that as a usage error.
    // The `--connection <unknown>` case is NOT a usage error either — it is
    // "target not found", which has its own dedicated test below.
    ["missing connection", ["run", "hello"], "no model is configured"],
    ["bad format", ["run", "hi", "--connection", "c", "--model", "m", "--format", "yaml"], "--format takes text or json"],
    ["bad approval", ["run", "hi", "--connection", "c", "--model", "m", "--approval", "maybe"], "--approval must be"],
    ["missing flag value", ["run", "hi", "--connection"], "requires a value"],
  ];

  for (const [name, argv, expected] of cases) {
    it(`rejects ${name} with a usage exit code`, async () => {
      const captured = capture();
      // The model-target cases now reach `resolveModelTarget`, which reads the
      // data directory, so they must not touch the repository's real `./.tavi`
      // — otherwise they assert an environment fact the suite does not control.
      const args = argv[0] === "run" ? [argv[0], "--data-dir", directories.create(), ...argv.slice(1)] : argv;
      expect(await main(args, { io: captured.io })).toBe(EXIT.usage);
      expect(captured.stderr()).toContain(expected);
    });
  }

  it("accepts an inline --flag=value form", async () => {
    const captured = capture();
    // Parses successfully, then fails composition because the connection is fake.
    const code = await main(["run", "hi", "--connection=fake", "--model=fake", "--in-memory"], { io: captured.io });
    expect([EXIT.ok, EXIT.unavailable, EXIT.taskFailed, EXIT.internal]).toContain(code);
  });
});

describe("runtime isolation", () => {
  it("closes the database even when the run fails", async () => {
    const directory = directories.create();
    const captured = capture();
    const runtimes: TaviRuntime[] = [];
    const failing: ModelPort = {
      async stream(): Promise<ModelOutcome> {
        throw new Error("boom");
      },
    };
    await main(runArgs(directory), { io: captured.io, runtimeFactory: factoryWith(failing, runtimes) });
    expect(runtimes[0]?.store.isOpen).toBe(false);
  });
});

describe("composition failure handling", () => {
  it("closes the database when composition fails midway", async () => {
    const directory = directories.create();
    const { SqliteStore } = await import("../support/database-fixture.js");
    const store = await SqliteStore.open({
      databasePath: join(directory, "tavi.sqlite"),
      artifactsDirectory: join(directory, "artifacts"),
    });

    // A composition that requires a model transport but is given none must fail
    // after the store is already open.
    await expect(
      composeTaviRuntime(
        {
          dataDirectory: directory,
          workspaces: [workspaceGrant],
          providers: [],
          credentials: {},
          defaultConnectionId: "fixture",
          defaultModel: "fixture-model",
        },
        { store, requireModelTransport: true },
      ),
    ).rejects.toThrowError(/No model provider connection/);

    expect(store.isOpen).toBe(false);
  });

  it("bounds an oversized tool payload in a client event", async () => {
    const directory = directories.create();
    const captured = capture();
    const huge = "x".repeat(50_000);
    const bigPayload: ModelPort = {
      async stream(request, options): Promise<ModelOutcome> {
        options.onEvent({
          type: "tool.completed",
          attemptId: request.attemptId,
          blockId: "call-big",
          toolName: "fixture.echo",
          callId: "call-big",
          input: { message: "hi" },
        });
        return {
          status: "completed",
          attemptId: request.attemptId,
          text: huge,
          toolCalls: [],
          usage: {},
        };
      },
    };
    const runtimes: TaviRuntime[] = [];
    // Text deltas are delivered through the event sink, which bounds them.
    const code = await main(runArgs(directory, ["--format", "json"]), {
      io: captured.io,
      runtimeFactory: factoryWith(bigPayload, runtimes),
    });
    expect(code).toBe(EXIT.ok);
    for (const event of parseEvents(captured.stdout())) {
      expect(JSON.stringify(event).length).toBeLessThan(200_000);
    }
    for (const runtime of runtimes) await runtime.close();
  });
});

describe("real AI SDK transport through the full stack", () => {
  it("completes model → tool → model against a synthetic OpenAI-compatible endpoint", async () => {
    const directory = directories.create();
    const captured = capture();
    const { createAiSdkModelAdapter } = await import("@tavi/agent-host/models");

    let turn = 0;
    const requests: { messages: { role: string; tool_calls?: { id: string }[]; tool_call_id?: string }[] }[] = [];
    const adapter = createAiSdkModelAdapter({
      connections: [
        {
          connectionId: "fixture",
          kind: "openai-compatible",
          baseUrl: "https://fixture.invalid/v1",
          credentialRef: "fixture.apiKey",
        },
      ],
      readSecret: async () => "test-key",
      fetch: async (_url, init) => {
        requests.push(JSON.parse(typeof init?.body === "string" ? init.body : "{}"));
        turn += 1;
        const body =
          turn === 1
            ? sse([toolCallChunk({ id: "call-1", name: "fixture.echo", arguments: { message: "ping" } }), textChunk("", "tool_calls")])
            : sse([textChunk("echoed ping", null), textChunk("", "stop")]);
        return new Response(body, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      },
    });

    const runtimes: TaviRuntime[] = [];
    const code = await main(runArgs(directory), {
      io: captured.io,
      runtimeFactory: async (options, overrides) => {
        const runtime = await composeTaviRuntime(
          { ...options, logger: { level: "error", sink: () => {} } },
          { ...overrides, modelOverride: adapter },
        );
        runtimes.push(runtime);
        return runtime;
      },
    });

    expect(code).toBe(EXIT.ok);
    expect(captured.stdout()).toContain("echoed ping");
    expect(requests).toHaveLength(2);

    // Turn one: the workflow's system prompt is delivered, and the request is
    // accepted rather than rejected as an invalid prompt.
    const systems = requests[0]?.messages.filter((message) => message.role === "system") ?? [];
    expect(systems).toHaveLength(1);
    expect(JSON.stringify(systems[0])).toContain("Tavi");

    // Turn two: the tool result is introduced by the matching assistant tool call.
    const assistant = requests[1]?.messages.find((message) => message.role === "assistant");
    const tool = requests[1]?.messages.find((message) => message.role === "tool");
    expect(assistant?.tool_calls?.[0]?.id).toBe("call-1");
    expect(tool?.tool_call_id).toBe("call-1");

    for (const runtime of runtimes) await runtime.close();
  });
});

describe("tavi recover", () => {
  it("requires explicit termination evidence", async () => {
    const captured = capture();
    // A generation without a reason is refused: the decision is recorded.
    expect(await main(["recover", "task-1", "--generation", "1"], { io: captured.io })).toBe(EXIT.usage);
    expect(captured.stderr()).toContain("--reason is required");

    const noGeneration = capture();
    expect(await main(["recover", "task-1", "--reason", "gone"], { io: noGeneration.io })).toBe(EXIT.usage);
    expect(noGeneration.stderr()).toContain("--generation is required");
  });

  it("reports a task with no recorded execution instead of pretending to recover it", async () => {
    const directory = directories.create();
    const captured = capture();
    const code = await main(["recover", "no-such-task", "--generation", "1", "--reason", "gone", "--data-dir", directory], {
      io: captured.io,
    });
    expect(code).toBe(EXIT.unavailable);
    expect(captured.stderr()).toContain("No execution is recorded");
  });

  it("terminates a generation with recorded evidence and frees the task", async () => {
    const directory = directories.create();
    const { SqliteStore } = await import("../support/database-fixture.js");
    const store = await SqliteStore.open({
      databasePath: join(directory, "tavi.sqlite"),
      artifactsDirectory: join(directory, "artifacts"),
    });
    const { task } = await store.asPort().repositories.tasks.admit({
      prompt: fixturePromptPolicy,
      workspaceId: "default",
      principalId: "operator",
      operationKey: "op-stuck",
      kind: "start",
      intent: { prompt: "hi" },
      checkpointNamespace: "",
      newTaskId: (() => "task-stuck")(),
      newAdmissionId: (() => "adm-stuck")(),
      newThreadId: (() => "thread-stuck")(),
      now: (() => "2026-01-01T00:00:00.000Z")(),
    });
    // A crashed invocation leaves an active slot whose lease later expires.
    await store.asPort().repositories.executions.acquire({
      taskId: task.taskId,
      ownerSession: "session-that-died",
      admissionId: "adm-stuck",
      leaseMs: 1_000,
      now: { fixed: (() => "2026-01-01T00:00:00.000Z")() },
    });
    await store.close();

    const captured = capture();
    const code = await main(
      [
        "recover",
        task.taskId,
        "--generation",
        "1",
        "--reason",
        "process confirmed dead by operator",
        "--operator",
        "tester",
        "--data-dir",
        directory,
      ],
      { io: captured.io },
    );
    expect(code).toBe(EXIT.ok);

    const reopened = await SqliteStore.open({
      databasePath: join(directory, "tavi.sqlite"),
      artifactsDirectory: join(directory, "artifacts"),
    });
    const record = await reopened.asPort().repositories.executions.current(task.taskId);
    expect(record?.state).toBe("terminated");
    expect(record?.terminatedReason).toContain("confirmed dead");
    expect(record?.terminatedBy).toBe("tester");

    // The replacement takes a new generation.
    const replacement = await reopened.asPort().repositories.executions.acquire({
      taskId: task.taskId,
      ownerSession: "session-new",
      admissionId: "adm-stuck",
      leaseMs: 1_000,
      now: { fixed: (() => "2026-01-01T01:00:00.000Z")() },
    });
    expect(replacement.generation).toBe(2);
    await reopened.close();
  });

  it("lists an expired lease in task history so it can be found", async () => {
    const directory = directories.create();
    const { SqliteStore } = await import("../support/database-fixture.js");
    const store = await SqliteStore.open({
      databasePath: join(directory, "tavi.sqlite"),
      artifactsDirectory: join(directory, "artifacts"),
    });
    await store.asPort().repositories.tasks.admit({
      prompt: fixturePromptPolicy,
      workspaceId: "default",
      principalId: "operator",
      operationKey: "op-expired",
      kind: "start",
      intent: { prompt: "hi" },
      checkpointNamespace: "",
      newTaskId: (() => "task-expired")(),
      newAdmissionId: (() => "adm-expired")(),
      newThreadId: (() => "thread-expired")(),
      now: (() => "2026-01-01T00:00:00.000Z")(),
    });
    await store.asPort().repositories.executions.acquire({
      taskId: "task-expired",
      ownerSession: "dead-session",
      admissionId: "adm-expired",
      leaseMs: 1_000,
      now: { fixed: (() => "2020-01-01T00:00:00.000Z")() },
    });
    await store.close();

    const captured = capture();
    process.env["TAVI_DATA_DIR"] = directory;
    try {
      expect(await main(["tasks"], { io: captured.io })).toBe(EXIT.ok);
    } finally {
      delete process.env["TAVI_DATA_DIR"];
    }
    const report = JSON.parse(captured.stdout()) as {
      expiredLeases: { ownerSession: string }[];
      unresolvedEffects: unknown[];
    };
    expect(report.expiredLeases.map((row) => row.ownerSession)).toContain("dead-session");
    expect(report.unresolvedEffects).toEqual([]);
  });
});

describe("tavi cancel", () => {
  it("requires a reason", async () => {
    const captured = capture();
    expect(await main(["cancel", "task-1"], { io: captured.io })).toBe(EXIT.usage);
    expect(captured.stderr()).toContain("--reason is required");
  });

  it("reports an unknown task instead of pretending to cancel it", async () => {
    const directory = directories.create();
    const captured = capture();
    const code = await main(["cancel", "no-such-task", "--reason", "changed my mind", "--data-dir", directory], { io: captured.io });
    expect(code).toBe(EXIT.unavailable);
    expect(captured.stderr()).toContain("does not exist");
  });

  it("cancels a task durably and closes its pending approvals", async () => {
    const directory = directories.create();
    const { SqliteStore } = await import("../support/database-fixture.js");
    const store = await SqliteStore.open({
      databasePath: join(directory, "tavi.sqlite"),
      artifactsDirectory: join(directory, "artifacts"),
    });
    const repositories = store.asPort().repositories;
    await repositories.tasks.admit({
      prompt: fixturePromptPolicy,
      workspaceId: "default",
      principalId: "operator",
      operationKey: "op-cancel",
      kind: "start",
      intent: { prompt: "hi" },
      checkpointNamespace: "",
      newTaskId: (() => "task-cancel")(),
      newAdmissionId: (() => "adm-cancel")(),
      newThreadId: (() => "thread-cancel")(),
      now: (() => "2026-01-01T00:00:00.000Z")(),
    });
    await repositories.approvals.request({
      approvalId: "approval:task-cancel:call-1",
      taskId: "task-cancel",
      admissionId: "adm-cancel",
      toolId: "fixture.write",
      callId: "call-1",
      steps: 1,
      inputs: { value: "x" },
      now: { fixed: (() => "2026-01-01T00:00:00.000Z")() },
    });
    await store.close();

    const captured = capture();
    const code = await main(
      ["cancel", "task-cancel", "--reason", "operator changed their mind", "--operator", "tester", "--data-dir", directory],
      { io: captured.io },
    );
    expect(code).toBe(EXIT.ok);
    const output = JSON.parse(captured.stdout()) as { requestedBy: string; cancelledApprovals: number };
    expect(output.requestedBy).toBe("tester");
    expect(output.cancelledApprovals).toBe(1);

    // The record survives a reopen.
    const reopened = await SqliteStore.open({
      databasePath: join(directory, "tavi.sqlite"),
      artifactsDirectory: join(directory, "artifacts"),
    });
    const repositories2 = reopened.asPort().repositories;
    expect((await repositories2.cancellations.get("task-cancel"))?.reason).toContain("changed their mind");
    expect((await repositories2.approvals.getForCall("task-cancel", "call-1"))?.state).toBe("cancelled");
    expect((await repositories2.tasks.get("task-cancel"))?.status).toBe("cancelled");
    await reopened.close();
  });

  it("surfaces cancellations and pending approvals in task history", async () => {
    const directory = directories.create();
    const { SqliteStore } = await import("../support/database-fixture.js");
    const store = await SqliteStore.open({
      databasePath: join(directory, "tavi.sqlite"),
      artifactsDirectory: join(directory, "artifacts"),
    });
    await store.asPort().repositories.tasks.admit({
      prompt: fixturePromptPolicy,
      workspaceId: "default",
      principalId: "operator",
      operationKey: "op-visible",
      kind: "start",
      intent: { prompt: "hi" },
      checkpointNamespace: "",
      newTaskId: (() => "task-visible")(),
      newAdmissionId: (() => "adm-visible")(),
      newThreadId: (() => "thread-visible")(),
      now: (() => "2026-01-01T00:00:00.000Z")(),
    });
    await store.asPort().repositories.approvals.request({
      approvalId: "approval:task-visible:call-9",
      taskId: "task-visible",
      admissionId: "adm-visible",
      toolId: "fixture.write",
      callId: "call-9",
      steps: 1,
      inputs: {},
      now: { fixed: (() => "2026-01-01T00:00:00.000Z")() },
    });
    await store.close();

    const captured = capture();
    process.env["TAVI_DATA_DIR"] = directory;
    try {
      expect(await main(["tasks"], { io: captured.io })).toBe(EXIT.ok);
    } finally {
      delete process.env["TAVI_DATA_DIR"];
    }
    const report = JSON.parse(captured.stdout()) as {
      pendingApprovals: { callId: string }[];
      cancellations: unknown[];
    };
    expect(report.pendingApprovals.map((row) => row.callId)).toContain("call-9");
    expect(report.cancellations).toEqual([]);
  });
});

describe("restart reconciliation", () => {
  it("records a receipt for a checkpoint the application never observed", async () => {
    const receipts = createInMemoryReceiptRepository();
    const report = await reconcileCheckpointReceipts({
      tasks: [{ taskId: "t1", threadId: "th1" }],
      receipts,
      latestCheckpoint: () => ({ checkpointId: "cp-from-saver", checkpointNamespace: "" }),
      now: () => "2026-01-01T00:00:00.000Z",
    });

    // The application observes the progress the saver already made; it does NOT
    // reinject the input that produced it.
    expect(report.observed).toEqual([{ taskId: "t1", checkpointId: "cp-from-saver" }]);
    expect((await receipts.latestForTask("t1"))?.checkpointId).toBe("cp-from-saver");
    // Reconciliation itself is idempotent.
    const second = await reconcileCheckpointReceipts({
      tasks: [{ taskId: "t1", threadId: "th1" }],
      receipts,
      latestCheckpoint: () => ({ checkpointId: "cp-from-saver", checkpointNamespace: "" }),
      now: () => "2026-01-01T00:00:01.000Z",
    });
    expect(second.observed).toEqual([]);
    expect(await receipts.listForTask("t1")).toHaveLength(1);
  });

  it("reports a receipt with no checkpoint behind it rather than trusting it", async () => {
    const receipts = createInMemoryReceiptRepository();
    await receipts.record({
      taskId: "t1",
      threadId: "th1",
      checkpointNamespace: "",
      checkpointId: "cp-gone",
      admissionId: "a1",
      source: "admission",
      now: { fixed: (() => "2026-01-01T00:00:00.000Z")() },
    });
    const report = await reconcileCheckpointReceipts({
      tasks: [{ taskId: "t1", threadId: "th1" }],
      receipts,
      latestCheckpoint: () => undefined,
      now: () => "2026-01-01T00:00:01.000Z",
    });
    // A dangling receipt means the saver has nothing to resume from, so the
    // application must not treat the task as having progressed.
    expect(report.dangling).toEqual([{ taskId: "t1", checkpointId: "cp-gone" }]);
    expect(report.observed).toEqual([]);
  });

  it("does nothing for a task that never ran", async () => {
    const receipts = createInMemoryReceiptRepository();
    const report = await reconcileCheckpointReceipts({
      tasks: [{ taskId: "t1", threadId: "th1" }],
      receipts,
      latestCheckpoint: () => undefined,
      now: () => "2026-01-01T00:00:00.000Z",
    });
    expect(report).toEqual({ observed: [], dangling: [] });
  });

  it("keeps a receipt recorded for a newer checkpoint than the saver reports", async () => {
    const receipts = createInMemoryReceiptRepository();
    await receipts.record({
      taskId: "t1",
      threadId: "th1",
      checkpointNamespace: "",
      checkpointId: "cp-1",
      admissionId: "a1",
      source: "admission",
      now: { fixed: (() => "2026-01-01T00:00:00.000Z")() },
    });
    const report = await reconcileCheckpointReceipts({
      tasks: [{ taskId: "t1", threadId: "th1" }],
      receipts,
      latestCheckpoint: () => ({ checkpointId: "cp-1", checkpointNamespace: "" }),
      now: () => "2026-01-01T00:00:01.000Z",
    });
    expect(report.observed).toEqual([]);
    expect(await receipts.listForTask("t1")).toHaveLength(1);
  });
});

describe("reconciliation detects a checkpoint newer than the last receipt", () => {
  it("records the newer checkpoint instead of stopping at an older receipt", async () => {
    const receipts = createInMemoryReceiptRepository();
    // The task already has a receipt for an older checkpoint, which is the state
    // a crash between a durable checkpoint and its receipt write leaves behind.
    await receipts.record({
      taskId: "t1",
      threadId: "th1",
      checkpointNamespace: "",
      checkpointId: "cp-old",
      admissionId: "a1",
      source: "admission",
      now: { fixed: (() => "2026-01-01T00:00:00.000Z")() },
    });

    const report = await reconcileCheckpointReceipts({
      tasks: [{ taskId: "t1", threadId: "th1" }],
      receipts,
      latestCheckpoint: () => ({ checkpointId: "cp-new", checkpointNamespace: "" }),
      now: () => "2026-01-01T00:00:01.000Z",
    });

    // Comparing presence alone would have found "a receipt exists" and stopped.
    expect(report.observed).toEqual([{ taskId: "t1", checkpointId: "cp-new" }]);
    expect((await receipts.latestForTask("t1"))?.checkpointId).toBe("cp-new");
    expect((await receipts.latestForTask("t1"))?.source).toBe("reconcile");
    expect(await receipts.listForTask("t1")).toHaveLength(2);
  });

  it("records the saver's real namespace, not a hardcoded one", async () => {
    const receipts = createInMemoryReceiptRepository();
    await reconcileCheckpointReceipts({
      tasks: [{ taskId: "t1", threadId: "th1" }],
      receipts,
      latestCheckpoint: () => ({ checkpointId: "cp-sub", checkpointNamespace: "subgraph/a" }),
      now: () => "2026-01-01T00:00:00.000Z",
    });
    expect((await receipts.latestForTask("t1"))?.checkpointNamespace).toBe("subgraph/a");
  });

  it("does not report dangling when no checkpoint reader is available", async () => {
    const receipts = createInMemoryReceiptRepository();
    await receipts.record({
      taskId: "t1",
      threadId: "th1",
      checkpointNamespace: "",
      checkpointId: "cp-1",
      admissionId: "a1",
      source: "admission",
      now: { fixed: (() => "2026-01-01T00:00:00.000Z")() },
    });
    const report = await reconcileCheckpointReceipts({
      tasks: [{ taskId: "t1", threadId: "th1" }],
      receipts,
      latestCheckpoint: () => undefined,
      now: () => "2026-01-01T00:00:01.000Z",
      // No reader: an unreadable checkpoint is not evidence of data loss.
      canReadCheckpoints: false,
    });
    expect(report).toEqual({ observed: [], dangling: [] });
  });
});

describe("single-owner behaviour", () => {
  it("refuses a second owner with a designed exit code, not an internal error", async () => {
    const directory = directories.create();
    const { acquireDataDirectoryOwnership } = await import("@tavi/runtime");
    const owner = await acquireDataDirectoryOwnership({ dataDirectory: directory, sessionId: "holder" });
    try {
      const captured = capture();
      const code = await main(["run", "hi", "--connection", "c", "--model", "m", "--data-dir", directory], { io: captured.io });
      // Another owner is a designed refusal, so it is distinguishable from a crash.
      expect(code).toBe(EXIT.alreadyOwned);
      expect(captured.stderr()).toMatch(/already owns .*; this command needs it to itself\. Wait for it to finish/);
    } finally {
      owner.release();
    }
  });

  it("lists a directory's owner so the operator can see who holds it", async () => {
    const directory = directories.create();
    const captured = capture();
    process.env["TAVI_DATA_DIR"] = directory;
    try {
      expect(await main(["tasks"], { io: captured.io })).toBe(EXIT.ok);
    } finally {
      delete process.env["TAVI_DATA_DIR"];
    }
    const report = JSON.parse(captured.stdout()) as { owner: { session_id?: string } | null };
    // `tasks` attached or owned the directory, and reports who holds it.
    expect(report).toHaveProperty("owner");
  });

  it("refuses to cancel against a directory another process owns without a live owner to attach to", async () => {
    const directory = directories.create();
    const { SqliteStore } = await import("../support/database-fixture.js");
    const { acquireDataDirectoryOwnership } = await import("@tavi/runtime");
    const seed = await SqliteStore.open({
      databasePath: join(directory, "tavi.sqlite"),
      artifactsDirectory: join(directory, "artifacts"),
    });
    await seed.asPort().repositories.tasks.admit({
      prompt: fixturePromptPolicy,
      workspaceId: "default",
      principalId: "operator",
      operationKey: "op-live",
      kind: "start",
      intent: { prompt: "hi" },
      checkpointNamespace: "",
      newTaskId: (() => "task-live")(),
      newAdmissionId: (() => "adm-live")(),
      newThreadId: (() => "thread-live")(),
      now: (() => "2026-01-01T00:00:00.000Z")(),
    });
    await seed.close();

    // A foreign owner holds the directory lock but publishes no IPC discovery, so
    // there is nothing to attach to. Writing here would make this process a second
    // SQLite writer, and a data directory has only one, so the command must refuse.
    const owner = await acquireDataDirectoryOwnership({ dataDirectory: directory, sessionId: "live-owner" });
    try {
      const captured = capture();
      const code = await main(["cancel", "task-live", "--reason", "stop it now", "--data-dir", directory], { io: captured.io });
      expect(code).toBe(EXIT.alreadyOwned);
      expect(captured.stderr()).toMatch(/already owns .*; this command needs it to itself/);
    } finally {
      owner.release();
    }

    const reopened = await SqliteStore.open({
      databasePath: join(directory, "tavi.sqlite"),
      artifactsDirectory: join(directory, "artifacts"),
    });
    // Nothing was written while the owner held the directory.
    expect(await reopened.asPort().repositories.cancellations.get("task-live")).toBeUndefined();
    expect((await reopened.asPort().repositories.tasks.get("task-live"))?.status).toBe("admitted");
    await reopened.close();
  });
});

describe("data-directory resolution", () => {
  const withEnv = async (value: string, body: () => Promise<void>): Promise<void> => {
    const previous = process.env["TAVI_DATA_DIR"];
    process.env["TAVI_DATA_DIR"] = value;
    try {
      await body();
    } finally {
      if (previous === undefined) delete process.env["TAVI_DATA_DIR"];
      else process.env["TAVI_DATA_DIR"] = previous;
    }
  };

  it("targets TAVI_DATA_DIR for tasks, cancel and doctor when no flag is given", async () => {
    const directory = directories.create();
    await withEnv(directory, async () => {
      const tasks = capture();
      expect(await main(["tasks"], { io: tasks.io })).toBe(EXIT.ok);
      // The operator named a directory in the environment; that is the directory
      // every command must use, not the repository default.
      expect((JSON.parse(tasks.stdout()) as { dataDirectory: string }).dataDirectory).toBe(directory);

      const cancel = capture();
      // No task exists there, which proves the command looked in this directory
      // rather than in ./.tavi.
      expect(await main(["cancel", "absent", "--reason", "x"], { io: cancel.io })).toBe(EXIT.unavailable);
      expect(cancel.stderr()).toContain("Task absent does not exist");

      const doctor = capture();
      expect(await main(["doctor"], { io: doctor.io })).toBe(EXIT.ok);
      expect(doctor.stdout()).toContain("applicationTables");
    });
  });

  it("lets --data-dir win over TAVI_DATA_DIR", async () => {
    const directory = directories.create();
    const other = directories.create();
    await withEnv(other, async () => {
      const tasks = capture();
      expect(await main(["tasks", "--data-dir", directory], { io: tasks.io })).toBe(EXIT.ok);
      expect((JSON.parse(tasks.stdout()) as { dataDirectory: string }).dataDirectory).toBe(directory);
    });
  });

  it("resolves a relative data directory against the current directory", async () => {
    const directory = directories.create();
    const previous = process.cwd();
    process.chdir(directory);
    const { resolve } = await import("node:path");
    try {
      const tasks = capture();
      expect(await main(["tasks", "--data-dir", "."], { io: tasks.io })).toBe(EXIT.ok);
      // Absolute, because the path is published to clients as part of the
      // endpoint: a relative one would be read against each client's cwd. The
      // expected value comes from the same source the code uses (`process.cwd()`
      // resolves symlinks on macOS), so this compares resolution, not realpath.
      const resolved = (JSON.parse(tasks.stdout()) as { dataDirectory: string }).dataDirectory;
      expect(resolved).toBe(resolve(process.cwd()));
      expect(resolved.startsWith("/")).toBe(true);
    } finally {
      process.chdir(previous);
    }
  });

  it("reads run --home, and refuses it with --attach or --in-memory", async () => {
    const { parseArgs } = await import("../../src/cli/parse.js");
    expect(parseArgs(["run", "--home", "hi"]).options).toMatchObject({ prompt: "hi", home: true });
    expect(parseArgs(["run", "hi"]).options?.home).toBeUndefined();
    expect(() => parseArgs(["run", "--home", "--attach", "t1"])).toThrow(/--home/);
    expect(() => parseArgs(["run", "--home", "--in-memory", "hi"])).toThrow(/--home/);
  });

  it("leaves the directory unset in every parser so the environment can decide", async () => {
    const { parseArgs } = await import("../../src/cli/parse.js");
    expect(parseArgs(["run", "hi", "--connection", "c", "--model", "m"]).options?.dataDirectory).toBeUndefined();
    expect(parseArgs(["serve"]).serve?.dataDirectory).toBeUndefined();
    expect(parseArgs(["cancel", "t", "--reason", "r"]).cancel?.dataDirectory).toBeUndefined();
    expect(parseArgs(["recover", "t", "--generation", "1", "--reason", "r"]).recover?.dataDirectory).toBeUndefined();
    expect(parseArgs(["tasks"]).dataDirectory).toBeUndefined();
    expect(parseArgs(["doctor"]).dataDirectory).toBeUndefined();
    // `tasks` and `doctor` accept the flag too, which the early-returning parser
    // used to swallow for `doctor`.
    expect(parseArgs(["tasks", "--data-dir", "/tmp/x"]).dataDirectory).toBe("/tmp/x");
    expect(parseArgs(["doctor", "--data-dir", "/tmp/y"]).dataDirectory).toBe("/tmp/y");
  });

  it("rejects a flag used as another flag's value", async () => {
    const { parseArgs } = await import("../../src/cli/parse.js");
    expect(() => parseArgs(["serve", "--data-dir", "--model", "x"])).toThrowError(/requires a value/);
    expect(() => parseArgs(["cancel", "t", "--reason", "--operator", "x"])).toThrowError(/requires a value/);
  });
});

describe("switches given a value, and switches given twice", () => {
  it("plugins ui: --yes is set-role's alone, and takes no value on any action", async () => {
    const { parseArgs } = await import("../../src/cli/parse.js");
    expect(() => parseArgs(["plugins", "ui", "list", "--yes"])).toThrowError("--yes applies to plugins ui set-role only");
    expect(() => parseArgs(["plugins", "ui", "list", "--yes=true"])).toThrowError("plugins ui list does not accept --yes");
    expect(() => parseArgs(["plugins", "ui", "set-role", "browser-view", "acme.view", "--yes=true"])).toThrowError(
      "plugins ui set-role does not accept --yes",
    );
    expect(parseArgs(["plugins", "ui", "set-role", "browser-view", "acme.view", "--yes"])).toMatchObject({
      pluginsUi: { action: "set-role", yes: true },
    });
  });

  it("heartbeat forget: --yes and then --yes=true is one flag given twice", async () => {
    const { parseArgs } = await import("../../src/cli/parse.js");
    expect(() => parseArgs(["heartbeat", "forget", "--yes", "--yes=true"])).toThrowError("--yes may be given only once");
    expect(parseArgs(["heartbeat", "forget", "--yes=true"])).toMatchObject({ command: "heartbeat" });
    expect(parseArgs(["heartbeat", "forget", "--yes", "--yes"])).toMatchObject({ command: "heartbeat" });
  });
});
