import { describe, expect, it } from "vitest";
import { z } from "zod";

import type {
  InvocationContext,
  ModelEvent,
  ModelOutcome,
  ModelPort,
  ModelRequest,
  DeclaredToolDefinition,
  ToolDispatchEvent,
  ToolRegistryPort,
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
import { createWorkflowAdapter, dispatchTool } from "@tavi/agent-host/workflow";

/**
 * Core redaction of tool results, end to end
 * through the graph: what the model reads next, what observers see, and the
 * placeholder guard on writing tools.
 */

const context: InvocationContext = { workspaceId: "ws1", principalId: "p1", runId: "root", caller: "test" };
const schema = z.strictObject({ value: z.string().optional() });
const SECRET = "AKIAIOSFODNN7EXAMPLE";

const definitions: readonly DeclaredToolDefinition[] = [
  { id: "fixture.read", sink: "none", version: "1", description: "Read a file", effect: "read-only", requiredPermissions: [] },
  { id: "fixture.write", sink: "none", version: "1", description: "Write a file", effect: "mutating", requiredPermissions: [] },
];

function setup(): { registry: ToolRegistryPort; handled: string[] } {
  const handled: string[] = [];
  const byId = new Map(definitions.map((definition) => [definition.id, definition]));
  const modelName = (id: string) => id.replace(/[^a-zA-Z0-9_-]/g, "_");
  const registry: ToolRegistryPort = {
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
        handler: async () => {
          handled.push(id);
          return id === "fixture.read" ? { content: `aws_access_key_id = ${SECRET}\nregion = eu-west-1` } : { wrote: true };
        },
      };
    },
    list: () => definitions,
    listOffered: async () => definitions,
    inputSchemaOf: (id) => (byId.has(id) ? schema : undefined),
    inputJsonSchemaOf: (id) => (byId.has(id) ? (z.toJSONSchema(schema, { io: "input" }) as Record<string, unknown>) : undefined),
    modelNameOf: (id) => (byId.has(id) ? modelName(id) : undefined),
    resolveModelName: (name) => [...byId.keys()].find((id) => modelName(id) === name),
  };
  return { registry, handled };
}

