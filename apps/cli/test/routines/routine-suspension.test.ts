import { routineFixture, executionFixture } from "./routine-fixture.js";
import { expect, it, afterEach } from "vitest";
import { temporaryDirectories } from "@tavi/test-support";
import { z } from "zod";
import { ROUTINE_TASK_POLICY, RoutineCreateSchema, routineDefaults, type ModelPort, type ModelRequest } from "@tavi/contracts";
import { AsyncCheckpointSaver } from "@tavi/agent-host/checkpoint";
import { join } from "node:path";
import { ToolRegistry } from "@tavi/runtime";
import { SqliteStore } from "../support/database-fixture.js";
import { executeRoutineWorkflow } from "../../src/features/routines/workflow.js";

const directories = temporaryDirectories();
afterEach(() => directories.cleanup());

/**
 * What happens when a routine run suspends.
 *
 * The plan's first deliverable for this step was a probe: drive the real
 * composed workflow with a scripted model and record what actually happens,
 * because the code path had only been read, never run. The recorded probe
 * results (2026-09-21) were:
 *
 * 1. A routine **root** that calls `agents.wait` reached `waiting`: the run's
 *    durable task sat `waiting` with an active wait row, and nothing in the
 *    routine loop, the chat tools or the IPC surface could settle it. The
 *    scheduler's own suspension resolver never runs for a routine-owned
 *    schedule (`routineDispatch` returns before it).
 * 2. A routine **worker** that calls `agents.wait` did *not* suspend: the
 *    research adapter is built without an `agents` port, so the call failed as
 *    a bounded tool error and the worker carried on.
 * 3. A **researcher that fails** already produced a typed
 *    `RESEARCH_UNAVAILABLE` run outcome.
 *
 * So the decided behaviour is structural refusal rather than an answer: a
 * routine task runs under `ROUTINE_TASK_POLICY`, whose `workerWaitsAllowed:
 * false` refuses `agents.wait` before any wait row exists, and
 * `RoutineExecutionService` settles any active wait on every terminal *and*
 * interrupt transition so a run can never sit over a `waiting` task.
 *
 * What this suite covers, stated precisely: it asserts the **end state** of both
 * layers (run terminal or completed, no `waiting` task, no active wait row), it
 * asserts the **refusal event** the adapter emits through an observer, and it
 * exercises the worker cases through tool availability — the research adapter is
 * built without an `agents` port, so a worker's call is answered `UNKNOWN_TOOL`
 * before the policy branch is consulted, which is why the worker cases pin
 * inheritance rather than the worker-level flags. The root-level cases are the
 * ones that reach the policy itself.
 */
const WAIT = { deadlineAt: "2099-09-20T07:00:00.000Z" };
type Mode = "root-wait" | "root-asks" | "worker-wait" | "worker-asks" | "worker-fails";

