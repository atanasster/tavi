import { routineFixture, executionFixture } from "./routine-fixture.js";
import { expect, it, afterEach } from "vitest";
import { temporaryDirectories, delay } from "@tavi/test-support";
import { z } from "zod";
import {
  ROUTINE_CHECKPOINT_TASK_POLICY,
  RoutineCreateSchema,
  routineDefaults,
  waitResumeOperationKey,
  type ModelPort,
  type ModelRequest,
} from "@tavi/contracts";
import { errorMessage } from "@tavi/contracts/util";
import { AsyncCheckpointSaver } from "@tavi/agent-host/checkpoint";
import { join } from "node:path";
import { RoutineControlService, RoutineDeliveryService, RoutineNewsService, RoutinePublicationService, ToolRegistry } from "@tavi/runtime";
import { routineAction } from "../../src/features/routines/actions.js";
import type { WorkflowAdapterOptions } from "@tavi/agent-host/workflow";
import { SqliteStore } from "../support/database-fixture.js";
import { executeRoutineWorkflow, withRoutineCheckpoints, type RoutineCheckpointHost } from "../../src/features/routines/workflow.js";

const directories = temporaryDirectories();
afterEach(() => directories.cleanup());

/**
 * Human checkpoints: a routine whose revision
 * turned them on may ask its delivery destination one question — only with
 * options and a default, its deadline inside the run's budget — and the run
 * keeps its slot while it waits, then resumes its root on its own adapter.
 */

type Ask = Parameters<NonNullable<WorkflowAdapterOptions["askUser"]>>[0];