/** Scripted calls, then text; records each request's tool results as the model reads them. */
function scriptedModel(calls: readonly { readonly id: string; readonly name: string; readonly input?: unknown }[]): {
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
        const call = calls[turn];
        turn += 1;
        if (call !== undefined)
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

function adapter(model: ModelPort, registry: ToolRegistryPort, extra: Partial<Parameters<typeof createWorkflowAdapter>[0]> = {}) {
  let counter = 0;
  return createWorkflowAdapter({
    ...extra,
    checkpointSaver: createInMemorySaver().saver,
    models: model,
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
    newId: (prefix) => `${prefix}-${(counter += 1)}`,
    now: () => "2026-01-01T00:00:00.000Z",
  } as Parameters<typeof createWorkflowAdapter>[0]);
}

describe("tool result redaction", () => {
  it("masks a secret in a tool's output before the model, the message and observers see it", async () => {
    const { registry } = setup();
    const { model, seen } = scriptedModel([{ id: "c1", name: "fixture.read" }]);
    const events: ToolDispatchEvent[] = [];
    const result = await adapter(model, registry).admit(
      { context, operationKey: "op-read", kind: "start", prompt: "read the config" },
      {
        onToolEvent: (event) => {
          events.push(event);
        },
      },
    );
    expect(result.outcome.status).toBe("completed");
    expect(seen.at(-1)).not.toContain(SECRET);
    expect(seen.at(-1)).toContain("[redacted:aws-key]");
    const completed = events.find((event) => event.phase === "completed");
    expect(JSON.stringify(completed?.output)).not.toContain(SECRET);
    expect(completed?.redacted).toEqual({ "aws-key": 1 });
  });

  it("leaves output untouched when the workspace turned redaction off", async () => {
    const { registry } = setup();
    const { model, seen } = scriptedModel([{ id: "c1", name: "fixture.read" }]);
    await adapter(model, registry, { redactToolResults: async () => false }).admit({
      context,
      operationKey: "op-off",
      kind: "start",
      prompt: "read",
    });
    expect(seen.at(-1)).toContain(SECRET);
  });

  it("shows observers a masked copy of a call's input", async () => {
    const { registry } = setup();
    const { model } = scriptedModel([{ id: "c1", name: "fixture.read", input: { value: SECRET } }]);
    const events: ToolDispatchEvent[] = [];
    await adapter(model, registry).admit(
      { context, operationKey: "op-in", kind: "start", prompt: "read" },
      {
        onToolEvent: (event) => {
          events.push(event);
        },
      },
    );
    expect(JSON.stringify(events.find((event) => event.phase === "started")?.input)).not.toContain(SECRET);
  });

  it("refuses a writing call whose input holds a placeholder, without a round or a dispatch", async () => {
    const { registry, handled } = setup();
    const { model, seen } = scriptedModel([
      { id: "c1", name: "fixture.write", input: { value: "aws_access_key_id = [redacted:aws-key]" } },
    ]);
    const result = await adapter(model, registry).admit({ context, operationKey: "op-write", kind: "start", prompt: "write it back" });
    expect(result.outcome.status).toBe("completed");
    expect(handled).not.toContain("fixture.write");
    expect(seen.at(-1)).toContain("masked secret");
  });

  it("lets a read-only call carry a placeholder", async () => {
    const { registry, handled } = setup();
    const { model } = scriptedModel([{ id: "c1", name: "fixture.read", input: { value: "[redacted:aws-key]" } }]);
    await adapter(model, registry).admit({ context, operationKey: "op-ro", kind: "start", prompt: "search" });
    expect(handled).toContain("fixture.read");
  });

  it("masks a mutating call's output, and the receipt a replay returns", async () => {
    const { registry } = setup();
    const writing: ToolRegistryPort = {
      ...registry,
      get: (id) => {
        const tool = registry.get(id);
        return tool === undefined ? undefined : { ...tool, handler: async () => ({ token: SECRET }) };
      },
    };
    const effects = createInMemoryEffectRepository();
    const dispatch = () =>
      dispatchTool(
        writing,
        { resolveWorkspace: () => ({ principalId: context.principalId }), missingPermissions: () => [] },
        effects,
        { id: "w1", name: "fixture.write", input: {} },
        context,
        { taskId: "task-1", admissionId: "admission-1", steps: 1 },
        undefined,
        undefined,
      );
    const first = await dispatch();
    expect(JSON.stringify(first.output)).not.toContain(SECRET);
    expect(first.redacted).toEqual({ "aws-key": 1 });
    const replayed = await dispatch();
    expect(JSON.stringify(replayed.output)).not.toContain(SECRET);
  });

  // `toModelError` masks these shapes before the failure is scrubbed, so the kinds are counted on the
  // error as thrown: the result still says what was masked.
  it.each([
    ["aws-key", SECRET],
    ["jwt", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"],
  ])("masks a credential an error echoes, and reports its kind (%s)", async (kind, secret) => {
    const { registry } = setup();
    const failing: ToolRegistryPort = {
      ...registry,
      get: (id) => {
        const tool = registry.get(id);
        return tool === undefined
          ? undefined
          : {
              ...tool,
              handler: async () => {
                throw new Error(`401 for ${secret}`);
              },
            };
      },
    };
    const access = { resolveWorkspace: () => ({ principalId: context.principalId }), missingPermissions: () => [] };
    for (const name of ["fixture.read", "fixture.write"]) {
      const message = await dispatchTool(
        failing,
        access,
        createInMemoryEffectRepository(),
        { id: `f-${name}`, name, input: {} },
        context,
        { taskId: "task-1", admissionId: "admission-1", steps: 1 },
        undefined,
        undefined,
      );
      expect(message.isError).toBe(true);
      expect(JSON.stringify(message.output)).not.toContain(secret);
      expect(message.redacted).toEqual({ [kind]: 1 });
    }
  });
});
