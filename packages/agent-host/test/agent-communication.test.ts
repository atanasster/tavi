import { fixturePromptPolicy } from "./support/prompt-policy.js";
import {
  TRUSTED_PUBLIC,
  untrustedLabel,
  DEFAULT_MAX_CONCURRENT_WORKERS,
  DEFAULT_MAX_SPAWN_DEPTH,
  MAX_AGENT_ENVELOPE_INLINE_BYTES,
  MAX_SHARED_MEMORY_RECORD_IDS,
  TaviError,
  WorkflowWaitSuspend,
  AgentWaitOutcomeSchema,
  agentMessageGrant,
  envelopeLabel,
  mailboxContextNote,
  type AccessPolicyPort,
  type AdmitInput,
  type AgentActor,
  type AgentMailboxRepositoryPort,
  type AgentWaitOutcome,
  type ArtifactRepositoryPort,
  type ContentLabel,
  type MemoryActor,
  type MemoryRecord,
  type MemoryServicePort,
  type TaskExecutionPolicy,
  type TaskRepositoryPort,
  type WorkflowPort,
  ATTENDED_TASK_POLICY,
  ROUTINE_TASK_POLICY,
  SCHEDULE_TASK_POLICY,
  UNATTENDED_TASK_POLICY,
} from "@tavi/contracts";
import { definedOnly } from "@tavi/contracts/util";
import { createAgentCommunicationService } from "@tavi/agent-host/agent-communication";
import {
  admitFixtureTask,
  createInMemoryAgentDelegationRepository,
  createInMemoryAgentMailboxRepository,
  createInMemoryAgentWaitRepository,
  createInMemoryArtifactRepository,
  createInMemoryTaskRepository,
} from "@tavi/test-support/fakes";
import { describe, expect, it } from "vitest";
import { sleep } from "@tavi/node-kit";

/**
 * Orchestrator-to-worker delegation.
 *
 * Fixture ports throughout — the plugin must not import `@tavi/runtime`, and
 * neither should its tests, matching `workflow.test.ts`'s own convention.
 */

const AT = "2026-01-01T00:00:00.000Z";
const actor: AgentActor = { principalId: "alice", workspaceId: "w1", runId: "t-orchestrator", caller: "cli" };
const workerA: AgentActor = { principalId: "alice", workspaceId: "w1", agentId: "worker-a", runId: "t-worker-a", caller: "cli" };
const workerB: AgentActor = { principalId: "alice", workspaceId: "w1", agentId: "worker-b", runId: "t-worker-b", caller: "cli" };

/** The shared in-memory mailbox, with the store's lease semantics. */
function createFixtureMailbox(): AgentMailboxRepositoryPort {
  return createInMemoryAgentMailboxRepository();
}

/** A minimal `WorkflowPort`: `kind: "start"` creates a task in `tasks`, everything else resolves against an existing one. */
function createFixtureWorkflow(
  tasks: TaskRepositoryPort,
): WorkflowPort & { readonly calls: AdmitInput[]; readonly labels: Map<string, ContentLabel> } {
  const calls: AdmitInput[] = [];
  // A thread's context label, as a test sets it: what `checkpoints.contextLabel` answers.
  const labels = new Map<string, ContentLabel>();
  let counter = 0;
  const newId = (prefix: string): string => `${prefix}-${(counter += 1)}`;
  return {
    calls,
    labels,
    admit: async (input) => {
      calls.push(input);
      if (input.kind === "start") {
        const result = await tasks.admit({
          prompt: fixturePromptPolicy,
          workspaceId: input.context.workspaceId,
          principalId: input.context.principalId,
          operationKey: input.operationKey,
          kind: "start",
          intent: input.prompt ?? null,
          // Forwarded as the durable repository and the workflow adapter do: a
          // fixture that dropped it would make the policy inheritance untestable.
          ...(input.executionPolicy === undefined ? {} : { executionPolicy: input.executionPolicy }),
          checkpointNamespace: "",
          newTaskId: (() => newId("task"))(),
          newAdmissionId: (() => newId("adm"))(),
          newThreadId: (() => newId("thread"))(),
          now: (() => AT)(),
        });
        input.onAdmitted?.({
          taskId: result.task.taskId,
          threadId: result.task.threadId,
          admissionId: result.admission.admissionId,
          created: result.created,
        });
        return {
          taskId: result.task.taskId,
          threadId: result.task.threadId,
          outcome: { status: "completed", finalText: "ok" },
          created: result.created,
          replay: !result.created,
        };
      }
      const existing = input.taskId === undefined ? undefined : await tasks.get(input.taskId);
      if (existing === undefined) throw new TaviError("NOT_FOUND", `Task ${input.taskId ?? ""} does not exist`);
      const result = await tasks.admit({
        prompt: fixturePromptPolicy,
        workspaceId: existing.workspaceId,
        principalId: existing.principalId,
        taskId: existing.taskId,
        operationKey: input.operationKey,
        kind: input.kind,
        intent: input.prompt ?? null,
        checkpointNamespace: existing.checkpointNamespace,
        newTaskId: (() => existing.taskId)(),
        newAdmissionId: (() => newId("adm"))(),
        newThreadId: (() => existing.threadId)(),
        now: (() => AT)(),
      });
      return {
        taskId: existing.taskId,
        threadId: existing.threadId,
        outcome: { status: "completed", finalText: "" },
        created: result.created,
        replay: !result.created,
      };
    },
    checkpoints: { latest: async () => undefined, listCheckpoints: async () => [], contextLabel: async (threadId) => labels.get(threadId) },
  };
}

/** Admits the orchestrator's own task (matching `actor.runId`), for tests where `waitFor`'s new ownership check needs it to exist. */
async function admitOrchestratorTask(tasks: TaskRepositoryPort): Promise<void> {
  await tasks.admit({
    prompt: fixturePromptPolicy,
    workspaceId: actor.workspaceId,
    principalId: actor.principalId,
    operationKey: "op-orchestrator",
    kind: "start",
    intent: null,
    checkpointNamespace: "",
    newTaskId: (() => "t-orchestrator")(),
    newAdmissionId: (() => "adm-orchestrator")(),
    newThreadId: (() => "thread-orchestrator")(),
    now: (() => AT)(),
  });
}

/** Admits an arbitrary task, for peer-messaging tests that need two independent sibling tasks. */
async function admitTask(tasks: TaskRepositoryPort, taskId: string): Promise<void> {
  await admitFixtureTask(tasks, taskId, fixturePromptPolicy, {
    workspaceId: actor.workspaceId,
    principalId: actor.principalId,
    now: () => AT,
  });
}

/** Permissive by default — nothing denied unless explicitly listed, matching `workflow.test.ts`'s own `createAccess`. */
function createAccess(deniedPermissions: readonly string[] = []): AccessPolicyPort {
  const denied = new Set(deniedPermissions);
  return {
    resolveWorkspace: () => ({ principalId: actor.principalId }),
    missingPermissions: (_context, required) => required.filter((entry) => denied.has(entry)),
  };
}

/**
 * Minimal `MemoryServicePort` fixture for `spawn()`'s `sharedMemoryRecordIds`
 * validation — only `get` is exercised by that
 * code path, so every other method fails loudly if a test ever reaches it.
 * `readableRecordIds` names every id this fixture will resolve; anything
 * else throws `NOT_FOUND`, the same way a real unauthorized/missing read
 * would. Every `get` call is captured so a test can assert on exactly which
 * `MemoryActor` `spawn()` passed.
 */
function createFixtureMemory(readableRecordIds: readonly string[]): MemoryServicePort & {
  readonly getCalls: { readonly actor: MemoryActor; readonly recordId: string }[];
} {
  const getCalls: { readonly actor: MemoryActor; readonly recordId: string }[] = [];
  const readable = new Set(readableRecordIds);
  const notImplemented = (): never => {
    throw new Error("not implemented in this fixture");
  };
  return {
    getCalls,
    propose: notImplemented,
    eligible: notImplemented,
    remember: notImplemented,

    approve: notImplemented,
    reject: notImplemented,
    correct: notImplemented,
    revoke: notImplemented,
    forget: notImplemented,
    get: async ({ actor, recordId }) => {
      getCalls.push({ actor, recordId });
      if (!readable.has(recordId)) throw new TaviError("NOT_FOUND", `Memory record ${recordId} not found`);
      return { recordId } as unknown as MemoryRecord;
    },
    list: notImplemented,
    search: notImplemented,
    resolvePreferences: notImplemented,
    resolveFactConflicts: notImplemented,
    export: notImplemented,
    usage: notImplemented,
    sweepExpired: notImplemented,
    // The port's reads for the operator's page and counts: not this fixture's.
    operatorView: notImplemented,
    history: notImplemented,
    related: notImplemented,
    counts: notImplemented,
    principals: notImplemented,
  };
}

function build(
  options: {
    readonly deniedPermissions?: readonly string[];
    readonly artifacts?: ArtifactRepositoryPort;
    readonly memory?: MemoryServicePort;
    readonly now?: () => string;
    readonly onWaitSettled?: (waitId: string, outcome: AgentWaitOutcome) => Promise<void>;
  } = {},
) {
  const tasks = createInMemoryTaskRepository();
  const mailbox = createFixtureMailbox();
  const waits = createInMemoryAgentWaitRepository();
  const delegations = createInMemoryAgentDelegationRepository(tasks);
  const workflow = createFixtureWorkflow(tasks);
  const cancelled: { taskId: string; reason: string; operator: string }[] = [];
  const service = createAgentCommunicationService({
    mailbox,
    waits,
    delegations,
    tasks,
    workflow,
    access: createAccess(options.deniedPermissions),
    ...definedOnly({
      artifacts: options.artifacts,
      memory: options.memory,
      onWaitSettled: options.onWaitSettled,
    }),
    cancelTask: async (input) => {
      cancelled.push(input);
      await tasks.updateStatus(input.taskId, "cancelled", null);
    },
    now: options.now ?? (() => AT),
  });
  return { tasks, mailbox, waits, delegations, workflow, service, cancelled };
}

describe("spawn", () => {
  it("creates a worker task and resolves the same one on an operation-key retry", async () => {
    const { service, workflow } = build();
    const first = await service.spawn({ actor, agentDefinitionId: "reporting-agent", input: "do the thing", operationKey: "op-1" });
    expect(first.created).toBe(true);
    expect(first.workerTaskId).toBeTruthy();
    expect(first.workerAgentId).toBeTruthy();

    const second = await service.spawn({ actor, agentDefinitionId: "reporting-agent", input: "do the thing", operationKey: "op-1" });
    expect(second.created).toBe(false);
    expect(second.workerTaskId).toBe(first.workerTaskId);
    expect(second.workerAgentId).toBe(first.workerAgentId);
    // A spawned worker is recorded as an agent's task, never an operator's.
    expect(workflow.calls.filter((call) => call.kind === "start").map((call) => call.origin)).toEqual(["agent"]);

    // Only one admission call ever reached the underlying workflow for the retry
    // path's task creation (the delegation-admission table resolved it first).
    expect(workflow.calls.filter((c) => c.kind === "start")).toHaveLength(1);
  });

  it("narrows a worker to the tools its spawn names, within its parent's allowlist, and takes a host's policy for a parent not admitted yet", async () => {
    const { tasks, service } = build();
    const parent = await tasks.admit({
      prompt: fixturePromptPolicy,
      workspaceId: actor.workspaceId,
      principalId: actor.principalId,
      operationKey: "parent-narrow",
      kind: "start",
      intent: null,
      executionPolicy: {
        mode: "unattended",
        humanQuestionsAllowed: false,
        workerWaitsAllowed: true,
        toolAllowlist: ["fs.*", "web_search"],
      },
      checkpointNamespace: "",
      newTaskId: (() => "task-parent-narrow")(),
      newAdmissionId: (() => "adm-parent-narrow")(),
      newThreadId: (() => "thread-parent-narrow")(),
      now: (() => AT)(),
    });
    const narrowed = await service.spawn({
      actor: { ...actor, runId: parent.task.taskId },
      agentDefinitionId: "reporting-agent",
      input: "read the notes",
      operationKey: "op-narrow",
      // `sandbox.run` is not the parent's to give: it is left out.
      tools: ["fs.read", "sandbox.run"],
    });
    expect((await tasks.get(narrowed.workerTaskId))?.executionPolicy?.toolAllowlist).toEqual(["fs.read"]);
    // A parent with no row yet: the host's policy stands in for it, rather than the unattended default.
    const reserved = await service.spawn({
      actor: { ...actor, runId: "task-not-admitted-yet" },
      agentDefinitionId: "reporting-agent",
      input: "research",
      operationKey: "op-reserved",
      parentPolicy: { mode: "unattended", humanQuestionsAllowed: false, workerWaitsAllowed: false, toolAllowlist: ["web_search"] },
    });
    expect((await tasks.get(reserved.workerTaskId))?.executionPolicy).toMatchObject({
      workerWaitsAllowed: false,
      toolAllowlist: ["web_search"],
    });
  });

  it("gives a worker its creating task's execution policy, so a scheduled parent cannot delegate a question", async () => {
    // A spawned worker must not become the way an unattended run reaches a
    // person: it inherits the parent's durable policy rather than defaulting.
    const { tasks, service, workflow } = build();
    const parent = await tasks.admit({
      prompt: fixturePromptPolicy,
      workspaceId: actor.workspaceId,
      principalId: actor.principalId,
      operationKey: "parent-op",
      kind: "start",
      intent: null,
      executionPolicy: { mode: "unattended", humanQuestionsAllowed: false, workerWaitsAllowed: true },
      checkpointNamespace: "",
      newTaskId: (() => "task-parent")(),
      newAdmissionId: (() => "adm-parent")(),
      newThreadId: (() => "thread-parent")(),
      now: (() => AT)(),
    });
    const spawned = await service.spawn({
      actor: { ...actor, runId: parent.task.taskId },
      agentDefinitionId: "reporting-agent",
      input: "gather",
      operationKey: "op-unattended",
    });
    expect(spawned.created).toBe(true);
    expect((await tasks.get(spawned.workerTaskId))?.executionPolicy).toEqual({
      mode: "unattended",
      humanQuestionsAllowed: false,
      workerWaitsAllowed: true,
    });
    // The adapter was told the same thing, so the child's own tasks are created
    // under it rather than under a default.
    expect(workflow.calls.find((call) => call.operationKey === "op-unattended")?.executionPolicy).toEqual({
      mode: "unattended",
      humanQuestionsAllowed: false,
      workerWaitsAllowed: true,
    });

    // An attended parent passes its own policy through unchanged.
    const attended = await tasks.admit({
      prompt: fixturePromptPolicy,
      workspaceId: actor.workspaceId,
      principalId: actor.principalId,
      operationKey: "parent-op-2",
      kind: "start",
      intent: null,
      executionPolicy: { mode: "attended", humanQuestionsAllowed: true, workerWaitsAllowed: true },
      checkpointNamespace: "",
      newTaskId: (() => "task-parent-2")(),
      newAdmissionId: (() => "adm-parent-2")(),
      newThreadId: (() => "thread-parent-2")(),
      now: (() => AT)(),
    });
    const child = await service.spawn({
      actor: { ...actor, runId: attended.task.taskId },
      agentDefinitionId: "reporting-agent",
      input: "gather",
      operationKey: "op-attended",
    });
    expect((await tasks.get(child.workerTaskId))?.executionPolicy.humanQuestionsAllowed).toBe(true);
  });

  it("carries a schedule fire's refusal of scheduling writes to its workers, a narrowed one too", async () => {
    const { tasks, service } = build();
    const fire = await tasks.admit({
      prompt: fixturePromptPolicy,
      workspaceId: actor.workspaceId,
      principalId: actor.principalId,
      operationKey: "fire-op",
      kind: "start",
      intent: null,
      executionPolicy: SCHEDULE_TASK_POLICY,
      checkpointNamespace: "",
      newTaskId: (() => "task-fire")(),
      newAdmissionId: (() => "adm-fire")(),
      newThreadId: (() => "thread-fire")(),
      now: (() => AT)(),
    });
    const whole = await service.spawn({
      actor: { ...actor, runId: fire.task.taskId },
      agentDefinitionId: "reporting-agent",
      input: "gather",
      operationKey: "op-fire-worker",
    });
    const narrowed = await service.spawn({
      actor: { ...actor, runId: fire.task.taskId },
      agentDefinitionId: "reporting-agent",
      input: "gather",
      operationKey: "op-fire-narrowed",
      tools: ["routines.run"],
    });
    expect((await tasks.get(whole.workerTaskId))?.executionPolicy.schedulingWritesDenied).toBe(true);
    expect((await tasks.get(narrowed.workerTaskId))?.executionPolicy.schedulingWritesDenied).toBe(true);
  });

  it("carries an email's reader session to its workers, a narrowed one and a worker's own worker too", async () => {
    const { tasks, service } = build();
    const fire = await tasks.admit({
      prompt: fixturePromptPolicy,
      workspaceId: actor.workspaceId,
      principalId: actor.principalId,
      operationKey: "email-op",
      kind: "start",
      intent: null,
      executionPolicy: { ...SCHEDULE_TASK_POLICY, readOnlyTools: true },
      checkpointNamespace: "",
      newTaskId: (() => "task-email")(),
      newAdmissionId: (() => "adm-email")(),
      newThreadId: (() => "thread-email")(),
      now: (() => AT)(),
    });
    const whole = await service.spawn({
      actor: { ...actor, runId: fire.task.taskId },
      agentDefinitionId: "reporting-agent",
      input: "gather",
      operationKey: "op-email-worker",
    });
    const narrowed = await service.spawn({
      actor: { ...actor, runId: fire.task.taskId },
      agentDefinitionId: "reporting-agent",
      input: "gather",
      operationKey: "op-email-narrowed",
      tools: ["fixture.write"],
    });
    const nested = await service.spawn({
      actor: { ...actor, runId: whole.workerTaskId },
      agentDefinitionId: "reporting-agent",
      input: "gather more",
      operationKey: "op-email-nested",
    });
    for (const worker of [whole, narrowed, nested])
      expect((await tasks.get(worker.workerTaskId))?.executionPolicy).toMatchObject({ readOnlyTools: true, schedulingWritesDenied: true });
  });

  it("scopes the operation key to the spawning principal", async () => {
    const { service } = build();
    await service.spawn({ actor, agentDefinitionId: "x", input: "a", operationKey: "op-1" });
    const other = await service.spawn({
      actor: { ...actor, principalId: "bob" },
      agentDefinitionId: "x",
      input: "a",
      operationKey: "op-1",
    });
    expect(other.created).toBe(true);
  });
});