async function routine(
  question: Record<string, unknown>,
  hostOptions: { readonly defaultGraceMs?: number } = {},
  later: readonly Record<string, unknown>[] = [],
  failDelivery = false,
) {
  // The question each run asks: the first, then `later` in turn.
  let asks = 0;
  const nextQuestion = () => (asks++ === 0 ? question : (later[asks - 2] ?? question));
  // The run's own clock, which a test moves on to stand for a long wait.
  let offsetMs = 0;
  const now = () => new Date(Date.now() + offsetMs).toISOString();
  const directory = directories.create("routine-checkpoint-");
  const store = await SqliteStore.open({ databasePath: join(directory, "tavi.sqlite") });
  const scope = { workspaceId: "default", principalId: "operator" };
  const routines = await routineFixture(store, { executionAvailable: true, deliveryAuthorization: "available" });
  // Every write of the run — its routine state, tasks, waits and checkpoints —
  // goes through the routine service's one connection, as the owner's do: a
  // second writer on the same file fails a read-then-write transaction with
  // "database is locked" when the two interleave.
  const database = routines.store;
  const checkpointSaver = new AsyncCheckpointSaver(database.checkpoints);
  await routines.putTarget(scope, {
    ...scope,
    targetId: "chat",
    connectionId: "tg",
    chatId: "123",
    label: "Fixture chat",
    authorizationRef: "operator-destination-allowlist",
    enabled: true,
    createdAt: "2026-09-20T06:00:00.000Z",
  });
  const defaults = routineDefaults("Europe/Sofia");
  const created = await routines.create(
    scope,
    RoutineCreateSchema.parse({
      ...defaults,
      report: { ...defaults.report, formats: ["in-app", "pdf"] },
      delivery: { ...defaults.delivery, targetIds: ["chat"] },
      execution: { ...defaults.execution, humanCheckpoints: "ask-with-default" },
      operationKey: "create",
      name: "News",
      objective: "Find news",
      agent: { agentId: "news", name: "News", instructions: "Find evidence" },
      triggers: [{ id: "morning", kind: "daily", at: "09:00", timezone: "Europe/Sofia" }],
      skills: [],
      models: {
        research: { primary: { connectionId: "research", model: "r1" }, fallbacks: [] },
        synthesis: { primary: { connectionId: "summary", model: "s1" }, fallbacks: [] },
      },
      permissions: { revision: 1, researchTools: ["web_search"], allowedHosts: ["example.com"], networkMode: "allowlist" },
    }),
  );
  await routines.finishEvaluation(scope, created.routine.routineId, 1, true, "pass");
  const runs = await executionFixture(routines, { ownerEpoch: "owner", now });
  const run = await runs.request(scope, created.routine.routineId, "manual");
  const fence = (await runs.start(scope, run.runId))!;
  const tools = new ToolRegistry();
  tools.register({
    id: "web_search",
    sink: "search",
    version: "1.0.0",
    description: "Fixture search",
    effect: "read-only",
    requiredPermissions: [],
    inputSchema: z.strictObject({}),
    handler: async () => ({ url: "https://example.com/release" }),
  });
  const toolResults: string[] = [];
  let rootCalls = 0;
  // Each run's turn is read from its own transcript, so a second run asks again.
  const model: ModelPort = {
    async stream(request: ModelRequest) {
      const base = { attemptId: request.attemptId, usage: { totalTokens: 10 }, text: "", toolCalls: [], status: "completed" as const };
      const results = request.messages.filter((message) => message.role === "tool");
      if (request.connectionId !== "summary") {
        return results.length === 0
          ? { ...base, toolCalls: [{ id: "search", name: "web_search", input: {} }] }
          : { ...base, text: "WORKER_EVIDENCE" };
      }
      rootCalls++;
      if (results.length === 0)
        return {
          ...base,
          toolCalls: [
            { id: "spawn", name: "agents.spawn", input: { agentDefinitionId: "news", input: "Find evidence", operationKey: "research" } },
          ],
        };
      if (results.at(-1)?.toolName === "agents.spawn")
        return { ...base, toolCalls: [{ id: "ask", name: "operator.ask_user", input: nextQuestion() }] };
      toolResults.push(JSON.stringify(results.at(-1) ?? null));
      return { ...base, text: JSON.stringify({ stories: [] }) };
    },
  };
  const p = database.asPort().repositories;
  const asked: Ask[] = [];
  const host: RoutineCheckpointHost = { held: new Map(), pollMs: 20, ...hostOptions };
  const close = async () => {
    await store.close();
  };
  const execute = (thisRun: typeof run, thisFence: typeof fence) =>
    executeRoutineWorkflow(
      {
        checkpointSaver,
        models: model,
        tools,
        connectionId: "wrong",
        model: "wrong",
        ownerSession: "owner",
        access: { resolveWorkspace: () => ({ principalId: "operator" }), missingPermissions: () => [] },
        tasks: p.tasks,
        promptSettings: p.systemPrompts,
        executions: p.executions,
        effects: p.effects,
        approvals: p.approvals,
        cancellations: p.cancellations,
        receipts: p.receipts,
        askUser: async (input) => {
          asked.push(input);
          if (failDelivery) throw new Error("the chat is unreachable");
        },
      },
      runs,
      thisRun,
      thisFence,
      "Return a linked summary.",
      undefined,
      undefined,
      host,
    );
  const result = execute(run, fence);
  // How the first run ended, once it has: a run that ends before it asks fails `question$` at once, saying why.
  let ended: string | undefined;
  void result.then(
    (settled) => {
      ended = JSON.stringify(settled.outcome);
    },
    (error: unknown) => {
      ended = errorMessage(error);
    },
  );
  /** Another run of the same routine, once the first has ended. */
  const again = async (operationKey: string) => {
    const next = await runs.request(scope, created.routine.routineId, operationKey);
    return { run: next, result: execute(next, (await runs.start(scope, next.runId))!) };
  };
  // The owner's routine actions, as `serve` builds them.
  const control = new RoutineControlService({
    routines,
    runs,
    news: new RoutineNewsService(runs),
    publication: new RoutinePublicationService(runs),
    delivery: new RoutineDeliveryService(runs, {
      messaging: {
        buildDestination: (_connectionId, target) => ({ chatId: target.to }),
        send: async () => {
          throw new Error("no sends");
        },
      },
    }),
    defaultModels: () => undefined,
    allowedHosts: ["example.com"],
    wake: () => {},
  });
  /** The root's active question, once the run is holding on it. */
  const question$ = async () => {
    // By the clock, not by tries: each try reads the store, which is slow while every suite runs at once.
    const deadline = Date.now() + 25_000;
    while (Date.now() < deadline) {
      const taskId = (await runs.get(scope, run.runId)).taskId;
      const wait = taskId === null ? undefined : await p.agentWaits.getActiveByTask(taskId);
      // Active first, then delivered: held once the question is out.
      if (taskId !== null && wait !== undefined && host.held.has(taskId) && asked.length > 0) return { taskId, wait };
      if (ended !== undefined) throw new Error(`the run ended before it held a question: ${ended}`);
      await delay(10);
    }
    throw new Error("the run never held a question");
  };
  return {
    scope,
    runs,
    run,
    fence,
    repositories: p,
    asked,
    host,
    result,
    question$,
    toolResults,
    rootCalls: () => rootCalls,
    close,
    advance: (ms: number) => {
      offsetMs += ms;
    },
    again,
    control,
    routineId: created.routine.routineId,
    store,
  };
}

