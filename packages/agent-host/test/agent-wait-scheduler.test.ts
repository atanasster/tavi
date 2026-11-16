import { fixturePromptPolicy } from "./support/prompt-policy.js";
import {
  waitResumeOperationKey,
  type AdmitInput,
  type AdmissionResult,
  type AgentWaitRepositoryPort,
  type TaskStatus,
  type WorkflowInvokeOptions,
  type WorkflowPort,
} from "@tavi/contracts";
import { createInMemoryAgentWaitRepository, createInMemoryTaskRepository } from "@tavi/test-support/fakes";
import { describe, expect, it } from "vitest";
import { partialFake } from "@tavi/test-support";

import { sweepExpiredWaits, startAgentWaitScheduler } from "../src/agents/agent-wait-scheduler.js";

/**
 * `sweepExpiredWaits` — the wait-specific expiry sweep. Exercised directly, one
 * call at a time, rather than through `startAgentWaitScheduler`'s real timer: a
 * fast unit test has no business waiting on a real interval (mirrors how
 * `leaseMs`/`now` are injectable elsewhere in this codebase rather than
 * requiring real wall-clock waits).
 */

function createFixtureWorkflow(): { workflow: WorkflowPort; admissions: AdmitInput[] } {
  const admissions: AdmitInput[] = [];
  const workflow: WorkflowPort = partialFake<WorkflowPort>({
    admit: async (input: AdmitInput, _options?: WorkflowInvokeOptions): Promise<AdmissionResult> => {
      admissions.push(input);
      return {
        taskId: input.taskId ?? "unknown",
        threadId: "thread-x",
        outcome: { status: "completed", finalText: "resumed" },
        created: false,
        replay: false,
      };
    },
    checkpoints: {
      latest: async () => undefined,
      listCheckpoints: async () => [],
    },
  });
  return { workflow, admissions };
}