describe("spawn: default tree limits", () => {
  it("refuses a fourth level of workers when no budget names a depth", async () => {
    const { service } = build();
    let runId = actor.runId;
    for (let level = 1; level <= DEFAULT_MAX_SPAWN_DEPTH; level += 1) {
      const spawned = await service.spawn({ actor: { ...actor, runId }, agentDefinitionId: "x", input: "a", operationKey: `op-${level}` });
      runId = spawned.workerTaskId;
    }
    await expect(
      service.spawn({ actor: { ...actor, runId }, agentDefinitionId: "x", input: "a", operationKey: "op-deep" }),
    ).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
  });

  it("refuses a sixth running worker in a tree — counted at every depth — until one ends", async () => {
    const { service, tasks } = build();
    const first = await service.spawn({ actor, agentDefinitionId: "x", input: "a", operationKey: "op-0" });
    const nested = { ...actor, runId: first.workerTaskId };
    for (let index = 1; index < DEFAULT_MAX_CONCURRENT_WORKERS; index += 1) {
      await service.spawn({ actor: index % 2 === 0 ? actor : nested, agentDefinitionId: "x", input: "a", operationKey: `op-${index}` });
    }
    await expect(service.spawn({ actor, agentDefinitionId: "x", input: "a", operationKey: "op-over" })).rejects.toMatchObject({
      code: "QUOTA_EXCEEDED",
    });
    await expect(
      service.spawn({ actor: nested, agentDefinitionId: "x", input: "a", operationKey: "op-over-nested" }),
    ).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
    await tasks.updateStatus(first.workerTaskId, "completed", "done");
    expect((await service.spawn({ actor, agentDefinitionId: "x", input: "a", operationKey: "op-after" })).created).toBe(true);
  });

  it("answers a full tree's retried spawn with its worker, and counts each tree apart", async () => {
    const { service } = build();
    for (let index = 0; index < DEFAULT_MAX_CONCURRENT_WORKERS; index += 1) {
      await service.spawn({ actor, agentDefinitionId: "x", input: "a", operationKey: `op-${index}` });
    }
    expect((await service.spawn({ actor, agentDefinitionId: "x", input: "a", operationKey: "op-0" })).created).toBe(false);
    expect(
      (await service.spawn({ actor: { ...actor, runId: "t-other-chat" }, agentDefinitionId: "x", input: "a", operationKey: "op-other" }))
        .created,
    ).toBe(true);
  });

  it("lets a budget narrow the defaults but never widen them", async () => {
    const { service } = build();
    let runId = actor.runId;
    for (let level = 1; level <= DEFAULT_MAX_SPAWN_DEPTH; level += 1) {
      runId = (
        await service.spawn({
          actor: { ...actor, runId },
          agentDefinitionId: "x",
          input: "a",
          operationKey: `deep-${level}`,
          budget: { maxSpawnDepth: 10 },
        })
      ).workerTaskId;
    }
    await expect(
      service.spawn({
        actor: { ...actor, runId },
        agentDefinitionId: "x",
        input: "a",
        operationKey: "deep-over",
        budget: { maxSpawnDepth: 10 },
      }),
    ).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
  });

  it("lets a budget narrow the concurrent workers", async () => {
    const { service } = build();
    await service.spawn({ actor, agentDefinitionId: "x", input: "a", operationKey: "op-1", budget: { maxConcurrentWorkers: 1 } });
    await expect(
      service.spawn({ actor, agentDefinitionId: "x", input: "a", operationKey: "op-2", budget: { maxConcurrentWorkers: 1 } }),
    ).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
  });
});

describe("spawn: delegated budget enforcement (maxSpawnDepth)", () => {
  it("records depth 1 for a root spawn with no budget, and stores no budget (the defaults apply)", async () => {
    const { service, delegations } = build();
    const result = await service.spawn({ actor, agentDefinitionId: "x", input: "a", operationKey: "op-1" });
    const record = await delegations.getByWorkerTaskId(result.workerTaskId);
    expect(record?.depth).toBe(1);
    expect(record?.budget).toBeUndefined();
  });

  it("inherits the parent's budget unchanged when the child spawn doesn't restate it, and increments depth per hop", async () => {
    const { service, delegations } = build();
    const root = await service.spawn({
      actor,
      agentDefinitionId: "x",
      input: "a",
      operationKey: "op-1",
      budget: { maxSpawnDepth: 3 },
    });
    const rootRecord = await delegations.getByWorkerTaskId(root.workerTaskId);
    expect(rootRecord?.depth).toBe(1);
    expect(rootRecord?.budget).toEqual({ maxSpawnDepth: 3 });

    // The root worker itself spawns a grandchild — no `budget` restated.
    const childActor: AgentActor = { principalId: "alice", workspaceId: "w1", runId: root.workerTaskId, caller: "cli" };
    const child = await service.spawn({ actor: childActor, agentDefinitionId: "x", input: "b", operationKey: "op-2" });
    const childRecord = await delegations.getByWorkerTaskId(child.workerTaskId);
    expect(childRecord?.depth).toBe(2);
    expect(rootRecord).toMatchObject({ parentTaskId: "t-orchestrator", rootTaskId: "t-orchestrator" });
    expect(childRecord).toMatchObject({ parentTaskId: root.workerTaskId, rootTaskId: "t-orchestrator" });
    expect((await delegations.listChildren("w1", root.workerTaskId, 10)).map((row) => row.workerTaskId)).toEqual([child.workerTaskId]);
    // Inherited from the root, not dropped just because this call omitted it.
    expect(childRecord?.budget).toEqual({ maxSpawnDepth: 3 });
  });

  it("rejects a spawn that would exceed the delegated budget's maxSpawnDepth with QUOTA_EXCEEDED", async () => {
    const { service, delegations } = build();
    const root = await service.spawn({
      actor,
      agentDefinitionId: "x",
      input: "a",
      operationKey: "op-1",
      budget: { maxSpawnDepth: 1 },
    });
    expect((await delegations.getByWorkerTaskId(root.workerTaskId))?.depth).toBe(1);

    const childActor: AgentActor = { principalId: "alice", workspaceId: "w1", runId: root.workerTaskId, caller: "cli" };
    await expect(service.spawn({ actor: childActor, agentDefinitionId: "x", input: "b", operationKey: "op-2" })).rejects.toMatchObject({
      code: "QUOTA_EXCEEDED",
    });
  });

  it("lets a child spawn narrow (but not need to widen) the inherited budget by restating it explicitly", async () => {
    const { service, delegations } = build();
    const root = await service.spawn({
      actor,
      agentDefinitionId: "x",
      input: "a",
      operationKey: "op-1",
      budget: { maxSpawnDepth: 5 },
    });
    const childActor: AgentActor = { principalId: "alice", workspaceId: "w1", runId: root.workerTaskId, caller: "cli" };
    const child = await service.spawn({
      actor: childActor,
      agentDefinitionId: "x",
      input: "b",
      operationKey: "op-2",
      budget: { maxSpawnDepth: 2 },
    });
    const childRecord = await delegations.getByWorkerTaskId(child.workerTaskId);
    expect(childRecord?.depth).toBe(2);
    expect(childRecord?.budget).toEqual({ maxSpawnDepth: 2 });

    // The grandchild is now at depth 3, which the narrowed budget forbids —
    // even though the ROOT's own maxSpawnDepth (5) would have allowed it.
    const grandchildActor: AgentActor = { principalId: "alice", workspaceId: "w1", runId: child.workerTaskId, caller: "cli" };
    await expect(service.spawn({ actor: grandchildActor, agentDefinitionId: "x", input: "c", operationKey: "op-3" })).rejects.toMatchObject(
      { code: "QUOTA_EXCEEDED" },
    );
  });

  it("does not let an explicit budget: {} bypass inherited budget enforcement", async () => {
    // `input.budget ?? callerDelegation?.budget` would treat `{}` (every field omitted, but the object itself
    // present) as "fully specified, nothing to inherit" — silently
    // discarding the parent's own `maxSpawnDepth` and persisting an
    // unbounded-looking budget for this worker's OWN descendants to
    // inherit from.
    const { service, delegations } = build();
    const root = await service.spawn({
      actor,
      agentDefinitionId: "x",
      input: "a",
      operationKey: "op-1",
      budget: { maxSpawnDepth: 1 },
    });
    const childActor: AgentActor = { principalId: "alice", workspaceId: "w1", runId: root.workerTaskId, caller: "cli" };
    await expect(
      service.spawn({ actor: childActor, agentDefinitionId: "x", input: "b", operationKey: "op-2", budget: {} }),
    ).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
    // Nothing was persisted for the rejected spawn to leave a bypassed
    // budget behind for a later retry to inherit from.
    expect(await delegations.getByOperationKey("w1", "alice", "op-2")).toBeUndefined();
  });

  it("does not let a child spawn WIDEN the inherited budget past what the caller itself was bound by", async () => {
    const { service, delegations } = build();
    const root = await service.spawn({
      actor,
      agentDefinitionId: "x",
      input: "a",
      operationKey: "op-1",
      budget: { maxSpawnDepth: 2 },
    });
    const childActor: AgentActor = { principalId: "alice", workspaceId: "w1", runId: root.workerTaskId, caller: "cli" };
    const child = await service.spawn({
      actor: childActor,
      agentDefinitionId: "x",
      input: "b",
      operationKey: "op-2",
      // Attempts to widen past the inherited cap of 2 — merges down to 2, not up to 999.
      budget: { maxSpawnDepth: 999 },
    });
    expect((await delegations.getByWorkerTaskId(child.workerTaskId))?.budget).toEqual({ maxSpawnDepth: 2 });

    // Depth 3 (the grandchild) still exceeds the un-widened cap of 2.
    const grandchildActor: AgentActor = { principalId: "alice", workspaceId: "w1", runId: child.workerTaskId, caller: "cli" };
    await expect(service.spawn({ actor: grandchildActor, agentDefinitionId: "x", input: "c", operationKey: "op-3" })).rejects.toMatchObject(
      { code: "QUOTA_EXCEEDED" },
    );
  });
});

describe("spawn: worker-scoped memory delegation", () => {
  it("sets memoryScopeRestricted unconditionally on a worker's first-admission context, with no sharedMemoryRecordIds granted", async () => {
    const { service, workflow } = build();
    await service.spawn({ actor, agentDefinitionId: "x", input: "a", operationKey: "op-1" });
    const start = workflow.calls.find((c) => c.kind === "start");
    expect(start?.context.memoryScopeRestricted).toBe(true);
    expect(start?.context.delegatedMemoryRecordIds).toBeUndefined();
  });

  it("threads sharedMemoryRecordIds into delegatedMemoryRecordIds on the worker's first-admission context", async () => {
    const memory = createFixtureMemory(["mem-1", "mem-2"]);
    const { service, workflow } = build({ memory });
    await service.spawn({
      actor,
      agentDefinitionId: "x",
      input: "a",
      operationKey: "op-1",
      sharedMemoryRecordIds: ["mem-1", "mem-2"],
    });
    const start = workflow.calls.find((c) => c.kind === "start");
    expect(start?.context.memoryScopeRestricted).toBe(true);
    expect(start?.context.delegatedMemoryRecordIds).toEqual(["mem-1", "mem-2"]);
    // Each requested id was validated under the spawning actor's own identity.
    expect(memory.getCalls.map((c) => c.recordId)).toEqual(["mem-1", "mem-2"]);
    expect(memory.getCalls.every((c) => c.actor.principalId === actor.principalId)).toBe(true);
  });

  it("rejects sharedMemoryRecordIds when the spawning actor cannot itself read one of them", async () => {
    const memory = createFixtureMemory(["mem-1"]);
    const { service } = build({ memory });
    await expect(
      service.spawn({
        actor,
        agentDefinitionId: "x",
        input: "a",
        operationKey: "op-1",
        sharedMemoryRecordIds: ["mem-1", "mem-unreadable"],
      }),
    ).rejects.toThrow(/mem-unreadable/);
  });

  it("rejects sharedMemoryRecordIds when no memory service is configured", async () => {
    const { service } = build();
    await expect(
      service.spawn({ actor, agentDefinitionId: "x", input: "a", operationKey: "op-1", sharedMemoryRecordIds: ["mem-1"] }),
    ).rejects.toThrow(/no memory service/);
  });

  it("rejects a sharedMemoryRecordIds list over MAX_SHARED_MEMORY_RECORD_IDS", async () => {
    const { service } = build();
    const tooMany = Array.from({ length: MAX_SHARED_MEMORY_RECORD_IDS + 1 }, (_, i) => `mem-${i}`);
    await expect(
      service.spawn({ actor, agentDefinitionId: "x", input: "a", operationKey: "op-1", sharedMemoryRecordIds: tooMany }),
    ).rejects.toThrow(TaviError);
  });

  it("re-applies memoryScopeRestricted/delegatedMemoryRecordIds via contextFrom on a worker's later turn (wake), not only at spawn", async () => {
    const memory = createFixtureMemory(["mem-1"]);
    const { service, workflow } = build({ memory });
    const { workerTaskId } = await service.spawn({
      actor,
      agentDefinitionId: "x",
      input: "a",
      operationKey: "op-1",
      sharedMemoryRecordIds: ["mem-1"],
    });

    // A second admission against the SAME worker task, well after spawn —
    // this is exactly the "checkpointed invocation has no reducer, so a
    // later admission's context fully replaces the first one" risk the
    // contextFrom fix exists to close (it holds for
    // send/wake/deliverAndWake/assertPeerGrant alike).
    await service.wake({ actor, taskId: workerTaskId });
    const wakeCall = workflow.calls.findLast((c) => c.kind === "reply" && c.taskId === workerTaskId);
    expect(wakeCall?.context.memoryScopeRestricted).toBe(true);
    expect(wakeCall?.context.delegatedMemoryRecordIds).toEqual(["mem-1"]);
  });

  it("names the chat a worker belongs to on its first turn and every later one, and a grandchild's as the same chat", async () => {
    const { service, workflow } = build();
    const child = await service.spawn({ actor, agentDefinitionId: "x", input: "a", operationKey: "op-1" });
    expect(workflow.calls.find((c) => c.kind === "start")?.context.chatTaskId).toBe(actor.runId);
    await service.wake({ actor, taskId: child.workerTaskId });
    expect(workflow.calls.findLast((c) => c.kind === "reply" && c.taskId === child.workerTaskId)?.context.chatTaskId).toBe(actor.runId);
    // A worker's own worker belongs to the same chat, not to the worker that spawned it.
    const grandchild = await service.spawn({
      actor: { ...actor, runId: child.workerTaskId },
      agentDefinitionId: "x",
      input: "b",
      operationKey: "op-2",
    });
    expect(workflow.calls.findLast((c) => c.kind === "start")?.context.chatTaskId).toBe(actor.runId);
    await service.wake({ actor, taskId: grandchild.workerTaskId });
    expect(workflow.calls.findLast((c) => c.kind === "reply" && c.taskId === grandchild.workerTaskId)?.context.chatTaskId).toBe(
      actor.runId,
    );
  });

  it("validates a restricted worker's own spawn() call against its OWN delegation grant, not an unrestricted read", async () => {
    // mem-1 is readable workspace-wide by this fixture; mem-2 is not
    // granted to worker-a at all. worker-a was itself spawned restricted
    // to ["mem-1"] only — its own attempt to grant a grandchild mem-2 must
    // be validated against ITS restriction, not an unrestricted read of
    // its principal's full scope.
    const memory = createFixtureMemory(["mem-1", "mem-2"]);
    const { service } = build({ memory });
    const { workerTaskId } = await service.spawn({
      actor,
      agentDefinitionId: "x",
      input: "a",
      operationKey: "op-parent",
      sharedMemoryRecordIds: ["mem-1"],
    });
    memory.getCalls.length = 0;

    const restrictedActor: AgentActor = { ...workerA, runId: workerTaskId };
    await service.spawn({
      actor: restrictedActor,
      agentDefinitionId: "x",
      input: "a",
      operationKey: "op-grandchild",
      sharedMemoryRecordIds: ["mem-2"],
    });

    expect(memory.getCalls).toHaveLength(1);
    expect(memory.getCalls[0]?.actor.scopeRestricted).toBe(true);
    expect(memory.getCalls[0]?.actor.allowedRecordIds).toEqual(["mem-1"]);
  });
});

