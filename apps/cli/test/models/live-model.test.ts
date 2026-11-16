import { ATTENDED_TASK_POLICY, type ModelRequest } from "@tavi/contracts";
import { ModelConfigService } from "@tavi/runtime";
import { afterEach, describe, expect, it } from "vitest";
import { composeTaviRuntime } from "../../src/runtime/composition.js";
import type { TaviRuntime } from "../../src/runtime/types.js";
import { run, scope, seeded as fixtureSeeded } from "../router/router-fixtures.js";

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

/**
 * `serve`'s composition: the default is resolved again at each turn
 * (`liveModelTarget`). `onCall`, given, runs before each model call answers;
 * a prompt naming `tool` makes the turn's first step call `fixture.echo`, so
 * the turn takes two model steps.
 */
async function owner(
  onCall?: (request: ModelRequest) => Promise<void>,
): Promise<{ runtime: TaviRuntime; models: ModelConfigService; requests: ModelRequest[] }> {
  const { directory, store } = await fixtureSeeded(cleanup);
  const requests: ModelRequest[] = [];
  const providers = ["main", "fast"].map((connectionId) => ({
    connectionId,
    kind: "openai-compatible" as const,
    baseUrl: `https://${connectionId}.invalid/v1`,
    credentialRef: `${connectionId}.key`,
  }));
  const runtime = await composeTaviRuntime(
    {
      dataDirectory: directory,
      workspaces: [{ ...scope, permissions: ["tools.invoke", "models.invoke", "runs.create"] }],
      providers,
      credentials: { "main.key": { value: "fixture" }, "fast.key": { value: "fixture" } },
      defaultConnectionId: "main",
      defaultModel: "m",
      liveModelTarget: {},
      devFixtureTools: true,
      logger: { level: "error", sink: () => {} },
      approvalRequiredFor: [],
    },
    {
      store,
      modelOverride: {
        async stream(request) {
          requests.push(request);
          await onCall?.(request);
          // A turn's first step answers the person's message; its second, the tool's result.
          const toolStep = JSON.stringify(request.messages.at(-1) ?? "").includes("use the tool");
          return toolStep
            ? {
                status: "completed",
                attemptId: request.attemptId,
                text: "",
                toolCalls: [{ id: `call-${request.attemptId}`, name: "fixture.echo", input: { message: "ping" } }],
                finishReason: "tool-calls",
                usage: {},
              }
            : { status: "completed", attemptId: request.attemptId, text: "done", toolCalls: [], usage: {} };
        },
      },
    },
  );
  cleanup.push(() => runtime.close());
  return { runtime, models: new ModelConfigService(store.asPort()), requests };
}
const reply = (runtime: TaviRuntime, taskId: string, key: string) =>
  runtime.workflow?.admit({
    context: { ...scope, runId: taskId, caller: "cli" },
    operationKey: key,
    kind: "reply",
    taskId,
    prompt: "and again",
  });
const last1 = (request: ModelRequest | undefined) => ({ connectionId: request?.connectionId, model: request?.model });
const last = (requests: readonly ModelRequest[]) => last1(requests.at(-1));

