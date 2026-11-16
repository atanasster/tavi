import {
  MAX_SHARED_MEMORY_RECORD_IDS,
  type AgentCommunicationServicePort,
  type InvocationContext,
  type ModelEvent,
  type ModelOutcome,
  type ModelPort,
  type ModelRequest,
} from "@tavi/contracts";
import { nowTimestamp } from "@tavi/contracts/util";
import { createAgentCommunicationService } from "@tavi/agent-host/agent-communication";
import { sweepExpiredWaits } from "@tavi/agent-host/agent-wait-scheduler";
import { MemoryService } from "@tavi/runtime";
import { temporaryDirectories } from "@tavi/test-support";
import { afterEach, describe, expect, it } from "vitest";

import { spawnOperationKey } from "../../src/features/agents/tools.js";
import { composeTaviRuntime } from "../../src/runtime/composition.js";
import type { TaviRuntime } from "../../src/runtime/types.js";

/**
 * Delegation restart fixtures: mail and its wake intent are committed
 * together in the application database, reconciled after restart, and
 * delivered at least once with deduplication by message ID.
 *
 * Same harness discipline as `fault-injection.test.ts`: a crash is modelled
 * by its durable consequence plus a restart — the runtime is closed (which
 * releases the kernel's advisory locks, as process death does) and a new
 * runtime is composed over the same data directory.
 *
 * `agents.receive`/`agents.ack` are not registered tools (they are runtime
 * operations, not model-controlled delivery bookkeeping — see
 * `apps/cli/src/features/agents/tools.ts`'s header comment), so these tests construct
 * their own `AgentCommunicationServicePort` directly against the restarted
 * runtime's real repositories/workflow — the same wiring `composition.ts`
 * itself uses, not a fixture.
 *
 * **The "one execution slot: orchestrator suspended in `waitFor` releases
 * its slot so the worker can run" guarantee** is real — `waitFor()`
 * suspends through a genuine LangGraph interrupt — but is exercised in
 * `packages/agent-host/test/agent-wait-races.test.ts` rather than here: proving
 * the execution slot is free while suspended needs direct access to the
 * `ExecutionRepositoryPort`, which this file's harness (composed through
 * the CLI's full `composeTaviRuntime`) does not expose as conveniently as a
 * bespoke plugin-level adapter does. This file instead covers the fixture
 * only a real restart can exercise: **deadline recovery after restart**,
 * below.
 */

const workspaces = [
  { workspaceId: "default", principalId: "operator", permissions: ["tools.invoke", "models.invoke", "runs.create"] },
] as const;

const context: InvocationContext = { workspaceId: "default", principalId: "operator", runId: "root", caller: "test" };

const directories = temporaryDirectories({ prefix: "tavi-agent-fault-" });

afterEach(() => directories.cleanup());

interface Harness {
  readonly runtime: TaviRuntime;
  readonly modelCalls: () => number;
  readonly close: () => Promise<unknown>;
}

/** Compose a runtime over a data directory with a scripted model — every admitted turn (orchestrator or worker) gets the next scripted reply. */
async function harness(directory: string, turns: readonly { readonly text: string }[] = [{ text: "ok" }]): Promise<Harness> {
  let modelCalls = 0;
  let turn = 0;
  const model: ModelPort = {
    async stream(
      request: ModelRequest,
      options: { readonly signal: AbortSignal; readonly onEvent: (event: ModelEvent) => void },
    ): Promise<ModelOutcome> {
      modelCalls += 1;
      const text = turns[turn]?.text ?? "done";
      turn += 1;
      options.onEvent({ type: "text.delta", attemptId: request.attemptId, blockId: "b", text });
      return { status: "completed", attemptId: request.attemptId, text, toolCalls: [], usage: {} };
    },
  };

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
    },
    { modelOverride: model },
  );

  // `agentDefinitionId` is a validated reference, so
  // the ids these tests spawn with have to exist (see the sibling note in
  // `agent-memory-scoping-acceptance.test.ts`).
  const agents = runtime.store.asPort().repositories.agents;
  for (const agentId of ["reporting-agent", "x"]) {
    // Idempotent: several of these tests restart over the same data directory.
    if ((await agents.get("default", agentId)) !== undefined) continue;
    await agents.create({
      agentId,
      workspaceId: "default",
      name: agentId,
      systemPrompt: `Act as ${agentId}.`,
      enabled: true,
      now: nowTimestamp(),
    });
  }
  return { runtime, modelCalls: () => modelCalls, close: () => runtime.close() };
}