describe("send/receive/ack", () => {
  it("delivers a sent envelope to the recipient's mailbox and wakes it by default", async () => {
    const { service, workflow, mailbox } = build();
    const { workerTaskId } = await service.spawn({ actor, agentDefinitionId: "x", input: "a", operationKey: "op-1" });

    const sent = await service.send({
      actor,
      recipientAgentId: "worker-1",
      recipientTaskId: workerTaskId,
      kind: "message",
      content: "hello worker",
    });
    expect(sent.accepted).toBe(true);

    const received = await service.receive({ actor, taskId: workerTaskId, limit: 10 });
    expect(received.envelopes).toHaveLength(1);
    expect(received.envelopes[0]?.content).toBe("hello worker");
    const messageId = received.envelopes[0]?.messageId ?? "";
    expect((await mailbox.getEnvelope(messageId))?.deliveryState).toBe("delivered");

    // A "reply" admission was requested for the recipient's task (the default wake).
    expect(workflow.calls.some((c) => c.kind === "reply" && c.taskId === workerTaskId)).toBe(true);

    await service.ack({
      actor,
      taskId: workerTaskId,
      leaseId: received.leaseId,
      acknowledgedMessageIds: [received.envelopes[0]?.messageId ?? ""],
    });
    const afterAck = await service.receive({ actor, taskId: workerTaskId, limit: 10 });
    expect(afterAck.envelopes).toHaveLength(0);
  });

  it("does not wake the recipient when wake is 'none'", async () => {
    const { service, workflow } = build();
    const { workerTaskId } = await service.spawn({ actor, agentDefinitionId: "x", input: "a", operationKey: "op-1" });
    const callsBefore = workflow.calls.length;
    await service.send({
      actor,
      recipientAgentId: "worker-1",
      recipientTaskId: workerTaskId,
      kind: "message",
      content: "hi",
      wake: "none",
    });
    expect(workflow.calls).toHaveLength(callsBefore);
  });

  it("settles a matching active wait and admits kind: 'deadline' with resume.waitOutcome, instead of the generic wake", async () => {
    const { service, workflow, waits, tasks } = build();
    await admitOrchestratorTask(tasks);
    const { workerTaskId, workerAgentId } = await service.spawn({ actor, agentDefinitionId: "x", input: "a", operationKey: "op-1" });
    const correlationId = `worker-result:${workerTaskId}`;
    await waits.prepare({ waitId: "wait-1", taskId: "t-orchestrator", correlationId, deadlineAt: "2026-01-01T00:05:00.000Z" });
    await waits.activate("wait-1");

    // A worker's own result to its parent, under its own worker-result correlation.
    await service.send({
      actor: { ...actor, runId: workerTaskId, agentId: workerAgentId },
      recipientAgentId: "t-orchestrator",
      recipientTaskId: "t-orchestrator",
      kind: "result",
      content: "the answer",
      correlationId,
    });

    expect((await waits.get("wait-1"))?.state).toBe("settled");
    expect((await waits.get("wait-1"))?.settledOutcome?.kind).toBe("replied");
    const deadlineCall = workflow.calls.find((c) => c.kind === "deadline" && c.taskId === "t-orchestrator");
    expect(deadlineCall).toBeDefined();
    expect(deadlineCall?.resume?.waitOutcome?.kind).toBe("replied");
    // No generic "reply" wake admission for this delivery — the wait-aware
    // path replaces it, not runs alongside it.
    expect(workflow.calls.some((c) => c.kind === "reply" && c.taskId === "t-orchestrator")).toBe(false);
  });

  it("delivers any other result as a message: a parent's, or one under another correlation id, settles no wait", async () => {
    const { service, workflow, waits, tasks } = build();
    await admitOrchestratorTask(tasks);
    const { workerTaskId, workerAgentId } = await service.spawn({ actor, agentDefinitionId: "x", input: "a", operationKey: "op-1" });
    await waits.prepare({ waitId: "wait-w", taskId: workerTaskId, correlationId: "c1", deadlineAt: "2026-01-01T00:05:00.000Z" });
    await waits.activate("wait-w");
    await waits.prepare({ waitId: "wait-o", taskId: "t-orchestrator", correlationId: "c2", deadlineAt: "2026-01-01T00:05:00.000Z" });
    await waits.activate("wait-o");

    // The parent is no delegated child of its worker.
    await service.send({
      actor,
      recipientAgentId: "worker-1",
      recipientTaskId: workerTaskId,
      kind: "result",
      content: "x",
      correlationId: "c1",
    });
    // The worker's result under a correlation id that is not its own worker-result one.
    await service.send({
      actor: { ...actor, runId: workerTaskId, agentId: workerAgentId },
      recipientAgentId: "t-orchestrator",
      recipientTaskId: "t-orchestrator",
      kind: "result",
      content: "y",
      correlationId: "c2",
    });

    expect((await waits.get("wait-w"))?.state).toBe("active");
    expect((await waits.get("wait-o"))?.state).toBe("active");
    expect(workflow.calls.some((c) => c.kind === "deadline")).toBe(false);
  });

  it("falls back to the generic wake when no active wait matches the correlation id", async () => {
    const { service, workflow } = build();
    const { workerTaskId } = await service.spawn({ actor, agentDefinitionId: "x", input: "a", operationKey: "op-1" });
    await service.send({
      actor,
      recipientAgentId: "worker-1",
      recipientTaskId: workerTaskId,
      kind: "message",
      content: "hi",
      correlationId: "no-such-wait",
    });
    expect(workflow.calls.some((c) => c.kind === "reply" && c.taskId === workerTaskId)).toBe(true);
    expect(workflow.calls.some((c) => c.kind === "deadline")).toBe(false);
  });

  it("refuses to send without a sender task id on the actor", async () => {
    const { service } = build();
    await expect(
      service.send({ actor: { ...actor, runId: undefined }, recipientAgentId: "w", recipientTaskId: "t", kind: "message", content: "x" }),
    ).rejects.toThrow(/runId/);
  });
});

describe("status/cancel", () => {
  it("reports a spawned worker's status", async () => {
    const { service } = build();
    const { workerTaskId } = await service.spawn({ actor, agentDefinitionId: "x", input: "a", operationKey: "op-1" });
    const status = await service.status({ actor, taskId: workerTaskId });
    expect(status.taskId).toBe(workerTaskId);
    expect(typeof status.status).toBe("string");
  });

  it("throws NOT_FOUND for an unknown task", async () => {
    const { service } = build();
    await expect(service.status({ actor, taskId: "no-such-task" })).rejects.toThrow(TaviError);
  });

  it("delegates cancellation to the injected cancelTask callback", async () => {
    const { service, cancelled } = build();
    const { workerTaskId } = await service.spawn({ actor, agentDefinitionId: "x", input: "a", operationKey: "op-1" });
    await service.cancel({ actor, taskId: workerTaskId, reason: "no longer needed" });
    expect(cancelled).toEqual([{ taskId: workerTaskId, reason: "no longer needed", operator: "cli" }]);
    const status = await service.status({ actor, taskId: workerTaskId });
    expect(status.status).toBe("cancelled");
  });
});