const SHIP = { question: "Ship the report today?", options: [{ label: "Ship" }, { label: "Hold" }], defaultOption: 2 };

it("asks the routine's own destination, holds the run inside its budget, and resumes its root on the routine's adapter", async () => {
  const f = await routine(SHIP);
  try {
    const { taskId, wait } = await f.question$();
    // Asked where the operator chose, under the routine's name — not a chat the model named.
    expect(f.asked).toHaveLength(1);
    expect(f.asked[0]).toMatchObject({
      question: "Ship the report today?",
      origin: "News",
      destination: { connectionId: "tg", chatId: "123" },
    });
    expect((await f.repositories.tasks.get(taskId))?.executionPolicy).toEqual(ROUTINE_CHECKPOINT_TASK_POLICY);
    // Its deadline leaves the run what it needs once answered.
    const run = await f.runs.get(f.scope, f.run.runId);
    expect(Date.parse(wait.deadlineAt)).toBeLessThanOrEqual(Date.parse(run.data.deadline) - (2 + 1 + 2) * 60_000);
    // The run is still running while it waits: it keeps its slot.
    expect(run.status).toBe("running");

    // A settler (a press, a web answer) settles it and hands the resume to the run that holds it.
    expect(
      await f.repositories.agentWaits.settle({
        waitId: wait.waitId,
        outcome: { kind: "answered", answers: ["Ship"] },
        resume: true,
        by: "operator",
        via: "telegram-main",
      }),
    ).toBe(true);
    const resumed = await f.host.held.get(taskId)!({
      context: { ...f.scope, runId: taskId, caller: "test" },
      operationKey: waitResumeOperationKey(wait.waitId),
      kind: "deadline",
      taskId,
      resume: { waitOutcome: { kind: "answered", answers: ["Ship"] }, waitId: wait.waitId },
    });
    expect(resumed.outcome.status).toBe("completed");
    const result = await f.result;
    expect(result.outcome.status).toBe("completed");
    // The routine's own synthesis model read the answer.
    expect(f.toolResults.at(-1)).toContain("Ship");
    // The run's timeline says what was asked and how it was settled.
    const ledger = (await routineAction(f.control, {
      ...f.scope,
      action: "ledger",
      routineId: f.routineId,
      runId: f.run.runId,
      limit: 200,
    })) as { events: { envelope: { code: string; checkpoint?: unknown } }[] };
    expect(
      ledger.events
        .filter((event) => event.envelope.code === "asked" || event.envelope.code === "answered")
        .map((event) => [event.envelope.code, event.envelope.checkpoint]),
    ).toEqual([
      ["asked", { question: "Ship the report today?" }],
      ["answered", { outcome: "answered", answers: ["Ship"] }],
    ]);
    // Nothing holds the task once the run is past its question.
    expect(f.host.held.has(taskId)).toBe(false);
  } finally {
    await f.close();
  }
});

it("resumes a settled question itself when no settler's resume came", async () => {
  const f = await routine(SHIP);
  try {
    const { wait } = await f.question$();
    // Settled — by the deadline sweep, say — with its resume never admitted.
    expect(
      await f.repositories.agentWaits.settle({
        waitId: wait.waitId,
        outcome: { kind: "wait-timeout", answers: ["Hold"] },
        resume: true,
        by: "policy",
        via: "policy",
      }),
    ).toBe(true);
    const result = await f.result;
    expect(result.outcome.status).toBe("completed");
    expect(f.toolResults.at(-1)).toContain("Hold");
  } finally {
    await f.close();
  }
});

