import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  ATTENDED_TASK_POLICY,
  HEARTBEAT_REPORT_TOOL_ID,
  HEARTBEAT_TASK_POLICY,
  NO_TURN_HOOKS,
  modFolderLabels,
  type ChatFolder,
  type CallAssessment,
  type InvocationContext,
  type ModEvent,
  type ModHookInput,
  type ModelEvent,
  type ModelOutcome,
  type ModelPort,
  type ModelRequest,
  type DeclaredToolDefinition,
  type ToolRegistryPort,
  type ToolRule,
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

/**
 * `tool.check` hooks at emission: merged into
 * the gate's verdict before it is checkpointed, only ever stricter.
 */

const context: InvocationContext = { workspaceId: "ws1", principalId: "p1", runId: "root", caller: "test" };
const schema = z.strictObject({ command: z.string().optional() });
const definitions: readonly DeclaredToolDefinition[] = [
  { id: "fixture.read", sink: "none", version: "1", description: "Read", effect: "read-only", requiredPermissions: [] },
  {
    id: "fixture.secret",
    sink: "none",
    version: "1",
    description: "Read a vault",
    effect: "read-only",
    requiredPermissions: [],
    sensitivity: "sensitive",
  },
  { id: "fixture.shell", sink: "none", version: "1", description: "Run a command", effect: "external", requiredPermissions: [] },
  { id: "fixture.batch", sink: "none", version: "1", description: "Run steps", effect: "external", requiredPermissions: [] },
  { id: "fixture.fetch", sink: "none", version: "1", description: "Fetch with a key", effect: "read-only", requiredPermissions: [] },
];
const assessShell = (input: unknown): CallAssessment => {
  const command = (input as { command?: string }).command ?? "";
  return {
    display: { title: `Run ${command}` },
    subjects: [command],
    risk: "medium",
    reasons: [],
    ...(command.includes("mkfs") ? { hardDeny: "formats a disk" } : {}),
  };
};

function registry(handled: string[], extra: readonly DeclaredToolDefinition[] = []): ToolRegistryPort {
  const all = [...definitions, ...extra];
  const byId = new Map(all.map((definition) => [definition.id, definition]));
  const modelName = (id: string) => id.replace(/[^a-zA-Z0-9_-]/g, "_");
  return {
    register: () => {
      throw new Error("not used");
    },
    get: (id) => {
      const definition = byId.get(id);
      if (definition === undefined) return undefined;
      return {
        ...definition,
        inputSchema: schema,
        inputJsonSchema: z.toJSONSchema(schema, { io: "input" }) as Record<string, unknown>,
        modelName: modelName(id),
        ...(id === "fixture.shell"
          ? { assess: assessShell }
          : id === "fixture.fetch"
            ? {
                assess: (): CallAssessment => ({
                  display: { title: "Fetch" },
                  subjects: ["GET https://api.example", "credential:acme.token"],
                  risk: "medium",
                  reasons: [],
                }),
              }
            : id === "fixture.batch"
              ? {
                  assess: (): CallAssessment => ({
                    display: { title: "Run steps" },
                    subjects: [],
                    risk: "medium",
                    reasons: [],
                    ruleAliases: ["fixture.act"],
                  }),
                }
              : {}),
        handler: async () => {
          handled.push(id);
          return { ok: true };
        },
      };
    },
    list: () => all,
    listOffered: async () => all,
    inputSchemaOf: (id) => (byId.has(id) ? schema : undefined),
    inputJsonSchemaOf: (id) => (byId.has(id) ? (z.toJSONSchema(schema, { io: "input" }) as Record<string, unknown>) : undefined),
    modelNameOf: (id) => (byId.has(id) ? modelName(id) : undefined),
    resolveModelName: (name) => [...byId.keys()].find((id) => modelName(id) === name),
  };
}

function scriptedModel(call: { readonly id: string; readonly name: string; readonly input?: unknown }): {
  model: ModelPort;
  seen: string[];
} {
  const seen: string[] = [];
  let turn = 0;
  return {
    seen,
    model: {
      async stream(request: ModelRequest, options: { readonly onEvent: (event: ModelEvent) => void }): Promise<ModelOutcome> {
        seen.push(JSON.stringify(request.messages.flatMap((message) => message.toolResults ?? [])));
        turn += 1;
        if (turn === 1)
          return {
            status: "completed",
            attemptId: request.attemptId,
            text: "",
            toolCalls: [{ id: call.id, name: call.name, input: call.input ?? {} }],
            usage: {},
          };
        options.onEvent({ type: "text.delta", attemptId: request.attemptId, blockId: "b", text: "done" });
        return { status: "completed", attemptId: request.attemptId, text: "done", toolCalls: [], usage: {} };
      },
    },
  };
}