describe("waitFor", () => {
  it("settles immediately when a correlated reply is already in the mailbox", async () => {
    const { service, mailbox, tasks } = build();
    await admitOrchestratorTask(tasks);
    const { workerTaskId } = await service.spawn({ actor, agentDefinitionId: "x", input: "a", operationKey: "op-1" });
    await mailbox.insertEnvelope({
      messageId: "m1",
      protocolVersion: 1,
      workspaceId: "w1",
      senderAgentId: "worker-1",
      senderTaskId: workerTaskId,
      recipientAgentId: "orchestrator",
      recipientTaskId: "t-orchestrator",
      kind: "reply",
      correlationId: "c1",
      createdAt: AT,
      deliveryState: "pending",
      retentionState: "active",
    });
    const result = await service.waitFor({ actor, taskId: "t-orchestrator", correlationId: "c1", deadlineAt: "2026-01-01T00:05:00.000Z" });
    expect(result.outcome.kind).toBe("replied");
    expect(result.outcome.envelope?.messageId).toBe("m1");
  });

  it("settles immediately when the awaited worker task has already completed", async () => {
    const { service, tasks } = build();
    await admitOrchestratorTask(tasks);
    const { workerTaskId } = await service.spawn({ actor, agentDefinitionId: "x", input: "a", operationKey: "op-1" });
    await tasks.updateStatus(workerTaskId, "completed", "done");
    const result = await service.waitFor({
      actor,
      taskId: "t-orchestrator",
      waitingOnWorkerTaskId: workerTaskId,
      deadlineAt: "2026-01-01T00:05:00.000Z",
    });
    expect(result.outcome.kind).toBe("worker-completed");
  });

  it("settles worker-failed when the awaited worker task has failed", async () => {
    const { service, tasks } = build();
    await admitOrchestratorTask(tasks);
    const { workerTaskId } = await service.spawn({ actor, agentDefinitionId: "x", input: "a", operationKey: "op-1" });
    await tasks.updateStatus(workerTaskId, "failed", "boom");
    const result = await service.waitFor({
      actor,
      taskId: "t-orchestrator",
      waitingOnWorkerTaskId: workerTaskId,
      deadlineAt: "2026-01-01T00:05:00.000Z",
    });
    expect(result.outcome.kind).toBe("worker-failed");
  });

  it("settles worker-failed when the awaited worker was stopped: it delivered nothing, and no wait hangs on it", async () => {
    const { service, tasks } = build();
    await admitOrchestratorTask(tasks);
    const { workerTaskId } = await service.spawn({ actor, agentDefinitionId: "x", input: "a", operationKey: "op-1" });
    await tasks.updateStatus(workerTaskId, "stopped", null);
    const result = await service.waitFor({
      actor,
      taskId: "t-orchestrator",
      waitingOnWorkerTaskId: workerTaskId,
      deadlineAt: "2026-01-01T00:05:00.000Z",
    });
    expect(result.outcome.kind).toBe("worker-failed");
  });

  it("registers a durable wait row and throws WorkflowWaitSuspend when nothing settles immediately", async () => {
    const { service, waits, tasks } = build();
    await admitOrchestratorTask(tasks);
    let thrown: unknown;
    try {
      await service.waitFor({ actor, taskId: "t-orchestrator", deadlineAt: "2026-01-01T00:05:00.000Z" });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(WorkflowWaitSuspend);
    expect((thrown as WorkflowWaitSuspend).waitId).toBeTruthy();
    // A wait row was still registered durably, active, for future work to pick up.
    const overdue = await waits.listActivePastDeadline("2026-01-01T00:05:00.001Z");
    expect(overdue).toHaveLength(1);
  });

  it("a caller-supplied waitId is used verbatim, not replaced with a fresh one", async () => {
    const { service, waits, tasks } = build();
    await admitOrchestratorTask(tasks);
    let thrown: unknown;
    try {
      await service.waitFor({
        actor,
        taskId: "t-orchestrator",
        deadlineAt: "2026-01-01T00:05:00.000Z",
        waitId: "wait:t-orchestrator:call-1",
      });
    } catch (error) {
      thrown = error;
    }
    expect((thrown as WorkflowWaitSuspend).waitId).toBe("wait:t-orchestrator:call-1");
    expect((await waits.get("wait:t-orchestrator:call-1"))?.state).toBe("active");
  });

  it("short-circuits on a durable row already settled under the given waitId, without re-registering", async () => {
    const { service, waits, tasks } = build();
    await admitOrchestratorTask(tasks);
    await waits.prepare({ waitId: "wait:t-orchestrator:call-1", taskId: "t-orchestrator", deadlineAt: "2026-01-01T00:05:00.000Z" });
    await waits.activate("wait:t-orchestrator:call-1");
    await waits.settle({ waitId: "wait:t-orchestrator:call-1", outcome: { kind: "wait-timeout" } });

    const result = await service.waitFor({
      actor,
      taskId: "t-orchestrator",
      deadlineAt: "2026-01-01T00:05:00.000Z",
      waitId: "wait:t-orchestrator:call-1",
    });
    expect(result).toEqual({ waitId: "wait:t-orchestrator:call-1", outcome: { kind: "wait-timeout" } });
  });

  it("registering the same waitId twice (a replayed graph node) is a safe no-op, not a duplicate-row error", async () => {
    const { service, tasks } = build();
    await admitOrchestratorTask(tasks);
    const attempt = async (): Promise<unknown> => {
      try {
        await service.waitFor({
          actor,
          taskId: "t-orchestrator",
          deadlineAt: "2026-01-01T00:05:00.000Z",
          waitId: "wait:t-orchestrator:call-1",
        });
        return undefined;
      } catch (error) {
        return error;
      }
    };
    const first = await attempt();
    const second = await attempt();
    expect(first).toBeInstanceOf(WorkflowWaitSuspend);
    expect(second).toBeInstanceOf(WorkflowWaitSuspend);
    expect((first as WorkflowWaitSuspend).waitId).toBe((second as WorkflowWaitSuspend).waitId);
  });

  it("caps a bounded worker's requested deadline at its delegated budget's expiresAt", async () => {
    const { service, tasks, waits } = build();
    await admitOrchestratorTask(tasks);
    const { workerTaskId } = await service.spawn({
      actor,
      agentDefinitionId: "x",
      input: "a",
      operationKey: "op-1",
      budget: { expiresAt: "2026-01-01T00:02:00.000Z" },
    });
    const workerActor: AgentActor = { principalId: "alice", workspaceId: "w1", runId: workerTaskId, caller: "cli" };
    let thrown: unknown;
    try {
      // Requests a deadline far past what the delegating orchestrator allowed.
      await service.waitFor({ actor: workerActor, taskId: workerTaskId, deadlineAt: "2026-01-01T00:10:00.000Z" });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(WorkflowWaitSuspend);
    expect((thrown as WorkflowWaitSuspend).deadlineAt).toBe("2026-01-01T00:02:00.000Z");
    // The persisted wait row must agree with the thrown payload — not
    // merely today's coincidence of sharing one local variable.
    expect((await waits.get((thrown as WorkflowWaitSuspend).waitId))?.deadlineAt).toBe("2026-01-01T00:02:00.000Z");
  });

  it("does not widen a caller-supplied deadline that is already earlier than the budget's expiresAt", async () => {
    const { service, tasks } = build();
    await admitOrchestratorTask(tasks);
    const { workerTaskId } = await service.spawn({
      actor,
      agentDefinitionId: "x",
      input: "a",
      operationKey: "op-1",
      budget: { expiresAt: "2026-01-01T00:10:00.000Z" },
    });
    const workerActor: AgentActor = { principalId: "alice", workspaceId: "w1", runId: workerTaskId, caller: "cli" };
    let thrown: unknown;
    try {
      // Requests a deadline BEFORE the delegated budget's expiresAt — the
      // cap is a max-bound, not an unconditional override.
      await service.waitFor({ actor: workerActor, taskId: workerTaskId, deadlineAt: "2026-01-01T00:02:00.000Z" });
    } catch (error) {
      thrown = error;
    }
    expect((thrown as WorkflowWaitSuspend).deadlineAt).toBe("2026-01-01T00:02:00.000Z");
  });

  it("caps the persisted wait row's deadlineAt even when the wait settles immediately", async () => {
    const { service, tasks, mailbox, waits } = build();
    await admitOrchestratorTask(tasks);
    const { workerTaskId } = await service.spawn({
      actor,
      agentDefinitionId: "x",
      input: "a",
      operationKey: "op-1",
      budget: { expiresAt: "2026-01-01T00:02:00.000Z" },
    });
    const workerActor: AgentActor = { principalId: "alice", workspaceId: "w1", runId: workerTaskId, caller: "cli" };
    await mailbox.insertEnvelope({
      messageId: "m1",
      protocolVersion: 1,
      workspaceId: "w1",
      senderAgentId: "peer",
      senderTaskId: "t-peer",
      recipientAgentId: "worker",
      recipientTaskId: workerTaskId,
      kind: "reply",
      correlationId: "c1",
      createdAt: AT,
      deliveryState: "pending",
      retentionState: "active",
    });
    const result = await service.waitFor({
      actor: workerActor,
      taskId: workerTaskId,
      correlationId: "c1",
      deadlineAt: "2026-01-01T00:10:00.000Z", // far past the budget
    });
    expect(result.outcome.kind).toBe("replied");
    // `settleImmediately` shares `registerWait()` with the suspend path —
    // the durable row still reflects the capped deadline, not the raw
    // requested one.
    expect((await waits.get(result.waitId))?.deadlineAt).toBe("2026-01-01T00:02:00.000Z");
  });

  it("rejects a taskId that isn't the calling actor's own task, rather than trusting workspace membership alone", async () => {
    const { service, tasks } = build();
    await admitOrchestratorTask(tasks);
    await admitTask(tasks, "t-worker-b");
    // `workerA`'s runId is "t-worker-a", not "t-worker-b" — a same-workspace
    // task it does not itself run as.
    await expect(service.waitFor({ actor: workerA, taskId: "t-worker-b", deadlineAt: "2026-01-01T00:10:00.000Z" })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
  });

  it("does not cap the root orchestrator's own deadline — only a delegated worker is bounded", async () => {
    const { service, tasks } = build();
    await admitOrchestratorTask(tasks);
    // The root orchestrator task was never itself spawned, so it has no
    // delegation row and no budget to cap it — "root-task" literally.
    let thrown: unknown;
    try {
      await service.waitFor({ actor, taskId: "t-orchestrator", deadlineAt: "2026-01-01T00:10:00.000Z" });
    } catch (error) {
      thrown = error;
    }
    expect((thrown as WorkflowWaitSuspend).deadlineAt).toBe("2026-01-01T00:10:00.000Z");
  });
});

describe("request/reply", () => {
  it("delivers a request, and the reply settles the requester's matching agents.wait correlation", async () => {
    const { service, tasks, waits } = build();
    await admitTask(tasks, "t-worker-a");
    await admitTask(tasks, "t-worker-b");

    const requested = await service.request({
      actor: workerA,
      recipientAgentId: "worker-b",
      recipientTaskId: "t-worker-b",
      content: "what's the status?",
      deadlineAt: "2026-01-01T00:10:00.000Z",
    });
    expect(requested.accepted).toBe(true);

    // The requester now suspends via the unchanged agents.wait mechanism,
    // correlated on the request's own messageId.
    await expect(
      service.waitFor({ actor: workerA, taskId: "t-worker-a", correlationId: requested.messageId, deadlineAt: "2026-01-01T00:10:00.000Z" }),
    ).rejects.toBeInstanceOf(WorkflowWaitSuspend);
    expect((await waits.get((await waits.getActiveByCorrelation("t-worker-a", requested.messageId))?.waitId ?? ""))?.state).toBe("active");

    const replied = await service.reply({ actor: workerB, requestMessageId: requested.messageId, content: "all good" });
    expect(replied.accepted).toBe(true);

    // The wait settled directly (deliverAndWake's active-wait branch), not
    // merely a generic wake — re-calling waitFor with the same
    // correlation finds the durable settled row.
    const resumed = await service.waitFor({
      actor: workerA,
      taskId: "t-worker-a",
      correlationId: requested.messageId,
      deadlineAt: "2026-01-01T00:10:00.000Z",
    });
    expect(resumed.outcome.kind).toBe("replied");
    expect(resumed.outcome.envelope?.content).toBe("all good");
    expect(resumed.outcome.envelope?.kind).toBe("reply");
    // Stored as the schema reads it back — the wire envelope, not the mailbox
    // record: the SQLite store refuses a row whose outcome carries its
    // delivery bookkeeping, and a replay of the wait's node reads that row.
    expect(resumed.outcome.envelope).not.toHaveProperty("deliveryState");
    expect(AgentWaitOutcomeSchema.safeParse(resumed.outcome).success).toBe(true);
  });

  it("caps a bounded worker's request deadline (and its envelope expiresAt) at its delegated budget's expiresAt", async () => {
    const { service, tasks, mailbox } = build();
    await admitOrchestratorTask(tasks);
    await admitTask(tasks, "t-worker-b");
    const { workerTaskId } = await service.spawn({
      actor,
      agentDefinitionId: "x",
      input: "a",
      operationKey: "op-1",
      budget: { expiresAt: "2026-01-01T00:02:00.000Z" },
    });
    const workerActor: AgentActor = { principalId: "alice", workspaceId: "w1", agentId: "worker-a", runId: workerTaskId, caller: "cli" };
    const requested = await service.request({
      actor: workerActor,
      recipientAgentId: "worker-b",
      recipientTaskId: "t-worker-b",
      // Requests a deadline far past what the delegating orchestrator allowed.
      deadlineAt: "2026-01-01T00:10:00.000Z",
    });
    expect((await mailbox.getEnvelope(requested.messageId))?.expiresAt).toBe("2026-01-01T00:02:00.000Z");
  });

  it("does not widen a request's caller-supplied deadline that is already earlier than the budget's expiresAt", async () => {
    const { service, tasks, mailbox } = build();
    await admitOrchestratorTask(tasks);
    await admitTask(tasks, "t-worker-b");
    const { workerTaskId } = await service.spawn({
      actor,
      agentDefinitionId: "x",
      input: "a",
      operationKey: "op-1",
      budget: { expiresAt: "2026-01-01T00:10:00.000Z" },
    });
    const workerActor: AgentActor = { principalId: "alice", workspaceId: "w1", agentId: "worker-a", runId: workerTaskId, caller: "cli" };
    const requested = await service.request({
      actor: workerActor,
      recipientAgentId: "worker-b",
      recipientTaskId: "t-worker-b",
      // Requests a deadline BEFORE the delegated budget's expiresAt.
      deadlineAt: "2026-01-01T00:02:00.000Z",
    });
    expect((await mailbox.getEnvelope(requested.messageId))?.expiresAt).toBe("2026-01-01T00:02:00.000Z");
  });

  it("caps the expectedReplySchema entry's own eviction deadline, not just the envelope's expiresAt", async () => {
    // The schema entry is process-only state, so it can't be inspected
    // directly — proven indirectly instead: advance time PAST the capped
    // deadline but still BEFORE the raw requested one, trigger the
    // opportunistic prune with an unrelated call, then show a reply that
    // would fail the original schema is now accepted anyway — the entry
    // was evicted using the CAPPED deadline, not the uncapped one.
    const currentTime = { value: AT };
    const { service, tasks } = build({ now: () => currentTime.value });
    await admitOrchestratorTask(tasks);
    await admitTask(tasks, "t-worker-b");
    const { workerTaskId } = await service.spawn({
      actor,
      agentDefinitionId: "x",
      input: "a",
      operationKey: "op-1",
      budget: { expiresAt: "2026-01-01T00:02:00.000Z" },
    });
    const workerActor: AgentActor = { principalId: "alice", workspaceId: "w1", agentId: "worker-a", runId: workerTaskId, caller: "cli" };
    const alwaysFails = { safeParse: () => ({ success: false, error: { message: "never matches" } }) };
    const requested = await service.request({
      actor: workerActor,
      recipientAgentId: "worker-b",
      recipientTaskId: "t-worker-b",
      expectedReplySchema: alwaysFails,
      deadlineAt: "2026-01-01T00:10:00.000Z", // far past the budget's cap of :02:00
    });

    // Between the capped deadline (:02:00) and the raw requested one (:10:00).
    currentTime.value = "2026-01-01T00:05:00.000Z";
    // pruneExpiredReplySchemas runs opportunistically at the top of the
    // next request() call.
    await service.request({
      actor: workerActor,
      recipientAgentId: "worker-b",
      recipientTaskId: "t-worker-b",
      deadlineAt: "2026-01-01T00:10:00.000Z",
    });

    const workerBActor: AgentActor = { principalId: "alice", workspaceId: "w1", agentId: "worker-b", runId: "t-worker-b", caller: "cli" };
    const replied = await service.reply({ actor: workerBActor, requestMessageId: requested.messageId, content: "anything" });
    expect(replied.accepted).toBe(true);
  });

  it("a plain agents.send cannot settle an active agents.request wait by spoofing its correlationId", async () => {
    // The gap this test guards: send() requires no agentMessageGrant and
    // never touches expectedReplySchema, so without a kind filter in
    // deliverAndWake, any co-workspace task that learned a pending
    // request's messageId could settle it via agents.send, bypassing both
    // guarantees reply() exists to enforce.
    const { service, tasks, waits } = build();
    await admitTask(tasks, "t-worker-a");
    await admitTask(tasks, "t-worker-b");
    const requested = await service.request({
      actor: workerA,
      recipientAgentId: "worker-b",
      recipientTaskId: "t-worker-b",
      deadlineAt: "2026-01-01T00:10:00.000Z",
    });
    await expect(
      service.waitFor({ actor: workerA, taskId: "t-worker-a", correlationId: requested.messageId, deadlineAt: "2026-01-01T00:10:00.000Z" }),
    ).rejects.toBeInstanceOf(WorkflowWaitSuspend);
    const waitId = (await waits.getActiveByCorrelation("t-worker-a", requested.messageId))?.waitId ?? "";
    expect((await waits.get(waitId))?.state).toBe("active");

    await service.send({
      actor: workerB,
      recipientAgentId: "worker-a",
      recipientTaskId: "t-worker-a",
      kind: "message",
      correlationId: requested.messageId,
      content: "not a real reply",
    });

    // Still active: a plain "message" envelope must never settle it.
    expect((await waits.get(waitId))?.state).toBe("active");

    // Nor a "result": only a delegated child's own `worker-result:<id>`
    // settles a wait, so a peer's answer still goes through reply().
    await service.send({
      actor: workerB,
      recipientAgentId: "worker-a",
      recipientTaskId: "t-worker-a",
      kind: "result",
      correlationId: requested.messageId,
      content: "a spoofed result",
    });
    expect((await waits.get(waitId))?.state).toBe("active");

    await service.reply({ actor: workerB, requestMessageId: requested.messageId, content: "a real reply" });
    expect((await waits.get(waitId))?.state).toBe("settled");
    expect((await waits.get(waitId))?.settledOutcome?.envelope?.content).toBe("a real reply");
  });

  it("a peer's result already in the mailbox does not settle a later agents.wait on the request either", async () => {
    const { service, tasks } = build();
    await admitTask(tasks, "t-worker-a");
    await admitTask(tasks, "t-worker-b");
    const requested = await service.request({
      actor: workerA,
      recipientAgentId: "worker-b",
      recipientTaskId: "t-worker-b",
      deadlineAt: "2026-01-01T00:10:00.000Z",
    });
    await service.send({
      actor: workerB,
      recipientAgentId: "worker-a",
      recipientTaskId: "t-worker-a",
      kind: "result",
      correlationId: requested.messageId,
      content: "a spoofed result",
      wake: "none",
    });
    await expect(
      service.waitFor({ actor: workerA, taskId: "t-worker-a", correlationId: requested.messageId, deadlineAt: "2026-01-01T00:10:00.000Z" }),
    ).rejects.toBeInstanceOf(WorkflowWaitSuspend);
  });

  it("a peer that is no delegated child of the waiter cannot settle its wait with a result under its own worker-result id", async () => {
    const { service, tasks, waits } = build();
    await admitTask(tasks, "t-worker-a");
    await admitTask(tasks, "t-worker-b");
    const correlationId = "worker-result:t-worker-b";
    await waits.prepare({ waitId: "wait-a", taskId: "t-worker-a", correlationId, deadlineAt: "2026-01-01T00:10:00.000Z" });
    await waits.activate("wait-a");

    await service.send({
      actor: workerB,
      recipientAgentId: "worker-a",
      recipientTaskId: "t-worker-a",
      kind: "result",
      correlationId,
      content: "a spoofed worker result",
    });

    expect((await waits.get("wait-a"))?.state).toBe("active");
    await expect(
      service.waitFor({ actor: workerA, taskId: "t-worker-a", correlationId, deadlineAt: "2026-01-01T00:10:00.000Z" }),
    ).rejects.toBeInstanceOf(WorkflowWaitSuspend);
  });

  it("rejects a request without the recipient's explicit agentMessageGrant", async () => {
    const { service, tasks } = build({ deniedPermissions: [agentMessageGrant("worker-b")] });
    await admitTask(tasks, "t-worker-a");
    await admitTask(tasks, "t-worker-b");

    await expect(
      service.request({
        actor: workerA,
        recipientAgentId: "worker-b",
        recipientTaskId: "t-worker-b",
        deadlineAt: "2026-01-01T00:10:00.000Z",
      }),
    ).rejects.toThrow(/not granted/);
  });

  it("rejects a reply without the requester's explicit agentMessageGrant", async () => {
    const { service, tasks } = build();
    await admitTask(tasks, "t-worker-a");
    await admitTask(tasks, "t-worker-b");
    const requested = await service.request({
      actor: workerA,
      recipientAgentId: "worker-b",
      recipientTaskId: "t-worker-b",
      deadlineAt: "2026-01-01T00:10:00.000Z",
    });

    const { service: deniedService, mailbox } = build({ deniedPermissions: [agentMessageGrant("worker-a")] });
    // Reuse the same request envelope across the two independently-built
    // services by inserting it into the denied-service's own mailbox —
    // simplest way to get an authorization-denying `access` fixture
    // without threading it through `build()`'s single shared instance.
    await mailbox.insertEnvelope({
      messageId: requested.messageId,
      protocolVersion: 1,
      workspaceId: "w1",
      senderAgentId: "worker-a",
      senderTaskId: "t-worker-a",
      recipientAgentId: "worker-b",
      recipientTaskId: "t-worker-b",
      kind: "request",
      correlationId: requested.messageId,
      createdAt: AT,
      deliveryState: "pending",
      retentionState: "active",
    });
    await expect(deniedService.reply({ actor: workerB, requestMessageId: requested.messageId, content: "hi" })).rejects.toThrow(
      /not granted/,
    );
  });

  it("rejects a request targeting the requester's own task", async () => {
    const { service, tasks } = build();
    await admitTask(tasks, "t-worker-a");
    await expect(
      service.request({
        actor: workerA,
        recipientAgentId: "worker-a",
        recipientTaskId: "t-worker-a",
        deadlineAt: "2026-01-01T00:10:00.000Z",
      }),
    ).rejects.toThrow(/cannot request itself/);
  });

  it("rejects a reply to a request this task was never the recipient of", async () => {
    const { service, tasks } = build();
    await admitTask(tasks, "t-worker-a");
    await admitTask(tasks, "t-worker-b");
    await expect(service.reply({ actor: workerB, requestMessageId: "no-such-request" })).rejects.toThrow(/does not exist/);
  });

  it("validates a reply's content against the request's expectedReplySchema", async () => {
    const { service, tasks } = build();
    await admitTask(tasks, "t-worker-a");
    await admitTask(tasks, "t-worker-b");
    const schema = {
      safeParse: (value: unknown) => (value === "ok" ? { success: true } : { success: false, error: { message: "expected 'ok'" } }),
    };
    const requested = await service.request({
      actor: workerA,
      recipientAgentId: "worker-b",
      recipientTaskId: "t-worker-b",
      expectedReplySchema: schema,
      deadlineAt: "2026-01-01T00:10:00.000Z",
    });

    await expect(service.reply({ actor: workerB, requestMessageId: requested.messageId, content: "not ok" })).rejects.toThrow(
      /expected schema/,
    );
    // A schema-conforming reply succeeds, and validates against the same
    // (now-consumed) registration only once.
    const replied = await service.reply({ actor: workerB, requestMessageId: requested.messageId, content: "ok" });
    expect(replied.accepted).toBe(true);
  });

  it("evicts a never-replied request's expectedReplySchema once its deadline passes, rather than leaking it forever", async () => {
    // `expectedReplySchemas` must not shrink only via a successful
    // `reply()`, or a request nobody ever answered leaks its entry for the
    // life of the process.
    // Eviction is opportunistic (checked at the top of the next `request`
    // call, not on a timer), so this drives it by making a second request
    // after the first one's deadline has passed.
    const { service, tasks } = build();
    await admitTask(tasks, "t-worker-a");
    await admitTask(tasks, "t-worker-b");
    const alwaysFails = { safeParse: () => ({ success: false, error: { message: "never matches" } }) };
    const neverReplied = await service.request({
      actor: workerA,
      recipientAgentId: "worker-b",
      recipientTaskId: "t-worker-b",
      expectedReplySchema: alwaysFails,
      // This fixture's `now()` is fixed at AT ("2026-01-01T00:00:00.000Z"),
      // never a real clock — a deadline at or before AT is already "past"
      // from the prune's perspective (`entry.deadlineAt <= atTime`) the
      // moment any later call to `request()` runs its opportunistic prune.
      deadlineAt: AT,
    });

    // A second request triggers the opportunistic prune at its start.
    await service.request({
      actor: workerA,
      recipientAgentId: "worker-b",
      recipientTaskId: "t-worker-b",
      deadlineAt: "2026-01-01T00:05:00.000Z",
    });

    // The evicted schema is gone: a reply to the original request that
    // would have failed validation now succeeds, since nothing is left to
    // validate against.
    const replied = await service.reply({ actor: workerB, requestMessageId: neverReplied.messageId, content: "anything at all" });
    expect(replied.accepted).toBe(true);
  });

  it("evicts a cancelled request's expectedReplySchema immediately, not waiting for its deadline", async () => {
    const { service, tasks } = build();
    await admitTask(tasks, "t-worker-a");
    await admitTask(tasks, "t-worker-b");
    const alwaysFails = { safeParse: () => ({ success: false, error: { message: "never matches" } }) };
    const requested = await service.request({
      actor: workerA,
      recipientAgentId: "worker-b",
      recipientTaskId: "t-worker-b",
      expectedReplySchema: alwaysFails,
      deadlineAt: "2026-01-01T00:10:00.000Z",
    });
    await expect(
      service.waitFor({ actor: workerA, taskId: "t-worker-a", correlationId: requested.messageId, deadlineAt: "2026-01-01T00:10:00.000Z" }),
    ).rejects.toBeInstanceOf(WorkflowWaitSuspend);

    await service.cancel({ actor: workerA, taskId: "t-worker-a" });

    const replied = await service.reply({ actor: workerB, requestMessageId: requested.messageId, content: "anything at all" });
    expect(replied.accepted).toBe(true);
  });

  it("tells its caller of a wait that cancel settles, so a question can be marked withdrawn", async () => {
    const told: [string, string][] = [];
    const { service, tasks, waits } = build({ onWaitSettled: async (waitId, outcome) => void told.push([waitId, outcome.kind]) });
    await admitTask(tasks, "t-worker-a");
    await expect(
      service.waitFor({ actor: workerA, taskId: "t-worker-a", waitId: "w-question", deadlineAt: "2026-01-01T00:10:00.000Z" }),
    ).rejects.toBeInstanceOf(WorkflowWaitSuspend);
    await service.cancel({ actor: workerA, taskId: "t-worker-a" });
    expect(told).toEqual([["w-question", "cancelled"]]);
    expect((await waits.get("w-question"))?.settledOutcome?.kind).toBe("cancelled");
  });

  it("late reply after the wait already settled by deadline is recorded but does not reopen it", async () => {
    const { service, tasks, waits } = build();
    await admitTask(tasks, "t-worker-a");
    await admitTask(tasks, "t-worker-b");
    const requested = await service.request({
      actor: workerA,
      recipientAgentId: "worker-b",
      recipientTaskId: "t-worker-b",
      deadlineAt: "2026-01-01T00:05:00.000Z",
    });
    await expect(
      service.waitFor({ actor: workerA, taskId: "t-worker-a", correlationId: requested.messageId, deadlineAt: "2026-01-01T00:05:00.000Z" }),
    ).rejects.toBeInstanceOf(WorkflowWaitSuspend);
    const waitId = (await waits.getActiveByCorrelation("t-worker-a", requested.messageId))?.waitId ?? "";
    // Simulate the expiry sweep settling it first.
    expect(await waits.settle({ waitId, outcome: { kind: "wait-timeout" } })).toBe(true);

    const replied = await service.reply({ actor: workerB, requestMessageId: requested.messageId, content: "too late" });
    expect(replied.accepted).toBe(true);
    // Recorded (the mailbox has the reply)...
    const received = await service.receive({ actor: workerA, taskId: "t-worker-a", limit: 10 });
    expect(received.envelopes.some((envelope) => envelope.causationId === requested.messageId)).toBe(true);
    // ...but the wait stayed settled with its original outcome, never
    // reopened by the late reply.
    expect((await waits.get(waitId))?.settledOutcome?.kind).toBe("wait-timeout");
  });
});

describe("authorization", () => {
  it("refuses to deliver a message to a task in another workspace, and does not deliver it", async () => {
    const { service, mailbox } = build();
    const { workerTaskId } = await service.spawn({ actor, agentDefinitionId: "x", input: "a", operationKey: "op-1" });
    const otherWorkspaceActor: AgentActor = { ...actor, workspaceId: "w2", runId: "t-other" };
    await expect(
      service.send({
        actor: otherWorkspaceActor,
        recipientAgentId: "worker-1",
        recipientTaskId: workerTaskId,
        kind: "message",
        content: "x",
      }),
    ).rejects.toThrow(/does not exist/);
    // The rejected send must have no delivery side effect.
    expect(await mailbox.listPending(workerTaskId, 10)).toHaveLength(0);
  });

  it("refuses to read another workspace's mailbox, status or wait, and to cancel its task", async () => {
    const { service, tasks } = build();
    await admitOrchestratorTask(tasks);
    const { workerTaskId } = await service.spawn({ actor, agentDefinitionId: "x", input: "a", operationKey: "op-1" });
    const otherWorkspaceActor: AgentActor = { ...actor, workspaceId: "w2", runId: "t-other" };

    await expect(service.receive({ actor: otherWorkspaceActor, taskId: workerTaskId, limit: 10 })).rejects.toThrow(/does not exist/);
    await expect(
      service.ack({ actor: otherWorkspaceActor, taskId: workerTaskId, leaseId: "l1", acknowledgedMessageIds: [] }),
    ).rejects.toThrow(/does not exist/);
    await expect(service.status({ actor: otherWorkspaceActor, taskId: workerTaskId })).rejects.toThrow(/does not exist/);
    await expect(service.cancel({ actor: otherWorkspaceActor, taskId: workerTaskId })).rejects.toThrow(/does not exist/);
    await expect(
      service.waitFor({ actor: otherWorkspaceActor, taskId: workerTaskId, deadlineAt: "2026-01-01T00:05:00.000Z" }),
    ).rejects.toThrow(/does not exist/);

    // None of the refused operations had a side effect: the worker task is untouched.
    const status = await service.status({ actor, taskId: workerTaskId });
    expect(status.status).not.toBe("cancelled");
  });

  it("never settles a correlation wait on, or marks read, an envelope addressed to another task, of the same or another principal", async () => {
    const { service, tasks, mailbox } = build();
    await admitTask(tasks, "t-worker-a");
    await admitTask(tasks, "t-worker-b");
    await admitFixtureTask(tasks, "t-bob", fixturePromptPolicy, { workspaceId: actor.workspaceId, principalId: "bob", now: () => AT });
    const bob: AgentActor = { principalId: "bob", workspaceId: actor.workspaceId, runId: "t-bob", caller: "cli" };
    await mailbox.insertEnvelope({
      messageId: "m-for-b",
      protocolVersion: 1,
      workspaceId: actor.workspaceId,
      senderAgentId: "worker-c",
      senderTaskId: "t-worker-c",
      recipientAgentId: "worker-b",
      recipientTaskId: "t-worker-b",
      kind: "reply",
      correlationId: "c-known",
      content: "for b only",
      createdAt: AT,
      deliveryState: "pending",
      retentionState: "active",
    });

    for (const [waiter, taskId] of [
      [workerA, "t-worker-a"],
      [bob, "t-bob"],
    ] as const) {
      await expect(
        service.waitFor({ actor: waiter, taskId, correlationId: "c-known", deadlineAt: "2026-01-01T00:10:00.000Z" }),
      ).rejects.toBeInstanceOf(WorkflowWaitSuspend);
    }
    // The real recipient still has it.
    expect((await mailbox.getEnvelope("m-for-b"))?.deliveryState).toBe("pending");
  });

  it("labels an envelope a correlation wait returns for its reader: another principal's words read as theirs", async () => {
    const { service, tasks, mailbox } = build();
    await admitTask(tasks, "t-worker-a");
    await admitFixtureTask(tasks, "t-bob", fixturePromptPolicy, { workspaceId: actor.workspaceId, principalId: "bob", now: () => AT });
    await mailbox.insertEnvelope({
      messageId: "m-from-bob",
      protocolVersion: 1,
      workspaceId: actor.workspaceId,
      senderAgentId: "bob-agent",
      senderTaskId: "t-bob",
      recipientAgentId: "worker-a",
      recipientTaskId: "t-worker-a",
      kind: "reply",
      correlationId: "c-bob",
      content: "from bob",
      createdAt: AT,
      deliveryState: "pending",
      retentionState: "active",
      label: TRUSTED_PUBLIC,
    });

    const waited = await service.waitFor({
      actor: workerA,
      taskId: "t-worker-a",
      correlationId: "c-bob",
      deadlineAt: "2026-01-01T00:10:00.000Z",
    });
    expect(waited.outcome.envelope?.content).toBe("from bob");
    expect(waited.outcome.envelope?.label?.integrity).toBe("untrusted");
    expect(waited.outcome.envelope?.label?.sources).toContain("chat-other");
    expect((await mailbox.getEnvelope("m-from-bob"))?.deliveryState).toBe("acknowledged");
  });

  it("lets a task cancel itself and what it delegated, directly or through its workers, but never its parent or an unrelated task", async () => {
    const { service, tasks } = build();
    await admitOrchestratorTask(tasks);
    await admitTask(tasks, "t-unrelated");
    const worker = await service.spawn({ actor, agentDefinitionId: "x", input: "a", operationKey: "op-w" });
    const workerActor: AgentActor = { ...actor, runId: worker.workerTaskId, agentId: worker.workerAgentId };
    const sibling = await service.spawn({ actor, agentDefinitionId: "x", input: "a", operationKey: "op-s" });
    const grandchild = await service.spawn({ actor: workerActor, agentDefinitionId: "x", input: "a", operationKey: "op-g" });

    await expect(service.cancel({ actor: workerActor, taskId: "t-orchestrator" })).rejects.toThrow(/not this task or one it delegated to/);
    await expect(service.cancel({ actor: workerActor, taskId: sibling.workerTaskId })).rejects.toThrow(/not this task/);
    await expect(service.cancel({ actor: workerActor, taskId: "t-unrelated" })).rejects.toThrow(/not this task/);
    await expect(service.cancel({ actor: { ...actor, principalId: "bob" }, taskId: worker.workerTaskId })).rejects.toThrow(/not this task/);
    expect((await tasks.get("t-orchestrator"))?.status).not.toBe("cancelled");
    expect((await tasks.get(sibling.workerTaskId))?.status).not.toBe("cancelled");

    // Its parent reaches its grandchild through the worker; the worker cancels itself.
    await service.cancel({ actor, taskId: grandchild.workerTaskId });
    expect((await tasks.get(grandchild.workerTaskId))?.status).toBe("cancelled");
    await service.cancel({ actor: workerActor, taskId: worker.workerTaskId });
    expect((await tasks.get(worker.workerTaskId))?.status).toBe("cancelled");

    // The system actor (no runId) that stops a schedule's run cancels any task in the workspace.
    await service.cancel({ actor: { ...actor, runId: undefined, caller: "schedule:nightly" }, taskId: "t-unrelated" });
    expect((await tasks.get("t-unrelated"))?.status).toBe("cancelled");
  });
});

describe("spawn synchrony (documented current limitation)", () => {
  it("does not resolve until the underlying workflow admission resolves", async () => {
    const tasks = createInMemoryTaskRepository();
    let resolveAdmit: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      resolveAdmit = resolve;
    });
    let admitted = false;
    const workflow: WorkflowPort = {
      admit: async (input) => {
        await gate;
        admitted = true;
        const result = await tasks.admit({
          prompt: fixturePromptPolicy,
          workspaceId: input.context.workspaceId,
          principalId: input.context.principalId,
          operationKey: input.operationKey,
          kind: "start",
          intent: null,
          checkpointNamespace: "",
          newTaskId: (() => "t-worker-gated")(),
          newAdmissionId: (() => "adm-1")(),
          newThreadId: (() => "thread-1")(),
          now: (() => AT)(),
        });
        return {
          taskId: result.task.taskId,
          threadId: result.task.threadId,
          outcome: { status: "completed", finalText: "" },
          created: result.created,
          replay: !result.created,
        };
      },
      checkpoints: { latest: async () => undefined, listCheckpoints: async () => [] },
    };
    const service = createAgentCommunicationService({
      mailbox: createFixtureMailbox(),
      waits: createInMemoryAgentWaitRepository(),
      delegations: createInMemoryAgentDelegationRepository(),
      tasks,
      workflow,
      access: createAccess(),
      cancelTask: () => {},
      now: () => AT,
    });

    let spawnResolved = false;
    const spawning = service.spawn({ actor, agentDefinitionId: "x", input: "a", operationKey: "op-1" }).then((result) => {
      spawnResolved = true;
      return result;
    });
    // Still pending: `spawn` has not returned before the fixture workflow's
    // admit gate opens — pinning today's "spawn blocks on the whole worker
    // turn" limitation (see agent-communication.ts's header comment).
    await Promise.resolve();
    expect(spawnResolved).toBe(false);
    expect(admitted).toBe(false);

    resolveAdmit?.();
    await spawning;
    expect(spawnResolved).toBe(true);
  });
});

describe("workers that report back", () => {
  /** The orchestrator's task, attended or not (or under the policy given), finished. */
  async function orchestrator(tasks: TaskRepositoryPort, attended: boolean | TaskExecutionPolicy): Promise<void> {
    await tasks.admit({
      prompt: fixturePromptPolicy,
      workspaceId: actor.workspaceId,
      principalId: actor.principalId,
      operationKey: "op-orchestrator",
      kind: "start",
      intent: null,
      checkpointNamespace: "",
      executionPolicy: typeof attended === "object" ? attended : attended ? ATTENDED_TASK_POLICY : UNATTENDED_TASK_POLICY,
      newTaskId: (() => "t-orchestrator")(),
      newAdmissionId: (() => "adm-orchestrator")(),
      newThreadId: (() => "thread-orchestrator")(),
      now: (() => AT)(),
    });
    await tasks.updateStatus("t-orchestrator", "completed", "done");
  }

  it("answers a background spawn once the worker's task exists, while its turn still runs — for a spawner that hears back from it", async () => {
    const policies = [
      { policy: ATTENDED_TASK_POLICY, backgrounded: true },
      // A schedule's fire is woken to read its workers' results.
      { policy: SCHEDULE_TASK_POLICY, backgrounded: true },
      // A routine's run, or one stored under the default policy, joins its worker.
      { policy: ROUTINE_TASK_POLICY, backgrounded: false },
      { policy: UNATTENDED_TASK_POLICY, backgrounded: false },
    ];
    for (const { policy, backgrounded } of policies) {
      const tasks = createInMemoryTaskRepository();
      await orchestrator(tasks, policy);
      const delegations = createInMemoryAgentDelegationRepository();
      let open: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        open = resolve;
      });
      const workflow: WorkflowPort = {
        admit: async (input) => {
          const result = await tasks.admit({
            prompt: fixturePromptPolicy,
            workspaceId: input.context.workspaceId,
            principalId: input.context.principalId,
            operationKey: input.operationKey,
            kind: "start",
            intent: null,
            checkpointNamespace: "",
            newTaskId: (() => "t-worker")(),
            newAdmissionId: (() => "adm-w")(),
            newThreadId: (() => "thread-w")(),
            now: (() => AT)(),
          });
          await input.onAdmitted?.({
            taskId: result.task.taskId,
            threadId: result.task.threadId,
            admissionId: result.admission.admissionId,
            created: result.created,
          });
          await gate;
          return {
            taskId: result.task.taskId,
            threadId: result.task.threadId,
            outcome: { status: "completed", finalText: "" },
            created: result.created,
            replay: false,
          };
        },
        checkpoints: { latest: async () => undefined, listCheckpoints: async () => [] },
      };
      const service = createAgentCommunicationService({
        mailbox: createFixtureMailbox(),
        waits: createInMemoryAgentWaitRepository(),
        delegations,
        tasks,
        workflow,
        access: createAccess(),
        cancelTask: () => {},
        now: () => AT,
      });
      let answered = false;
      const spawning = service
        .spawn({ actor, agentDefinitionId: "x", input: "a", operationKey: "op-bg", background: true })
        .then((result) => {
          answered = true;
          return result;
        });
      await sleep(20);
      // Backgrounded: answered with the gate still shut, its delegation already recorded. Otherwise it joins.
      expect(answered).toBe(backgrounded);
      if (backgrounded) expect((await delegations.getByWorkerTaskId("t-worker"))?.parentTaskId).toBe("t-orchestrator");
      open();
      expect((await spawning).workerTaskId).toBe("t-worker");
    }
  });

  it("sends a finished worker's answer to its parent once, and wakes an attended parent that is not running", async () => {
    const { tasks, mailbox, workflow, service } = build();
    await orchestrator(tasks, true);
    const spawned = await service.spawn({ actor, agentDefinitionId: "researcher", input: "look it up", operationKey: "op-r" });
    await tasks.updateStatus(spawned.workerTaskId, "completed", "The answer is 42.");
    const before = workflow.calls.length;
    await service.announceWorkerResult(spawned.workerTaskId);
    await service.announceWorkerResult(spawned.workerTaskId);
    const results = (await mailbox.listPending("t-orchestrator", 10)).filter((envelope) => envelope.kind === "result");
    expect(results).toHaveLength(1);
    expect(results[0]?.content).toContain("The answer is 42.");
    expect(results[0]?.senderTaskId).toBe(spawned.workerTaskId);
    const wakes = workflow.calls.slice(before).filter((call) => call.taskId === "t-orchestrator" && call.kind === "reply");
    expect(wakes).toHaveLength(1);
    expect(await service.status({ actor, taskId: spawned.workerTaskId })).toMatchObject({
      status: "completed",
      finalText: "The answer is 42.",
    });
  });

  it("resumes a parent waiting on the worker with its result, and leaves an unattended parent's in its mailbox", async () => {
    const waiting = build();
    await orchestrator(waiting.tasks, true);
    const spawned = await waiting.service.spawn({ actor, agentDefinitionId: "x", input: "a", operationKey: "op-w" });
    await waiting.waits.prepare({
      waitId: "w-1",
      taskId: "t-orchestrator",
      waitingOnWorkerTaskId: spawned.workerTaskId,
      deadlineAt: "2099-01-01T00:00:00.000Z",
    });
    await waiting.waits.activate("w-1");
    await waiting.tasks.updateStatus(spawned.workerTaskId, "failed", "could not reach it");
    await waiting.service.announceWorkerResult(spawned.workerTaskId);
    const settled = await waiting.waits.get("w-1");
    expect(settled?.settledOutcome?.kind).toBe("worker-failed");
    expect(settled?.settledOutcome?.envelope?.content).toContain("could not reach it");
    expect(waiting.workflow.calls.some((call) => call.kind === "deadline" && call.taskId === "t-orchestrator")).toBe(true);

    const unattended = build();
    await orchestrator(unattended.tasks, false);
    const worker = await unattended.service.spawn({ actor, agentDefinitionId: "x", input: "a", operationKey: "op-u" });
    await unattended.tasks.updateStatus(worker.workerTaskId, "completed", "fine");
    const before = unattended.workflow.calls.length;
    await unattended.service.announceWorkerResult(worker.workerTaskId);
    expect(unattended.workflow.calls.slice(before)).toEqual([]);
    expect((await unattended.mailbox.listPending("t-orchestrator", 10)).some((envelope) => envelope.kind === "result")).toBe(true);
  });

  it("wakes a schedule's fire to read a worker's result, and tells whether it has one yet to hear from", async () => {
    const { tasks, mailbox, workflow, service } = build();
    await tasks.admit({
      prompt: fixturePromptPolicy,
      workspaceId: actor.workspaceId,
      principalId: actor.principalId,
      operationKey: "op-orchestrator",
      kind: "start",
      intent: null,
      checkpointNamespace: "",
      executionPolicy: SCHEDULE_TASK_POLICY,
      origin: "schedule",
      originScheduleId: "sched-1",
      newTaskId: (() => "t-orchestrator")(),
      newAdmissionId: (() => "adm-orchestrator")(),
      newThreadId: (() => "thread-orchestrator")(),
      now: (() => AT)(),
    });
    await tasks.updateStatus("t-orchestrator", "completed", "done");
    const spawned = await service.spawn({ actor, agentDefinitionId: "x", input: "a", operationKey: "op-f" });
    await tasks.updateStatus(spawned.workerTaskId, "running", null);
    expect(await service.workersOutstanding("t-orchestrator")).toBe(true);
    await tasks.updateStatus(spawned.workerTaskId, "completed", "found it");
    // Ended, its result not announced yet.
    expect(await service.workersOutstanding("t-orchestrator")).toBe(true);
    const before = workflow.calls.length;
    await service.announceWorkerResult(spawned.workerTaskId);
    expect(workflow.calls.slice(before).filter((call) => call.taskId === "t-orchestrator" && call.kind === "reply")).toHaveLength(1);
    // Announced, but not read yet.
    expect(await service.workersOutstanding("t-orchestrator")).toBe(true);
    for (const envelope of await mailbox.listPending("t-orchestrator", 10))
      await mailbox.setDeliveryState(envelope.messageId, "acknowledged");
    expect(await service.workersOutstanding("t-orchestrator")).toBe(false);
    // A cancelled worker reports nothing, so the run has nothing to hear from it.
    const cancelled = await service.spawn({ actor, agentDefinitionId: "x", input: "b", operationKey: "op-g" });
    await tasks.updateStatus(cancelled.workerTaskId, "cancelled", null);
    expect(await service.workersOutstanding("t-orchestrator")).toBe(false);
  });

  it("reports nothing for a cancelled worker, and cannot be blocked by another task's look-alike result", async () => {
    const { tasks, mailbox, service } = build();
    await orchestrator(tasks, true);
    const cancelled = await service.spawn({ actor, agentDefinitionId: "x", input: "a", operationKey: "op-c" });
    await tasks.updateStatus(cancelled.workerTaskId, "cancelled", null);
    await service.announceWorkerResult(cancelled.workerTaskId);
    expect(await mailbox.listPending("t-orchestrator", 10)).toEqual([]);

    const worker = await service.spawn({ actor, agentDefinitionId: "x", input: "a", operationKey: "op-s" });
    // Another task sends a result under the worker's correlation first.
    await service.send({
      actor,
      recipientAgentId: "t-orchestrator",
      recipientTaskId: "t-orchestrator",
      kind: "result",
      content: "fake",
      correlationId: `worker-result:${worker.workerTaskId}`,
      wake: "none",
    });
    await tasks.updateStatus(worker.workerTaskId, "completed", "real");
    await service.announceWorkerResult(worker.workerTaskId);
    expect((await mailbox.listPending("t-orchestrator", 10)).map((envelope) => envelope.content)).toEqual([
      "fake",
      expect.stringContaining("real"),
    ]);
  });

  it("gives a wait on a worker that already reported its answer", async () => {
    const { tasks, service } = build();
    await orchestrator(tasks, true);
    const worker = await service.spawn({ actor, agentDefinitionId: "x", input: "a", operationKey: "op-a" });
    await tasks.updateStatus(worker.workerTaskId, "completed", "the answer");
    await service.announceWorkerResult(worker.workerTaskId);
    const waited = await service.waitFor({
      actor,
      taskId: "t-orchestrator",
      waitingOnWorkerTaskId: worker.workerTaskId,
      deadlineAt: "2099-01-01T00:00:00.000Z",
    });
    expect(waited.outcome.kind).toBe("worker-completed");
    expect(waited.outcome.envelope?.content).toContain("the answer");
  });

  it("ignores a task that is no worker, or not finished", async () => {
    const { tasks, mailbox, service } = build();
    await orchestrator(tasks, true);
    const spawned = await service.spawn({ actor, agentDefinitionId: "x", input: "a", operationKey: "op-n" });
    await service.announceWorkerResult("t-orchestrator");
    await tasks.updateStatus(spawned.workerTaskId, "running", null);
    await service.announceWorkerResult(spawned.workerTaskId);
    expect(await mailbox.listPending("t-orchestrator", 10)).toEqual([]);
  });
});

