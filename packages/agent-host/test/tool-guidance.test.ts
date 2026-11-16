import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  NO_TURN_HOOKS,
  type DeclaredToolDefinition,
  type InvocationContext,
  type ModelOutcome,
  type ModelPort,
  type ModelRequest,
  type ToolRegistryPort,
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

/** A built-in tool's own line in the system prompt (`ToolDefinition.promptGuidance`), while it is offered. */

const context: InvocationContext = { workspaceId: "ws1", principalId: "p1", runId: "root", caller: "test" };
const schema = z.strictObject({});

function registry(definitions: readonly DeclaredToolDefinition[]): ToolRegistryPort {
  const byId = new Map(definitions.map((definition) => [definition.id, definition]));
  const modelName = (id: string) => id.replace(/[^a-zA-Z0-9_-]/g, "_");
  return {
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
}

async function systemPromptWith(definitions: readonly DeclaredToolDefinition[]): Promise<string> {
  const requests: ModelRequest[] = [];
  const model: ModelPort = {
    async stream(request): Promise<ModelOutcome> {
      requests.push(request);
      return { status: "completed", attemptId: request.attemptId, text: "done", toolCalls: [], usage: {} };
    },
  };
  let counter = 0;
  const adapter = createWorkflowAdapter({
    checkpointSaver: createInMemorySaver().saver,
    models: model,
    tools: registry(definitions),
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
    turnHooks: NO_TURN_HOOKS,
    newId: (prefix) => `${prefix}-${(counter += 1)}`,
    now: () => "2026-01-01T00:00:00.000Z",
  } as Parameters<typeof createWorkflowAdapter>[0]);
  await adapter.admit({ context, operationKey: "op", kind: "start", prompt: "hello" });
  return requests[0]?.messages.find((message) => message.role === "system")?.text ?? "";
}

const tool = (id: string, promptGuidance?: string): DeclaredToolDefinition => ({
  id,
  sink: "none",
  version: "1",
  description: id,
  effect: "read-only",
  requiredPermissions: [],
  ...(promptGuidance === undefined ? {} : { promptGuidance }),
});

describe("a tool's prompt guidance", () => {
  it("reaches the system prompt while the tool is offered, in tool-id order, and not otherwise", async () => {
    const text = await systemPromptWith([tool("zeta.read", "Zeta second."), tool("alpha.read", "Alpha first."), tool("plain.read")]);
    expect(text).toContain("- Alpha first.\n- Zeta second.");
    expect(await systemPromptWith([tool("plain.read")])).not.toContain("Alpha first.");
  });
});

describe("a turn with no tool that opens a web address", () => {
  const note = "cannot check whether a link is live";

  it("is told it cannot check a link or fetch an archive snapshot, and to say so", async () => {
    const text = await systemPromptWith([tool("fs.read"), tool("web_search")]);
    expect(text).toContain(note);
    expect(text).toContain("snapshot");
  });

  it("is not told so when http.request, web_fetch or a browser that opens pages is offered", async () => {
    for (const id of ["http.request", "web_fetch", "browser.navigate", "browser.create_session"])
      expect(await systemPromptWith([tool("fs.read"), tool(id)])).not.toContain(note);
  });
});
