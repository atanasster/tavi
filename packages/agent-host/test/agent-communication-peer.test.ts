import { fixturePromptPolicy } from "./support/prompt-policy.js";
import type { AccessPolicyPort, AgentActor, TaskRepositoryPort, WorkflowPort } from "@tavi/contracts";
import { AgentWaitInputSchema, WorkflowWaitSuspend, agentWaitInputConflict } from "@tavi/contracts";
import { createAgentCommunicationService } from "@tavi/agent-host/agent-communication";
import { sweepExpiredWaits } from "@tavi/agent-host/agent-wait-scheduler";
import {
  admitFixtureTask,
  createInMemoryAgentDelegationRepository,
  createInMemoryAgentMailboxRepository,
  createInMemoryAgentWaitRepository,
  createInMemoryTaskRepository,
} from "@tavi/test-support/fakes";
import { describe, expect, it } from "vitest";

/**
 * Worker ↔ worker peer messaging — the fixtures its acceptance criteria
 * name, beyond what
 * `agent-communication.test.ts`'s "request/reply" block already covers
 * (worker A → worker B → reply; a late reply recorded but not reopening a
 * settled wait; grant/self-request/schema rejections). This file adds the
 * two that specifically need more than one task waiting at once: cycle
 * termination through bounded deadlines, and a reply/timeout race settling
 * exactly once for a request-originated wait.
 *
 * `waitFor` is called directly against the plugin (not through a real
 * LangGraph adapter): it throws the same `WorkflowWaitSuspend` marker
 * either way, and nothing about deadline-driven cycle termination or the
 * settle-race depends on an actual graph node running — `workflow.test.ts`
 * and `agent-wait-races.test.ts` already cover the graph-integrated
 * suspend/resume path generically, for `agents.wait` regardless of what
 * populated its correlation.
 */

const AT = "2026-01-01T00:00:00.000Z";

/**
 * Always permissive — this file's tests exercise cycle/race mechanics, not
 * grant denial (that's `agent-communication.test.ts`'s job). Named
 * distinctly from that file's own `createAccess`, whose `deniedPermissions`
 * parameter gives it genuinely different behavior (two
 * same-named-but-different `createAccess` functions in sibling files would
 * be a drift risk).
 */
function createPermissiveAccess(): AccessPolicyPort {
  return { resolveWorkspace: () => ({ principalId: "alice" }), missingPermissions: () => [] };
}

/** A minimal `WorkflowPort`: `kind: "start"` creates a task, everything else resolves against an existing one — mirrors `agent-communication.test.ts`'s own fixture. */
function createFixtureWorkflow(tasks: TaskRepositoryPort): WorkflowPort {
  let counter = 0;
  return {
    admit: async (input) => {
      if (input.kind === "start") {
        const result = await tasks.admit({
          prompt: fixturePromptPolicy,
          workspaceId: input.context.workspaceId,
          principalId: input.context.principalId,
          operationKey: input.operationKey,
          kind: "start",
          intent: input.prompt ?? null,
          checkpointNamespace: "",
          newTaskId: (() => `task-${(counter += 1)}`)(),
          newAdmissionId: (() => `adm-${(counter += 1)}`)(),
          newThreadId: (() => `thread-${(counter += 1)}`)(),
          now: (() => AT)(),
        });
        return {
          taskId: result.task.taskId,
          threadId: result.task.threadId,
          outcome: { status: "completed", finalText: "" },
          created: result.created,
          replay: !result.created,
        };
      }
      const existing = input.taskId === undefined ? undefined : await tasks.get(input.taskId);
      return {
        taskId: existing?.taskId ?? input.taskId ?? "unknown",
        threadId: existing?.threadId ?? "thread-x",
        outcome: { status: "completed", finalText: "" },
        created: false,
        replay: true,
      };
    },
    checkpoints: { latest: async () => undefined, listCheckpoints: async () => [] },
  };
}

function build() {
  const tasks = createInMemoryTaskRepository();
  const mailbox = createInMemoryAgentMailboxRepository();
  const waits = createInMemoryAgentWaitRepository();
  const delegations = createInMemoryAgentDelegationRepository();
  const workflow = createFixtureWorkflow(tasks);
  const service = createAgentCommunicationService({
    mailbox,
    waits,
    delegations,
    tasks,
    workflow,
    access: createPermissiveAccess(),
    cancelTask: () => {
      throw new Error("cancel is not exercised by this file");
    },
    now: () => AT,
  });
  return { tasks, mailbox, waits, workflow, service };
}

