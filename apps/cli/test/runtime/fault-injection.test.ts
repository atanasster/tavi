import { z } from "zod";

import type { ModelEvent, ModelOutcome, ModelPort, ModelRequest } from "@tavi/contracts";
import { nowTimestamp } from "@tavi/contracts/util";
import { temporaryDirectories } from "@tavi/test-support";
import { afterEach, describe, expect, it } from "vitest";

import { composeTaviRuntime } from "../../src/runtime/composition.js";
import type { TaviRuntime } from "../../src/runtime/types.js";
import { fixtureRuntimeOptions } from "../support/serve-fixture.js";

/**
 * Fault-injection gates.
 *
 * Each test drives the *real* durable stack — SQLite, the pinned saver, the
 * execution ledger, the effect ledger, the approval records — and interrupts it at
 * a named point.
 *
 * A crash is modelled by its *durable consequence* plus a restart: the runtime is
 * closed (which releases the kernel's advisory locks, as process death does) and a
 * new runtime is composed over the same data directory. Interrupting in-flight
 * work is modelled by making the model call throw, which is what a process dying
 * mid-call looks like from the durable side.
 *
 * Assertions cover three durability properties: no overlapping writers, no
 * reprocessing of checkpointed input, and no repeated known-completed effect.
 */

const workspaces = [
  {
    workspaceId: "default",
    principalId: "operator",
    permissions: ["tools.invoke", "models.invoke", "runs.create"],
  },
] as const;

const context = { workspaceId: "default", principalId: "operator", runId: "r", caller: "test" };

const directories = temporaryDirectories({ prefix: "tavi-fault-" });

/** Set by the mid-invocation termination test so a handler can reach its runtime. */
let firstRuntimeRef: Harness | undefined;

afterEach(() => directories.cleanup());

interface Harness {
  readonly runtime: TaviRuntime;
  readonly modelCalls: () => number;
  readonly toolCalls: () => number;
  /**
   * End this runtime's ownership, as process death would.
   *
   * The kernel releases advisory locks when the owner dies while every durable row
   * survives, so closing and then recomposing over the same directory is the
   * faithful in-process model of "the process is gone, the state is not".
   */
  readonly close: () => Promise<unknown>;
}

/** Compose a runtime over a data directory with scripted model and tool behaviour. */
async function harness(
  directory: string,
  behaviour: {
    readonly turns?: readonly { readonly text: string }[];
    readonly onToolCall?: () => Promise<unknown>;
    readonly crashDuringModelCall?: boolean;
    /** Register a mutating tool, so the effect ledger is exercised. */
    readonly mutatingTool?: boolean;
  } = {},
): Promise<Harness> {
  let modelCalls = 0;
  let toolCalls = 0;
  let turn = 0;

  const model: ModelPort = {
    async stream(
      request: ModelRequest,
      options: { readonly signal: AbortSignal; readonly onEvent: (event: ModelEvent) => void },
    ): Promise<ModelOutcome> {
      modelCalls += 1;
      if (behaviour.crashDuringModelCall === true) {
        // The process dies mid-call: no outcome is returned and nothing is
        // committed for this admission.
        throw new Error("CRASH: simulated process death during the model call");
      }
      turn += 1;
      const scripted = behaviour.turns ?? [];
      if (turn === 1 && (behaviour.onToolCall !== undefined || behaviour.mutatingTool === true)) {
        return {
          status: "completed",
          attemptId: request.attemptId,
          text: "",
          toolCalls: [
            behaviour.mutatingTool === true
              ? { id: "call-1", name: "fixture.write", input: { value: "ping" } }
              : { id: "call-1", name: "fixture.echo", input: { message: "ping" } },
          ],
          usage: {},
        };
      }
      const text = scripted[turn - 1]?.text ?? "done";
      options.onEvent({ type: "text.delta", attemptId: request.attemptId, blockId: "b", text });
      return { status: "completed", attemptId: request.attemptId, text, toolCalls: [], usage: {} };
    },
  };

  const runtime = await composeTaviRuntime(
    fixtureRuntimeOptions(directory, {
      workspaces: [...workspaces],
      // The scripted model calls `fixture.echo`, which is off the production
      // tool surface by default.
      devFixtureTools: true,
      // A mutating fixture is auto-approved so the effect ledger, not the
      // approval gate, is what these tests exercise.
      approvalRequiredFor: [],
    }),
    { modelOverride: model },
  );

  if (behaviour.mutatingTool === true) {
    runtime.tools.register({
      id: "fixture.write",
      sink: "none",
      version: "1.0.0",
      description: "A mutating fixture effect",
      effect: "mutating",
      requiredPermissions: ["tools.invoke"],
      inputSchema: z.object({ value: z.string() }),
      handler: async () => ({ wrote: true }),
    });
  }

  // Wrap the tools so the test can count and interrupt real dispatches.
  const originalGet = runtime.tools.get.bind(runtime.tools);
  (runtime.tools as unknown as { get: typeof originalGet }).get = (id: string) => {
    const tool = originalGet(id);
    if (tool === undefined) return undefined;
    return {
      ...tool,
      handler: async (input: Parameters<typeof tool.handler>[0]) => {
        toolCalls += 1;
        if (behaviour.onToolCall !== undefined) return behaviour.onToolCall();
        return tool.handler(input);
      },
    };
  };

  return {
    runtime,
    modelCalls: () => modelCalls,
    toolCalls: () => toolCalls,
    close: () => runtime.close(),
  };
}

