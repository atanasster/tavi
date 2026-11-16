import {
  ATTENDED_TASK_POLICY,
  type InvocationContext,
  type ModelEvent,
  type ModelOutcome,
  type ModelPort,
  type ModelRequest,
} from "@tavi/contracts";
import { nowTimestamp } from "@tavi/contracts/util";
import { temporaryDirectories, waitFor } from "@tavi/test-support";
import { afterEach, describe, expect, it } from "vitest";

import { spawnOperationKey } from "../../src/features/agents/tools.js";
import { composeTaviRuntime } from "../../src/runtime/composition.js";
import type { TaviRuntime } from "../../src/runtime/types.js";

/**
 * A worker's result reaches its parent once, through the composed owner:
 * the worker's end is announced after its admission,
 * the parent is woken, and the parent's turn reads the result as a quoted
 * data message — never in its instructions, and never again on a later turn.
 */

const workspaces = [
  { workspaceId: "default", principalId: "operator", permissions: ["tools.invoke", "models.invoke", "runs.create"] },
] as const;

const directories = temporaryDirectories({ prefix: "tavi-worker-results-" });

afterEach(() => directories.cleanup());

/** The text a request's user messages carry, newest last. */
const userTexts = (request: ModelRequest): string[] =>
  request.messages.filter((message) => message.role === "user").map((message) => message.text);

/** A model that answers a worker's prompt with its finding, and anything else with "ok"; every request is kept. */
function recordingModel(): ModelPort & { readonly requests: ModelRequest[] } {
  const requests: ModelRequest[] = [];
  return {
    requests,
    async stream(
      request: ModelRequest,
      options: { readonly signal: AbortSignal; readonly onEvent: (event: ModelEvent) => void },
    ): Promise<ModelOutcome> {
      requests.push(request);
      const text = userTexts(request).some((entry) => entry.startsWith("research the answer")) ? "The answer is qq42qq." : "ok";
      options.onEvent({ type: "text.delta", attemptId: request.attemptId, blockId: "b", text });
      return { status: "completed", attemptId: request.attemptId, text, toolCalls: [], usage: {} };
    },
  };
}

async function compose(
  directory: string,
  model: ModelPort,
  options: { readonly workerResultSweepEnabled?: boolean } = {},
): Promise<TaviRuntime> {
  const runtime = await composeTaviRuntime(
    {
      dataDirectory: directory,
      workspaces: [...workspaces],
      providers: [],
      credentials: {},
      defaultConnectionId: "fixture",
      defaultModel: "fixture-model",
      logger: { level: "error", sink: () => {} },
      approvalRequiredFor: [],
      ...options,
    },
    { modelOverride: model },
  );
  const agents = runtime.store.asPort().repositories.agents;
  if ((await agents.get("default", "researcher")) === undefined) {
    await agents.create({
      agentId: "researcher",
      workspaceId: "default",
      name: "researcher",
      systemPrompt: "Act as a researcher.",
      enabled: true,
      now: nowTimestamp(),
    });
  }
  return runtime;
}

/** The parent chat's first turn, attended so its workers report back to it. */
async function parentChat(runtime: TaviRuntime): Promise<string> {
  const workflow = runtime.workflow;
  if (workflow === undefined) throw new Error("workflow unavailable");
  const admitted = await workflow.admit({
    context: { workspaceId: "default", principalId: "operator", runId: "pending-admission", caller: "test" },
    operationKey: "parent-chat",
    kind: "start",
    prompt: "orchestrate",
    executionPolicy: ATTENDED_TASK_POLICY,
  });
  expect(admitted.outcome.status).toBe("completed");
  return admitted.taskId;
}

const mailboxBlocks = (request: ModelRequest): string[] => userTexts(request).filter((text) => text.startsWith("[mailbox]"));