/** Invoke a registered governed tool's handler directly, the same path a model tool call dispatches through. */
async function callTool(
  runtime: TaviRuntime,
  id: string,
  input: unknown,
  invocationContext: InvocationContext = context,
): Promise<unknown> {
  const tool = runtime.tools.get(id);
  if (tool === undefined) throw new Error(`tool ${id} is not registered`);
  return tool.handler({ input, context: invocationContext, signal: new AbortController().signal });
}

/**
 * The same `AgentCommunicationServicePort` wiring `composition.ts` uses
 * (`mailbox`/`waits`/`delegations`/`tasks`/`workflow`/`now`/`newId` all
 * sourced from the real runtime), for `receive`/`ack` — not registered as
 * tools. `cancelTask` intentionally throws rather than reusing
 * `recordCancellation`: no test in this file calls `agents.cancel`; if you
 * add one, wire a real `cancelTask` (see `composition.ts`) instead of
 * extending this stub.
 */
function agentsServiceFor(runtime: TaviRuntime): AgentCommunicationServicePort {
  if (runtime.workflow === undefined) throw new Error("workflow unavailable");
  const repositories = runtime.store.asPort().repositories;
  return createAgentCommunicationService({
    mailbox: repositories.agentMailbox,
    waits: repositories.agentWaits,
    delegations: repositories.agentDelegations,
    tasks: repositories.tasks,
    workflow: runtime.workflow,
    access: runtime.access,
    cancelTask: () => {
      throw new Error("cancel is intentionally unimplemented here — no test in this file calls agents.cancel");
    },
    now: () => runtime.clock.now(),
    newId: (prefix) => runtime.clock.newId(prefix),
  });
}

describe("fault injection: crash after spawn's admit commits, before recordSpawn", () => {
  it("a retry with the same operation key resolves the identical worker, never a duplicate", async () => {
    const directory = directories.create();
    const first = await harness(directory, [{ text: "worker done" }]);
    const spawned = (await callTool(first.runtime, "agents.spawn", {
      agentDefinitionId: "reporting-agent",
      input: "do the thing",
      operationKey: "op-spawn-crash",
    })) as { workerTaskId: string; workerAgentId: string; created: boolean };
    expect(spawned.created).toBe(true);
    expect(first.modelCalls()).toBe(1);
    await first.close();

    // Restart over the same directory and retry the identical spawn request,
    // modelling a crash after the worker's task/admission committed.
    const second = await harness(directory, [{ text: "should not run again" }]);
    const retried = (await callTool(second.runtime, "agents.spawn", {
      agentDefinitionId: "reporting-agent",
      input: "do the thing",
      operationKey: "op-spawn-crash",
    })) as { workerTaskId: string; workerAgentId: string; created: boolean };

    expect(retried.workerTaskId).toBe(spawned.workerTaskId);
    expect(retried.workerAgentId).toBe(spawned.workerAgentId);
    expect(retried.created).toBe(false);
    // No reprocessing: the retry resolved the durable admission rather than
    // running the worker's turn again.
    expect(second.modelCalls()).toBe(0);

    const delegations = second.runtime.store.asPort().repositories.agentDelegations;
    // Recorded under the model's key namespaced by the spawning task and turn.
    expect((await delegations.getByOperationKey("default", "operator", spawnOperationKey(context, "op-spawn-crash")))?.workerTaskId).toBe(
      spawned.workerTaskId,
    );
    await second.close();
  });
});