/** A port answering every `tool.check` with `answer`, as `decider`, recording what it was asked. */
function hooks(
  answer: (
    input: ModHookInput<"tool.check">,
    core: { decision: "allow" | "ask" | "deny" },
  ) => { decision: "allow" | "ask" | "deny"; reason?: string },
): { port: TurnHooksPort; asked: ModHookInput<"tool.check">[] } {
  const asked: ModHookInput<"tool.check">[] = [];
  return {
    asked,
    port: {
      has: (event: ModEvent) => event === "tool.check",
      dispatch: async (event, input, core) => {
        if (event !== "tool.check") return NO_TURN_HOOKS.dispatch(event, input, core);
        const checkInput = input as ModHookInput<"tool.check">;
        asked.push(checkInput);
        const below = (await core(input)) as { decision: "allow" | "ask" | "deny" };
        const result = answer(checkInput, below);
        const changed = result.decision !== below.decision || result.reason !== undefined;
        return { result, ...(changed ? { decidedBy: "acme.guard" } : {}) } as never;
      },
    },
  };
}

function adapter(
  model: ModelPort,
  handled: string[],
  turnHooks: TurnHooksPort,
  rules: readonly ToolRule[] = [],
  extra: Partial<Parameters<typeof createWorkflowAdapter>[0]> = {},
) {
  let counter = 0;
  return createWorkflowAdapter({
    checkpointSaver: createInMemorySaver().saver,
    models: model,
    tools: registry(handled),
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
    toolPolicy: { rules: async () => rules, sessionGrants: async () => [] },
    turnHooks,
    newId: (prefix) => `${prefix}-${(counter += 1)}`,
    now: () => "2026-01-01T00:00:00.000Z",
    ...extra,
  } as Parameters<typeof createWorkflowAdapter>[0]);
}