describe("worker results reach their parent once", () => {
  /** The orchestrator's task, attended, ended with `outcome` as its latest admission's. */
  async function orchestratorEnded(tasks: TaskRepositoryPort, outcome: "completed" | "waiting"): Promise<void> {
    await tasks.admit({
      prompt: fixturePromptPolicy,
      workspaceId: actor.workspaceId,
      principalId: actor.principalId,
      operationKey: "op-orchestrator",
      kind: "start",
      intent: null,
      checkpointNamespace: "",
      executionPolicy: ATTENDED_TASK_POLICY,
      newTaskId: (() => "t-orchestrator")(),
      newAdmissionId: (() => "adm-orchestrator")(),
      newThreadId: (() => "thread-orchestrator")(),
      now: (() => AT)(),
    });
    await tasks.commitAdmission({
      admissionId: "adm-orchestrator",
      taskId: "t-orchestrator",
      state: "committed",
      result:
        outcome === "waiting"
          ? ({
              status: "waiting",
              finalText: "",
              interrupt: { requests: [{ callId: "call-1", toolName: "fs.write", input: {}, steps: 1 }] },
            } as never)
          : { status: "completed", finalText: "done" },
    });
  }

  const wakesOf = (calls: readonly AdmitInput[]): AdmitInput[] =>
    calls.filter((call) => call.taskId === "t-orchestrator" && call.kind === "reply");

  it("takes no turn in a chat the person stopped: a late result waits in its mailbox for their reply", async () => {
    const { tasks, mailbox, workflow, service } = build();
    await orchestratorEnded(tasks, "completed");
    const worker = await service.spawn({ actor, agentDefinitionId: "x", input: "a", operationKey: "op-late" });
    await tasks.updateStatus("t-orchestrator", "stopped", null);
    await tasks.updateStatus(worker.workerTaskId, "completed", "the answer");
    const before = workflow.calls.length;
    await service.announceWorkerResult(worker.workerTaskId);
    expect(wakesOf(workflow.calls.slice(before))).toEqual([]);
    expect(await service.wakeIfOwed("t-orchestrator")).toBe(false);
    expect((await mailbox.listPending("t-orchestrator", 10)).some((envelope) => envelope.kind === "result")).toBe(true);
  });

  it("wakes no unattended run the person stopped when a worker sends to it: the mail waits", async () => {
    const { tasks, mailbox, workflow, service } = build();
    await admitOrchestratorTask(tasks);
    const worker = await service.spawn({ actor, agentDefinitionId: "x", input: "a", operationKey: "op-sent" });
    await tasks.updateStatus("t-orchestrator", "stopped", null);
    const before = workflow.calls.length;
    await service.send({
      actor: { ...actor, runId: worker.workerTaskId, agentId: "worker-1" },
      recipientAgentId: "t-orchestrator",
      recipientTaskId: "t-orchestrator",
      kind: "message",
      content: "found it",
    });
    expect(wakesOf(workflow.calls.slice(before))).toEqual([]);
    expect((await mailbox.listPending("t-orchestrator", 10)).some((envelope) => envelope.content === "found it")).toBe(true);
  });

  it("gives Home its worker's result after a Stop, as after a finished turn: Home reads ready and never ends", async () => {
    const { tasks, workflow, service } = build();
    await orchestratorEnded(tasks, "completed");
    const task = await tasks.get("t-orchestrator");
    (task as { chatKind?: string }).chatKind = "home";
    const worker = await service.spawn({ actor, agentDefinitionId: "x", input: "a", operationKey: "op-home" });
    await tasks.updateStatus("t-orchestrator", "stopped", null);
    await tasks.updateStatus(worker.workerTaskId, "completed", "the answer");
    const before = workflow.calls.length;
    await service.announceWorkerResult(worker.workerTaskId);
    const [woken] = wakesOf(workflow.calls.slice(before));
    expect(wakesOf(workflow.calls.slice(before))).toHaveLength(1);
    // It reports, and what the person stopped stays stopped.
    expect(woken?.afterStop).toBe(true);
  });

  it("tells the parent a stopped worker's ending, once, in that word", async () => {
    const { tasks, mailbox, service } = build();
    await orchestratorEnded(tasks, "completed");
    const worker = await service.spawn({ actor, agentDefinitionId: "x", input: "a", operationKey: "op-stopped" });
    await tasks.updateStatus(worker.workerTaskId, "stopped", null);
    await service.announceWorkerResult(worker.workerTaskId);
    const told = (await mailbox.listPending("t-orchestrator", 10)).filter((envelope) => envelope.kind === "result");
    expect(told).toHaveLength(1);
    expect(told[0]?.content).toContain(`Worker ${worker.workerTaskId}`);
    expect(told[0]?.content).toContain("stopped");
  });

  it("never wakes a parent waiting on an approval round, and wakes it once the round's turn has ended", async () => {
    const { tasks, mailbox, workflow, service } = build();
    await orchestratorEnded(tasks, "waiting");
    const worker = await service.spawn({ actor, agentDefinitionId: "x", input: "a", operationKey: "op-round" });
    await tasks.updateStatus(worker.workerTaskId, "completed", "the answer");
    const before = workflow.calls.length;
    await service.announceWorkerResult(worker.workerTaskId);
    // A new admission over the pending round would set it aside: none is made.
    expect(wakesOf(workflow.calls.slice(before))).toEqual([]);
    expect((await mailbox.listPending("t-orchestrator", 10)).some((envelope) => envelope.kind === "result")).toBe(true);
    // Still waiting: the owed wake waits too.
    expect(await service.wakeIfOwed("t-orchestrator")).toBe(false);
    // The round is decided and its turn ends: the wake it was owed is admitted, once.
    await tasks.admit({
      prompt: fixturePromptPolicy,
      workspaceId: actor.workspaceId,
      principalId: actor.principalId,
      taskId: "t-orchestrator",
      operationKey: "op-decided",
      kind: "approval",
      intent: null,
      checkpointNamespace: "",
      newTaskId: (() => "t-orchestrator")(),
      newAdmissionId: (() => "adm-decided")(),
      newThreadId: (() => "thread-orchestrator")(),
      now: (() => AT)(),
    });
    await tasks.commitAdmission({
      admissionId: "adm-decided",
      taskId: "t-orchestrator",
      state: "committed",
      result: { status: "completed", finalText: "decided" },
    });
    expect(await service.wakeIfOwed("t-orchestrator")).toBe(true);
    expect(await service.wakeIfOwed("t-orchestrator")).toBe(false);
    expect(wakesOf(workflow.calls.slice(before))).toHaveLength(1);
  });

  it("owes a running parent a wake, admitted at its admission's end only while the result is unread", async () => {
    const { tasks, mailbox, workflow, service } = build();
    await orchestratorEnded(tasks, "completed");
    const worker = await service.spawn({ actor, agentDefinitionId: "x", input: "a", operationKey: "op-running" });
    await tasks.updateStatus("t-orchestrator", "running", null);
    await tasks.updateStatus(worker.workerTaskId, "completed", "the answer");
    const before = workflow.calls.length;
    await service.announceWorkerResult(worker.workerTaskId);
    expect(wakesOf(workflow.calls.slice(before))).toEqual([]);
    // The parent's last model call ended without reading it: its admission's end wakes it.
    await tasks.updateStatus("t-orchestrator", "completed", "done");
    expect(await service.wakeIfOwed("t-orchestrator")).toBe(true);
    expect(wakesOf(workflow.calls.slice(before))).toHaveLength(1);

    // A second result that the running turn did read is owed nothing.
    const second = await service.spawn({ actor, agentDefinitionId: "x", input: "a", operationKey: "op-running-2" });
    await tasks.updateStatus("t-orchestrator", "running", null);
    await tasks.updateStatus(second.workerTaskId, "completed", "read in time");
    await service.announceWorkerResult(second.workerTaskId);
    for (const envelope of await mailbox.listPending("t-orchestrator", 10))
      await mailbox.setDeliveryState(envelope.messageId, "acknowledged");
    await tasks.updateStatus("t-orchestrator", "completed", "done");
    expect(await service.wakeIfOwed("t-orchestrator")).toBe(false);
    expect(wakesOf(workflow.calls.slice(before))).toHaveLength(1);
  });

  it("holds the woken turn to the channel the worker's spawning turn was held to", async () => {
    const { tasks, workflow, service } = build();
    await orchestratorEnded(tasks, "completed");
    const worker = await service.spawn({
      actor: { ...actor, heldChannel: "messaging" },
      agentDefinitionId: "x",
      input: "a",
      operationKey: "op-held",
    });
    await tasks.updateStatus(worker.workerTaskId, "completed", "the answer");
    const before = workflow.calls.length;
    await service.announceWorkerResult(worker.workerTaskId);
    const [wake] = wakesOf(workflow.calls.slice(before));
    expect(wake?.context.heldChannel).toBe("messaging");
    expect(wake?.prompt).toBeUndefined();
  });

  it("starts a worker knowing the URLs its spawning task knew, and tainted when it was", async () => {
    const { tasks, workflow, service } = build();
    await orchestratorEnded(tasks, "completed");
    const before = workflow.calls.length;
    await service.spawn({
      actor: { ...actor, tainted: true, knownUrls: ["https://docs.example/guide"] },
      agentDefinitionId: "x",
      input: "fetch https://evil.example/?d=1",
      operationKey: "op-known",
    });
    const [admitted] = workflow.calls.slice(before);
    expect(admitted?.context.inheritedKnownUrls).toEqual(["https://docs.example/guide"]);
    expect(admitted?.context.inheritedTaint).toBe(true);
  });

  it("carries the connection a channel turn came in on to its worker, its row and the wake it owes", async () => {
    const { tasks, workflow, service, delegations } = build();
    await orchestratorEnded(tasks, "completed");
    const before = workflow.calls.length;
    const worker = await service.spawn({
      actor: { ...actor, heldChannel: "messaging", heldConnectionId: "tg-1" },
      agentDefinitionId: "x",
      input: "a",
      operationKey: "op-connection",
    });
    expect(workflow.calls.slice(before)[0]?.context.heldConnectionId).toBe("tg-1");
    expect((await delegations.getByWorkerTaskId(worker.workerTaskId))?.heldConnectionId).toBe("tg-1");
    await tasks.updateStatus(worker.workerTaskId, "completed", "the answer");
    const woken = workflow.calls.length;
    await service.announceWorkerResult(worker.workerTaskId);
    expect(wakesOf(workflow.calls.slice(woken))[0]?.context.heldConnectionId).toBe("tg-1");
  });

  it("holds the woken turn to the front end the worker's spawning turn was typed in", async () => {
    const { tasks, workflow, service, delegations } = build();
    await orchestratorEnded(tasks, "completed");
    const worker = await service.spawn({
      actor: { ...actor, frontEnd: "web" },
      agentDefinitionId: "x",
      input: "a",
      operationKey: "op-web",
    });
    expect((await delegations.getByWorkerTaskId(worker.workerTaskId))?.frontEnd).toBe("web");
    expect(workflow.calls.find((call) => call.operationKey === "op-web")?.context.frontEnd).toBe("web");
    await tasks.updateStatus(worker.workerTaskId, "completed", "the answer");
    const before = workflow.calls.length;
    await service.announceWorkerResult(worker.workerTaskId);
    const [wake] = wakesOf(workflow.calls.slice(before));
    expect(wake?.context.frontEnd).toBe("web");
  });

  it("sends one result when the worker already sent its own, recorded read so nothing takes it up again", async () => {
    const { tasks, mailbox, workflow, service } = build();
    await orchestratorEnded(tasks, "completed");
    const worker = await service.spawn({ actor, agentDefinitionId: "x", input: "a", operationKey: "op-explicit" });
    const workerActor: AgentActor = { ...actor, runId: worker.workerTaskId, agentId: worker.workerAgentId };
    await service.send({
      actor: workerActor,
      recipientAgentId: "t-orchestrator",
      recipientTaskId: "t-orchestrator",
      kind: "result",
      content: "my own answer",
      wake: "none",
    });
    await tasks.updateStatus(worker.workerTaskId, "completed", "my own answer");
    const before = workflow.calls.length;
    await service.announceWorkerResult(worker.workerTaskId);
    const results = (await mailbox.listPending("t-orchestrator", 10)).filter((envelope) => envelope.kind === "result");
    expect(results.map((envelope) => envelope.content)).toEqual(["my own answer"]);
    expect(wakesOf(workflow.calls.slice(before))).toEqual([]);
    const admissions = await tasks.listAdmissions(worker.workerTaskId);
    expect((await mailbox.getEnvelope(`worker-result-${admissions.at(-1)?.admissionId ?? ""}`))?.deliveryState).toBe("acknowledged");
  });

  it("never wakes a parent over its pending round for a worker's own result either, and wakes it once the round's turn ends", async () => {
    const { tasks, workflow, service } = build();
    await orchestratorEnded(tasks, "waiting");
    const worker = await service.spawn({ actor, agentDefinitionId: "x", input: "a", operationKey: "op-send-round" });
    const workerActor: AgentActor = { ...actor, runId: worker.workerTaskId, agentId: worker.workerAgentId };
    const before = workflow.calls.length;
    // The default `wake: "if-idle"`.
    await service.send({
      actor: workerActor,
      recipientAgentId: "t-orchestrator",
      recipientTaskId: "t-orchestrator",
      kind: "result",
      content: "my own answer",
    });
    await tasks.updateStatus(worker.workerTaskId, "completed", "my own answer");
    await service.announceWorkerResult(worker.workerTaskId);
    expect(wakesOf(workflow.calls.slice(before))).toEqual([]);
    await tasks.admit({
      prompt: fixturePromptPolicy,
      workspaceId: actor.workspaceId,
      principalId: actor.principalId,
      taskId: "t-orchestrator",
      operationKey: "op-decided-send",
      kind: "approval",
      intent: null,
      checkpointNamespace: "",
      newTaskId: (() => "t-orchestrator")(),
      newAdmissionId: (() => "adm-decided-send")(),
      newThreadId: (() => "thread-orchestrator")(),
      now: (() => AT)(),
    });
    await tasks.commitAdmission({
      admissionId: "adm-decided-send",
      taskId: "t-orchestrator",
      state: "committed",
      result: { status: "completed", finalText: "decided" },
    });
    expect(await service.wakeIfOwed("t-orchestrator")).toBe(true);
    expect(wakesOf(workflow.calls.slice(before))).toHaveLength(1);
  });

  it("still reports a worker that failed after sending a partial result of its own", async () => {
    const { tasks, mailbox, service } = build();
    await orchestratorEnded(tasks, "completed");
    const worker = await service.spawn({ actor, agentDefinitionId: "x", input: "a", operationKey: "op-partial" });
    const workerActor: AgentActor = { ...actor, runId: worker.workerTaskId, agentId: worker.workerAgentId };
    await service.send({
      actor: workerActor,
      recipientAgentId: "t-orchestrator",
      recipientTaskId: "t-orchestrator",
      kind: "result",
      content: "half of it",
      wake: "none",
    });
    await tasks.updateStatus(worker.workerTaskId, "failed", "ran out of budget");
    await service.announceWorkerResult(worker.workerTaskId);
    const results = (await mailbox.listPending("t-orchestrator", 10))
      .filter((envelope) => envelope.kind === "result")
      .map((envelope) => envelope.content);
    expect(results).toEqual(["half of it", expect.stringContaining("failed")]);
  });

  it("answers a wait on a finished worker only with that worker's own result, and marks it read", async () => {
    const { tasks, mailbox, service } = build();
    await orchestratorEnded(tasks, "completed");
    const worker = await service.spawn({ actor, agentDefinitionId: "x", input: "a", operationKey: "op-wait" });
    // Another task's look-alike, under the worker's correlation.
    await service.send({
      actor,
      recipientAgentId: "t-orchestrator",
      recipientTaskId: "t-orchestrator",
      kind: "result",
      content: "fake",
      correlationId: `worker-result:${worker.workerTaskId}`,
      wake: "none",
    });
    await tasks.updateStatus(worker.workerTaskId, "completed", "real");
    const notYet = await service.waitFor({
      actor,
      taskId: "t-orchestrator",
      waitingOnWorkerTaskId: worker.workerTaskId,
      deadlineAt: "2099-01-01T00:00:00.000Z",
      waitId: "w-before",
    });
    expect(notYet.outcome.envelope).toBeUndefined();
    await service.announceWorkerResult(worker.workerTaskId);
    const waited = await service.waitFor({
      actor,
      taskId: "t-orchestrator",
      waitingOnWorkerTaskId: worker.workerTaskId,
      deadlineAt: "2099-01-01T00:00:00.000Z",
      waitId: "w-after",
    });
    expect(waited.outcome.envelope?.content).toContain("real");
    expect((await mailbox.getEnvelope(waited.outcome.envelope?.messageId ?? ""))?.deliveryState).toBe("acknowledged");
  });

  it("keeps a long answer whole in an artifact, its envelope within the inline bound", async () => {
    const artifacts = createInMemoryArtifactRepository();
    const { tasks, mailbox, service } = build({ artifacts });
    await orchestratorEnded(tasks, "completed");
    const worker = await service.spawn({ actor, agentDefinitionId: "x", input: "a", operationKey: "op-long" });
    await tasks.updateStatus(worker.workerTaskId, "completed", "é".repeat(3_000));
    await service.announceWorkerResult(worker.workerTaskId);
    const [result] = (await mailbox.listPending("t-orchestrator", 10)).filter((envelope) => envelope.kind === "result");
    expect(new TextEncoder().encode(result?.content ?? "").length).toBeLessThanOrEqual(MAX_AGENT_ENVELOPE_INLINE_BYTES);
    expect(result?.artifactId).toBeDefined();
    expect(new TextDecoder().decode(await artifacts.readArtifactBody(result?.artifactId ?? ""))).toContain("é".repeat(3_000));
  });

  it("names the workers that fill a tree when it refuses a spawn, waiting ones included", async () => {
    const { tasks, service } = build();
    const spawned = [];
    for (let index = 0; index < DEFAULT_MAX_CONCURRENT_WORKERS; index += 1)
      spawned.push(await service.spawn({ actor, agentDefinitionId: `agent-${index}`, input: "a", operationKey: `op-fill-${index}` }));
    await tasks.updateStatus(spawned[0]!.workerTaskId, "waiting", null);
    const refused = await service.spawn({ actor, agentDefinitionId: "x", input: "a", operationKey: "op-one-more" }).then(
      () => undefined,
      (error: unknown) => error as TaviError,
    );
    expect(refused?.code).toBe("QUOTA_EXCEEDED");
    for (const worker of spawned) expect(refused?.message).toContain(worker.workerTaskId);
    expect(refused?.message).toContain(`${spawned[0]!.workerTaskId} (agent-0, waiting)`);
    expect(refused?.message).toContain("waiting on an approval or a question counts");
  });

  it("announces at start a worker whose ending no owner announced, once", async () => {
    const tasks = createInMemoryTaskRepository();
    const mailbox = createFixtureMailbox();
    const delegations = createInMemoryAgentDelegationRepository(tasks, mailbox);
    const workflow = createFixtureWorkflow(tasks);
    const options = {
      mailbox,
      waits: createInMemoryAgentWaitRepository(),
      delegations,
      tasks,
      workflow,
      access: createAccess(),
      cancelTask: () => {},
      now: () => AT,
    };
    await orchestratorEnded(tasks, "completed");
    const worker = await createAgentCommunicationService(options).spawn({
      actor,
      agentDefinitionId: "x",
      input: "a",
      operationKey: "op-lost",
    });
    await tasks.updateStatus(worker.workerTaskId, "completed", "lost in a restart");
    // A new owner over the same records: the first never announced.
    const restarted = createAgentCommunicationService(options);
    expect(await restarted.announceUnreported({ since: AT })).toBe(1);
    expect(
      (await mailbox.listPending("t-orchestrator", 10))
        .filter((envelope) => envelope.kind === "result")
        .map((envelope) => envelope.content),
    ).toEqual([expect.stringContaining("lost in a restart")]);
    expect(await restarted.announceUnreported({ since: AT })).toBe(0);
    expect(wakesOf(workflow.calls)).toHaveLength(1);
  });
});