async function routine(mode: Mode) {
  const directory = directories.create("routine-suspend-");
  const store = await SqliteStore.open({ databasePath: join(directory, "tavi.sqlite") });
  const scope = { workspaceId: "default", principalId: "operator" };
  let rootCalls = 0;
  let childCalls = 0;
  let effects = 0;
  const routines = await routineFixture(store, { executionAvailable: true });
  // Every write of the run goes through the routine service's one connection,
  // as the owner's do: a second writer on the same file fails a read-then-write
  // transaction with "database is locked" when the two interleave.
  const database = routines.store;
  const checkpointSaver = new AsyncCheckpointSaver(database.checkpoints);
  const created = await routines.create(
    scope,
    RoutineCreateSchema.parse({
      ...routineDefaults("Europe/Sofia"),
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
  await routines.finishEvaluation(scope, (await created).routine.routineId, 1, true, "pass");
  const runs = await executionFixture(routines, { ownerEpoch: "owner" });
  const run = await runs.request(scope, (await created).routine.routineId, "manual");
  const fence = (await runs.start(scope, (await run).runId))!;
  const tools = new ToolRegistry();
  tools.register({
    id: "web_search",
    sink: "search",
    version: "1.0.0",
    description: "Fixture search",
    effect: "read-only",
    requiredPermissions: [],
    inputSchema: z.strictObject({}),
    handler: async () => {
      effects++;
      return { url: "https://example.com/release" };
    },
  });
  const model: ModelPort = {
    async stream(request: ModelRequest) {
      const base = { attemptId: request.attemptId, usage: { totalTokens: 10 }, text: "", toolCalls: [], status: "completed" as const };
      if (request.connectionId !== "summary") {
        childCalls++;
        if (childCalls === 1 && mode === "worker-fails")
          return { ...base, status: "failed", error: { code: "auth", message: "Fixture missing auth", retryable: false } };
        if (childCalls === 1) return { ...base, toolCalls: [{ id: "search", name: "web_search", input: {} }] };
        if (childCalls === 2 && mode === "worker-wait") return { ...base, toolCalls: [{ id: "wait", name: "agents.wait", input: WAIT }] };
        if (childCalls === 2 && mode === "worker-asks")
          return {
            ...base,
            toolCalls: [
              { id: "ask", name: "operator.ask_user", input: { question: "Which model?", deadlineAt: "2099-01-01T00:00:00.000Z" } },
            ],
          };
        return { ...base, text: "WORKER_EVIDENCE" };
      }
      rootCalls++;
      if (rootCalls === 1)
        return {
          ...base,
          toolCalls: [
            { id: "spawn", name: "agents.spawn", input: { agentDefinitionId: "news", input: "Find evidence", operationKey: "research" } },
          ],
        };
      if (rootCalls === 2 && mode === "root-wait") return { ...base, toolCalls: [{ id: "wait", name: "agents.wait", input: WAIT }] };
      if (rootCalls === 2 && mode === "root-asks")
        return {
          ...base,
          toolCalls: [
            { id: "ask", name: "operator.ask_user", input: { question: "Which model?", deadlineAt: "2099-01-01T00:00:00.000Z" } },
          ],
        };
      return { ...base, text: JSON.stringify({ stories: [] }) };
    },
  };
  const p = database.asPort().repositories;
  const events: { toolName: string; phase: string; message?: string }[] = [];
  const close = async () => {
    await store.close();
  };
  let result: Awaited<ReturnType<typeof executeRoutineWorkflow>>;
  try {
    result = await executeRoutineWorkflow(
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
      },
      runs,
      run,
      fence,
      "Return a linked summary.",
      undefined,
      {
        onToolEvent: (event) => {
          events.push(event);
        },
      },
    );
  } catch (error) {
    close();
    throw error;
  }
  const delegation = await p.agentDelegations.getByOperationKey(
    scope.workspaceId,
    scope.principalId,
    `${(await run).data.operationKey}:research`,
  );
  return {
    scope,
    store,
    runs,
    run,
    fence,
    result,
    repositories: p,
    effects,
    events,
    childCalls: () => childCalls,
    rootTask: async () => await p.tasks.get(result.taskId),
    workerTask: async () => (delegation === undefined ? undefined : await p.tasks.get(delegation.workerTaskId)),
    close,
  };
}

it("refuses a routine root agents.wait with a bounded typed result and no wait row", async () => {
  const f = await routine("root-wait");
  try {
    expect((await f.rootTask())?.executionPolicy).toEqual(ROUTINE_TASK_POLICY);
    expect(f.result.outcome.status).toBe("completed");
    expect((await f.rootTask())?.status).not.toBe("waiting");
    expect(await f.repositories.agentWaits.getActiveByTask(f.result.taskId)).toBeUndefined();
    // The refusal itself is the observable the claim rests on: the adapter emits
    // a `failed` tool event for the refused `agents.wait`, which is what an
    // attached client renders.
    expect(f.events.some((event) => event.toolName === "agents.wait" && event.phase === "failed")).toBe(true);
  } finally {
    f.close();
  }
});

it("refuses a routine root ask_user at the orchestration grant, with nothing suspended", async () => {
  const f = await routine("root-asks");
  try {
    // `operator.ask_user` is not part of a routine's orchestration grant, so the
    // model port refuses it before the adapter's own `humanQuestionsAllowed`
    // branch is reached — a stronger refusal than a policy-level one, and the
    // reason this case is pinned here rather than assumed to exercise the flag.
    expect(f.result.outcome).toMatchObject({ status: "failed", error: { code: "NOT_AUTHORIZED" } });
    expect((await f.rootTask())?.status).not.toBe("waiting");
    expect(await f.repositories.agentWaits.getActiveByTask(f.result.taskId)).toBeUndefined();
    expect(f.events.some((event) => event.toolName === "operator.ask_user")).toBe(false);
  } finally {
    f.close();
  }
});

it("inherits the routine policy on the worker and refuses its wait through tool availability", async () => {
  const f = await routine("worker-wait");
  try {
    // A worker's call is answered `UNKNOWN_TOOL` because the research adapter is
    // built without an `agents` port, so this case pins policy *inheritance* and
    // the end state -- not the worker-level `workerWaitsAllowed` flag, which this
    // surface never consults.
    expect((await f.workerTask())?.executionPolicy).toEqual(ROUTINE_TASK_POLICY);
    expect(f.result.outcome.status).toBe("completed");
    expect((await f.workerTask())?.status).not.toBe("waiting");
    expect(f.effects).toBe(1);
  } finally {
    f.close();
  }
});

it("fails a run whose required researcher never completes, with a typed reason", async () => {
  const f = await routine("worker-fails");
  try {
    expect(f.result.outcome).toMatchObject({ status: "failed", error: { code: "RESEARCH_UNAVAILABLE" } });
    expect((await f.workerTask())?.status).toBe("failed");
    expect((await f.rootTask())?.status).not.toBe("waiting");
  } finally {
    f.close();
  }
});

it("settles a wait an older checkpoint left active before the run terminates", async () => {
  const f = await routine("root-wait");
  try {
    // Reproduce the pre-C2 state directly: a suspended root with an active wait
    // and a `waiting` task row. `finish` must not leave either behind.
    const taskId = f.result.taskId;
    // The legacy shape that matters most: a task row whose *persisted* policy
    // still allows waits (the migration backfills every non-attended origin with
    // `UNATTENDED_TASK_POLICY`), so only the backstop refuses it.
    f.store.handle
      .prepare("UPDATE tavi_tasks SET execution_policy_json=? WHERE task_id=?")
      .run(JSON.stringify({ mode: "unattended", humanQuestionsAllowed: false, workerWaitsAllowed: true }), taskId);
    await f.repositories.agentWaits.prepare({ waitId: "stale-wait", taskId, deadlineAt: "2099-01-01T00:00:00.000Z" });
    await f.repositories.agentWaits.activate("stale-wait");
    await f.repositories.tasks.updateStatus(taskId, "waiting", null);
    await f.runs.finish(f.fence, "failed");
    expect(await f.repositories.agentWaits.getActiveByTask(taskId)).toBeUndefined();
    expect((await f.repositories.tasks.get(taskId))?.status).not.toBe("waiting");
    expect((await f.runs.get(f.scope, (await f.run).runId)).status).toBe("failed");
  } finally {
    f.close();
  }
});

it("closes an approval round a run raised when the run terminates", async () => {
  const f = await routine("root-wait");
  try {
    const taskId = f.result.taskId;
    // The state an `ask` rule or a critical call leaves: a pending approval row
    // and an announced round, with the task suspended on it.
    await f.repositories.approvals.request({
      approvalId: "routine-approval",
      taskId,
      admissionId: "adm-routine",
      toolId: "web_search",
      callId: "c1",
      steps: 2,
      inputs: {},
      now: { fixed: "2026-09-20T07:00:00.000Z" },
    });
    await f.repositories.approvalRounds.create({
      taskId,
      steps: 2,
      token: "abcdefgh",
      workspaceId: f.scope.workspaceId,
      createdAt: "2026-09-20T07:00:00.000Z",
    });
    await f.repositories.tasks.updateStatus(taskId, "waiting", null);
    await f.runs.finish(f.fence, "failed");
    expect((await f.repositories.approvals.listForTask(taskId)).map((row) => row.state)).toEqual(["cancelled"]);
    expect((await f.repositories.approvalRounds.get(taskId, 2))?.settledAt).toBeDefined();
    expect(await f.repositories.approvalRounds.listEvents(taskId, 2)).toEqual([
      expect.objectContaining({ kind: "settled", via: "policy", detail: expect.objectContaining({ reason: "run-ended" }) }),
    ]);
    expect((await f.repositories.tasks.get(taskId))?.status).not.toBe("waiting");
  } finally {
    f.close();
  }
});

it("settles a suspended task when the run is cancelled", async () => {
  const f = await routine("root-wait");
  try {
    const taskId = f.result.taskId;
    await f.repositories.agentWaits.prepare({ waitId: "cancel-wait", taskId, deadlineAt: "2099-01-01T00:00:00.000Z" });
    await f.repositories.agentWaits.activate("cancel-wait");
    await f.repositories.tasks.updateStatus(taskId, "waiting", null);
    await f.runs.cancel(f.scope, (await f.run).runId);
    expect(await f.repositories.agentWaits.getActiveByTask(taskId)).toBeUndefined();
    expect((await f.repositories.tasks.get(taskId))?.status).not.toBe("waiting");
    expect((await f.runs.get(f.scope, (await f.run).runId)).status).toBe("cancelled");
  } finally {
    f.close();
  }
});

it("keeps a worker question out of durable state through tool availability", async () => {
  const f = await routine("worker-asks");
  try {
    // Same limitation as the wait case: the worker's adapter has no `agents`
    // port, so no question is delivered and no wait row exists (design 7.8).
    expect((await f.workerTask())?.executionPolicy).toEqual(ROUTINE_TASK_POLICY);
    expect(f.result.outcome.status).toBe("completed");
    const worker = await f.workerTask();
    expect(worker).toBeDefined();
    if (worker === undefined) throw new Error("Worker task missing");
    expect((await worker)?.status).not.toBe("waiting");
    expect(await f.repositories.agentWaits.getActiveByTask((await worker!).taskId)).toBeUndefined();
    expect(f.effects).toBe(1);
  } finally {
    f.close();
  }
});

it("settles a suspended task when a replacement owner recovers an interrupted run", async () => {
  const f = await routine("root-wait");
  try {
    const taskId = f.result.taskId;
    await f.repositories.agentWaits.prepare({ waitId: "recovery-wait", taskId, deadlineAt: "2099-01-01T00:00:00.000Z" });
    await f.repositories.agentWaits.activate("recovery-wait");
    await f.repositories.tasks.updateStatus(taskId, "waiting", null);
    // The run is still `running` under the crashed owner; a replacement owner
    // recovers it. `interrupted` is live rather than terminal, so without the
    // settle here the `waiting` task would survive until the next drain.
    const restarted = await executionFixture(f.runs.routines, { ownerEpoch: "replacement" });
    expect(await restarted.recoverPreviousOwner()).toBe(1);
    expect(await f.repositories.agentWaits.getActiveByTask(taskId)).toBeUndefined();
    expect((await f.repositories.tasks.get(taskId))?.status).not.toBe("waiting");
    expect((await restarted.get(f.scope, (await f.run).runId)).status).toBe("interrupted");
  } finally {
    f.close();
  }
});