describe("a wait a person answers", () => {
  it("carries operator.ask_user's question onto the suspension the graph interrupts with", async () => {
    const { tasks, service } = build();
    await admitFixtureTask(tasks, "t-a", fixturePromptPolicy);
    const actor: AgentActor = { principalId: "alice", workspaceId: "w1", agentId: "agent-a", runId: "t-a", caller: "cli" };
    const suspended = await service
      .waitFor({ actor, taskId: "t-a", deadlineAt: "2026-01-01T00:05:00.000Z", question: "Which projects should I track?" })
      .catch((error: unknown) => error);
    expect(suspended).toBeInstanceOf(WorkflowWaitSuspend);
    expect((suspended as WorkflowWaitSuspend).question).toBe("Which projects should I track?");
  });
});

describe("a wait's deadline", () => {
  it("holds a root task's far deadline to a week, and refuses one that is not a timestamp", async () => {
    const { tasks, waits, service } = build();
    await admitFixtureTask(tasks, "t-a", fixturePromptPolicy);
    const actor: AgentActor = { principalId: "alice", workspaceId: "w1", agentId: "agent-a", runId: "t-a", caller: "cli" };
    const suspended = await service
      .waitFor({ actor, taskId: "t-a", waitId: "wait-far", deadlineAt: "3000-01-01T00:00:00.000Z" })
      .catch((error: unknown) => error);
    expect(suspended).toBeInstanceOf(WorkflowWaitSuspend);
    expect((await waits.get("wait-far"))?.deadlineAt).toBe("2026-01-08T00:00:00.000Z");
    await expect(service.waitFor({ actor, taskId: "t-a", waitId: "wait-bad", deadlineAt: "zzz" })).rejects.toThrow(/not a valid timestamp/);
  });

  it("stores a deadline given with an offset in UTC, so the expiry sweep compares it rightly", async () => {
    const { tasks, waits, service } = build();
    await admitFixtureTask(tasks, "t-a", fixturePromptPolicy);
    const actor: AgentActor = { principalId: "alice", workspaceId: "w1", agentId: "agent-a", runId: "t-a", caller: "cli" };
    await service.waitFor({ actor, taskId: "t-a", waitId: "wait-offset", deadlineAt: "2025-12-31T19:05:00-05:00" }).catch(() => undefined);
    expect((await waits.get("wait-offset"))?.deadlineAt).toBe("2026-01-01T00:05:00.000Z");
  });

  it("is a timestamp in the tool's schema, and the input names at most one thing to wait on", () => {
    expect(AgentWaitInputSchema.safeParse({ deadlineAt: "zzz" }).success).toBe(false);
    expect(AgentWaitInputSchema.safeParse({ deadlineAt: "2026-01-01T02:00:00+02:00" }).success).toBe(true);
    const both = AgentWaitInputSchema.parse({ correlationId: "m-1", waitingOnWorkerTaskId: "t-2", deadlineAt: "2026-01-01T00:05:00.000Z" });
    expect(agentWaitInputConflict(both)).toMatch(/not both/);
    expect(agentWaitInputConflict({ correlationId: "m-1", deadlineAt: "2026-01-01T00:05:00.000Z" })).toBeUndefined();
  });
});