describe("sweepExpiredWaits", () => {
  it("settles and resumes every active wait past its deadline", async () => {
    const waits = createInMemoryAgentWaitRepository();
    const tasks = createInMemoryTaskRepository();
    const { workflow, admissions } = createFixtureWorkflow();

    await tasks.admit({
      prompt: fixturePromptPolicy,
      workspaceId: "ws1",
      principalId: "p1",
      operationKey: "op1",
      kind: "start",
      intent: null,
      checkpointNamespace: "",
      newTaskId: (() => "task-1")(),
      newAdmissionId: (() => "adm-1")(),
      newThreadId: (() => "thread-1")(),
      now: (() => "2026-01-01T00:00:00.000Z")(),
    });
    await waits.prepare({ waitId: "w1", taskId: "task-1", deadlineAt: "2026-01-01T00:05:00.000Z" });
    await waits.activate("w1");

    const result = await sweepExpiredWaits({ waits, tasks, workflow, now: () => "2026-01-01T00:10:00.000Z" });

    expect(result.settled).toBe(1);
    expect(result.alreadySettled).toBe(0);
    expect(result.orphaned).toEqual([]);
    expect((await waits.get("w1"))?.state).toBe("settled");
    expect(admissions).toHaveLength(1);
    expect(admissions[0]?.kind).toBe("deadline");
    expect(admissions[0]?.taskId).toBe("task-1");
    expect(admissions[0]?.resume).toEqual({ waitOutcome: { kind: "wait-timeout" }, waitId: "w1", via: "policy", decidedBy: "policy" });
  });

  it("answers a question that named a default with it at its deadline", async () => {
    const waits = createInMemoryAgentWaitRepository();
    const tasks = createInMemoryTaskRepository();
    const { workflow, admissions } = createFixtureWorkflow();
    await tasks.admit({
      prompt: fixturePromptPolicy,
      workspaceId: "ws1",
      principalId: "p1",
      operationKey: "op1",
      kind: "start",
      intent: null,
      checkpointNamespace: "",
      newTaskId: (() => "task-1")(),
      newAdmissionId: (() => "adm-1")(),
      newThreadId: (() => "thread-1")(),
      now: (() => "2026-01-01T00:00:00.000Z")(),
    });
    await waits.prepare({
      waitId: "w1",
      taskId: "task-1",
      deadlineAt: "2026-01-01T00:05:00.000Z",
      choices: { options: [{ label: "Ship" }, { label: "Wait" }], multiSelect: false, allowOther: true, defaultOption: 2 },
    });
    await waits.activate("w1");
    await sweepExpiredWaits({ waits, tasks, workflow, now: () => "2026-01-01T00:10:00.000Z" });
    expect((await waits.get("w1"))?.settledOutcome).toMatchObject({ kind: "wait-timeout", answers: ["Wait"] });
    expect(admissions[0]?.resume?.waitOutcome).toMatchObject({ kind: "wait-timeout", answers: ["Wait"] });
  });

  it("tells its caller of each wait it settles by deadline", async () => {
    const waits = createInMemoryAgentWaitRepository();
    const tasks = createInMemoryTaskRepository();
    const { workflow } = createFixtureWorkflow();
    await tasks.admit({
      prompt: fixturePromptPolicy,
      workspaceId: "ws1",
      principalId: "p1",
      operationKey: "op1",
      kind: "start",
      intent: null,
      checkpointNamespace: "",
      newTaskId: (() => "task-1")(),
      newAdmissionId: (() => "adm-1")(),
      newThreadId: (() => "thread-1")(),
      now: (() => "2026-01-01T00:00:00.000Z")(),
    });
    await waits.prepare({ waitId: "w1", taskId: "task-1", deadlineAt: "2026-01-01T00:05:00.000Z" });
    await waits.activate("w1");
    const told: [string, string][] = [];
    await sweepExpiredWaits({
      waits,
      tasks,
      workflow,
      now: () => "2026-01-01T00:10:00.000Z",
      onSettled: async (waitId, outcome) => void told.push([waitId, outcome.kind]),
    });
    expect(told).toEqual([["w1", "wait-timeout"]]);
  });

  it("leaves a not-yet-due active wait untouched", async () => {
    const waits = createInMemoryAgentWaitRepository();
    const tasks = createInMemoryTaskRepository();
    const { workflow, admissions } = createFixtureWorkflow();
    await tasks.admit({
      prompt: fixturePromptPolicy,
      workspaceId: "ws1",
      principalId: "p1",
      operationKey: "op1",
      kind: "start",
      intent: null,
      checkpointNamespace: "",
      newTaskId: (() => "task-1")(),
      newAdmissionId: (() => "adm-1")(),
      newThreadId: (() => "thread-1")(),
      now: (() => "2026-01-01T00:00:00.000Z")(),
    });
    await waits.prepare({ waitId: "w1", taskId: "task-1", deadlineAt: "2026-01-01T00:30:00.000Z" });
    await waits.activate("w1");

    const result = await sweepExpiredWaits({ waits, tasks, workflow, now: () => "2026-01-01T00:10:00.000Z" });

    expect(result.settled).toBe(0);
    expect(admissions).toEqual([]);
    expect((await waits.get("w1"))?.state).toBe("active");
  });

  it("counts, but does not double-admit, a wait a racing caller settles mid-sweep", async () => {
    // Two due waits in one sweep pass. While the loop is awaiting the first
    // wait's `admit()` call, a racing caller (the fixture workflow itself,
    // standing in for `send()`'s wait-aware branch) settles the second wait
    // first — exercising the real ordering `settle`'s conditional-transition
    // contract exists for: a reply/deadline race settles exactly once.
    const waits = createInMemoryAgentWaitRepository();
    const tasks = createInMemoryTaskRepository();
    await tasks.admit({
      prompt: fixturePromptPolicy,
      workspaceId: "ws1",
      principalId: "p1",
      operationKey: "op1",
      kind: "start",
      intent: null,
      checkpointNamespace: "",
      newTaskId: (() => "task-1")(),
      newAdmissionId: (() => "adm-1")(),
      newThreadId: (() => "thread-1")(),
      now: (() => "2026-01-01T00:00:00.000Z")(),
    });
    await waits.prepare({ waitId: "w1", taskId: "task-1", deadlineAt: "2026-01-01T00:05:00.000Z" });
    await waits.activate("w1");
    await waits.prepare({ waitId: "w2", taskId: "task-1", deadlineAt: "2026-01-01T00:05:00.000Z" });
    await waits.activate("w2");

    const admissions: AdmitInput[] = [];
    const workflow: WorkflowPort = partialFake<WorkflowPort>({
      admit: async (input: AdmitInput): Promise<AdmissionResult> => {
        admissions.push(input);
        if (input.taskId === "task-1" && admissions.length === 1) {
          // Racing settle for w2, landing while w1's admit is "in flight".
          await waits.settle({ waitId: "w2", outcome: { kind: "replied" } });
        }
        return {
          taskId: input.taskId ?? "unknown",
          threadId: "thread-x",
          outcome: { status: "completed", finalText: "resumed" },
          created: false,
          replay: false,
        };
      },
      checkpoints: { latest: async () => undefined, listCheckpoints: async () => [] },
    });

    const result = await sweepExpiredWaits({ waits, tasks, workflow, now: () => "2026-01-01T00:10:00.000Z" });

    expect(result.settled).toBe(1);
    expect(result.alreadySettled).toBe(1);
    // Only w1's timeout was admitted; w2's race-settled outcome was never
    // re-admitted by the sweep.
    expect(admissions).toHaveLength(1);
    expect((await waits.get("w2"))?.settledOutcome).toEqual({ kind: "replied" });
  });

  it("reports an orphaned wait whose task no longer exists, without throwing", async () => {
    const waits = createInMemoryAgentWaitRepository();
    const tasks = createInMemoryTaskRepository();
    const { workflow, admissions } = createFixtureWorkflow();
    await waits.prepare({ waitId: "w-orphan", taskId: "no-such-task", deadlineAt: "2026-01-01T00:05:00.000Z" });
    await waits.activate("w-orphan");

    const result = await sweepExpiredWaits({ waits, tasks, workflow, now: () => "2026-01-01T00:10:00.000Z" });

    expect(result.orphaned).toEqual(["w-orphan"]);
    expect(admissions).toEqual([]);
  });
});