const workflowOf = (runtime: TaviRuntime) => {
  if (runtime.workflow === undefined) throw new Error("workflow unavailable");
  return runtime.workflow;
};

describe("fault injection: crash after the admission commit", () => {
  it("resolves the same task and does not reprocess checkpointed input", async () => {
    const directory = directories.create();
    const first = await harness(directory, { turns: [{ text: "first answer" }] });
    const admitted = await workflowOf(first.runtime).admit({
      context,
      operationKey: "op-crash-admit",
      kind: "start",
      prompt: "hello",
    });
    expect(admitted.outcome.status).toBe("completed");
    expect(first.modelCalls()).toBe(1);
    await first.close();

    // Restart over the same directory and retry the identical request.
    const second = await harness(directory, { turns: [{ text: "second answer" }] });
    const replay = await workflowOf(second.runtime).admit({
      context,
      operationKey: "op-crash-admit",
      kind: "start",
      prompt: "hello",
    });
    expect(replay.taskId).toBe(admitted.taskId);
    expect(replay.replay).toBe(true);
    // No overlap and no reprocessing: the stored outcome is returned as-is.
    expect(second.modelCalls()).toBe(0);
    expect(replay.outcome.finalText).toBe("first answer");
    await second.close();
  });
});

describe("fault injection: crash after the execution claim", () => {
  it("refuses to overlap the dead invocation and recovers only with confirmation", async () => {
    const directory = directories.create();
    // Seed the durable state a process killed mid-invocation leaves behind: a
    // task, and an execution slot still marked active with no release.
    const seeded = await harness(directory, { turns: [{ text: "unused" }] });
    const admitted = await workflowOf(seeded.runtime).admit({
      context,
      operationKey: "op-crash-claim",
      kind: "start",
      prompt: "hi",
    });
    const executionsBefore = seeded.runtime.store.asPort().repositories.executions;
    await executionsBefore.acquire({
      taskId: admitted.taskId,
      ownerSession: "process-that-died",
      admissionId: "admission-that-died",
      // A short lease that has already expired by the time the new owner starts.
      leaseMs: 1,
      now: { fixed: (() => "2020-01-01T00:00:00.000Z")() },
    });
    await seeded.close();

    const second = await harness(directory, { turns: [{ text: "after recovery" }] });
    const executions = second.runtime.store.asPort().repositories.executions;
    const task = (await second.runtime.store.listTasks(10))[0];
    expect(task).toBeDefined();
    const held = await executions.current(task?.taskId ?? "");
    expect(held?.state).toBe("active");

    // A replacement is refused: an expired lease is not permission to overlap.
    await expect(
      workflowOf(second.runtime).admit({
        context,
        taskId: task?.taskId ?? "",
        operationKey: "op-crash-claim-retry",
        kind: "reply",
      }),
    ).rejects.toThrowError(/expired execution lease|already executing/);

    // Only an explicit, evidenced termination admits a replacement generation.
    await executions.terminate({
      taskId: task?.taskId ?? "",
      generation: held?.generation ?? 1,
      confirmedTerminated: true,
      reason: "process confirmed dead",
      terminatedBy: "test-operator",
      now: { fixed: (() => nowTimestamp())() },
    });
    const replacement = await workflowOf(second.runtime).admit({
      context,
      taskId: task?.taskId ?? "",
      operationKey: "op-crash-claim-retry",
      kind: "reply",
    });
    expect(replacement.outcome.status).toBe("completed");
    await second.close();
  });
});