describe("peer messaging: cycles and races", () => {
  it("a two-agent request cycle terminates via independent per-wait deadlines, never hanging", async () => {
    const { tasks, waits, workflow, service } = build();
    await admitFixtureTask(tasks, "t-a", fixturePromptPolicy);
    await admitFixtureTask(tasks, "t-b", fixturePromptPolicy);
    const actorA: AgentActor = { principalId: "alice", workspaceId: "w1", agentId: "agent-a", runId: "t-a", caller: "cli" };
    const actorB: AgentActor = { principalId: "alice", workspaceId: "w1", agentId: "agent-b", runId: "t-b", caller: "cli" };

    // A requests B; before replying, B requests A back — a genuine cycle,
    // neither side able to settle the other's wait through a reply.
    const aToB = await service.request({
      actor: actorA,
      recipientAgentId: "agent-b",
      recipientTaskId: "t-b",
      deadlineAt: "2026-01-01T00:05:00.000Z",
    });
    const bToA = await service.request({
      actor: actorB,
      recipientAgentId: "agent-a",
      recipientTaskId: "t-a",
      deadlineAt: "2026-01-01T00:07:00.000Z",
    });

    await expect(
      service.waitFor({ actor: actorA, taskId: "t-a", correlationId: aToB.messageId, deadlineAt: "2026-01-01T00:05:00.000Z" }),
    ).rejects.toBeInstanceOf(WorkflowWaitSuspend);
    await expect(
      service.waitFor({ actor: actorB, taskId: "t-b", correlationId: bToA.messageId, deadlineAt: "2026-01-01T00:07:00.000Z" }),
    ).rejects.toBeInstanceOf(WorkflowWaitSuspend);

    const waitIdA = (await waits.getActiveByCorrelation("t-a", aToB.messageId))?.waitId ?? "";
    const waitIdB = (await waits.getActiveByCorrelation("t-b", bToA.messageId))?.waitId ?? "";
    expect((await waits.get(waitIdA))?.state).toBe("active");
    expect((await waits.get(waitIdB))?.state).toBe("active");

    // Neither deadline has passed yet at t=00:03: the cycle is stalled, not
    // resolved — this is the "bounds stalls but does not guarantee useful
    // completion" trade-off, accepted on purpose.
    const early = await sweepExpiredWaits({ waits, tasks, workflow, now: () => "2026-01-01T00:03:00.000Z" });
    expect(early.settled).toBe(0);
    expect((await waits.get(waitIdA))?.state).toBe("active");
    expect((await waits.get(waitIdB))?.state).toBe("active");

    // Past both deadlines: the sweep terminates the whole cycle without
    // either side ever replying — no cycle-detection logic ran (deferred
    // per this plugin's own header comment), the
    // deadlines alone bound the stall.
    const swept = await sweepExpiredWaits({ waits, tasks, workflow, now: () => "2026-01-01T00:10:00.000Z" });
    expect(swept.settled).toBe(2);
    expect((await waits.get(waitIdA))?.state).toBe("settled");
    expect((await waits.get(waitIdA))?.settledOutcome?.kind).toBe("wait-timeout");
    expect((await waits.get(waitIdB))?.state).toBe("settled");
    expect((await waits.get(waitIdB))?.settledOutcome?.kind).toBe("wait-timeout");
  });

  it("a reply/timeout race for a request-originated wait settles exactly once", async () => {
    const { tasks, waits, workflow, service } = build();
    await admitFixtureTask(tasks, "t-a", fixturePromptPolicy);
    await admitFixtureTask(tasks, "t-b", fixturePromptPolicy);
    const actorA: AgentActor = { principalId: "alice", workspaceId: "w1", agentId: "agent-a", runId: "t-a", caller: "cli" };
    const actorB: AgentActor = { principalId: "alice", workspaceId: "w1", agentId: "agent-b", runId: "t-b", caller: "cli" };

    const requested = await service.request({
      actor: actorA,
      recipientAgentId: "agent-b",
      recipientTaskId: "t-b",
      deadlineAt: "2026-01-01T00:05:00.000Z",
    });
    await expect(
      service.waitFor({ actor: actorA, taskId: "t-a", correlationId: requested.messageId, deadlineAt: "2026-01-01T00:05:00.000Z" }),
    ).rejects.toBeInstanceOf(WorkflowWaitSuspend);
    const waitId = (await waits.getActiveByCorrelation("t-a", requested.messageId))?.waitId ?? "";

    // Race `reply()` against a sweep pass whose `now` is already past the
    // deadline — both target the same durable wait row.
    const [replyResult] = await Promise.all([
      service.reply({ actor: actorB, requestMessageId: requested.messageId, content: "just in time" }),
      sweepExpiredWaits({ waits, tasks, workflow, now: () => "2026-01-01T00:10:00.000Z" }),
    ]);

    expect(replyResult.accepted).toBe(true);
    // Exactly one settlement survives; `settle`'s conditional transition
    // is what guarantees this, not call ordering.
    const finalState = await waits.get(waitId);
    expect(finalState?.state).toBe("settled");
    expect(["replied", "wait-timeout"]).toContain(finalState?.settledOutcome?.kind);

    const resumed = await service.waitFor({
      waitId,
      actor: actorA,
      taskId: "t-a",
      correlationId: requested.messageId,
      deadlineAt: "2026-01-01T00:05:00.000Z",
    });
    expect(resumed.outcome).toEqual(finalState?.settledOutcome);
  });
});