describe("switching models without a restart", () => {
  it("runs a changed default from the next turn, on a connection added after the owner started", async () => {
    const { runtime, models, requests } = await owner();
    const first = (await run(runtime, "first"))?.taskId ?? "missing";
    expect(last(requests)).toEqual({ connectionId: "main", model: "m" });
    await models.setWorkspaceDefault({ workspaceId: "default", target: { connectionId: "fast", model: "m" } });
    expect((await reply(runtime, first, "next"))?.outcome.status).toBe("completed");
    expect(last(requests)).toEqual({ connectionId: "fast", model: "m" });
    await models.putConnection({
      connectionId: "late",
      kind: "openai-compatible",
      baseUrl: "https://late.invalid/v1",
      credentialRef: "late.key",
      label: "late",
    });
    await models.setWorkspaceDefault({ workspaceId: "default", target: { connectionId: "late", model: "l" } });
    expect((await run(runtime, "late"))?.outcome.status).toBe("completed");
    expect(last(requests)).toEqual({ connectionId: "late", model: "l" });
  });

  it("keeps a chat on the model chosen for it, whatever the default", async () => {
    const { runtime, models, requests } = await owner();
    const chat = (await run(runtime, "chat"))?.taskId ?? "missing";
    await runtime.taskRouting.choose?.(scope, chat, { connectionId: "fast", model: "m" });
    expect((await reply(runtime, chat, "chosen"))?.outcome.status).toBe("completed");
    expect(last(requests)).toEqual({ connectionId: "fast", model: "m" });
    await models.setWorkspaceDefault({ workspaceId: "default", target: { connectionId: "main", model: "other" } });
    expect((await reply(runtime, chat, "still"))?.outcome.status).toBe("completed");
    expect(last(requests)).toEqual({ connectionId: "fast", model: "m" });
    expect((await run(runtime, "another"))?.outcome.status).toBe("completed");
    expect(last(requests)).toEqual({ connectionId: "main", model: "other" });
  });

  it("keeps a turn on the model it began with when the default or the chat's model changes during it", async () => {
    let change: (() => Promise<void>) | undefined;
    const { runtime, models, requests } = await owner(async () => {
      const now = change;
      change = undefined;
      await now?.();
    });
    // The default moves while the turn's first step runs: its second step stays on main.
    change = async () => {
      await models.setWorkspaceDefault({ workspaceId: "default", target: { connectionId: "fast", model: "m" } });
    };
    const chat =
      (
        await runtime.workflow?.admit({
          context: { ...scope, runId: "pending", caller: "cli" },
          operationKey: "turn",
          kind: "start",
          prompt: "use the tool",
          origin: "cli",
          executionPolicy: ATTENDED_TASK_POLICY,
        })
      )?.taskId ?? "missing";
    expect(requests.map(last1)).toEqual([
      { connectionId: "main", model: "m" },
      { connectionId: "main", model: "m" },
    ]);
    // The chat's model chosen while a turn runs: that turn stays on fast, the next runs main.
    requests.length = 0;
    change = async () => {
      await runtime.taskRouting.choose?.(scope, chat, { connectionId: "main", model: "m" });
    };
    const second = await runtime.workflow?.admit({
      context: { ...scope, runId: chat, caller: "cli" },
      operationKey: "turn-2",
      kind: "reply",
      taskId: chat,
      prompt: "use the tool again",
    });
    expect(second?.outcome, JSON.stringify(second?.outcome)).toMatchObject({ status: "completed" });
    expect(requests.map(last1)).toEqual([
      { connectionId: "fast", model: "m" },
      { connectionId: "fast", model: "m" },
    ]);
    expect((await reply(runtime, chat, "turn-3"))?.outcome.status).toBe("completed");
    expect(last(requests)).toEqual({ connectionId: "main", model: "m" });
  });

  it("runs a worker on the model chosen for its chat", async () => {
    const { runtime, models, requests } = await owner();
    const chat = (await run(runtime, "chat"))?.taskId ?? "missing";
    await runtime.taskRouting.choose?.(scope, chat, { connectionId: "fast", model: "m" });
    await models.setWorkspaceDefault({ workspaceId: "default", target: { connectionId: "main", model: "other" } });
    // A turn delegated from the chat carries it as its chat (as a worker's every turn does).
    expect(
      (
        await runtime.workflow?.admit({
          context: { ...scope, runId: "pending", caller: "agent", chatTaskId: chat },
          operationKey: "worker",
          kind: "start",
          prompt: "work",
          origin: "agent",
          chatKind: "worker",
          executionPolicy: ATTENDED_TASK_POLICY,
        })
      )?.outcome.status,
    ).toBe("completed");
    expect(last(requests)).toEqual({ connectionId: "fast", model: "m" });
  });
});