describe("sweepExpiredWaits — recovering a resume that never ran", () => {
  async function waitingTask(tasks: ReturnType<typeof createInMemoryTaskRepository>, status: TaskStatus): Promise<void> {
    await tasks.admit({
      prompt: fixturePromptPolicy,
      workspaceId: "ws1",
      principalId: "p1",
      operationKey: "op1",
      kind: "start",
      intent: null,
      checkpointNamespace: "",
      newTaskId: (() => "task-1")(),
      newAdmissionId: (() => "adm-1")(),
      newThreadId: (() => "thread-1")(),
      now: (() => "2026-01-01T00:00:00.000Z")(),
    });
    await tasks.updateStatus("task-1", status, null);
  }

  it("re-admits an answered wait whose resume was lost, once, under the wait's own key", async () => {
    const waits = createInMemoryAgentWaitRepository();
    const tasks = createInMemoryTaskRepository();
    const { workflow, admissions } = createFixtureWorkflow();
    await waitingTask(tasks, "waiting");
    await waits.prepare({ waitId: "w1", taskId: "task-1", deadlineAt: "2099-01-01T00:00:00.000Z" });
    await waits.activate("w1");
    // The answer was recorded, and then the process died before the resume.
    expect(await waits.settle({ waitId: "w1", outcome: { kind: "answered", replyText: "yes" }, resume: true })).toBe(true);

    const first = await sweepExpiredWaits({ waits, tasks, workflow, now: () => "2026-01-01T00:10:00.000Z" });
    expect(first.recovered).toBe(1);
    expect(admissions).toEqual([
      // A recovered resume names its wait, but not who settled it: attribution is not its identity.
      expect.objectContaining({
        kind: "deadline",
        taskId: "task-1",
        operationKey: waitResumeOperationKey("w1"),
        resume: { waitOutcome: { kind: "answered", replyText: "yes" }, waitId: "w1" },
      }),
    ]);
    const second = await sweepExpiredWaits({ waits, tasks, workflow, now: () => "2026-01-01T00:11:00.000Z" });
    expect(second.recovered).toBe(0);
    expect(admissions).toHaveLength(1);
  });

  it("clears, without admitting, a pending resume that was already admitted or whose task finished", async () => {
    for (const [label, status, admittedAlready] of [
      ["admitted, flag not yet cleared", "waiting", true],
      ["task finished", "completed", false],
    ] as const) {
      const waits = createInMemoryAgentWaitRepository();
      const tasks = createInMemoryTaskRepository();
      const { workflow, admissions } = createFixtureWorkflow();
      await waitingTask(tasks, status);
      if (admittedAlready) {
        // The resume's own admission is on the task: the turn is running, or ran.
        await tasks.admit({
          prompt: fixturePromptPolicy,
          workspaceId: "ws1",
          principalId: "p1",
          operationKey: waitResumeOperationKey("w1"),
          kind: "deadline",
          taskId: "task-1",
          intent: null,
          checkpointNamespace: "",
          newTaskId: (() => "unused")(),
          newAdmissionId: (() => "adm-2")(),
          newThreadId: (() => "unused")(),
          now: (() => "2026-01-01T00:01:00.000Z")(),
        });
      }
      await waits.prepare({ waitId: "w1", taskId: "task-1", deadlineAt: "2099-01-01T00:00:00.000Z" });
      await waits.activate("w1");
      await waits.settle({ waitId: "w1", outcome: { kind: "answered", replyText: "yes" }, resume: true });
      const result = await sweepExpiredWaits({ waits, tasks, workflow, now: () => "2026-01-01T00:10:00.000Z" });
      expect(result.recovered, label).toBe(0);
      expect(admissions, label).toEqual([]);
      expect(await waits.listPendingResumes("9999"), label).toEqual([]);
    }
  });

  it("does not recover a resume settled inside the grace window", async () => {
    const waits = createInMemoryAgentWaitRepository({ now: () => "2026-01-01T00:09:50.000Z" });
    const tasks = createInMemoryTaskRepository();
    const { workflow, admissions } = createFixtureWorkflow();
    await waitingTask(tasks, "waiting");
    await waits.prepare({ waitId: "w1", taskId: "task-1", deadlineAt: "2099-01-01T00:00:00.000Z" });
    await waits.activate("w1");
    await waits.settle({ waitId: "w1", outcome: { kind: "answered", replyText: "yes" }, resume: true });
    // Ten seconds after the answer: its settler may still be admitting.
    const early = await sweepExpiredWaits({ waits, tasks, workflow, now: () => "2026-01-01T00:10:00.000Z" });
    expect(early.recovered).toBe(0);
    expect(admissions).toEqual([]);
    const late = await sweepExpiredWaits({ waits, tasks, workflow, now: () => "2026-01-01T00:10:30.000Z" });
    expect(late.recovered).toBe(1);
  });

  it("reports a resume that cannot be admitted and still recovers the others", async () => {
    const waits = createInMemoryAgentWaitRepository();
    const tasks = createInMemoryTaskRepository();
    const admissions: AdmitInput[] = [];
    const workflow = partialFake<WorkflowPort>({
      admit: async (input: AdmitInput) => {
        if (input.taskId === "task-1") throw new Error("not found");
        admissions.push(input);
        return {
          taskId: input.taskId ?? "",
          threadId: "t",
          outcome: { status: "completed", finalText: "" },
          created: false,
          replay: false,
        };
      },
    });
    for (const taskId of ["task-1", "task-2"]) {
      await tasks.admit({
        prompt: fixturePromptPolicy,
        workspaceId: "ws1",
        principalId: "p1",
        operationKey: `op-${taskId}`,
        kind: "start",
        intent: null,
        checkpointNamespace: "",
        newTaskId: (() => taskId)(),
        newAdmissionId: (() => `adm-${taskId}`)(),
        newThreadId: (() => `thread-${taskId}`)(),
        now: (() => "2026-01-01T00:00:00.000Z")(),
      });
      await tasks.updateStatus(taskId, "waiting", null);
      await waits.prepare({ waitId: `w-${taskId}`, taskId, deadlineAt: "2099-01-01T00:00:00.000Z" });
      await waits.activate(`w-${taskId}`);
      await waits.settle({ waitId: `w-${taskId}`, outcome: { kind: "answered", replyText: "yes" }, resume: true });
    }
    const result = await sweepExpiredWaits({ waits, tasks, workflow, now: () => "2026-01-01T00:10:00.000Z" });
    expect(result.failedResumes).toEqual(["w-task-1"]);
    expect(result.recovered).toBe(1);
    expect(admissions.map((admission) => admission.taskId)).toEqual(["task-2"]);
    expect((await waits.listPendingResumes("9999")).map((wait) => wait.waitId)).toEqual(["w-task-1"]);
  });

  it("marks the expiry sweep's own resume as admitted", async () => {
    const waits = createInMemoryAgentWaitRepository();
    const tasks = createInMemoryTaskRepository();
    const { workflow } = createFixtureWorkflow();
    await waitingTask(tasks, "waiting");
    await waits.prepare({ waitId: "w1", taskId: "task-1", deadlineAt: "2026-01-01T00:05:00.000Z" });
    await waits.activate("w1");
    await sweepExpiredWaits({ waits, tasks, workflow, now: () => "2026-01-01T00:10:00.000Z" });
    expect(await waits.listPendingResumes("9999")).toEqual([]);
  });
});

