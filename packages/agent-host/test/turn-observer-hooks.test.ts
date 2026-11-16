import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  ATTENDED_TASK_POLICY,
  NO_TURN_HOOKS,
  type InvocationContext,
  type ModEvent,
  type ModelEvent,
  type ModelOutcome,
  type ModelPort,
  type ModelRequest,
  type DeclaredToolDefinition,
  type ToolRegistryPort,
  type TurnHooksPort,
} from "@tavi/contracts";
import {
  createInMemoryApprovalRepository,
  createInMemoryCancellationRepository,
  createInMemoryEffectRepository,
  createInMemoryExecutionRepository,
  createInMemoryReceiptRepository,
  createInMemorySaver,
  createInMemoryTaskRepository,
} from "@tavi/test-support/fakes";
import { createWorkflowAdapter } from "@tavi/agent-host/workflow";
import { sleep } from "@tavi/node-kit";

/** Turn observers: told, never awaited, never able to change the turn. */

const context: InvocationContext = { workspaceId: "ws1", principalId: "p1", runId: "root", caller: "test" };
const schema = z.strictObject({});
const definitions: readonly DeclaredToolDefinition[] = [
  { id: "fixture.read", sink: "none", version: "1", description: "Read", effect: "read-only", requiredPermissions: [] },
  { id: "fixture.write", sink: "none", version: "1", description: "Write", effect: "mutating", requiredPermissions: [] },
];
const byId = new Map(definitions.map((definition) => [definition.id, definition]));
const modelName = (id: string) => id.replace(".", "_");

const registry: ToolRegistryPort = {
  register: () => {
    throw new Error("not used");
  },
  get: (id) => {
    const definition = byId.get(id);
    return definition === undefined
      ? undefined
      : {
          ...definition,
          inputSchema: schema,
          inputJsonSchema: z.toJSONSchema(schema, { io: "input" }) as Record<string, unknown>,
          modelName: modelName(id),
          handler: async () => ({ ok: true }),
        };
  },
  list: () => definitions,
  listOffered: async () => definitions,
  inputSchemaOf: (id) => (byId.has(id) ? schema : undefined),
  inputJsonSchemaOf: (id) => (byId.has(id) ? (z.toJSONSchema(schema, { io: "input" }) as Record<string, unknown>) : undefined),
  modelNameOf: (id) => (byId.has(id) ? modelName(id) : undefined),
  resolveModelName: (name) => [...byId.keys()].find((id) => modelName(id) === name),
};

/** One call of `tool`, then an answer; a fresh one per adapter. */
const fixtureModel = (tool = "fixture.read"): ModelPort => {
  let turn = 0;
  return {
    async stream(request: ModelRequest, options: { readonly onEvent: (event: ModelEvent) => void }): Promise<ModelOutcome> {
      turn += 1;
      const usage = { inputTokens: 100, outputTokens: 10, inputCacheReadTokens: 80, inputCacheWriteTokens: 5 };
      if (turn === 1)
        return { status: "completed", attemptId: request.attemptId, text: "", toolCalls: [{ id: "c1", name: tool, input: {} }], usage };
      options.onEvent({ type: "text.delta", attemptId: request.attemptId, blockId: "b", text: "done" });
      return { status: "completed", attemptId: request.attemptId, text: "done", toolCalls: [], usage };
    },
  };
};

/** A port that records observer events, holding each for `delayMs` and trying to answer something. */
function recorder(delayMs = 0): { port: TurnHooksPort; seen: { event: ModEvent; input: unknown }[] } {
  const seen: { event: ModEvent; input: unknown }[] = [];
  return {
    seen,
    port: {
      has: (event) => event === "turn.start" || event === "model.step" || event === "turn.complete",
      dispatch: async (event, input, core) => {
        await sleep(delayMs);
        seen.push({ event, input });
        return NO_TURN_HOOKS.dispatch(event, input, core);
      },
    },
  };
}