describe("fault injection: crash after a mailbox commit, before the recipient ever receives it", () => {
  it("the envelope survives a restart, is receivable, and disappears from pending only after ack", async () => {
    const directory = directories.create();
    const first = await harness(directory, [{ text: "worker done" }]);
    const spawned = (await callTool(first.runtime, "agents.spawn", {
      agentDefinitionId: "x",
      input: "a",
      operationKey: "op-1",
    })) as { workerTaskId: string };

    // wake: "none" isolates the mailbox commit itself: the default
    // wake: "if-idle" would trigger a real workflow.admit({kind: "reply"})
    // turn on the recipient before this test's simulated crash, which would
    // make "before the recipient ever receives it" untrue (a wake-triggered
    // admission is not a receive, but it is real extra durable activity this
    // test does not intend to also be exercising).
    // Through the service, which honours `wake: "none"` (the model's tool takes no wake): a
    // woken worker's turn reads its mail, which these faults happen before.
    await agentsServiceFor(first.runtime).send({
      actor: { workspaceId: context.workspaceId, principalId: context.principalId, runId: context.runId, caller: context.caller },
      recipientAgentId: "worker-1",
      recipientTaskId: spawned.workerTaskId,
      kind: "message",
      content: "hello worker",
      wake: "none",
    });
    // Simulate a crash immediately after the mailbox commit — no receive/ack
    // (and, thanks to wake: "none" above, no wake-triggered admission either)
    // ever happened in this process.
    await first.close();

    const second = await harness(directory);
    const mailbox = second.runtime.store.asPort().repositories.agentMailbox;
    const pendingAfterRestart = await mailbox.listPending(spawned.workerTaskId, 10);
    expect(pendingAfterRestart).toHaveLength(1);
    expect(pendingAfterRestart[0]?.content).toBe("hello worker");

    const agents = agentsServiceFor(second.runtime);
    // principalId matches the worker task's own principal (spawn() admits
    // the worker under the same caller's principal) — see the fuller note
    // at this same construction below, in the ack-survives-restart test.
    const workerActor = { workspaceId: "default", principalId: "operator", runId: spawned.workerTaskId, caller: "test" };
    const received = await agents.receive({ actor: workerActor, taskId: spawned.workerTaskId, limit: 10 });
    expect(received.envelopes).toHaveLength(1);
    const messageId = received.envelopes[0]?.messageId ?? "";
    expect(received.envelopes[0]?.content).toBe("hello worker");
    // Claimed (delivered), not yet acknowledged — a claim alone doesn't
    // finish it: delivered means leased delivery, not
    // durable processing.
    expect((await mailbox.getEnvelope(messageId))?.deliveryState).toBe("delivered");

    await agents.ack({
      actor: workerActor,
      taskId: spawned.workerTaskId,
      leaseId: received.leaseId,
      acknowledgedMessageIds: [messageId],
    });
    expect((await mailbox.getEnvelope(messageId))?.deliveryState).toBe("acknowledged");
    await second.close();
  });

  it("a duplicate insert of the identical message id is rejected, not silently re-delivered", async () => {
    const directory = directories.create();
    const first = await harness(directory, [{ text: "worker done" }]);
    const spawned = (await callTool(first.runtime, "agents.spawn", {
      agentDefinitionId: "x",
      input: "a",
      operationKey: "op-1",
    })) as { workerTaskId: string };
    // Through the service, which honours `wake: "none"` (the model's tool takes no wake): a
    // woken worker's turn reads its mail, which these faults happen before.
    await agentsServiceFor(first.runtime).send({
      actor: { workspaceId: context.workspaceId, principalId: context.principalId, runId: context.runId, caller: context.caller },
      recipientAgentId: "worker-1",
      recipientTaskId: spawned.workerTaskId,
      kind: "message",
      content: "once",
      wake: "none",
    });
    await first.close();

    const second = await harness(directory);
    const mailbox = second.runtime.store.asPort().repositories.agentMailbox;
    const before = await mailbox.listPending(spawned.workerTaskId, 10);
    expect(before).toHaveLength(1);
    // message_id is the table's primary key; this directly probes that
    // invariant at the repository level. No caller path can reach this
    // today — send() always mints a fresh messageId via newId("msg"), so a
    // real retried send() never collides — but the constraint becomes
    // load-bearing the moment send() gains a caller-supplied idempotency
    // key, which would be the natural way to add real retry-safety here.
    const duplicate = before[0];
    if (duplicate === undefined) throw new Error("expected one pending envelope");
    await expect((async () => await mailbox.insertEnvelope(duplicate))()).rejects.toThrowError();
    expect(await mailbox.listPending(spawned.workerTaskId, 10)).toHaveLength(1);
    await second.close();
  });
});