describe("fault injection: an in-flight model failure", () => {
  it("records a failed admission and replays it instead of re-running the call", async () => {
    const directory = directories.create();
    const first = await harness(directory, { crashDuringModelCall: true });
    const failed = await workflowOf(first.runtime).admit({
      context,
      operationKey: "op-inflight",
      kind: "start",
      prompt: "hi",
    });

    // The transport failure is recorded as a terminal outcome rather than left
    // uncommitted, so the failure is durable and the run does not claim success.
    expect(failed.outcome.status).toBe("failed");
    const taskId = failed.taskId;
    await first.close();

    const second = await harness(directory, { turns: [{ text: "after restart" }] });
    const retry = await workflowOf(second.runtime).admit({
      context,
      operationKey: "op-inflight",
      kind: "start",
      prompt: "hi",
    });

    // The retry resolves the same task and replays the recorded failure. Retrying
    // is a *new* operation key, which is deliberate: a retry must not silently
    // repeat work whose effects may already exist.
    expect(retry.taskId).toBe(taskId);
    expect(retry.replay).toBe(true);
    expect(retry.outcome.status).toBe("failed");
    expect(second.modelCalls()).toBe(0);
    await second.close();
  });

  it("leaves a killed process's admission uncommitted, so a retry re-runs it", async () => {
    const directory = directories.create();
    // A genuine process death does not run a catch block, so the durable state it
    // leaves is an admission with no outcome. This is that state.
    const seeded = await harness(directory, { turns: [{ text: "unused" }] });
    const admitted = await workflowOf(seeded.runtime).admit({
      context,
      operationKey: "op-killed",
      kind: "start",
      prompt: "hi",
    });
    const repositories = seeded.runtime.store.asPort().repositories;
    // Clear the outcome, exactly as a death before the commit would leave it.
    const record = await repositories.tasks.getAdmission(admitted.taskId, "op-killed");
    if (record !== null && record !== undefined) {
      await repositories.tasks.setAdmissionResult(record.admissionId, null);
    }
    await seeded.close();

    const second = await harness(directory, { turns: [{ text: "re-ran" }] });
    const retry = await workflowOf(second.runtime).admit({
      context,
      taskId: admitted.taskId,
      operationKey: "op-killed-2",
      kind: "reply",
    });
    // The work legitimately re-runs because nothing recorded completion, and the
    // same task and thread are reused rather than replaced.
    expect(retry.taskId).toBe(admitted.taskId);
    expect(retry.outcome.finalText).toBe("re-ran");
    await second.close();
  });
});

describe("fault injection: crash around an external effect", () => {
  it("keeps a completed effect and its receipt across a crash", async () => {
    const directory = directories.create();
    const first = await harness(directory, {
      mutatingTool: true,
      onToolCall: async () => ({ echoed: "first" }),
    });
    const admitted = await workflowOf(first.runtime).admit({
      context,
      operationKey: "op-effect-after",
      kind: "start",
      prompt: "hi",
    });
    expect(first.toolCalls()).toBe(1);
    await first.close();

    const second = await harness(directory, {
      mutatingTool: true,
      onToolCall: async () => ({ echoed: "second" }),
    });
    const effects = second.runtime.store.asPort().repositories.effects;
    const recorded = await effects.listForTask(admitted.taskId);

    // The intent was durable before the handler ran and the receipt after, so a
    // restart sees a settled effect rather than an unknown one.
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.state).toBe("accepted");
    expect(recorded[0]?.receipt).toMatchObject({ echoed: "first" });
    // A settled effect is not awaiting reconciliation.
    expect(await effects.listUnresolved(10)).toEqual([]);
    // Nothing dispatched in this process.
    expect(second.toolCalls()).toBe(0);
    await second.close();
  });

  it("records an interrupted effect as uncertain and surfaces it for reconciliation", async () => {
    const directory = directories.create();
    const first = await harness(directory, {
      mutatingTool: true,
      onToolCall: async () => {
        throw new Error("CRASH: connection reset after submission");
      },
    });
    const admitted = await workflowOf(first.runtime).admit({
      context,
      operationKey: "op-effect-before",
      kind: "start",
      prompt: "hi",
    });
    await first.close();

    const second = await harness(directory, {
      mutatingTool: true,
      onToolCall: async () => ({ echoed: "second" }),
    });
    const effects = second.runtime.store.asPort().repositories.effects;
    const recorded = await effects.listForTask(admitted.taskId);

    // The handler threw, so the outcome is unknown rather than rejected: the
    // submission may have reached the provider.
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.state).toBe("uncertain");
    // It is surfaced for a human rather than retried or assumed.
    expect((await effects.listUnresolved(10)).map((row) => row.effectKey)).toEqual([recorded[0]?.effectKey]);
    expect(second.toolCalls()).toBe(0);
    await second.close();
  });
});

