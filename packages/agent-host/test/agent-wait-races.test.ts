import { fixturePromptPolicy } from "./support/prompt-policy.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import type {
  AgentMailboxRepositoryPort,
  AgentWaitRepositoryPort,
  CancellationRepositoryPort,
  InvocationContext,
  ModelEvent,
  ModelOutcome,
  ModelPort,
  ModelRequest,
  TaskRepositoryPort,
  ToolDefinition,
} from "@tavi/contracts";
import { createAgentCommunicationService } from "@tavi/agent-host/agent-communication";
import { sweepExpiredWaits } from "@tavi/agent-host/agent-wait-scheduler";
import {
  createInMemoryAgentDelegationRepository,
  createInMemoryAgentMailboxRepository,
  createInMemoryAgentWaitRepository,
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
 * Race and lifecycle fixtures for the `agents.wait` interrupt, driven through the real
 * graph — a genuinely suspended admission, not repository state assembled
 * by hand — the way the other fixtures in `workflow.test.ts`'s "wait
 * suspend and resume" block already do for the base suspend/resume case.
 */

const context: InvocationContext = { workspaceId: "ws1", principalId: "p1", runId: "root", caller: "test" };

const agentsWaitDefinition: ToolDefinition = {
  id: "agents.wait",
  version: "1.0.0",
  description: "Suspend until a matching reply arrives, a worker completes, or the deadline passes.",
  effect: "read-only",
  requiredPermissions: ["tools.invoke"],
};

function createRegistry(): {
  registry: {
    register: () => never;
    get: (id: string) => unknown;
    list: () => readonly never[];
    listOffered: () => Promise<readonly never[]>;
  };
} {
  const byId = new Map([[agentsWaitDefinition.id, agentsWaitDefinition]]);
  return {
    registry: {
      register: () => {
        throw new Error("not used in this test");
      },
      get: (id: string) => {
        const definition = byId.get(id);
        if (definition === undefined) return undefined;
        const schema = z.object({}).passthrough();
        return {
          ...definition,
          inputSchema: schema,
          inputJsonSchema: z.toJSONSchema(schema, { io: "input" }) as Record<string, unknown>,
          modelName: definition.id.replace(/[^a-zA-Z0-9_-]/g, "_"),
          handler: async () => {
            throw new Error("agents.wait is dispatched directly by toolsNode, never through this handler");
          },
        };
      },
      list: () => [],
      listOffered: async () => [],
    },
  };
}

/** One suspending `agents.wait` turn, then a corrected/completed turn once resumed. */
function waitingModel(waitInput: Record<string, unknown>, resumedText: string): ModelPort {
  let call = 0;
  return {
    async stream(request: ModelRequest, streamOptions: { readonly onEvent: (event: ModelEvent) => void }): Promise<ModelOutcome> {
      call += 1;
      if (call === 1) {
        return {
          status: "completed",
          attemptId: request.attemptId,
          text: "",
          toolCalls: [{ id: "call-wait", name: "agents.wait", input: waitInput }],
          usage: {},
        };
      }
      streamOptions.onEvent({ type: "text.delta", attemptId: request.attemptId, blockId: "b", text: resumedText });
      return { status: "completed", attemptId: request.attemptId, text: resumedText, toolCalls: [], usage: {} };
    },
  };
}

interface Setup {
  readonly adapter: ReturnType<typeof createWorkflowAdapter>;
  readonly tasks: TaskRepositoryPort;
  readonly mailbox: AgentMailboxRepositoryPort;
  readonly waits: AgentWaitRepositoryPort;
  readonly cancellations: CancellationRepositoryPort;
  readonly delegations: ReturnType<typeof createInMemoryAgentDelegationRepository>;
  readonly executions: ReturnType<typeof createInMemoryExecutionRepository>;
  readonly agentsService: ReturnType<typeof createAgentCommunicationService>;
}

function setup(model: ModelPort, cancelReason = "cancelled via agents.cancel"): Setup {
  const { registry } = createRegistry();
  const { saver } = createInMemorySaver();
  const tasks = createInMemoryTaskRepository();
  const mailbox = createInMemoryAgentMailboxRepository();
  const waits = createInMemoryAgentWaitRepository();
  const delegations = createInMemoryAgentDelegationRepository();
  const cancellations = createInMemoryCancellationRepository();
  const executions = createInMemoryExecutionRepository();
  let counter = 0;
  const newId = (prefix: string): string => `${prefix}-${(counter += 1)}`;
  let agentsService: ReturnType<typeof createAgentCommunicationService> | undefined;
  // Permissive by default — nothing denied — so the peer-grant tests can
  // opt into a denial explicitly without every other test in this file
  // needing to grant every agentMessageGrant string by hand.
  const access = { resolveWorkspace: () => ({ principalId: context.principalId }), missingPermissions: () => [] };
  const adapter = createWorkflowAdapter({
    checkpointSaver: saver,
    models: model,
    tools: registry as unknown as Parameters<typeof createWorkflowAdapter>[0]["tools"],
    tasks,
    executions,
    effects: createInMemoryEffectRepository(),
    receipts: createInMemoryReceiptRepository(),
    approvals: createInMemoryApprovalRepository(),
    cancellations,
    ownerSession: "test-session",
    connectionId: "fixture",
    model: "fixture-model",
    systemPrompt: "test system prompt",
    access,
    agents: () => agentsService,
    newId,
    now: () => "2026-01-01T00:00:00.000Z",
  });
  const service = createAgentCommunicationService({
    mailbox,
    waits,
    delegations,
    tasks,
    workflow: adapter,
    access,
    cancelTask: async (input) => {
      await cancellations.request({
        taskId: input.taskId,
        requestedBy: input.operator,
        reason: input.reason ?? cancelReason,
        now: { fixed: (() => "2026-01-01T00:00:00.000Z")() },
      });
      await tasks.updateStatus(input.taskId, "cancelled", null);
    },
    newId,
    now: () => "2026-01-01T00:00:00.000Z",
  });
  agentsService = service;
  return { adapter, tasks, mailbox, waits, cancellations, delegations, executions, agentsService: service };
}

describe("agents.wait races and lifecycle", () => {
  it("a reply already durable before agents.wait registers settles immediately, never suspending the real graph", async () => {
    const { adapter, mailbox } = setup(waitingModel({ correlationId: "c1", deadlineAt: "2026-01-01T00:10:00.000Z" }, "unused"));

    let seenTaskId: string | undefined;
    const result = await adapter.admit({
      context,
      operationKey: "op-early-reply",
      kind: "start",
      prompt: "hello",
      // Called once the task id is durable and before any node runs — the
      // earliest point a reply can legitimately be said to have "already
      // landed" ahead of the wait's own registration.
      onAdmitted: async (admitted) => {
        seenTaskId = admitted.taskId;
        await mailbox.insertEnvelope({
          messageId: "msg-early",
          protocolVersion: 1,
          workspaceId: context.workspaceId,
          senderAgentId: "peer",
          senderTaskId: "peer-task",
          recipientAgentId: "orchestrator",
          recipientTaskId: admitted.taskId,
          kind: "reply",
          correlationId: "c1",
          content: "early",
          createdAt: "2026-01-01T00:00:00.000Z",
          deliveryState: "pending",
          retentionState: "active",
        });
      },
    });

    expect(seenTaskId).toBeDefined();
    // Never suspended: the model's single scripted turn produced the tool
    // call, `agents.wait` settled from the already-durable reply, and the
    // graph looped back to `model` for its corrective/finishing turn in the
    // same admission — no `waiting` status ever observed.
    expect(result.outcome.status).toBe("completed");
    expect(result.outcome.waitInterrupt).toBeUndefined();
  });

  it("send()'s wait-aware settle wins when it runs first, and a subsequent sweep pass correctly no-ops on the already-settled row", async () => {
    // Complete the sender first to select this ordering explicitly. The peer
    // race test separately runs both contenders concurrently.
    // A worker's own result under its `worker-result:<id>` correlation: the only `result` that settles a wait.
    const { adapter, waits, tasks, delegations, agentsService } = setup(
      waitingModel({ correlationId: "worker-result:peer-task", deadlineAt: "2026-01-01T00:05:00.000Z" }, "got the reply"),
    );

    const first = await adapter.admit({ context, operationKey: "op-race", kind: "start", prompt: "hello" });
    delegations.recordSpawn({
      operationKey: "op-peer",
      workspaceId: context.workspaceId,
      principalId: context.principalId,
      workerTaskId: "peer-task",
      workerAgentId: "peer",
      depth: 1,
      parentTaskId: first.taskId,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    expect(first.outcome.status).toBe("waiting");
    const waitId = first.outcome.waitInterrupt?.wait.waitId ?? "";
    expect((await waits.get(waitId))?.state).toBe("active");

    const sendResult = await agentsService.send({
      actor: { workspaceId: context.workspaceId, principalId: context.principalId, runId: "peer-task", caller: "test" },
      recipientAgentId: "orchestrator",
      recipientTaskId: first.taskId,
      kind: "result",
      correlationId: "worker-result:peer-task",
      content: "the reply",
    });
    const sweepResult = await sweepExpiredWaits({ waits, tasks, workflow: adapter, now: () => "2026-01-01T00:10:00.000Z" });

    expect(sendResult.accepted).toBe(true);
    // The persisted winner is absent from the active-wait scan.
    expect(sweepResult).toEqual({ settled: 0, alreadySettled: 0, orphaned: [], recovered: 0, failedResumes: [] });
    expect((await waits.get(waitId))?.state).toBe("settled");
    expect((await waits.get(waitId))?.settledOutcome?.kind).toBe("replied");
    const final = await tasks.get(first.taskId);
    expect(final?.status).toBe("completed");
    expect(final?.finalText).toBe("got the reply");
  });

  it("agents.cancel on a task suspended on agents.wait settles the wait as cancelled and the task never resumes", async () => {
    const { adapter, waits, tasks, agentsService } = setup(
      waitingModel({ correlationId: "c3", deadlineAt: "2026-01-01T00:10:00.000Z" }, "unused"),
    );

    const first = await adapter.admit({ context, operationKey: "op-cancel", kind: "start", prompt: "hello" });
    expect(first.outcome.status).toBe("waiting");
    const waitId = first.outcome.waitInterrupt?.wait.waitId ?? "";
    expect((await waits.get(waitId))?.state).toBe("active");

    await agentsService.cancel({
      actor: { workspaceId: context.workspaceId, principalId: context.principalId, runId: first.taskId, caller: "test" },
      taskId: first.taskId,
      reason: "no longer needed",
    });

    // The dangling-forever gap this fixture exists to close: the wait row
    // itself must move out of `active`, or the expiry sweep would keep
    // surfacing it for a task nothing will ever resume again.
    expect((await waits.get(waitId))?.state).toBe("settled");
    expect((await waits.get(waitId))?.settledOutcome).toEqual({ kind: "cancelled" });
    expect((await tasks.get(first.taskId))?.status).toBe("cancelled");

    // A later admission attempt for the cancelled task (the shape a stray
    // deadline-sweep or reply admission would take) is short-circuited to
    // the cancelled outcome by `admit()`'s own pre-check — it never
    // resumes the suspended graph node.
    const resumed = await adapter.admit({
      context,
      taskId: first.taskId,
      operationKey: "op-cancel-resume-attempt",
      kind: "deadline",
      resume: { waitOutcome: { kind: "cancelled" } },
    });
    expect(resumed.outcome.status).toBe("failed");
  });

  it("the orchestrator's execution slot is released while suspended, so an independently admitted worker is never blocked by it", async () => {
    const { adapter, executions, tasks, waits } = setup(
      waitingModel({ waitingOnWorkerTaskId: "worker-1", deadlineAt: "2026-01-01T00:05:00.000Z" }, "worker was done"),
    );

    const first = await adapter.admit({ context, operationKey: "op-slot", kind: "start", prompt: "hello" });
    expect(first.outcome.status).toBe("waiting");
    // The orchestrator's own execution slot is free while suspended (an
    // orchestrator suspended in waitFor releases its slot so the worker
    // can run), verified directly rather than merely inferred from the interrupt.
    expect((await executions.current(first.taskId))?.state).not.toBe("active");

    // The worker's own task, admitted independently — never nested inside
    // the orchestrator's call stack the way `spawn`'s synchronous blocking
    // (this module's own disclosed gap) would
    // otherwise force it to be.
    await tasks.admit({
      prompt: fixturePromptPolicy,
      workspaceId: context.workspaceId,
      principalId: context.principalId,
      operationKey: "op-worker",
      kind: "start",
      intent: null,
      checkpointNamespace: "",
      newTaskId: (() => "worker-1")(),
      newAdmissionId: (() => "adm-worker")(),
      newThreadId: (() => "thread-worker")(),
      now: (() => "2026-01-01T00:00:00.000Z")(),
    });
    const lease = await executions.acquire({
      taskId: "worker-1",
      ownerSession: "test-session",
      admissionId: "adm-worker",
      leaseMs: 60_000,
      now: { fixed: (() => "2026-01-01T00:00:00.000Z")() },
    });
    expect(lease.taskId).toBe("worker-1");
    await executions.release({
      taskId: "worker-1",
      generation: lease.generation,
      ownerSession: "test-session",
      now: { fixed: (() => "2026-01-01T00:00:00.000Z")() },
    });
    await tasks.updateStatus("worker-1", "completed", "worker output");

    // Deadline passes with the worker now finished; the expiry sweep is
    // the only mechanism that resumes a `waitingOnWorkerTaskId` wait today
    // (there is no live push on task completion — a disclosed limitation,
    // not new to this fixture), and the orchestrator resumes correctly.
    const swept = await sweepExpiredWaits({ waits, tasks, workflow: adapter, now: () => "2026-01-01T00:10:00.000Z" });
    expect(swept.settled).toBe(1);
    const final = await tasks.get(first.taskId);
    expect(final?.status).toBe("completed");
    expect(final?.finalText).toBe("worker was done");
  });
});