describe("fault injection: crash after ack, restart does not reprocess", () => {
  it("an acknowledged message stays acknowledged across a restart", async () => {
    const directory = directories.create();
    const first = await harness(directory, [{ text: "worker done" }]);
    const spawned = (await callTool(first.runtime, "agents.spawn", {
      agentDefinitionId: "x",
      input: "a",
      operationKey: "op-1",
    })) as { workerTaskId: string };
    // Through the service, which honours `wake: "none"` (the model's tool takes no wake): a
    // woken worker's turn reads its mail, which these faults happen before.
    await agentsServiceFor(first.runtime).send({
      actor: { workspaceId: context.workspaceId, principalId: context.principalId, runId: context.runId, caller: context.caller },
      recipientAgentId: "worker-1",
      recipientTaskId: spawned.workerTaskId,
      kind: "message",
      content: "hello",
      wake: "none",
    });

    const agents = agentsServiceFor(first.runtime);
    // principalId matches the worker task's own principal, since spawn()
    // admits the worker under the same caller's principal (contextFrom
    // reuses input.actor) — no separate per-agent identity exists yet. This is load-bearing
    // for assertOwnsTask's workspace-only check to accept this actor as the
    // worker task's own caller.
    const workerActor = { workspaceId: "default", principalId: "operator", runId: spawned.workerTaskId, caller: "test" };
    const received = await agents.receive({ actor: workerActor, taskId: spawned.workerTaskId, limit: 10 });
    await agents.ack({
      actor: workerActor,
      taskId: spawned.workerTaskId,
      leaseId: received.leaseId,
      acknowledgedMessageIds: [received.envelopes[0]?.messageId ?? ""],
    });
    // Crash immediately after the ack commits.
    await first.close();

    const second = await harness(directory);
    const mailbox = second.runtime.store.asPort().repositories.agentMailbox;
    expect(await mailbox.listPending(spawned.workerTaskId, 10)).toHaveLength(0);
    const envelope = await mailbox.getEnvelope(received.envelopes[0]?.messageId ?? "");
    expect(envelope?.deliveryState).toBe("acknowledged");
    await second.close();
  });
});

describe("fault injection: crash while suspended on agents.wait, before its deadline sweep runs", () => {
  it("the wait row survives a restart, and the expiry sweep on the restarted runtime still finds and settles it", async () => {
    const directory = directories.create();

    // A model that, on its very first turn, requests `agents.wait` with a
    // deadline already in the past — no `correlationId`/
    // `waitingOnWorkerTaskId`, so nothing settles it immediately and the
    // admission genuinely suspends through a real LangGraph interrupt.
    const waitModel: ModelPort = {
      async stream(request: ModelRequest): Promise<ModelOutcome> {
        return {
          status: "completed",
          attemptId: request.attemptId,
          text: "",
          toolCalls: [{ id: "call-wait", name: "agents.wait", input: { deadlineAt: "2020-01-01T00:00:00.000Z" } }],
          usage: {},
        };
      },
    };
    const first = await composeTaviRuntime(
      {
        dataDirectory: directory,
        workspaces: [...workspaces],
        providers: [],
        credentials: {},
        defaultConnectionId: "fixture",
        defaultModel: "fixture-model",
        logger: { level: "error", sink: () => {} },
        approvalRequiredFor: [],
      },
      { modelOverride: waitModel },
    );
    if (first.workflow === undefined) throw new Error("workflow unavailable");
    const admitted = await first.workflow.admit({
      context,
      operationKey: "op-suspend",
      kind: "start",
      prompt: "hello",
    });
    expect(admitted.outcome.status).toBe("waiting");
    const waitId = admitted.outcome.waitInterrupt?.wait.waitId;
    expect(waitId).toBeDefined();
    expect((await first.store.asPort().repositories.agentWaits.get(waitId ?? ""))?.state).toBe("active");

    // Crash before any sweep ever runs: the durable wait row and the
    // suspended checkpoint are all this restart has to recover from.
    await first.close();

    const finishModel: ModelPort = {
      async stream(request: ModelRequest, options: { readonly onEvent: (event: ModelEvent) => void }): Promise<ModelOutcome> {
        const text = "resumed after restart";
        options.onEvent({ type: "text.delta", attemptId: request.attemptId, blockId: "b", text });
        return { status: "completed", attemptId: request.attemptId, text, toolCalls: [], usage: {} };
      },
    };
    const second = await composeTaviRuntime(
      {
        dataDirectory: directory,
        workspaces: [...workspaces],
        providers: [],
        credentials: {},
        defaultConnectionId: "fixture",
        defaultModel: "fixture-model",
        logger: { level: "error", sink: () => {} },
        approvalRequiredFor: [],
      },
      { modelOverride: finishModel },
    );
    if (second.workflow === undefined) throw new Error("workflow unavailable");
    const repositories = second.store.asPort().repositories;
    // The row is durable across the restart, still exactly where the first
    // process left it — nothing about a process crash between "suspend" and
    // "sweep" should have touched it.
    expect((await repositories.agentWaits.get(waitId ?? ""))?.state).toBe("active");

    const swept = await sweepExpiredWaits({
      waits: repositories.agentWaits,
      tasks: repositories.tasks,
      workflow: second.workflow,
      now: () => nowTimestamp(),
    });
    expect(swept.settled).toBe(1);
    expect(swept.orphaned).toEqual([]);
    expect((await repositories.agentWaits.get(waitId ?? ""))?.state).toBe("settled");
    const task = await repositories.tasks.get(admitted.taskId);
    expect(task?.status).toBe("completed");
    expect(task?.finalText).toBe("resumed after restart");

    await second.close();
  });
});

