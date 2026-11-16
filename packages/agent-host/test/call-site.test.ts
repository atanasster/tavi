import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  ATTENDED_TASK_POLICY,
  HEARTBEAT_TASK_POLICY,
  type DeclaredToolDefinition,
  type InvocationContext,
  type ModelCallSite,
  type ModelOutcome,
  type ModelPort,
  type ModelRequest,
  type TaskOrigin,
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

/**
 * The site each model call of a turn is recorded under (`tavi doctor`'s
 * per-site report): the adapter's own when it names one, else the task's
 * origin for plumbing and workers, else the call's place in its turn.
 */

const context: InvocationContext = { workspaceId: "ws1", principalId: "p1", runId: "root", caller: "test" };
const schema = z.strictObject({});
const definition: DeclaredToolDefinition = {
  id: "memory.search",
  sink: "none",
  version: "1",
  description: "Search memory",
  effect: "read-only",
  requiredPermissions: [],
};

/**
 * A two-call turn (a tool call, then an answer) on an adapter built with `extra`; the sites its calls were sent with.
 * `endless`: the model calls the tool every time it is asked, as a researcher that never stops searching.
 */
async function sitesOf(
  origin: TaskOrigin,
  extra: Record<string, unknown> = {},
  observe?: (options: Parameters<ModelPort["stream"]>[1]) => void,
  endless = false,
): Promise<(ModelCallSite | undefined)[]> {
  const sites: (ModelCallSite | undefined)[] = [];
  const registry: ToolRegistryPort = {
    register: () => {
      throw new Error("not used");
    },
    get: (id) =>
      id !== definition.id
        ? undefined
        : {
            ...definition,
            inputSchema: schema,
            inputJsonSchema: z.toJSONSchema(schema, { io: "input" }) as Record<string, unknown>,
            modelName: "memory_search",
            handler: async () => ({ results: [] }),
          },
    list: () => [definition],
    listOffered: async () => [definition],
    inputSchemaOf: (id) => (id === definition.id ? schema : undefined),
    inputJsonSchemaOf: (id) => (id === definition.id ? (z.toJSONSchema(schema, { io: "input" }) as Record<string, unknown>) : undefined),
    modelNameOf: (id) => (id === definition.id ? "memory_search" : undefined),
    resolveModelName: (name) => (name === "memory_search" ? definition.id : undefined),
  };
  const model: ModelPort = {
    async stream(request: ModelRequest, options): Promise<ModelOutcome> {
      sites.push(options.site);
      observe?.(options);
      return endless || sites.length === 1
        ? {
            status: "completed",
            attemptId: request.attemptId,
            text: "",
            toolCalls: [{ id: `c${sites.length}`, name: "memory.search", input: {} }],
            usage: {},
          }
        : { status: "completed", attemptId: request.attemptId, text: "done", toolCalls: [], usage: {} };
    },
  };
  let counter = 0;
  const adapter = createWorkflowAdapter({
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
    ...extra,
  } as Parameters<typeof createWorkflowAdapter>[0]);
  const result = await adapter.admit({
    context,
    operationKey: `op-${origin}`,
    kind: "start",
    prompt: "search",
    origin,
    executionPolicy: origin === "heartbeat" ? HEARTBEAT_TASK_POLICY : ATTENDED_TASK_POLICY,
  });
  expect(result.outcome.status).toBe("completed");
  return sites;
}

describe("a model call's ledger site", () => {
  it("is the call's place in a chat turn: its first call, then a later one", async () => {
    expect(await sitesOf("cli")).toEqual(["chat-step1", "chat-stepN"]);
  });

  it("is the final step's on the turn's last allowed step", async () => {
    expect(await sitesOf("cli", { maxSteps: 2 })).toEqual(["chat-step1", "final-step"]);
  });

  it("reaches the final step of a turn that spends every step on a tool, rather than the graph's own limit", async () => {
    // Each tool step passes four graph nodes: a turn of twelve still ends on its own final step, with an answer.
    const sites = await sitesOf("cli", { maxSteps: 12 }, undefined, true);
    expect(sites).toHaveLength(12);
    expect(sites.at(-1)).toBe("final-step");
  });

  it("is the origin's for a heartbeat tick and a worker, on every call", async () => {
    expect(await sitesOf("heartbeat")).toEqual(["heartbeat", "heartbeat"]);
    expect(await sitesOf("agent")).toEqual(["worker", "worker"]);
  });

  it("passes the task's cache lifetime and key with each call, never in the request", async () => {
    const seen: (readonly [string | undefined, string | undefined])[] = [];
    await sitesOf("heartbeat", { cacheFor: () => ({ ttl: "1h", key: "heartbeat:p" }) }, (options) =>
      seen.push([options.cacheTtl, options.cacheKey]),
    );
    expect(seen).toEqual([
      ["1h", "heartbeat:p"],
      ["1h", "heartbeat:p"],
    ]);
  });

  it("is the adapter's own when it names one, whatever the origin and step", async () => {
    expect(await sitesOf("cli", { callSite: "routine-research" })).toEqual(["routine-research", "routine-research"]);
  });
});