describe("payload offload", () => {
  const oversized = "x".repeat(MAX_AGENT_ENVELOPE_INLINE_BYTES + 1);

  it("offloads over-cap send() content to the artifact store, referenced by artifactId instead of inline content", async () => {
    const artifacts = createInMemoryArtifactRepository();
    const { service, tasks, mailbox } = build({ artifacts });
    await admitTask(tasks, "t-worker-a");
    await admitTask(tasks, "t-worker-b");

    const sent = await service.send({
      actor,
      recipientAgentId: "worker-b",
      recipientTaskId: "t-worker-b",
      kind: "message",
      content: oversized,
    });
    const envelope = await mailbox.getEnvelope(sent.messageId);
    expect(envelope?.content).toBeUndefined();
    expect(envelope?.artifactId).toBeDefined();
    const stored = await artifacts.readArtifactBody(envelope?.artifactId ?? "");
    expect(new TextDecoder().decode(stored)).toBe(oversized);
  });

  it("rejects over-cap content when no artifact store is configured", async () => {
    const { service, tasks } = build();
    await admitTask(tasks, "t-worker-a");
    await admitTask(tasks, "t-worker-b");
    await expect(
      service.send({ actor, recipientAgentId: "worker-b", recipientTaskId: "t-worker-b", kind: "message", content: oversized }),
    ).rejects.toThrow(/exceeds the .* inline cap/);
  });

  it("leaves content under the cap inline, never touching the artifact store", async () => {
    const artifacts = createInMemoryArtifactRepository();
    const putArtifact = artifacts.putArtifact.bind(artifacts);
    let putCalls = 0;
    artifacts.putArtifact = (input) => {
      putCalls += 1;
      return putArtifact(input);
    };
    const { service, tasks, mailbox } = build({ artifacts });
    await admitTask(tasks, "t-worker-a");
    await admitTask(tasks, "t-worker-b");

    const sent = await service.send({
      actor,
      recipientAgentId: "worker-b",
      recipientTaskId: "t-worker-b",
      kind: "message",
      content: "small",
    });
    expect((await mailbox.getEnvelope(sent.messageId))?.content).toBe("small");
    expect(putCalls).toBe(0);
  });

  it("rejects an oversized accompanying note alongside an explicit artifactId, rather than silently offloading or truncating it", async () => {
    const artifacts = createInMemoryArtifactRepository();
    const { service, tasks } = build({ artifacts });
    await admitTask(tasks, "t-worker-a");
    await admitTask(tasks, "t-worker-b");
    await expect(
      service.send({
        actor,
        recipientAgentId: "worker-b",
        recipientTaskId: "t-worker-b",
        kind: "message",
        content: oversized,
        artifactId: "art-preexisting",
      }),
    ).rejects.toThrow(/exceeds the .* inline cap/);
  });

  it("also offloads over-cap request()/reply() content", async () => {
    const artifacts = createInMemoryArtifactRepository();
    const { service, tasks, mailbox } = build({ artifacts });
    await admitTask(tasks, "t-worker-a");
    await admitTask(tasks, "t-worker-b");
    const requested = await service.request({
      actor: workerA,
      recipientAgentId: "worker-b",
      recipientTaskId: "t-worker-b",
      content: oversized,
      deadlineAt: "2026-01-01T00:10:00.000Z",
    });
    expect((await mailbox.getEnvelope(requested.messageId))?.artifactId).toBeDefined();
    expect((await mailbox.getEnvelope(requested.messageId))?.content).toBeUndefined();

    const replied = await service.reply({ actor: workerB, requestMessageId: requested.messageId, content: oversized });
    expect((await mailbox.getEnvelope(replied.messageId))?.artifactId).toBeDefined();
    expect((await mailbox.getEnvelope(replied.messageId))?.content).toBeUndefined();
  });
});