describe("agents.spawn tool: sharedMemoryRecordIds", () => {
  it("accepts a readable record id and persists the grant on the delegation record", async () => {
    const directory = directories.create();
    const runtime = await harness(directory, [{ text: "worker done" }]);
    const memory = new MemoryService(runtime.runtime.store.asPort(), {
      now: () => runtime.runtime.clock.now(),
      newId: (prefix) => runtime.runtime.clock.newId(prefix),
    });
    const record = await memory.approve({
      actor: { principalId: "operator", workspaceId: "default", caller: "test", authority: "operator" },
      recordId: (
        await memory.propose({
          actor: { principalId: "operator", workspaceId: "default", caller: "test", authority: "operator" },
          scope: { kind: "personal", principalId: "operator" },
          kind: "fact",
          body: "a fact worth sharing with a worker",
        })
      ).recordId,
    });

    const spawned = (await callTool(runtime.runtime, "agents.spawn", {
      agentDefinitionId: "reporting-agent",
      input: "do the thing",
      operationKey: "op-shared-memory",
      sharedMemoryRecordIds: [record.recordId],
    })) as { workerTaskId: string; created: boolean };
    expect(spawned.created).toBe(true);

    const delegations = runtime.runtime.store.asPort().repositories.agentDelegations;
    const delegation = await delegations.getByWorkerTaskId(spawned.workerTaskId);
    expect(delegation?.sharedMemoryRecordIds).toEqual([record.recordId]);
    await runtime.close();
  });

  it("rejects a sharedMemoryRecordIds list longer than MAX_SHARED_MEMORY_RECORD_IDS", async () => {
    const directory = directories.create();
    const runtime = await harness(directory);
    const tooMany = Array.from({ length: MAX_SHARED_MEMORY_RECORD_IDS + 1 }, (_, i) => `record-${i}`);
    await expect(
      callTool(runtime.runtime, "agents.spawn", {
        agentDefinitionId: "reporting-agent",
        input: "do the thing",
        operationKey: "op-too-many-records",
        sharedMemoryRecordIds: tooMany,
      }),
    ).rejects.toThrow(/invalid arguments/);
    await runtime.close();
  });

  it("persists no sharedMemoryRecordIds (undefined, not an empty array) when the field is omitted", async () => {
    const directory = directories.create();
    const runtime = await harness(directory, [{ text: "worker done" }]);
    const spawned = (await callTool(runtime.runtime, "agents.spawn", {
      agentDefinitionId: "reporting-agent",
      input: "do the thing",
      operationKey: "op-no-shared-memory",
    })) as { workerTaskId: string };

    const delegations = runtime.runtime.store.asPort().repositories.agentDelegations;
    expect((await delegations.getByWorkerTaskId(spawned.workerTaskId))?.sharedMemoryRecordIds).toBeUndefined();
    await runtime.close();
  });

  it("rejects a record id the caller cannot itself read", async () => {
    const directory = directories.create();
    const runtime = await harness(directory);
    const memory = new MemoryService(runtime.runtime.store.asPort(), {
      now: () => runtime.runtime.clock.now(),
      newId: (prefix) => runtime.runtime.clock.newId(prefix),
    });
    const record = await memory.approve({
      actor: { principalId: "someone-else", workspaceId: "default", caller: "test", authority: "operator" },
      recordId: (
        await memory.propose({
          actor: { principalId: "someone-else", workspaceId: "default", caller: "test", authority: "operator" },
          scope: { kind: "personal", principalId: "someone-else" },
          kind: "fact",
          body: "not the caller's own record",
        })
      ).recordId,
    });

    await expect(
      callTool(runtime.runtime, "agents.spawn", {
        agentDefinitionId: "reporting-agent",
        input: "do the thing",
        operationKey: "op-unreadable",
        sharedMemoryRecordIds: [record.recordId],
      }),
    ).rejects.toThrow(/cannot itself read/);
    await runtime.close();
  });
});