describe("tool.check hooks at emission", () => {
  it("hands a hook the chat's folder by label only, never its host paths", async () => {
    const handled: string[] = [];
    const { model } = scriptedModel({ id: "c1", name: "fixture.read" });
    const { port, asked } = hooks((_input, core) => core);
    const folder: ChatFolder = {
      primary: "/Users/o/projects/site",
      primaryKind: "host",
      managed: "/Users/o/.tavi/chats/ws1/t",
      scratch: "/Users/o/.tavi/chats/ws1/t/.tmp",
      home: "/Users/o/.tavi/chats/ws1/t/.home",
      attachments: [{ path: "/Users/o/docs", mode: "ro", label: "docs" }],
      revision: 2,
    };
    await adapter(model, handled, port, [], { turnFolder: async () => folder }).admit({
      context,
      operationKey: "op-folder",
      kind: "start",
      prompt: "read",
    });
    expect(asked[0]?.envelope.folder).toEqual(modFolderLabels(folder));
    expect(JSON.stringify(asked[0]?.envelope)).not.toContain("/Users/o");
  });

  it("raises an allowed call to a round that offers only once, with the hook's reason on the card", async () => {
    const handled: string[] = [];
    const { model } = scriptedModel({ id: "c1", name: "fixture.read" });
    const { port } = hooks(() => ({ decision: "ask", reason: "Reads the payroll folder." }));
    const result = await adapter(model, handled, port).admit({ context, operationKey: "op-ask", kind: "start", prompt: "read" });
    expect(result.outcome.status).toBe("waiting");
    const [request] = result.outcome.interrupt?.requests ?? [];
    expect(request?.allowedScopes).toEqual(["once"]);
    expect(request?.risk?.reasons).toContain("acme.guard: Reads the payroll folder.");
    expect(handled).toEqual([]);
  });

  it("refuses a call a hook denies, with no round, naming the plugin as the rule and telling the model why", async () => {
    const handled: string[] = [];
    const { model, seen } = scriptedModel({ id: "c1", name: "fixture.read" });
    const { port } = hooks(() => ({ decision: "deny", reason: "Not on Fridays." }));
    const result = await adapter(model, handled, port).admit({ context, operationKey: "op-deny", kind: "start", prompt: "read" });
    expect(result.outcome.status).toBe("completed");
    expect(handled).toEqual([]);
    expect(seen.at(-1)).toContain("Not on Fridays.");
  });

  it("never loosens: a hook answering allow to an ask leaves the round as it was", async () => {
    const handled: string[] = [];
    const { model } = scriptedModel({ id: "c1", name: "fixture.shell", input: { command: "ls" } });
    const { port } = hooks(() => ({ decision: "allow" }));
    const result = await adapter(model, handled, port).admit({ context, operationKey: "op-loose", kind: "start", prompt: "list" });
    const [request] = result.outcome.interrupt?.requests ?? [];
    expect(request?.allowedScopes).toEqual(["once", "session", "always"]);
    expect(handled).toEqual([]);
  });

  it("does not ask hooks about a call core already denies", async () => {
    const { model } = scriptedModel({ id: "c1", name: "fixture.shell", input: { command: "mkfs /dev/sda" } });
    const { port, asked } = hooks((_input, core) => core);
    await adapter(model, [], port).admit({ context, operationKey: "op-hard", kind: "start", prompt: "format" });
    expect(asked).toEqual([]);
  });

  it("keeps a hook's answer across an owner restart: the resumed approval asks it nothing", async () => {
    const handled: string[] = [];
    const { model } = scriptedModel({ id: "c1", name: "fixture.read" });
    const { port, asked } = hooks(() => ({ decision: "ask", reason: "Check first." }));
    // What survives a restart: the checkpoints and the durable records; the adapter itself is built again.
    const durable = {
      checkpointSaver: createInMemorySaver().saver,
      tasks: createInMemoryTaskRepository(),
      executions: createInMemoryExecutionRepository(),
      effects: createInMemoryEffectRepository(),
      receipts: createInMemoryReceiptRepository(),
      approvals: createInMemoryApprovalRepository(),
      cancellations: createInMemoryCancellationRepository(),
    };
    const first = await adapter(model, handled, port, [], durable).admit({
      context,
      operationKey: "op-restart",
      kind: "start",
      prompt: "read",
    });
    expect(first.outcome.status).toBe("waiting");
    const restarted = adapter(model, handled, port, [], { ...durable, ownerSession: "after-restart" });
    await restarted.admit({
      context,
      taskId: first.taskId,
      operationKey: "op-restart-decide",
      kind: "approval",
      resume: { approved: true, scope: "once", decidedBy: "alice" },
    });
    expect(asked).toHaveLength(1);
    expect(handled).toEqual(["fixture.read"]);
  });

  it("asks once per call: a resumed approval does not ask the hook again", async () => {
    const handled: string[] = [];
    const { model } = scriptedModel({ id: "c1", name: "fixture.read" });
    const { port, asked } = hooks(() => ({ decision: "ask", reason: "Check first." }));
    const workflow = adapter(model, handled, port);
    const first = await workflow.admit({ context, operationKey: "op-once", kind: "start", prompt: "read" });
    await workflow.admit({
      context,
      taskId: first.taskId,
      operationKey: "op-once-decide",
      kind: "approval",
      resume: { approved: true, scope: "once", decidedBy: "alice" },
    });
    expect(asked).toHaveLength(1);
    expect(handled).toEqual(["fixture.read"]);
  });

  it("shows hooks no input for a sensitive tool, and the envelope says who and where", async () => {
    const { model } = scriptedModel({ id: "c1", name: "fixture.secret", input: { command: "vault read" } });
    const { port, asked } = hooks((_input, core) => core);
    await adapter(model, [], port).admit({
      context,
      operationKey: "op-sensitive",
      kind: "start",
      prompt: "read",
      origin: "cli",
      executionPolicy: ATTENDED_TASK_POLICY,
    });
    expect(asked[0]?.input).toBeUndefined();
    expect(asked[0]?.sensitive).toBe(true);
    expect(asked[0]?.envelope).toMatchObject({ workspaceId: "ws1", principalId: "p1", source: "cli", attended: true });
  });

  it("tells hooks a schedule's run is unattended", async () => {
    const { model } = scriptedModel({ id: "c1", name: "fixture.read" });
    const { port, asked } = hooks((_input, core) => core);
    await adapter(model, [], port).admit({
      context,
      operationKey: "op-schedule",
      kind: "start",
      prompt: "read",
      origin: "schedule",
      originScheduleId: "schedule-1",
      executionPolicy: ATTENDED_TASK_POLICY,
    });
    expect(asked[0]?.envelope.attended).toBe(false);
  });

  it("tells hooks a heartbeat tick is unattended, from the heartbeat, and lets them deny an allowlisted tool", async () => {
    const handled: string[] = [];
    const { model } = scriptedModel({ id: "c1", name: "fixture.read" });
    const { port, asked } = hooks(() => ({ decision: "deny", reason: "Not during a check." }));
    await adapter(model, handled, port).admit({
      context,
      operationKey: "op-beat-deny",
      kind: "start",
      prompt: "check",
      origin: "heartbeat",
      executionPolicy: { ...HEARTBEAT_TASK_POLICY, toolAllowlist: ["fixture.read"] },
    });
    expect(asked[0]?.envelope).toMatchObject({ source: "heartbeat", attended: false });
    expect(handled).toEqual([]);
  });

  it("an ask a hook raises in an idea's prepared step is a denial: nobody attends it", async () => {
    const handled: string[] = [];
    const { model } = scriptedModel({ id: "c1", name: "fixture.read" });
    const { port } = hooks(() => ({ decision: "ask", reason: "Check with the person." }));
    const result = await adapter(model, handled, port).admit({
      context,
      operationKey: "op-prep-ask",
      kind: "start",
      prompt: "read",
      origin: "ideas",
      executionPolicy: { ...HEARTBEAT_TASK_POLICY, toolAllowlist: ["fixture.read"] },
    });
    expect(result.outcome.status).not.toBe("waiting");
    expect(handled).toEqual([]);
  });

  it("never makes a tool outside a heartbeat's allowlist callable: refused before any hook is asked", async () => {
    const handled: string[] = [];
    const { model, seen } = scriptedModel({ id: "c1", name: "fixture.shell", input: { command: "ls" } });
    const { port, asked } = hooks(() => ({ decision: "allow" }));
    const result = await adapter(model, handled, port).admit({
      context,
      operationKey: "op-beat-wide",
      kind: "start",
      prompt: "check",
      origin: "heartbeat",
      executionPolicy: { ...HEARTBEAT_TASK_POLICY, toolAllowlist: ["fixture.read"] },
    });
    expect(result.outcome.status).toBe("completed");
    expect(asked).toEqual([]);
    expect(handled).toEqual([]);
    expect(seen.at(-1)).toContain("This task cannot use this tool");
  });

  it("never puts heartbeat.report to a hook: not checked, not called, its result not shown", async () => {
    const handled: string[] = [];
    const { model } = scriptedModel({ id: "c1", name: HEARTBEAT_REPORT_TOOL_ID });
    const seen: string[] = [];
    const port: TurnHooksPort = {
      has: () => true,
      dispatch: async (event, input, core) => {
        seen.push(`${event} ${JSON.stringify(input)}`);
        return await NO_TURN_HOOKS.dispatch(event, input, core);
      },
    };
    const report: DeclaredToolDefinition = {
      id: HEARTBEAT_REPORT_TOOL_ID,
      sink: "reply",
      version: "1",
      description: "Report",
      effect: "read-only",
      requiredPermissions: [],
    };
    const result = await adapter(model, handled, port, [], { tools: registry(handled, [report]) }).admit({
      context,
      operationKey: "op-beat-report",
      kind: "start",
      prompt: "check",
      origin: "heartbeat",
      executionPolicy: { ...HEARTBEAT_TASK_POLICY, toolAllowlist: [HEARTBEAT_REPORT_TOOL_ID] },
    });
    expect(result.outcome.status).toBe("completed");
    expect(handled).toEqual([HEARTBEAT_REPORT_TOOL_ID]);
    for (const event of seen) expect(event).not.toContain(HEARTBEAT_REPORT_TOOL_ID);
  });

  it("hands hooks the call's rule aliases, so a match on a step covers a batch of them", async () => {
    const { model } = scriptedModel({ id: "c1", name: "fixture.batch" });
    const { port, asked } = hooks((_input, core) => core);
    await adapter(model, [], port).admit({ context, operationKey: "op-batch", kind: "start", prompt: "act" });
    expect(asked[0]?.aliases).toEqual(["fixture.act"]);
  });

  it("adds its reason to a call core already asks about, and limits it to once", async () => {
    const { model } = scriptedModel({ id: "c1", name: "fixture.shell", input: { command: "rm -rf build" } });
    const { port } = hooks((_input, core) => (core.decision === "ask" ? { decision: "ask", reason: "Deletes files." } : core));
    const result = await adapter(model, [], port).admit({ context, operationKey: "op-ask-ask", kind: "start", prompt: "clean" });
    const [request] = result.outcome.interrupt?.requests ?? [];
    expect(request?.allowedScopes).toEqual(["once"]);
    expect(request?.risk?.reasons).toContain("acme.guard: Deletes files.");
  });

  it("limits a call core asks about to once when a hook asks too, even without a reason", async () => {
    const { model } = scriptedModel({ id: "c1", name: "fixture.shell", input: { command: "rm -rf build" } });
    const port: TurnHooksPort = {
      has: (event) => event === "tool.check",
      dispatch: async (event, input, core) =>
        event === "tool.check"
          ? ({ result: { decision: "ask" }, decidedBy: "acme.guard" } as never)
          : NO_TURN_HOOKS.dispatch(event, input, core),
    };
    const result = await adapter(model, [], port).admit({ context, operationKey: "op-ask-bare", kind: "start", prompt: "clean" });
    const [request] = result.outcome.interrupt?.requests ?? [];
    expect(request?.allowedScopes).toEqual(["once"]);
    expect(request?.risk?.reasons).toContain("The acme.guard plugin asks about this call.");
  });

  it("shows hooks the call's input masked, and masks the reasons a hook writes", async () => {
    const { model, seen } = scriptedModel({ id: "c1", name: "fixture.read", input: { command: "cat key AKIAIOSFODNN7EXAMPLE" } });
    const { port, asked } = hooks(() => ({ decision: "deny", reason: "It holds AKIAIOSFODNN7EXAMPLE." }));
    await adapter(model, [], port).admit({ context, operationKey: "op-mask", kind: "start", prompt: "read" });
    expect(asked[0]?.input).toEqual({ command: "cat key [redacted:aws-key]" });
    expect(seen.at(-1)).toContain("It holds [redacted:aws-key].");
    expect(seen.at(-1)).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });

  it("raises a call core asks about to a deny", async () => {
    const handled: string[] = [];
    const { model, seen } = scriptedModel({ id: "c1", name: "fixture.shell", input: { command: "rm -rf /" } });
    const { port } = hooks(() => ({ decision: "deny", reason: "Never the root." }));
    const result = await adapter(model, handled, port).admit({ context, operationKey: "op-ask-deny", kind: "start", prompt: "clean" });
    expect(result.outcome.status).toBe("completed");
    expect(handled).toEqual([]);
    expect(seen.at(-1)).toContain("Never the root.");
  });

  it("shows hooks no input of a call that carries a credential", async () => {
    const { model } = scriptedModel({ id: "c1", name: "fixture.fetch", input: { command: "token=abc" } });
    const { port, asked } = hooks((_input, core) => core);
    await adapter(model, [], port).admit({ context, operationKey: "op-credential", kind: "start", prompt: "fetch" });
    expect(asked[0]?.input).toBeUndefined();
    expect(asked[0]?.sensitive).toBe(true);
  });
});