describe("a worker's result through the composed owner", () => {
  it("announces the worker's end, wakes its parent, and the parent's turn reads the result once, as data", async () => {
    const model = recordingModel();
    const runtime = await compose(directories.create(), model);
    try {
      const parentTaskId = await parentChat(runtime);
      const tool = runtime.tools.get("agents.spawn");
      if (tool === undefined) throw new Error("agents.spawn is not registered");
      const turn: InvocationContext = {
        workspaceId: "default",
        principalId: "operator",
        runId: parentTaskId,
        caller: "test",
        turnStartedAt: "2026-10-05T00:00:00.000Z",
      };
      const spawned = (await tool.handler({
        input: { agentDefinitionId: "researcher", input: "research the answer", operationKey: "worker-1" },
        context: turn,
        signal: new AbortController().signal,
      })) as { readonly workerTaskId: string };

      // The worker's end is announced after its admission; the parent's wake reads it.
      await waitFor(() => model.requests.some((request) => mailboxBlocks(request).some((text) => text.includes("qq42qq"))), 10_000, {
        what: "the parent's turn to read the worker's result",
      });
      const reading = model.requests.find((request) => mailboxBlocks(request).some((text) => text.includes("qq42qq")))!;
      expect(reading.messages.some((message) => message.role === "system" && message.text.includes("qq42qq"))).toBe(false);
      const repositories = runtime.store.asPort().repositories;
      const [result] = await repositories.agentMailbox.listByCorrelation(`worker-result:${spawned.workerTaskId}`);
      expect(result?.recipientTaskId).toBe(parentTaskId);
      await waitFor(
        async () => (await repositories.agentMailbox.getEnvelope(result!.messageId))?.deliveryState === "acknowledged",
        10_000,
        { what: "the result to be marked read" },
      );
      await waitFor(async () => (await repositories.tasks.get(parentTaskId))?.status === "completed", 10_000, {
        what: "the parent's wake to end",
      });

      // The next turn: the result is history, never a second block.
      const before = model.requests.length;
      const workflow = runtime.workflow!;
      await workflow.admit({
        context: { workspaceId: "default", principalId: "operator", runId: parentTaskId, caller: "test" },
        taskId: parentTaskId,
        operationKey: "parent-next",
        kind: "reply",
        prompt: "anything else?",
      });
      const next = model.requests.slice(before).at(-1)!;
      expect(mailboxBlocks(next)).toHaveLength(1);
      expect(next.messages.some((message) => message.role === "system" && message.text.includes("qq42qq"))).toBe(false);

      // The same key in the same turn is the same worker; in another turn, a new one.
      const retried = (await tool.handler({
        input: { agentDefinitionId: "researcher", input: "research the answer", operationKey: "worker-1" },
        context: turn,
        signal: new AbortController().signal,
      })) as { readonly workerTaskId: string };
      expect(retried.workerTaskId).toBe(spawned.workerTaskId);
      const later = (await tool.handler({
        input: { agentDefinitionId: "researcher", input: "research the answer", operationKey: "worker-1" },
        context: { ...turn, turnStartedAt: "2026-10-06T00:00:00.000Z" },
        signal: new AbortController().signal,
      })) as { readonly workerTaskId: string };
      expect(later.workerTaskId).not.toBe(spawned.workerTaskId);
    } finally {
      await runtime.close();
    }
  });

  it("announces at start a worker's result that a restart lost, and wakes its parent to read it", async () => {
    const directory = directories.create();
    const first = await compose(directory, recordingModel());
    let parentTaskId: string;
    let workerTaskId: string;
    try {
      parentTaskId = await parentChat(first);
      // A worker that ended with no announce: its delegation row is written once the
      // owner's own end-of-task hook has passed it by, as a restart between the two would leave it.
      const worker = await first.workflow!.admit({
        context: { workspaceId: "default", principalId: "operator", runId: "pending-admission", caller: "test" },
        operationKey: "lost-worker",
        kind: "start",
        prompt: "research the answer",
        executionPolicy: ATTENDED_TASK_POLICY,
        chatKind: "worker",
      });
      workerTaskId = worker.taskId;
      const ended = workerTaskId;
      await waitFor(async () => (await first.store.asPort().repositories.tasks.get(ended))?.status === "completed", 10_000, {
        what: "the worker to end",
      });
      // The owner's announce was scheduled as the worker's admission ended, one
      // macrotask out: let it begin (and find no delegation row) before the row is written.
      await new Promise((resolve) => setImmediate(resolve));
      await first.store.asPort().repositories.agentDelegations.recordSpawn({
        operationKey: "lost-spawn",
        workspaceId: "default",
        principalId: "operator",
        workerTaskId,
        workerAgentId: "agent-lost",
        parentTaskId,
        rootTaskId: parentTaskId,
        agentDefinitionId: "researcher",
        depth: 1,
        createdAt: nowTimestamp(),
      });
      expect(await first.store.asPort().repositories.agentMailbox.listByCorrelation(`worker-result:${workerTaskId}`)).toEqual([]);
    } finally {
      await first.close();
    }

    const model = recordingModel();
    const second = await compose(directory, model, { workerResultSweepEnabled: true });
    try {
      await waitFor(() => model.requests.some((request) => mailboxBlocks(request).some((text) => text.includes("qq42qq"))), 10_000, {
        what: "the restarted owner to announce the lost result",
      });
      const results = await second.store.asPort().repositories.agentMailbox.listByCorrelation(`worker-result:${workerTaskId}`);
      expect(results).toHaveLength(1);
      expect(results[0]?.recipientTaskId).toBe(parentTaskId);
    } finally {
      await second.close();
    }
  });
});

describe("spawnOperationKey", () => {
  it("is the same within a turn of a task, and different across turns and tasks", () => {
    const turn = { runId: "home-1", turnStartedAt: "2026-10-05T00:00:00.000Z" };
    expect(spawnOperationKey(turn, "worker-1")).toBe(spawnOperationKey({ ...turn }, "worker-1"));
    expect(spawnOperationKey(turn, "worker-1")).not.toBe(
      spawnOperationKey({ ...turn, turnStartedAt: "2026-10-06T00:00:00.000Z" }, "worker-1"),
    );
    expect(spawnOperationKey(turn, "worker-1")).not.toBe(spawnOperationKey({ ...turn, runId: "home-2" }, "worker-1"));
    expect(spawnOperationKey(turn, "x".repeat(256)).length).toBeLessThanOrEqual(256);
  });
});