function adapter(turnHooks: TurnHooksPort, extra: Partial<Parameters<typeof createWorkflowAdapter>[0]> = {}, tool?: string) {
  let counter = 0;
  return createWorkflowAdapter({
    checkpointSaver: createInMemorySaver().saver,
    models: fixtureModel(tool),
    tools: registry,
    tasks: createInMemoryTaskRepository(),
    executions: createInMemoryExecutionRepository(),
    effects: createInMemoryEffectRepository(),
    receipts: createInMemoryReceiptRepository(),
    approvals: createInMemoryApprovalRepository(),
    cancellations: createInMemoryCancellationRepository(),
    ownerSession: "test-session",
    connectionId: "fixture",
    model: "fixture-model",
    systemPrompt: "test system prompt",
    access: { resolveWorkspace: () => ({ principalId: context.principalId }), missingPermissions: () => [] },
    toolPolicy: { rules: async () => [], sessionGrants: async () => [] },
    turnHooks,
    newId: (prefix) => `${prefix}-${(counter += 1)}`,
    now: () => "2026-01-01T00:00:00.000Z",
    ...extra,
  } as Parameters<typeof createWorkflowAdapter>[0]);
}

const settle = () => sleep(100);

describe("turn observers", () => {
  it("tells observers the turn's start, each model step, and its end with usage and tool calls", async () => {
    const { port, seen } = recorder();
    const result = await adapter(port).admit({
      context,
      operationKey: "op-observe",
      kind: "start",
      prompt: "read",
      origin: "cli",
      executionPolicy: ATTENDED_TASK_POLICY,
    });
    expect(result.outcome.status).toBe("completed");
    await settle();
    expect(seen.map((entry) => entry.event)).toEqual(["turn.start", "model.step", "model.step", "turn.complete"]);
    expect(seen[0]?.input).toMatchObject({ kind: "start", envelope: { source: "cli", attended: true } });
    expect(seen[1]?.input).toMatchObject({ step: expect.any(Number), model: "fixture-model" });
    expect(seen[3]?.input).toMatchObject({
      outcome: "completed",
      toolCalls: 1,
      usage: { inputTokens: 200, outputTokens: 20, inputCacheReadTokens: 160, inputCacheWriteTokens: 10 },
    });
  });

  it("holds the turn up for a slow observer at most for turn.complete's 2 seconds", async () => {
    const { port, seen } = recorder(3_000);
    const started = performance.now();
    await adapter(port).admit({ context, operationKey: "op-slow", kind: "start", prompt: "read" });
    const took = performance.now() - started;
    expect(took).toBeGreaterThanOrEqual(1_900);
    expect(took).toBeLessThan(2_900);
    expect(seen).toEqual([]);
  });

  it("tells observers of a turn whose invocation throws that it failed", async () => {
    const { port, seen } = recorder();
    const saver = createInMemorySaver().saver;
    // The checkpoint store fails mid-turn: the invocation throws rather than returning an outcome.
    saver.put = async () => {
      throw new Error("the disk is full");
    };
    await adapter(port, { checkpointSaver: saver })
      .admit({ context, operationKey: "op-throw", kind: "start", prompt: "read", origin: "cli", executionPolicy: ATTENDED_TASK_POLICY })
      .catch(() => undefined);
    await settle();
    expect(seen.map((entry) => entry.event)).toContain("turn.start");
    expect(seen.find((entry) => entry.event === "turn.complete")?.input).toMatchObject({ outcome: "failed" });
  });

  it("keeps the turn's outcome when an observer's dispatch fails", async () => {
    const failing: TurnHooksPort = {
      has: () => true,
      dispatch: async (event, input, core) =>
        event === "turn.start" || event === "model.step" || event === "turn.complete"
          ? Promise.reject(new Error("observer broke"))
          : NO_TURN_HOOKS.dispatch(event, input, core),
    };
    const diagnostics: string[] = [];
    const result = await adapter(failing, { onDiagnostic: (message) => diagnostics.push(message) }).admit({
      context,
      operationKey: "op-broken",
      kind: "start",
      prompt: "read",
    });
    expect(result.outcome.status).toBe("completed");
    await settle();
    expect(diagnostics).toContain("plugins' turn.complete hooks could not be told");
  });

  it("reports a turn that waits, and the approval that resumes it as a turn of its own", async () => {
    const { port, seen } = recorder();
    const workflow = adapter(port, {}, "fixture.write");
    const first = await workflow.admit({
      context,
      operationKey: "op-wait",
      kind: "start",
      prompt: "write",
      executionPolicy: ATTENDED_TASK_POLICY,
    });
    expect(first.outcome.status).toBe("waiting");
    await workflow.admit({
      context,
      taskId: first.taskId,
      operationKey: "op-wait-decide",
      kind: "approval",
      resume: { approved: true, scope: "once", decidedBy: "alice" },
    });
    await settle();
    const turns = seen
      .filter((entry) => entry.event !== "model.step")
      .map((entry) => [
        entry.event,
        (entry.input as { kind?: string; outcome?: string }).kind ?? (entry.input as { outcome?: string }).outcome,
      ]);
    expect(turns).toEqual([
      ["turn.start", "start"],
      ["turn.complete", "waiting"],
      ["turn.start", "approval"],
      ["turn.complete", "completed"],
    ]);
  });

  it("tells a resumed turn's observers the channel the turn was held to, not the approver's", async () => {
    const { port, seen } = recorder();
    const workflow = adapter(
      port,
      {
        turnChannel: async (invocation: InvocationContext) => (invocation.messagingReplyTo === undefined ? undefined : "messaging"),
        turnConnection: async (invocation: InvocationContext) => invocation.messagingReplyTo?.connectionId,
      },
      "fixture.write",
    );
    const fromChannel = {
      ...context,
      messagingReplyTo: { connectionId: "tg1", externalConversationId: "chat-1", externalSenderId: "user-1" },
    };
    const first = await workflow.admit({
      context: fromChannel,
      operationKey: "op-held",
      kind: "start",
      prompt: "write",
      origin: "web",
      executionPolicy: ATTENDED_TASK_POLICY,
    });
    expect(first.outcome.status).toBe("waiting");
    await workflow.admit({
      context: { ...context, caller: "ipc" },
      taskId: first.taskId,
      operationKey: "op-held-decide",
      kind: "approval",
      resume: { approved: true, scope: "once", decidedBy: "alice" },
    });
    await settle();
    const resumed = seen
      .filter((entry) => entry.event !== "model.step")
      .slice(2)
      .map((entry) => (entry.input as { envelope: { source: string; channel?: string } }).envelope);
    expect(resumed).toEqual([
      expect.objectContaining({ source: "messaging", channel: "tg1" }),
      expect.objectContaining({ source: "messaging", channel: "tg1" }),
    ]);
  });

  it("tells observers a cancelled turn was cancelled, and offers it no suggestions", async () => {
    const controller = new AbortController();
    const port: TurnHooksPort = {
      has: (event) => event === "turn.complete",
      dispatch: async (event, input, core) => {
        if (event !== "turn.complete") return NO_TURN_HOOKS.dispatch(event, input, core);
        told.push((input as { outcome: string }).outcome);
        return { result: { suggestions: ["Try again"] } } as never;
      },
    };
    const told: string[] = [];
    const models: ModelPort = {
      stream: async () => {
        controller.abort(new Error("the person stopped it"));
        throw controller.signal.reason;
      },
    };
    const suggested: (readonly string[])[] = [];
    await adapter(port, { models })
      .admit(
        { context, operationKey: "op-cancel", kind: "start", prompt: "read" },
        { signal: controller.signal, onSuggestions: (suggestions) => suggested.push(suggestions) },
      )
      .catch(() => undefined);
    await settle();
    expect(told).toEqual(["cancelled"]);
    expect(suggested).toEqual([]);
  });

  it("tells a resumed turn's observers the same channel as its tool hooks, for a checkpoint with no stamped connection", async () => {
    const seen: { event: string; channel?: string }[] = [];
    const port: TurnHooksPort = {
      has: () => true,
      dispatch: async (event, input, core) => {
        seen.push({
          event,
          ...((input as { envelope: { channel?: string } }).envelope.channel === undefined
            ? {}
            : { channel: (input as { envelope: { channel?: string } }).envelope.channel }),
        });
        return NO_TURN_HOOKS.dispatch(event, input, core);
      },
    };
    // The first turn's connection is not stamped (a checkpoint written before it was), so it is read afresh.
    let stamped = false;
    const workflow = adapter(
      port,
      {
        turnChannel: async (invocation: InvocationContext) => (invocation.messagingReplyTo === undefined ? undefined : "messaging"),
        turnConnection: async (invocation: InvocationContext) =>
          stamped ? invocation.messagingReplyTo?.connectionId : ((stamped = true), undefined),
      },
      "fixture.write",
    );
    const fromChannel = {
      ...context,
      messagingReplyTo: { connectionId: "tg1", externalConversationId: "chat-1", externalSenderId: "user-1" },
    };
    const first = await workflow.admit({
      context: fromChannel,
      operationKey: "op-old",
      kind: "start",
      prompt: "write",
      executionPolicy: ATTENDED_TASK_POLICY,
    });
    expect(first.outcome.status).toBe("waiting");
    seen.length = 0;
    const approver = {
      ...context,
      caller: "messaging:tg2",
      messagingReplyTo: { connectionId: "tg2", externalConversationId: "chat-2", externalSenderId: "user-2" },
    };
    await workflow.admit({
      context: approver,
      taskId: first.taskId,
      operationKey: "op-old-decide",
      kind: "approval",
      resume: { approved: true, scope: "once", decidedBy: "alice" },
    });
    await settle();
    const channels = new Set(seen.map((entry) => entry.channel));
    expect(seen.map((entry) => entry.event)).toEqual(expect.arrayContaining(["turn.start", "tool.call", "turn.complete"]));
    expect([...channels]).toEqual(["tg1"]);
  });

  it("tells observers a turn cancelled by a recorded cancel was cancelled, with no suggestions", async () => {
    const told: string[] = [];
    const port: TurnHooksPort = {
      has: (event) => event === "turn.complete",
      dispatch: async (event, input, core) => {
        if (event !== "turn.complete") return NO_TURN_HOOKS.dispatch(event, input, core);
        told.push((input as { outcome: string }).outcome);
        return { result: { suggestions: ["Try again"] } } as never;
      },
    };
    const cancellations = createInMemoryCancellationRepository();
    // `tavi cancel` records the cancel as the turn starts; the turn's signal never fires.
    const suggested: (readonly string[])[] = [];
    const result = await adapter(port, { cancellations }).admit(
      {
        context,
        operationKey: "op-recorded-cancel",
        kind: "start",
        prompt: "read",
        onClaimed: ({ taskId }) =>
          void cancellations.request({ taskId, requestedBy: "operator", reason: "stop", now: { fixed: "2026-01-01T00:00:00.000Z" } }),
      },
      { onSuggestions: (suggestions) => suggested.push(suggestions) },
    );
    await settle();
    expect(result.outcome).toMatchObject({ status: "failed", error: { code: "CANCELLED" } });
    expect(told).toEqual(["cancelled"]);
    expect(suggested).toEqual([]);
  });

  it("hands the turn's suggestions to the admission's observer", async () => {
    const port: TurnHooksPort = {
      has: (event) => event === "turn.complete",
      dispatch: async (event, input, core) =>
        event === "turn.complete"
          ? ({ result: { suggestions: ["Run the tests", "Review the diff"] } } as never)
          : NO_TURN_HOOKS.dispatch(event, input, core),
    };
    const seen: (readonly string[])[] = [];
    await adapter(port).admit(
      { context, operationKey: "op-suggest", kind: "start", prompt: "read" },
      { onSuggestions: (suggestions) => seen.push(suggestions) },
    );
    expect(seen).toEqual([["Run the tests", "Review the diff"]]);
  });
});
