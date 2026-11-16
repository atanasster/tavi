import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  absentWorkspaceSystemPrompt,
  ATTENDED_TASK_POLICY,
  HEARTBEAT_TASK_POLICY,
  type ChatFolder,
  type InvocationContext,
  type ModelEvent,
  type ModelOutcome,
  type ModelPort,
  type ModelRequest,
  type TaskOrigin,
  type DeclaredToolDefinition,
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
import { DEFAULT_SYSTEM_PROMPT, HEARTBEAT_SYSTEM_PROMPT, systemPromptHash } from "../src/prompts/system-prompt.js";

/**
 * A heartbeat tick's turn: the workflow
 * hands `turnFolder` the task's origin, and a folder answered as `undefined`
 * leaves the turn with none — so nothing is created for a tick, and its tools
 * see no folder.
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

function setup(extra: Record<string, unknown> = {}) {
  const seen: { readonly folder: ChatFolder | undefined; readonly folderUnavailable: string | undefined }[] = [];
  const askedOrigins: (TaskOrigin | undefined)[] = [];
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
            handler: async ({ context: invocation }: { readonly context: InvocationContext }) => {
              seen.push({ folder: invocation.folder, folderUnavailable: invocation.folderUnavailable });
              return { results: [] };
            },
          },
    list: () => [definition],
    listOffered: async () => [definition],
    inputSchemaOf: (id) => (id === definition.id ? schema : undefined),
    inputJsonSchemaOf: (id) => (id === definition.id ? (z.toJSONSchema(schema, { io: "input" }) as Record<string, unknown>) : undefined),
    modelNameOf: (id) => (id === definition.id ? "memory_search" : undefined),
    resolveModelName: (name) => (name === "memory_search" ? definition.id : undefined),
  };
  let turn = 0;
  const model: ModelPort = {
    async stream(request: ModelRequest, options: { readonly onEvent: (event: ModelEvent) => void }): Promise<ModelOutcome> {
      turn += 1;
      if (turn % 2 === 1)
        return {
          status: "completed",
          attemptId: request.attemptId,
          text: "",
          toolCalls: [{ id: `c${turn}`, name: "memory.search", input: {} }],
          usage: {},
        };
      options.onEvent({ type: "text.delta", attemptId: request.attemptId, blockId: "b", text: "done" });
      return { status: "completed", attemptId: request.attemptId, text: "done", toolCalls: [], usage: {} };
    },
  };
  const managed: ChatFolder = {
    primary: "/data/chats/ws1/x",
    primaryKind: "managed",
    managed: "/data/chats/ws1/x",
    scratch: "/data/chats/ws1/x/.tmp",
    home: "/data/chats/ws1/x/.home",
    attachments: [],
    revision: 1,
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
    // As the composition answers: no folder for a heartbeat tick, the chat's own for anything else.
    turnFolder: (_invocation, turn) => {
      askedOrigins.push(turn.origin);
      return turn.origin === "heartbeat" ? undefined : managed;
    },
    newId: (prefix) => `${prefix}-${(counter += 1)}`,
    now: () => "2026-01-01T00:00:00.000Z",
    ...extra,
  } as Parameters<typeof createWorkflowAdapter>[0]);
  return { adapter, seen, askedOrigins, managed };
}

describe("a heartbeat tick's turn", () => {
  it("is asked for its folder with its origin, and runs with none when the answer is none", async () => {
    const { adapter, seen, askedOrigins } = setup();
    const result = await adapter.admit({
      context,
      operationKey: "op-beat",
      kind: "start",
      prompt: "check",
      origin: "heartbeat",
      executionPolicy: HEARTBEAT_TASK_POLICY,
    });
    expect(result.outcome.status).toBe("completed");
    expect(askedOrigins).toEqual(["heartbeat"]);
    expect(seen).toEqual([{ folder: undefined, folderUnavailable: undefined }]);
  });

  it("memory invariant 20: assembles no memory manifest for any heartbeat turn, kept from the person or not, and does for a chat", async () => {
    const asked: string[] = [];
    // Any read of the memory service is recorded; each fails, which leaves the prompt as it was.
    const memory = new Proxy(
      {},
      {
        get: (_target, name) => {
          asked.push(String(name));
          return async () => {
            throw new Error("not used");
          };
        },
      },
    );
    const withheld = setup({ memory, memoryWithheld: () => true });
    await withheld.adapter.admit({
      context,
      operationKey: "op-kept",
      kind: "start",
      prompt: "check",
      origin: "heartbeat",
      executionPolicy: HEARTBEAT_TASK_POLICY,
    });
    expect(asked).toEqual([]);
    // A heartbeat turn the host did not open (one resumed after a restart, say) is judged by its origin.
    const notOpened = setup({ memory, memoryWithheld: () => false });
    await notOpened.adapter.admit({
      context,
      operationKey: "op-not-opened",
      kind: "start",
      prompt: "check",
      origin: "heartbeat",
      executionPolicy: HEARTBEAT_TASK_POLICY,
    });
    expect(asked).toEqual([]);
    const chat = setup({ memory, memoryWithheld: () => false });
    await chat.adapter.admit({
      context,
      operationKey: "op-chat",
      kind: "start",
      prompt: "check",
      origin: "cli",
      executionPolicy: ATTENDED_TASK_POLICY,
    });
    expect(asked.length).toBeGreaterThan(0);
  });

  it("leaves every other origin's folder as it was", async () => {
    const { adapter, seen, askedOrigins, managed } = setup();
    await adapter.admit({
      context,
      operationKey: "op-chat",
      kind: "start",
      prompt: "search",
      origin: "cli",
      executionPolicy: ATTENDED_TASK_POLICY,
    });
    expect(askedOrigins).toEqual(["cli"]);
    expect(seen).toEqual([{ folder: managed, folderUnavailable: undefined }]);
  });

  it("an idea's prepared step is plumbing too: no memory manifest, whatever it is kept from", async () => {
    const asked: string[] = [];
    const memory = new Proxy(
      {},
      {
        get: (_target, name) => {
          asked.push(String(name));
          return async () => {
            throw new Error("not used");
          };
        },
      },
    );
    const prepared = setup({ memory, memoryWithheld: () => false });
    const result = await prepared.adapter.admit({
      context,
      operationKey: "op-prep",
      kind: "start",
      prompt: "Find flights",
      origin: "ideas",
      executionPolicy: { mode: "unattended", humanQuestionsAllowed: false, workerWaitsAllowed: false, toolAllowlist: ["memory.search"] },
    });
    expect(result.outcome.status).toBe("completed");
    expect(asked).toEqual([]);
  });

  it("runs under the compact heartbeat base under models.promptLayout v2, and under the chat's base otherwise", async () => {
    const systemOf = async (layout: "v1" | "v2", origin: "heartbeat" | "cli") => {
      const systems: string[] = [];
      const models: ModelPort = {
        async stream(request) {
          systems.push(request.messages.find((message) => message.role === "system")?.text ?? "");
          return { status: "completed", attemptId: request.attemptId, text: "done", toolCalls: [], usage: {} };
        },
      };
      const { adapter } = setup({ models, systemPrompt: undefined, promptLayout: async () => layout });
      await adapter.admit({
        context,
        operationKey: `op-${layout}-${origin}`,
        kind: "start",
        prompt: "check",
        origin,
        executionPolicy: origin === "heartbeat" ? HEARTBEAT_TASK_POLICY : ATTENDED_TASK_POLICY,
      });
      return systems[0] ?? "";
    };
    const compact = await systemOf("v2", "heartbeat");
    expect(compact.startsWith(HEARTBEAT_SYSTEM_PROMPT)).toBe(true);
    // The rules every task needs are kept.
    expect(compact).toContain("[untrusted:<id> source=… host=…]");
    expect(compact).toContain("approval decisions");
    expect(HEARTBEAT_SYSTEM_PROMPT.length).toBeLessThan(DEFAULT_SYSTEM_PROMPT.length / 2);
    expect((await systemOf("v1", "heartbeat")).startsWith(DEFAULT_SYSTEM_PROMPT)).toBe(true);
    expect((await systemOf("v2", "cli")).startsWith(DEFAULT_SYSTEM_PROMPT)).toBe(true);
  });

  it("records the heartbeat template on the snapshot, and lets a workspace's own base win", async () => {
    const snapshotOf = async (workspaceText: string | undefined) => {
      const tasks = createInMemoryTaskRepository((workspaceId) =>
        workspaceText === undefined
          ? absentWorkspaceSystemPrompt(workspaceId)
          : { ...absentWorkspaceSystemPrompt(workspaceId), text: workspaceText, hash: systemPromptHash(workspaceText), revision: 1 },
      );
      const { adapter } = setup({ tasks, systemPrompt: undefined, promptLayout: async () => "v2" as const });
      const admitted = await adapter.admit({
        context,
        operationKey: `op-snapshot-${workspaceText ?? "none"}`,
        kind: "start",
        prompt: "check",
        origin: "heartbeat",
        executionPolicy: HEARTBEAT_TASK_POLICY,
      });
      return tasks.getPromptSnapshot(admitted.taskId);
    };
    expect(await snapshotOf(undefined)).toMatchObject({ source: "builtin", templateVersion: "tavi-default-2-heartbeat" });
    expect(await snapshotOf("Our own base.")).toMatchObject({ source: "workspace", text: "Our own base.", templateVersion: null });
  });
});