describe("getArtifact", () => {
  const oversized = "0123456789".repeat(300); // 3000 bytes, over the 2 KiB cap

  it("reads an offloaded artifact's content, bounded by the default read length", async () => {
    const artifacts = createInMemoryArtifactRepository();
    const { service, tasks } = build({ artifacts });
    await admitTask(tasks, "t-worker-a");
    await admitTask(tasks, "t-worker-b");
    const sent = await service.send({
      actor,
      recipientAgentId: "worker-b",
      recipientTaskId: "t-worker-b",
      kind: "message",
      content: oversized,
    });

    const bReceived = { principalId: "alice", workspaceId: "w1", runId: "t-worker-b", caller: "cli" };
    const result = await service.getArtifact({ actor: bReceived, messageId: sent.messageId });
    expect(result.byteSize).toBe(oversized.length);
    expect(result.offset).toBe(0);
    expect(result.length).toBe(MAX_AGENT_ENVELOPE_INLINE_BYTES);
    expect(result.content).toBe(oversized.slice(0, MAX_AGENT_ENVELOPE_INLINE_BYTES));
    expect(result.truncated).toBe(true);
  });

  it("paginates via offset/length, reporting truncated: false on the final page", async () => {
    const artifacts = createInMemoryArtifactRepository();
    const { service, tasks } = build({ artifacts });
    await admitTask(tasks, "t-worker-a");
    await admitTask(tasks, "t-worker-b");
    const sent = await service.send({
      actor,
      recipientAgentId: "worker-b",
      recipientTaskId: "t-worker-b",
      kind: "message",
      content: oversized,
    });
    const bReceived = { principalId: "alice", workspaceId: "w1", runId: "t-worker-b", caller: "cli" };

    const first = await service.getArtifact({ actor: bReceived, messageId: sent.messageId, offset: 0, length: 1000 });
    expect(first.content).toBe(oversized.slice(0, 1000));
    expect(first.truncated).toBe(true);

    const last = await service.getArtifact({ actor: bReceived, messageId: sent.messageId, offset: 2000, length: 1000 });
    expect(last.content).toBe(oversized.slice(2000));
    expect(last.length).toBe(1000);
    expect(last.truncated).toBe(false);
  });

  it("rejects a read from a task that was never the message's recipient — recipient scope, not merely knowing an artifactId", async () => {
    const artifacts = createInMemoryArtifactRepository();
    const { service, tasks } = build({ artifacts });
    await admitTask(tasks, "t-worker-a");
    await admitTask(tasks, "t-worker-b");
    await admitTask(tasks, "t-worker-c");
    const sent = await service.send({
      actor,
      recipientAgentId: "worker-b",
      recipientTaskId: "t-worker-b",
      kind: "message",
      content: oversized,
    });

    const cActor = { principalId: "alice", workspaceId: "w1", runId: "t-worker-c", caller: "cli" };
    await expect(service.getArtifact({ actor: cActor, messageId: sent.messageId })).rejects.toThrow(/does not exist/);
  });

  it("the recipient-scope check is exact task-identity, not same-workspace membership", async () => {
    // Pins the property `getArtifact`'s own code comment claims: the check
    // is `envelope.recipientTaskId !== input.actor.runId`, not
    // `assertOwnsTask`'s weaker same-workspace pattern used elsewhere in
    // this file. Demonstrated here by an actor whose runId string exactly
    // matches the real recipient's but whose workspaceId differs — this
    // still succeeds, because task ids are the actual authority boundary
    // (globally unique in practice, via newId/crypto.randomUUID), not
    // workspace membership. If a future refactor "simplified" this check
    // to `assertOwnsTask`'s shape, this test's second assertion would
    // start failing loudly rather than silently reopening a
    // same-runId-different-workspace read.
    const artifacts = createInMemoryArtifactRepository();
    const { service, tasks } = build({ artifacts });
    await admitTask(tasks, "t-worker-a");
    await admitTask(tasks, "t-worker-b");
    const sent = await service.send({
      actor,
      recipientAgentId: "worker-b",
      recipientTaskId: "t-worker-b",
      kind: "message",
      content: oversized,
    });

    const sameRunIdDifferentWorkspace = { principalId: "alice", workspaceId: "w2", runId: "t-worker-b", caller: "cli" };
    await expect(service.getArtifact({ actor: sameRunIdDifferentWorkspace, messageId: sent.messageId })).resolves.toBeDefined();
  });

  it("returns what the artifact was stored with: a tainted fold archive and an old unlabelled one read untrusted, an offloaded payload as an agent's", async () => {
    const artifacts = createInMemoryArtifactRepository();
    const { service, tasks } = build({ artifacts });
    await admitTask(tasks, "t-worker-a");
    await admitTask(tasks, "t-worker-b");
    const bReceived = { principalId: "alice", workspaceId: "w1", runId: "t-worker-b", caller: "cli" };
    const web = untrustedLabel("web", {
      principal: "host:example.com",
      ref: { ref: "c1", host: "example.com", at: "2026-01-01T00:00:00.000Z" },
    });
    const read = async (artifactId: string) => {
      const sent = await service.send({ actor, recipientAgentId: "worker-b", recipientTaskId: "t-worker-b", kind: "message", artifactId });
      return (await service.getArtifact({ actor: bReceived, messageId: sent.messageId })).label;
    };
    const tainted = await artifacts.putArtifact({
      workspaceId: "w1",
      runId: "t-worker-a",
      contentType: "application/json",
      body: "[]",
      fold: "epoch",
      label: web,
    });
    expect(await read(tainted.artifactId)).toEqual(web);
    const old = await artifacts.putArtifact({
      workspaceId: "w1",
      runId: "t-worker-a",
      contentType: "application/json",
      body: "[]",
      fold: "summary",
    });
    expect(await read(old.artifactId)).toMatchObject({
      integrity: "untrusted",
      sources: expect.arrayContaining(["unknown-source", "agent"]),
    });
    const clean = await artifacts.putArtifact({
      workspaceId: "w1",
      runId: "t-worker-a",
      contentType: "text/plain",
      body: "notes",
      label: TRUSTED_PUBLIC,
    });
    expect(await read(clean.artifactId)).toEqual(TRUSTED_PUBLIC);
    const offloaded = await service.send({
      actor,
      recipientAgentId: "worker-b",
      recipientTaskId: "t-worker-b",
      kind: "message",
      content: oversized,
    });
    expect((await service.getArtifact({ actor: bReceived, messageId: offloaded.messageId })).label).toMatchObject({
      integrity: "untrusted",
      sources: ["agent"],
      principals: [`agent:${actor.runId}`],
    });
  });

  it("rejects a read for a message that carries no artifact (inline content only)", async () => {
    const artifacts = createInMemoryArtifactRepository();
    const { service, tasks } = build({ artifacts });
    await admitTask(tasks, "t-worker-a");
    await admitTask(tasks, "t-worker-b");
    const sent = await service.send({
      actor,
      recipientAgentId: "worker-b",
      recipientTaskId: "t-worker-b",
      kind: "message",
      content: "small",
    });
    const bReceived = { principalId: "alice", workspaceId: "w1", runId: "t-worker-b", caller: "cli" };
    await expect(service.getArtifact({ actor: bReceived, messageId: sent.messageId })).rejects.toThrow(/does not exist/);
  });
});