it("refuses a checkpoint question without a default, and the run goes on without asking", async () => {
  const f = await routine({ question: "Ship the report today?", options: [{ label: "Ship" }, { label: "Hold" }] });
  try {
    const result = await f.result;
    expect(result.outcome.status).toBe("completed");
    expect(f.asked).toEqual([]);
    expect(f.toolResults.at(-1)).toContain("INVALID_INPUT");
    expect(await f.repositories.agentWaits.getActiveByTask(result.taskId)).toBeUndefined();
  } finally {
    await f.close();
  }
});

it("gives the resumed turn its whole step budget, however long the question waited", async () => {
  const f = await routine(SHIP);
  try {
    const { taskId, wait } = await f.question$();
    // Ten minutes pass: well past the two-minute synthesis budget, inside the run's deadline.
    f.advance(10 * 60_000);
    expect(
      await f.repositories.agentWaits.settle({
        waitId: wait.waitId,
        outcome: { kind: "answered", answers: ["Ship"] },
        resume: true,
        by: "operator",
        via: "telegram-main",
      }),
    ).toBe(true);
    const resumed = await f.host.held.get(taskId)!({
      context: { ...f.scope, runId: taskId, caller: "test" },
      operationKey: waitResumeOperationKey(wait.waitId),
      kind: "deadline",
      taskId,
      resume: { waitOutcome: { kind: "answered", answers: ["Ship"] }, waitId: wait.waitId },
    });
    expect(resumed.outcome.status).toBe("completed");
    {
      const outcome = (await f.result).outcome;
      expect(outcome.status, JSON.stringify(outcome)).toBe("completed");
    }
  } finally {
    await f.close();
  }
});