describe("a cancel while tool.check or prompt.submit hooks run", () => {
  /** Hooks on `event` that wait for the run's cancel, as a stalled hook does under the registry. */
  const stalled = (event: ModEvent): TurnHooksPort => ({
    has: (asked) => asked === event,
    dispatch: async (asked, input, core, signal) =>
      asked !== event
        ? NO_TURN_HOOKS.dispatch(asked, input, core)
        : new Promise((_resolve, reject) => signal?.addEventListener("abort", () => reject(signal.reason), { once: true })),
  });

  it("ends the turn aborted when the cancel lands in a tool.check hook, and runs no call", async () => {
    const handled: string[] = [];
    const { model } = scriptedModel({ id: "c1", name: "fixture.read" });
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error("the person cancelled")), 20);
    const result = await adapter(model, handled, stalled("tool.check")).admit(
      { context, operationKey: "op-cancel-check", kind: "start", prompt: "read" },
      { signal: controller.signal },
    );
    expect(result.outcome).toMatchObject({ status: "failed", error: { code: "ABORTED" } });
    expect(handled).toEqual([]);
  });

  it("commits a turn cancelled while its prompt hooks ran as aborted, with no model call", async () => {
    const handled: string[] = [];
    const { model, seen } = scriptedModel({ id: "c1", name: "fixture.read" });
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error("the person cancelled")), 20);
    const result = await adapter(model, handled, stalled("prompt.submit")).admit(
      { context, operationKey: "op-cancel-prompt", kind: "start", prompt: "read" },
      { signal: controller.signal },
    );
    expect(result.outcome).toMatchObject({ status: "failed", error: { code: "ABORTED" } });
    expect(seen).toEqual([]);
  });
});