describe("startAgentWaitScheduler", () => {
  it("invokes sweepExpiredWaits on each tick and stops cleanly", async () => {
    const waits = createInMemoryAgentWaitRepository();
    const tasks = createInMemoryTaskRepository();
    const { workflow } = createFixtureWorkflow();

    let tickFn: (() => void) | undefined;
    let cleared = false;
    const handle = startAgentWaitScheduler({
      waits,
      tasks,
      workflow,
      intervalMs: 1000,
      setIntervalFn: (callback) => {
        tickFn = callback;
        return 1 as unknown as ReturnType<typeof setInterval>;
      },
      clearIntervalFn: () => {
        cleared = true;
      },
    });

    expect(tickFn).toBeDefined();
    // Drive one tick manually — no real timer involved.
    tickFn?.();
    await Promise.resolve();

    handle.stop();
    expect(cleared).toBe(true);

    // Stopping again is a documented no-op, not a second clear call.
    cleared = false;
    handle.stop();
    expect(cleared).toBe(false);
  });

  it("reports sweep failures via onError instead of throwing from the timer callback", async () => {
    const waits: AgentWaitRepositoryPort = {
      prepare: async () => {},
      activate: async () => {},
      get: async () => undefined,
      settle: async () => false,
      markResumed: async () => {},
      listPendingResumes: async () => [],
      listActivePastDeadline: () => {
        throw new Error("boom");
      },
      getActiveByCorrelation: async () => undefined,
      getActiveByTask: async () => undefined,
      getRecentlySettledByTask: async () => undefined,
      listActiveHandoffs: async () => [],
      listActiveConnects: async () => [],
    };
    const tasks = createInMemoryTaskRepository();
    const { workflow } = createFixtureWorkflow();

    let tickFn: (() => void) | undefined;
    const errors: unknown[] = [];
    const handle = startAgentWaitScheduler({
      waits,
      tasks,
      workflow,
      intervalMs: 1000,
      onError: (error) => errors.push(error),
      setIntervalFn: (callback) => {
        tickFn = callback;
        return 1 as unknown as ReturnType<typeof setInterval>;
      },
      clearIntervalFn: () => {},
    });

    expect(() => tickFn?.()).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
    expect(errors).toHaveLength(1);

    handle.stop();
  });

  it("reports every completed sweep's result via onSwept, including empty ones", async () => {
    const waits = createInMemoryAgentWaitRepository();
    const tasks = createInMemoryTaskRepository();
    const { workflow } = createFixtureWorkflow();

    let tickFn: (() => void) | undefined;
    const results: unknown[] = [];
    const handle = startAgentWaitScheduler({
      waits,
      tasks,
      workflow,
      intervalMs: 1000,
      onSwept: (result) => results.push(result),
      setIntervalFn: (callback) => {
        tickFn = callback;
        return 1 as unknown as ReturnType<typeof setInterval>;
      },
      clearIntervalFn: () => {},
    });

    tickFn?.();
    // The sweep is several awaits deep; a macrotask turn lets all of them run.
    await new Promise((resolve) => setImmediate(resolve));
    expect(results).toEqual([{ settled: 0, alreadySettled: 0, orphaned: [], recovered: 0, failedResumes: [] }]);

    handle.stop();
  });
});