it("applies the default itself when the owner's sweep has not, a grace after the deadline", async () => {
  const f = await routine(SHIP, { defaultGraceMs: 0 });
  try {
    const { wait } = await f.question$();
    f.advance(Date.parse(wait.deadlineAt) - Date.now() + 1_000);
    const result = await f.result;
    expect(result.outcome.status, JSON.stringify(result.outcome)).toBe("completed");
    expect((await f.repositories.agentWaits.get(wait.waitId))?.settledOutcome).toMatchObject({ kind: "wait-timeout", answers: ["Hold"] });
    expect(f.toolResults.at(-1)).toContain("Hold");
    const ledger = (await routineAction(f.control, {
      ...f.scope,
      action: "ledger",
      routineId: f.routineId,
      runId: f.run.runId,
      limit: 200,
    })) as { events: { envelope: { code: string; checkpoint?: unknown } }[] };
    expect(ledger.events.find((event) => event.envelope.code === "answered")?.envelope.checkpoint).toEqual({
      outcome: "defaulted",
      answers: ["Hold"],
    });
    // A default nobody chose is not kept for next time.
    await expect(
      (async () =>
        await routineAction(f.control, {
          ...f.scope,
          action: "always_answer",
          routineId: f.routineId,
          waitId: wait.waitId,
          answers: ["Hold"],
        }))(),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  } finally {
    await f.close();
  }
});

it("hands a held root's resume to its run, refuses a routine root nobody holds, and passes everything else through", async () => {
  const passed: string[] = [];
  const workflow = {
    checkpoints: {} as never,
    admit: async (input: { readonly taskId?: string }) => {
      passed.push(input.taskId ?? "new");
      return { taskId: input.taskId ?? "new" } as never;
    },
  };
  const host: RoutineCheckpointHost = { held: new Map([["held", async () => ({ taskId: "held", forwarded: true }) as never]]) };
  const tasks = { get: (taskId: string) => ({ creationOperationKey: taskId === "orphan" ? "routine:run-1" : "chat:1" }) };
  const routed = withRoutineCheckpoints(workflow as never, host, tasks);
  const resume = (taskId: string) => ({
    context: { workspaceId: "default", principalId: "operator", runId: taskId, caller: "test" },
    operationKey: `wait:${taskId}`,
    kind: "deadline" as const,
    taskId,
    resume: { waitOutcome: { kind: "answered" as const }, waitId: "w" },
  });
  expect(await routed.admit(resume("held"))).toMatchObject({ forwarded: true });
  await expect(routed.admit(resume("orphan"))).rejects.toMatchObject({ code: "UNAVAILABLE" });
  expect(await routed.admit(resume("chat"))).toMatchObject({ taskId: "chat" });
  expect(passed).toEqual(["chat"]);
});

it("answers a question the operator already answered for this routine, without asking, until they forget it", async () => {
  const f = await routine(SHIP);
  try {
    const { taskId, wait } = await f.question$();
    expect(
      await f.repositories.agentWaits.settle({
        waitId: wait.waitId,
        outcome: { kind: "answered", answers: ["Ship"] },
        resume: true,
        by: "operator",
        via: "telegram-main",
      }),
    ).toBe(true);
    await f.host.held.get(taskId)!({
      context: { ...f.scope, runId: taskId, caller: "test" },
      operationKey: waitResumeOperationKey(wait.waitId),
      kind: "deadline",
      taskId,
      resume: { waitOutcome: { kind: "answered", answers: ["Ship"] }, waitId: wait.waitId },
    });
    {
      const outcome = (await f.result).outcome;
      expect(outcome.status, JSON.stringify(outcome)).toBe("completed");
    }
    await f.runs.finish(f.fence, "succeeded");

    // "Always answer Ship for this routine", from the question it asked; only one of its options.
    await expect(
      (async () =>
        await routineAction(f.control, {
          ...f.scope,
          action: "always_answer",
          routineId: f.routineId,
          waitId: wait.waitId,
          answers: ["Maybe"],
        }))(),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await routineAction(f.control, { ...f.scope, action: "always_answer", routineId: f.routineId, waitId: wait.waitId, answers: ["Ship"] });
    expect(await routineAction(f.control, { ...f.scope, action: "answers", routineId: f.routineId })).toMatchObject({
      answers: [{ questionKey: "ship the report today?", question: "Ship the report today?", answers: ["Ship"], createdBy: "operator" }],
    });

    // The next run asks the same: answered at once, nothing sent, and the history says how.
    const second = await f.again("manual-2");
    expect((await second.result).outcome.status).toBe("completed");
    expect(f.asked).toHaveLength(1);
    expect(f.toolResults.at(-1)).toContain("Ship");
    const secondTask = (await f.runs.get(f.scope, second.run.runId)).taskId!;
    expect(
      f.store.handle.prepare("SELECT state, settled_by, settled_via FROM tavi_agent_wait_intents WHERE task_id = ?").all(secondTask),
    ).toEqual([{ state: "settled", settled_by: "operator", settled_via: "standing-answer" }]);

    // Each run lists its questions with how they were settled.
    expect(await routineAction(f.control, { ...f.scope, action: "checkpoints", routineId: f.routineId, runId: f.run.runId })).toMatchObject(
      {
        checkpoints: [
          {
            waitId: wait.waitId,
            question: "Ship the report today?",
            options: ["Ship", "Hold"],
            state: "answered",
            answers: ["Ship"],
            by: "operator",
            via: "telegram-main",
          },
        ],
      },
    );
    const secondLedger = (await routineAction(f.control, {
      ...f.scope,
      action: "ledger",
      routineId: f.routineId,
      runId: second.run.runId,
      limit: 200,
    })) as { events: { envelope: { code: string; checkpoint?: unknown } }[] };
    expect(
      secondLedger.events
        .filter((event) => event.envelope.code === "asked" || event.envelope.code === "answered")
        .map((event) => event.envelope.checkpoint),
    ).toEqual([{ question: "Ship the report today?", outcome: "answered", answers: ["Ship"], via: "standing-answer" }]);
    // Named, though it was never asked: the row keeps its question.
    expect(
      await routineAction(f.control, { ...f.scope, action: "checkpoints", routineId: f.routineId, runId: second.run.runId }),
    ).toMatchObject({
      checkpoints: [{ question: "Ship the report today?", state: "answered", answers: ["Ship"], via: "standing-answer" }],
    });
    // A standing answer is not itself kept again, and another person's scope finds nothing.
    const standingWait = f.store.handle.prepare("SELECT wait_id FROM tavi_agent_wait_intents WHERE task_id = ?").get(secondTask) as {
      wait_id: string;
    };
    await expect(
      (async () =>
        await routineAction(f.control, {
          ...f.scope,
          action: "always_answer",
          routineId: f.routineId,
          waitId: standingWait.wait_id,
          answers: ["Ship"],
        }))(),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      (async () =>
        await routineAction(f.control, {
          workspaceId: "default",
          principalId: "other",
          action: "always_answer",
          routineId: f.routineId,
          waitId: wait.waitId,
          answers: ["Ship"],
        }))(),
    ).rejects.toThrow();
    await expect(
      (async () => await routineAction(f.control, { ...f.scope, action: "checkpoints", routineId: "routine-other", runId: f.run.runId }))(),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(
      await routineAction(f.control, {
        ...f.scope,
        action: "forget_answer",
        routineId: f.routineId,
        questionKey: "ship the report today?",
      }),
    ).toEqual({ removed: true });
    expect(await routineAction(f.control, { ...f.scope, action: "answers", routineId: f.routineId })).toEqual({ answers: [] });
  } finally {
    await f.close();
  }
});

it("asks again when the kept answer is no longer among the question's options", async () => {
  const f = await routine(SHIP, {}, [
    { question: "Ship the report today?", options: [{ label: "Send" }, { label: "Hold" }], defaultOption: 2 },
  ]);
  try {
    const { taskId, wait } = await f.question$();
    expect(
      await f.repositories.agentWaits.settle({
        waitId: wait.waitId,
        outcome: { kind: "answered", answers: ["Ship"] },
        resume: true,
        by: "operator",
        via: "telegram-main",
      }),
    ).toBe(true);
    await f.host.held.get(taskId)!({
      context: { ...f.scope, runId: taskId, caller: "test" },
      operationKey: waitResumeOperationKey(wait.waitId),
      kind: "deadline",
      taskId,
      resume: { waitOutcome: { kind: "answered", answers: ["Ship"] }, waitId: wait.waitId },
    });
    await f.result;
    await f.runs.finish(f.fence, "succeeded");
    await routineAction(f.control, { ...f.scope, action: "always_answer", routineId: f.routineId, waitId: wait.waitId, answers: ["Ship"] });
    // The same question now offers Send, not Ship: the kept answer does not apply, so it is asked.
    const second = await f.again("manual-2");
    for (let tries = 0; tries < 1500 && f.asked.length < 2; tries++) await delay(10);
    expect(f.asked).toHaveLength(2);
    expect(f.asked[1]?.choices?.options.map((option) => option.label)).toEqual(["Send", "Hold"]);
    // Answered as any question is, and the run finishes.
    const secondTask = (await f.runs.get(f.scope, second.run.runId)).taskId!;
    const secondWait = (await f.repositories.agentWaits.getActiveByTask(secondTask))!;
    expect(
      await f.repositories.agentWaits.settle({
        waitId: secondWait.waitId,
        outcome: { kind: "answered", answers: ["Send"] },
        resume: true,
        by: "operator",
        via: "telegram-main",
      }),
    ).toBe(true);
    await f.host.held.get(secondTask)!({
      context: { ...f.scope, runId: secondTask, caller: "test" },
      operationKey: waitResumeOperationKey(secondWait.waitId),
      kind: "deadline",
      taskId: secondTask,
      resume: { waitOutcome: { kind: "answered", answers: ["Send"] }, waitId: secondWait.waitId },
    });
    expect((await second.result).outcome.status).toBe("completed");
  } finally {
    await f.close();
  }
});

it("records a question that could not be sent, and the run goes on without asking", async () => {
  const f = await routine(SHIP, {}, [], true);
  try {
    {
      const outcome = (await f.result).outcome;
      expect(outcome.status, JSON.stringify(outcome)).toBe("completed");
    }
    expect(f.toolResults.at(-1)).toContain("the chat is unreachable");
    const ledger = (await routineAction(f.control, {
      ...f.scope,
      action: "ledger",
      routineId: f.routineId,
      runId: f.run.runId,
      limit: 200,
    })) as { events: { envelope: { code: string; checkpoint?: unknown } }[] };
    expect(
      ledger.events
        .filter((event) => event.envelope.code === "asked" || event.envelope.code === "answered")
        .map((event) => [event.envelope.code, event.envelope.checkpoint]),
    ).toEqual([
      ["asked", { question: "Ship the report today?" }],
      ["answered", { outcome: "undelivered" }],
    ]);
  } finally {
    await f.close();
  }
});