describe("the zero-hook fast path", () => {
  it("asks whether an event has hooks at each call, so a plugin loaded mid-round sees the round's later calls", async () => {
    const handled: string[] = [];
    let loaded = false;
    const tools = registry(handled);
    // The first call's run loads a plugin, as a dev reload would.
    const reloading: ToolRegistryPort = {
      ...tools,
      get: (id) => {
        const tool = tools.get(id);
        return tool === undefined || id !== "fixture.read"
          ? tool
          : {
              ...tool,
              handler: async () => {
                handled.push(id);
                loaded = true;
                return { ok: true };
              },
            };
      },
    };
    const called: string[] = [];
    const port: TurnHooksPort = {
      has: (event) => loaded && event === "tool.call",
      hasEvent: (event) => loaded && event === "tool.call",
      dispatch: async (event, input, core) => {
        if (event === "tool.call") called.push((input as ModHookInput<"tool.call">).callId);
        return NO_TURN_HOOKS.dispatch(event, input, core);
      },
    };
    let turn = 0;
    const model: ModelPort = {
      async stream(request: ModelRequest): Promise<ModelOutcome> {
        turn += 1;
        if (turn === 1)
          return {
            status: "completed",
            attemptId: request.attemptId,
            text: "",
            toolCalls: [
              { id: "c1", name: "fixture.read", input: {} },
              // A call that changes something runs in its turn; an independent read would run beside c1, before the load.
              { id: "c2", name: "fixture.shell", input: { command: "ls" } },
            ],
            usage: {},
          };
        return { status: "completed", attemptId: request.attemptId, text: "done", toolCalls: [], usage: {} };
      },
    };
    const allowShell: ToolRule = {
      ruleId: "allow-shell",
      workspaceId: "ws1",
      toolPattern: "fixture.shell",
      decision: "allow",
      source: "operator",
      createdBy: "operator",
      createdVia: "cli",
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    const result = await adapter(model, handled, port, [allowShell], { tools: reloading }).admit({
      context,
      operationKey: "op-reload",
      kind: "start",
      prompt: "read both",
    });
    expect(result.outcome.status).toBe("completed");
    expect(handled).toEqual(["fixture.read", "fixture.shell"]);
    expect(called).toEqual(["c2"]);
  });

  it("asks tool.check hooks about a round's later calls once a plugin loads while its earlier ones are judged", async () => {
    const handled: string[] = [];
    let loaded = false;
    const tools = registry(handled);
    // Judging the first call loads a plugin, as a dev reload landing just then would.
    const reloading: ToolRegistryPort = {
      ...tools,
      get: (id) => {
        const tool = tools.get(id);
        return tool === undefined || id !== "fixture.read"
          ? tool
          : {
              ...tool,
              assess: (): CallAssessment => {
                loaded = true;
                return { display: { title: "Read" }, subjects: [], risk: "low", reasons: [] };
              },
            };
      },
    };
    const checked: string[] = [];
    const port: TurnHooksPort = {
      has: (event) => loaded && event === "tool.check",
      hasEvent: (event) => loaded && event === "tool.check",
      dispatch: async (event, input, core) => {
        if (event === "tool.check") checked.push((input as ModHookInput<"tool.check">).callId);
        return NO_TURN_HOOKS.dispatch(event, input, core);
      },
    };
    let turn = 0;
    const model: ModelPort = {
      async stream(request: ModelRequest): Promise<ModelOutcome> {
        turn += 1;
        if (turn === 1)
          return {
            status: "completed",
            attemptId: request.attemptId,
            text: "",
            toolCalls: [
              { id: "c1", name: "fixture.read", input: {} },
              { id: "c2", name: "fixture.secret", input: {} },
            ],
            usage: {},
          };
        return { status: "completed", attemptId: request.attemptId, text: "done", toolCalls: [], usage: {} };
      },
    };
    await adapter(model, handled, port, [], { tools: reloading }).admit({
      context,
      operationKey: "op-reload-check",
      kind: "start",
      prompt: "read both",
    });
    expect(checked).toEqual(["c2"]);
  });
});

describe("independent read-only calls", () => {
  it("run at the same time, their results in call order, while a call that changes something waits its turn", async () => {
    const handled: string[] = [];
    const tools = registry(handled);
    let running = 0;
    let most = 0;
    const order: string[] = [];
    const slow = (id: string, ms: number) => async (): Promise<unknown> => {
      running += 1;
      most = Math.max(most, running);
      await new Promise((resolve) => setTimeout(resolve, ms));
      running -= 1;
      order.push(id);
      return { id };
    };
    const timed: ToolRegistryPort = {
      ...tools,
      get: (id) => {
        const tool = tools.get(id);
        if (tool === undefined) return tool;
        if (id === "fixture.read") return { ...tool, handler: slow(id, 40) };
        if (id === "fixture.fetch") return { ...tool, handler: slow(id, 5) };
        if (id === "fixture.shell")
          return {
            ...tool,
            handler: async () => {
              order.push(`${id} with ${running} running`);
              return { ok: true };
            },
          };
        return tool;
      },
    };
    let turn = 0;
    let seen: readonly unknown[] = [];
    const model: ModelPort = {
      async stream(request: ModelRequest): Promise<ModelOutcome> {
        turn += 1;
        seen = request.messages;
        if (turn === 1)
          return {
            status: "completed",
            attemptId: request.attemptId,
            text: "",
            toolCalls: [
              { id: "c1", name: "fixture.read", input: {} },
              { id: "c2", name: "fixture.fetch", input: {} },
              { id: "c3", name: "fixture.shell", input: { command: "ls" } },
            ],
            usage: {},
          };
        return { status: "completed", attemptId: request.attemptId, text: "done", toolCalls: [], usage: {} };
      },
    };
    const allowShell: ToolRule = {
      ruleId: "allow-shell",
      workspaceId: "ws1",
      toolPattern: "fixture.shell",
      decision: "allow",
      source: "operator",
      createdBy: "operator",
      createdVia: "cli",
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    const result = await adapter(model, handled, NO_TURN_HOOKS, [allowShell], { tools: timed }).admit({
      context,
      operationKey: "op-parallel",
      kind: "start",
      prompt: "read both, then run",
    });
    expect(result.outcome.status).toBe("completed");
    // Both reads ran at once (the quick one finished first); the shell ran after both, with nothing running.
    expect(most).toBe(2);
    expect(order).toEqual(["fixture.fetch", "fixture.read", "fixture.shell with 0 running"]);
    const results = (seen as { readonly role?: string; readonly toolCallId?: string }[]).filter((message) => message.role === "tool");
    expect(results.map((message) => message.toolCallId)).toEqual(["c1", "c2", "c3"]);
  });

  it("never runs a read early past a write before it in the same step", async () => {
    const handled: string[] = [];
    const tools = registry(handled);
    const order: string[] = [];
    const timed: ToolRegistryPort = {
      ...tools,
      get: (id) => {
        const tool = tools.get(id);
        if (tool === undefined) return tool;
        if (id === "fixture.shell")
          return {
            ...tool,
            handler: async () => {
              await new Promise((resolve) => setTimeout(resolve, 20));
              order.push(id);
              return { ok: true };
            },
          };
        if (id === "fixture.read" || id === "fixture.fetch")
          return {
            ...tool,
            handler: async () => {
              order.push(id);
              return { ok: true };
            },
          };
        return tool;
      },
    };
    let turn = 0;
    const model: ModelPort = {
      async stream(request: ModelRequest): Promise<ModelOutcome> {
        turn += 1;
        if (turn === 1)
          return {
            status: "completed",
            attemptId: request.attemptId,
            text: "",
            toolCalls: [
              { id: "c1", name: "fixture.shell", input: { command: "ls" } },
              { id: "c2", name: "fixture.read", input: {} },
              { id: "c3", name: "fixture.fetch", input: {} },
            ],
            usage: {},
          };
        return { status: "completed", attemptId: request.attemptId, text: "done", toolCalls: [], usage: {} };
      },
    };
    const allowShell: ToolRule = {
      ruleId: "allow-shell",
      workspaceId: "ws1",
      toolPattern: "fixture.shell",
      decision: "allow",
      source: "operator",
      createdBy: "operator",
      createdVia: "cli",
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    const result = await adapter(model, handled, NO_TURN_HOOKS, [allowShell], { tools: timed }).admit({
      context,
      operationKey: "op-write-then-read",
      kind: "start",
      prompt: "run, then read",
    });
    expect(result.outcome.status).toBe("completed");
    expect(order).toEqual(["fixture.shell", "fixture.read", "fixture.fetch"]);
  });
});

describe("independent read-only calls, run by run", () => {
  type Call = { readonly id: string; readonly name: string; readonly input: unknown };
  const allowShell: ToolRule = {
    ruleId: "allow-shell",
    workspaceId: "ws1",
    toolPattern: "fixture.shell",
    decision: "allow",
    source: "operator",
    createdBy: "operator",
    createdVia: "cli",
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  /** A model asking for `calls` in its first step, then answering; `seen` holds the last request's messages. */
  const stepOf = (calls: readonly Call[]) => {
    let turn = 0;
    const state: { seen: readonly unknown[] } = { seen: [] };
    const model: ModelPort = {
      async stream(request: ModelRequest): Promise<ModelOutcome> {
        turn += 1;
        state.seen = request.messages;
        return turn === 1
          ? { status: "completed", attemptId: request.attemptId, text: "", toolCalls: [...calls], usage: {} }
          : { status: "completed", attemptId: request.attemptId, text: "done", toolCalls: [], usage: {} };
      },
    };
    return { model, state };
  };
  /** The registry with `fixture.read` and `fixture.shell` running `read` and `shell`. */
  const timedWith = (read: ToolHandlerOf, shell?: ToolHandlerOf): ToolRegistryPort => {
    const tools = registry([]);
    return {
      ...tools,
      get: (id) => {
        const tool = tools.get(id);
        if (tool === undefined) return tool;
        if (id === "fixture.read") return { ...tool, handler: read };
        if (id === "fixture.shell" && shell !== undefined) return { ...tool, handler: shell };
        return tool;
      },
    };
  };
  type ToolHandlerOf = NonNullable<ReturnType<ToolRegistryPort["get"]>>["handler"];
  const reads = (count: number, input: (index: number) => unknown = (index) => ({ command: `r${String(index)}` })): Call[] =>
    Array.from({ length: count }, (_, index) => ({ id: `c${String(index + 1)}`, name: "fixture.read", input: input(index) }));
  const resultIds = (seen: readonly unknown[]) =>
    (seen as { readonly role?: string; readonly toolCallId?: string }[])
      .filter((message) => message.role === "tool")
      .map((message) => message.toolCallId);
  /** Counts the reads running at once, each taking `ms`. */
  const gauge = (ms: number) => {
    const state = { running: 0, most: 0, ran: [] as string[] };
    const handler: ToolHandlerOf = async ({ input }) => {
      state.running += 1;
      state.most = Math.max(state.most, state.running);
      await new Promise((resolve) => setTimeout(resolve, ms));
      state.running -= 1;
      state.ran.push((input as { command?: string }).command ?? "");
      return { ok: true };
    };
    return { state, handler };
  };

  it("finishes three slow reads in about the longest one's time, not the sum", async () => {
    const { state, handler } = gauge(80);
    const { model, state: step } = stepOf(reads(3));
    const began = performance.now();
    const result = await adapter(model, [], NO_TURN_HOOKS, [], { tools: timedWith(handler) }).admit({
      context,
      operationKey: "op-three-reads",
      kind: "start",
      prompt: "read three",
    });
    const took = performance.now() - began;
    expect(result.outcome.status).toBe("completed");
    expect(state.most).toBe(3);
    expect(took).toBeLessThan(3 * 80);
    expect(resultIds(step.seen)).toEqual(["c1", "c2", "c3"]);
  });

  it("runs a read run after a write together, once the write has settled", async () => {
    const { state, handler } = gauge(30);
    const order: string[] = [];
    const shell: ToolHandlerOf = async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push(`shell with ${String(state.running)} running`);
      return { ok: true };
    };
    const calls: Call[] = [
      { id: "c0", name: "fixture.shell", input: { command: "ls" } },
      ...reads(3),
      { id: "c9", name: "fixture.shell", input: { command: "pwd" } },
    ];
    const { model, state: step } = stepOf(calls);
    const result = await adapter(model, [], NO_TURN_HOOKS, [allowShell], { tools: timedWith(handler, shell) }).admit({
      context,
      operationKey: "op-write-then-reads",
      kind: "start",
      prompt: "run, read, run",
    });
    expect(result.outcome.status).toBe("completed");
    expect(state.most).toBe(3);
    expect(order).toEqual(["shell with 0 running", "shell with 0 running"]);
    expect(state.ran.toSorted()).toEqual(["r0", "r1", "r2"]);
    expect(resultIds(step.seen)).toEqual(["c0", "c1", "c2", "c3", "c9"]);
  });

  it("runs every call in turn at tools.parallelReads 1, and at most that many together above it", async () => {
    for (const [cap, most] of [
      [1, 1],
      [2, 2],
    ] as const) {
      const { state, handler } = gauge(10);
      const { model, state: step } = stepOf(reads(5));
      const result = await adapter(model, [], NO_TURN_HOOKS, [], {
        tools: timedWith(handler),
        parallelReads: async () => cap,
      }).admit({ context, operationKey: `op-cap-${String(cap)}`, kind: "start", prompt: "read five" });
      expect(result.outcome.status).toBe("completed");
      expect(state.most).toBe(most);
      // Each read ran once, the ones past the cap too.
      expect(state.ran.toSorted()).toEqual(["r0", "r1", "r2", "r3", "r4"]);
      expect(resultIds(step.seen)).toEqual(["c1", "c2", "c3", "c4", "c5"]);
    }
  });

  it("keeps the first of two calls on one browser session early, the second after it, and runs none twice", async () => {
    const running = new Map<string, number>();
    let overlap = false;
    let together = 0;
    let most = 0;
    const ran: string[] = [];
    const handler: ToolHandlerOf = async ({ input }) => {
      const { command, sessionId } = input as { command: string; sessionId: string };
      if ((running.get(sessionId) ?? 0) > 0) overlap = true;
      running.set(sessionId, (running.get(sessionId) ?? 0) + 1);
      together += 1;
      most = Math.max(most, together);
      await new Promise((resolve) => setTimeout(resolve, 20));
      together -= 1;
      running.set(sessionId, (running.get(sessionId) ?? 0) - 1);
      ran.push(command);
      return { ok: true };
    };
    const sessionSchema = z.strictObject({ command: z.string(), sessionId: z.string() });
    const base = timedWith(handler);
    const tools: ToolRegistryPort = {
      ...base,
      get: (id) => {
        const tool = base.get(id);
        return tool === undefined || id !== "fixture.read" ? tool : { ...tool, inputSchema: sessionSchema };
      },
      inputSchemaOf: (id) => (id === "fixture.read" ? sessionSchema : base.inputSchemaOf(id)),
    };
    const sessions = ["s1", "s1", "s2", "s3"];
    const { model, state: step } = stepOf(reads(4, (index) => ({ command: `r${String(index)}`, sessionId: sessions[index] as string })));
    const result = await adapter(model, [], NO_TURN_HOOKS, [], { tools }).admit({
      context,
      operationKey: "op-sessions",
      kind: "start",
      prompt: "read the pages",
    });
    expect(result.outcome.status).toBe("completed");
    expect(overlap).toBe(false);
    expect(most).toBe(3);
    // The second s1 call left to its turn starts no fresh scan: r2 and r3 ran once each.
    expect(ran.toSorted()).toEqual(["r0", "r1", "r2", "r3"]);
    expect(resultIds(step.seen)).toEqual(["c1", "c2", "c3", "c4"]);
  });

  it("asks one question at a time, in call order, when reads run together", async () => {
    let waiting = 0;
    let overlapped = false;
    const waits: string[] = [];
    const agents = {
      waitFor: async (input: { readonly waitId: string }) => {
        if (waiting > 0) overlapped = true;
        waiting += 1;
        waits.push(input.waitId);
        await new Promise((resolve) => setTimeout(resolve, 10));
        waiting -= 1;
        return { outcome: { kind: "replied" } };
      },
    };
    const answered: string[] = [];
    const handler: ToolHandlerOf = async ({ input, ask }) => {
      const { command } = input as { command: string };
      if (ask === undefined) throw new Error("no ask");
      await ask({ key: "which", question: `Which one for ${command}?`, deadlineMs: 60_000 });
      answered.push(command);
      return { ok: true };
    };
    const { model, state: step } = stepOf(reads(2));
    const result = await adapter(model, [], NO_TURN_HOOKS, [], {
      tools: timedWith(handler),
      agents: () => agents as never,
      askUser: async () => undefined,
    }).admit({ context, operationKey: "op-asks", kind: "start", prompt: "ask twice", executionPolicy: ATTENDED_TASK_POLICY });
    expect(result.outcome.status).toBe("completed");
    expect(overlapped).toBe(false);
    expect(waits).toHaveLength(2);
    expect(waits[0]).toContain("c1:which");
    expect(waits[1]).toContain("c2:which");
    expect(answered).toEqual(["r0", "r1"]);
    expect(resultIds(step.seen)).toEqual(["c1", "c2"]);
  });

  it("cancels every read of a batch when the run is cancelled mid-batch", async () => {
    const aborted: string[] = [];
    const handler: ToolHandlerOf = async ({ input, signal }) => {
      const { command } = input as { command: string };
      await new Promise((_resolve, reject) =>
        signal.addEventListener(
          "abort",
          () => {
            aborted.push(command);
            reject(signal.reason);
          },
          { once: true },
        ),
      );
      return { ok: true };
    };
    const { model } = stepOf(reads(3));
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error("the person cancelled")), 30);
    const result = await adapter(model, [], NO_TURN_HOOKS, [], { tools: timedWith(handler) }).admit(
      { context, operationKey: "op-cancel-batch", kind: "start", prompt: "read three" },
      { signal: controller.signal },
    );
    expect(result.outcome).toMatchObject({ status: "failed", error: { code: "ABORTED" } });
    expect(aborted.toSorted()).toEqual(["r0", "r1", "r2"]);
  });
});