describe("worker and mailbox labels", () => {
  const web = untrustedLabel("web", { principal: "host:news.example", ref: { ref: "call-1", host: "news.example", at: AT } });
  const threadOf = async (tasks: TaskRepositoryPort, taskId: string): Promise<string> => (await tasks.get(taskId))?.threadId ?? "";

  it("starts a worker with its spawning call's label: clean from a clean turn, the page's sources from a tainted one", async () => {
    const { tasks, workflow, service } = build();
    await admitOrchestratorTask(tasks);
    const before = workflow.calls.length;
    await service.spawn({ actor: { ...actor, label: TRUSTED_PUBLIC }, agentDefinitionId: "x", input: "a", operationKey: "op-clean" });
    await service.spawn({ actor: { ...actor, tainted: true, label: web }, agentDefinitionId: "x", input: "b", operationKey: "op-web" });
    const [clean, tainted] = workflow.calls.slice(before);
    expect(clean?.context.inheritedLabel).toBeUndefined();
    expect(clean?.context.inheritedTaint).toBeUndefined();
    expect(tainted?.context.inheritedLabel).toEqual(web);
    // The label says it all: no bare taint beside it.
    expect(tainted?.context.inheritedTaint).toBeUndefined();
  });

  it("a caller that names no label still hands on a bare taint (in flight before labels), and a label that disagrees is joined with it", async () => {
    const { tasks, workflow, service } = build();
    await admitOrchestratorTask(tasks);
    const before = workflow.calls.length;
    await service.spawn({ actor: { ...actor, tainted: true }, agentDefinitionId: "x", input: "a", operationKey: "op-bare" });
    await service.spawn({
      actor: { ...actor, tainted: true, label: TRUSTED_PUBLIC },
      agentDefinitionId: "x",
      input: "b",
      operationKey: "op-disagree",
    });
    const [bare, disagree] = workflow.calls.slice(before);
    expect(bare?.context.inheritedTaint).toBe(true);
    expect(bare?.context.inheritedLabel).toBeUndefined();
    expect(disagree?.context.inheritedTaint).toBe(true);
  });

  it("a clean worker's result carries a trusted label; one that fetched a page carries the page's; one whose label cannot be read fails safe", async () => {
    const artifacts = createInMemoryArtifactRepository();
    const { tasks, workflow, service, mailbox } = build({ artifacts });
    await admitOrchestratorTask(tasks);
    const clean = await service.spawn({ actor, agentDefinitionId: "x", input: "a", operationKey: "op-r-clean" });
    const fetched = await service.spawn({ actor, agentDefinitionId: "x", input: "b", operationKey: "op-r-web" });
    const unread = await service.spawn({ actor, agentDefinitionId: "x", input: "c", operationKey: "op-r-unread" });
    workflow.labels.set(await threadOf(tasks, clean.workerTaskId), TRUSTED_PUBLIC);
    workflow.labels.set(await threadOf(tasks, fetched.workerTaskId), web);
    for (const [worker, text] of [
      [clean, "clean"],
      [fetched, "x".repeat(MAX_AGENT_ENVELOPE_INLINE_BYTES * 2)],
      [unread, "unread"],
    ] as const) {
      await tasks.updateStatus(worker.workerTaskId, "completed", text);
      await service.announceWorkerResult(worker.workerTaskId);
    }
    const results = await mailbox.listByCorrelation(`worker-result:${clean.workerTaskId}`);
    expect(results[0]?.label).toEqual(TRUSTED_PUBLIC);
    const page = (await mailbox.listByCorrelation(`worker-result:${fetched.workerTaskId}`))[0];
    expect(page?.label).toEqual(web);
    // Its whole answer, kept as an artifact, is stored with the worker's label, not an agent placeholder.
    expect(page?.artifactId).toBeDefined();
    expect((await artifacts.getArtifact(page?.artifactId ?? ""))?.label).toEqual(web);
    expect((await mailbox.listByCorrelation(`worker-result:${unread.workerTaskId}`))[0]?.label).toMatchObject({
      integrity: "untrusted",
      sources: ["agent"],
      principals: [`agent:${unread.workerTaskId}`],
    });
    // `agents.status` reads its final words with the same label.
    expect((await service.status({ actor, taskId: clean.workerTaskId })).label).toEqual(TRUSTED_PUBLIC);
    expect((await service.status({ actor, taskId: fetched.workerTaskId })).label).toEqual(web);
  });

  it("a peer message carries its sender's label at send time, offloaded or not; an unlabelled one reads as an agent's, untrusted", async () => {
    const artifacts = createInMemoryArtifactRepository();
    const { service, tasks, mailbox } = build({ artifacts });
    await admitTask(tasks, "t-worker-b");
    const small = await service.send({
      actor: { ...actor, label: web },
      recipientAgentId: "worker-b",
      recipientTaskId: "t-worker-b",
      kind: "message",
      content: "see the page",
    });
    const big = await service.send({
      actor: { ...actor, label: TRUSTED_PUBLIC },
      recipientAgentId: "worker-b",
      recipientTaskId: "t-worker-b",
      kind: "message",
      content: "y".repeat(MAX_AGENT_ENVELOPE_INLINE_BYTES * 2),
    });
    const old = await service.send({
      actor,
      recipientAgentId: "worker-b",
      recipientTaskId: "t-worker-b",
      kind: "message",
      content: "from before labels",
    });
    expect((await mailbox.getEnvelope(small.messageId))?.label).toEqual(web);
    expect((await mailbox.getEnvelope(big.messageId))?.label).toEqual(TRUSTED_PUBLIC);
    const bReceived = { principalId: "alice", workspaceId: "w1", runId: "t-worker-b", caller: "cli" };
    expect((await service.getArtifact({ actor: bReceived, messageId: big.messageId })).label).toEqual(TRUSTED_PUBLIC);
    const unlabelled = await mailbox.getEnvelope(old.messageId);
    expect(unlabelled?.label).toBeUndefined();
    expect(envelopeLabel(unlabelled!)).toMatchObject({ integrity: "untrusted", sources: ["agent"], principals: [`agent:${actor.runId}`] });
    // The receiver's mailbox block is labelled by the join of what it shows.
    const note = mailboxContextNote([(await mailbox.getEnvelope(small.messageId))!, unlabelled!]);
    expect(note?.label).toMatchObject({ integrity: "untrusted", sources: expect.arrayContaining(["agent", "web"]) });
    expect(mailboxContextNote([(await mailbox.getEnvelope(big.messageId))!])?.label).toEqual(TRUSTED_PUBLIC);
    // The label is never in the block's text.
    expect(note?.text).not.toContain("integrity");
  });

  it("a request and its reply carry their senders' labels at send time, inline or offloaded", async () => {
    const artifacts = createInMemoryArtifactRepository();
    const { service, tasks, mailbox } = build({ artifacts });
    await admitOrchestratorTask(tasks);
    await admitTask(tasks, "t-worker-b");
    const asked = await service.request({
      actor: { ...actor, label: web },
      recipientAgentId: "worker-b",
      recipientTaskId: "t-worker-b",
      content: "what did the page say?",
      deadlineAt: "2026-01-01T01:00:00.000Z",
    });
    const big = await service.request({
      actor: { ...actor, label: TRUSTED_PUBLIC },
      recipientAgentId: "worker-b",
      recipientTaskId: "t-worker-b",
      content: "q".repeat(MAX_AGENT_ENVELOPE_INLINE_BYTES * 2),
      deadlineAt: "2026-01-01T01:00:00.000Z",
    });
    expect((await mailbox.getEnvelope(asked.messageId))?.label).toEqual(web);
    const bReceived = { principalId: "alice", workspaceId: "w1", runId: "t-worker-b", caller: "cli" };
    expect((await service.getArtifact({ actor: bReceived, messageId: big.messageId })).label).toEqual(TRUSTED_PUBLIC);
    const answered = await service.reply({
      actor: { ...bReceived, agentId: "worker-b", label: TRUSTED_PUBLIC },
      requestMessageId: asked.messageId,
      content: "nothing worrying",
    });
    const bigAnswer = await service.reply({
      actor: { ...bReceived, agentId: "worker-b", label: web },
      requestMessageId: big.messageId,
      content: "a".repeat(MAX_AGENT_ENVELOPE_INLINE_BYTES * 2),
    });
    expect((await mailbox.getEnvelope(answered.messageId))?.label).toEqual(TRUSTED_PUBLIC);
    expect((await mailbox.getEnvelope(bigAnswer.messageId))?.label).toEqual(web);
    expect((await service.getArtifact({ actor, messageId: bigAnswer.messageId })).label).toEqual(web);
  });

  it("another principal's words are never trusted: send, request, reply and status join chat-other, however clean the sender", async () => {
    const artifacts = createInMemoryArtifactRepository();
    const { service, tasks, mailbox, workflow } = build({ artifacts });
    await admitOrchestratorTask(tasks);
    await admitFixtureTask(tasks, "t-bob", fixturePromptPolicy, { workspaceId: actor.workspaceId, principalId: "bob", now: () => AT });
    const otherPerson = {
      integrity: "untrusted",
      sources: expect.arrayContaining(["chat-other"]),
      principals: expect.arrayContaining(["agent:t-orchestrator"]),
    };
    const sent = await service.send({
      actor: { ...actor, label: TRUSTED_PUBLIC },
      recipientAgentId: "bob",
      recipientTaskId: "t-bob",
      kind: "message",
      content: "do this now",
    });
    expect((await mailbox.getEnvelope(sent.messageId))?.label).toMatchObject(otherPerson);
    const offloaded = await service.send({
      actor: { ...actor, label: TRUSTED_PUBLIC },
      recipientAgentId: "bob",
      recipientTaskId: "t-bob",
      kind: "message",
      content: "z".repeat(MAX_AGENT_ENVELOPE_INLINE_BYTES * 2),
    });
    expect(
      (
        await service.getArtifact({
          actor: { principalId: "bob", workspaceId: "w1", runId: "t-bob", caller: "cli" },
          messageId: offloaded.messageId,
        })
      ).label,
    ).toMatchObject(otherPerson);
    // Unlabelled too: an agent's words, and another person's.
    const bare = await service.send({ actor, recipientAgentId: "bob", recipientTaskId: "t-bob", kind: "message", content: "hi" });
    expect((await mailbox.getEnvelope(bare.messageId))?.label).toMatchObject({
      integrity: "untrusted",
      sources: expect.arrayContaining(["agent", "chat-other"]),
    });
    const asked = await service.request({
      actor: { ...actor, label: TRUSTED_PUBLIC },
      recipientAgentId: "bob",
      recipientTaskId: "t-bob",
      content: "?",
      deadlineAt: "2026-01-01T01:00:00.000Z",
    });
    expect((await mailbox.getEnvelope(asked.messageId))?.label).toMatchObject(otherPerson);
    const bob = { principalId: "bob", workspaceId: "w1", runId: "t-bob", agentId: "bob", caller: "cli", label: TRUSTED_PUBLIC };
    const answered = await service.reply({ actor: bob, requestMessageId: asked.messageId, content: "!" });
    expect((await mailbox.getEnvelope(answered.messageId))?.label).toMatchObject({
      integrity: "untrusted",
      sources: ["chat-other"],
      principals: ["agent:t-bob"],
    });
    // A clean task of another principal, read by status: its words are that person's.
    await tasks.updateStatus("t-bob", "completed", "bob's answer");
    workflow.labels.set(await threadOf(tasks, "t-bob"), TRUSTED_PUBLIC);
    expect((await service.status({ actor, taskId: "t-bob" })).label).toMatchObject({
      integrity: "untrusted",
      sources: ["chat-other"],
      principals: ["agent:t-bob"],
    });
    // The same principal's clean task stays trusted.
    await tasks.updateStatus("t-orchestrator", "completed", "mine");
    workflow.labels.set(await threadOf(tasks, "t-orchestrator"), TRUSTED_PUBLIC);
    expect((await service.status({ actor, taskId: "t-orchestrator" })).label).toEqual(TRUSTED_PUBLIC);
  });
});