describe("fault injection: competing resumes and delayed invocations", () => {
  it("resolves a competing resume of the same operation key to one admission", async () => {
    const directory = directories.create();
    const first = await harness(directory, { turns: [{ text: "answer" }] });
    const workflow = workflowOf(first.runtime);

    // Two callers race the same logical request.
    const [left, right] = await Promise.all([
      workflow.admit({ context, operationKey: "op-race", kind: "start", prompt: "hi" }),
      workflow.admit({ context, operationKey: "op-race", kind: "start", prompt: "hi" }),
    ]);
    expect(left.taskId).toBe(right.taskId);
    // Exactly one of them did the work and the other replayed it.
    expect([left.replay, right.replay].filter((value) => value === false)).toHaveLength(1);
    expect(first.modelCalls()).toBe(1);
    await first.close();
  });

  it("refuses a write from a generation the adapter no longer holds", async () => {
    const directory = directories.create();
    // The tool handler terminates the running generation mid-invocation: this is
    // exactly what an operator confirming a dead process does while a delayed
    // invocation is still alive. The *adapter's* fence, not the repository's, must
    // then refuse the next write.
    let terminated = false;
    const first = await harness(directory, {
      turns: [{ text: "unused" }],
      onToolCall: async () => {
        const executions = firstRuntimeRef?.runtime.store.asPort().repositories.executions;
        const task = (await firstRuntimeRef?.runtime.store.listTasks(1))?.[0];
        const current = await executions?.current(task?.taskId ?? "");
        if (executions !== undefined && task !== undefined && current !== undefined && !terminated) {
          terminated = true;
          await executions.terminate({
            taskId: task.taskId,
            generation: (await current).generation,
            confirmedTerminated: true,
            reason: "operator confirmed the invocation is gone",
            terminatedBy: "test-operator",
            now: { fixed: (() => nowTimestamp())() },
          });
        }
        return { ok: true };
      },
    });
    firstRuntimeRef = first;

    // The run must fail rather than commit: the write boundary re-checks the
    // generation and refuses a superseded one.
    await expect(
      workflowOf(first.runtime).admit({
        context,
        operationKey: "op-superseded",
        kind: "start",
        prompt: "hi",
      }),
    ).rejects.toThrowError(/superseded|terminated|generation/);
    expect(terminated).toBe(true);

    const executions = first.runtime.store.asPort().repositories.executions;
    const task = (await first.runtime.store.listTasks(1))[0];
    // The terminated generation did not write an outcome.
    expect((await executions.list(task?.taskId ?? "")).at(-1)?.state).toBe("terminated");
    await first.close();
  });

  it("refuses the superseded generation directly, and admits only a newer one", async () => {
    const directory = directories.create();
    const first = await harness(directory, { turns: [{ text: "v1" }] });
    const admitted = await workflowOf(first.runtime).admit({
      context,
      operationKey: "op-delayed",
      kind: "start",
      prompt: "hi",
    });
    const executions = first.runtime.store.asPort().repositories.executions;

    // A replacement generation exists while the older one is still recorded, so
    // this exercises the superseded-generation branch rather than the state check.
    await executions.terminate({
      taskId: admitted.taskId,
      generation: (await executions.list(admitted.taskId))[0]?.generation ?? 1,
      confirmedTerminated: true,
      reason: "operator confirmed the old invocation is gone",
      terminatedBy: "test-operator",
      now: { fixed: (() => nowTimestamp())() },
    });
    const replacement = await workflowOf(first.runtime).admit({
      context,
      taskId: admitted.taskId,
      operationKey: "op-delayed-2",
      kind: "reply",
    });
    expect(replacement.outcome.status).toBe("completed");

    const generations = (await executions.list(admitted.taskId)).map((row) => row.generation);
    const stale = generations[0] ?? 1;
    const newest = generations.at(-1) ?? stale;
    expect(newest).toBeGreaterThan(stale);
    // The delayed invocation from the older generation cannot write, and the
    // refusal names the supersession rather than only a state.
    await expect((async () => await executions.assertCurrentGeneration(admitted.taskId, stale, "old-session"))()).rejects.toThrowError(
      /superseded|terminated|owned by/,
    );
    // The replacement generation completed and released, and a released
    // generation may not write either: authority requires an active, current
    // generation, not merely the newest one.
    const newestRow = (await executions.list(admitted.taskId)).at(-1);
    expect(newestRow?.state).toBe("released");
    await expect(
      (async () => await executions.assertCurrentGeneration(admitted.taskId, newest, newestRow?.ownerSession ?? ""))(),
    ).rejects.toThrowError(/released|superseded/);

    // A freshly acquired generation is the one permitted to write.
    const held = await executions.acquire({
      taskId: admitted.taskId,
      ownerSession: "live-owner",
      admissionId: "adm-live",
      leaseMs: 60_000,
      now: { fixed: (() => nowTimestamp())() },
    });
    await (async () => await executions.assertCurrentGeneration(admitted.taskId, held.generation, "live-owner"))();
    await first.close();
  });
});
