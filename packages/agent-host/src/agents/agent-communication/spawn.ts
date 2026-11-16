import {
  isTrustedPublic,
  isUntrusted,
  type ContentLabel,
  DEFAULT_TASK_POLICY,
  type TaskExecutionPolicy,
  MAX_SHARED_MEMORY_RECORD_IDS,
  TaviError,
  MAX_SPAWN_TOOLS,
  toolPatternMatches,
  type AgentActor,
  type AgentDelegatedBudget,
  type AgentSpawnInput,
  type AgentSpawnResult,
  type MemoryActor,
  DEFAULT_MAX_CONCURRENT_WORKERS,
  DEFAULT_MAX_SPAWN_DEPTH,
} from "@tavi/contracts";
import { definedOnly, errorMessage } from "@tavi/contracts/util";
import { contextFrom, type AgentCommunicationContext } from "./context.js";

/** How many of a tree's workers a refused spawn names. */
const QUOTA_NAMED_WORKERS = 8;

/**
 * What a spawned worker starts with: its spawning call's context label
 * (`inheritedLabel`), joined with a bare taint when the call also says it was
 * tainted, so the two never disagree downward. A caller that names no label
 * hands on only `inheritedTaint`, read as untrusted from an unknown source.
 */
function spawnLabel(actor: AgentActor): { readonly inheritedLabel?: ContentLabel; readonly inheritedTaint?: true } {
  if (actor.label === undefined) return actor.tainted === true ? { inheritedTaint: true } : {};
  return {
    ...(isTrustedPublic(actor.label) ? {} : { inheritedLabel: actor.label }),
    ...(actor.tainted === true && !isUntrusted(actor.label) ? { inheritedTaint: true as const } : {}),
  };
}

/**
 * Combines a spawning caller's own inherited budget with the budget it
 * explicitly requests for its child, never letting the child end up LESS
 * bounded than the caller itself was ("one root budget
 * [preserved] across spawn depth").
 *
 * A naive `requested ?? callerBudget` (this fix's own first draft, a
 * scoped review caught before it shipped) treats an explicit `budget: {}`
 * — every field omitted, but the object itself present — as "fully
 * specified, nothing to inherit," silently discarding the caller's own
 * `maxSpawnDepth`/etc. rather than inheriting it: `{}.maxSpawnDepth` is
 * `undefined`, so the enforcement check in `spawn()` never fires, and the
 * escaped (unbounded) budget is what gets PERSISTED for this worker's own
 * descendants to inherit from — exactly the resource-exhaustion vector
 * this whole fix exists to close, and reachable by exactly the actor it
 * targets (a delegated worker calling `spawn()` on its own children).
 *
 * Per-field, not all-or-nothing: a numeric dimension merges to the
 * NARROWER of the two (a caller may tighten what it inherited, never
 * loosen or drop it); `expiresAt` merges to the EARLIER of the two, same
 * reasoning. A dimension neither side set stays unset (still unbounded on
 * that one dimension — this only enforces "never gets wider than what
 * either the caller or its own parent already bounded it to").
 */
function mergeBudget(
  callerBudget: AgentDelegatedBudget | undefined,
  requested: AgentDelegatedBudget | undefined,
): AgentDelegatedBudget | undefined {
  if (callerBudget === undefined) return requested;
  if (requested === undefined) return callerBudget;
  const narrower = (a: number | undefined, b: number | undefined): number | undefined =>
    a === undefined ? b : b === undefined ? a : Math.min(a, b);
  const earlier = (a: string | undefined, b: string | undefined): string | undefined =>
    a === undefined ? b : b === undefined ? a : a < b ? a : b;
  const merged: AgentDelegatedBudget = {
    ...(narrower(callerBudget.maxSpawnDepth, requested.maxSpawnDepth) === undefined
      ? {}
      : { maxSpawnDepth: narrower(callerBudget.maxSpawnDepth, requested.maxSpawnDepth) }),
    ...(narrower(callerBudget.maxConcurrentWorkers, requested.maxConcurrentWorkers) === undefined
      ? {}
      : { maxConcurrentWorkers: narrower(callerBudget.maxConcurrentWorkers, requested.maxConcurrentWorkers) }),
    ...(narrower(callerBudget.maxModelCalls, requested.maxModelCalls) === undefined
      ? {}
      : { maxModelCalls: narrower(callerBudget.maxModelCalls, requested.maxModelCalls) }),
    ...(narrower(callerBudget.maxToolCalls, requested.maxToolCalls) === undefined
      ? {}
      : { maxToolCalls: narrower(callerBudget.maxToolCalls, requested.maxToolCalls) }),
    ...(narrower(callerBudget.maxMessages, requested.maxMessages) === undefined
      ? {}
      : { maxMessages: narrower(callerBudget.maxMessages, requested.maxMessages) }),
    ...(narrower(callerBudget.maxMessageBytes, requested.maxMessageBytes) === undefined
      ? {}
      : { maxMessageBytes: narrower(callerBudget.maxMessageBytes, requested.maxMessageBytes) }),
    ...(narrower(callerBudget.maxMailboxMessages, requested.maxMailboxMessages) === undefined
      ? {}
      : { maxMailboxMessages: narrower(callerBudget.maxMailboxMessages, requested.maxMailboxMessages) }),
    ...(earlier(callerBudget.expiresAt, requested.expiresAt) === undefined
      ? {}
      : { expiresAt: earlier(callerBudget.expiresAt, requested.expiresAt) }),
  };
  return merged;
}

/**
 * `policy` with its allowlist narrowed to `tools` (`AgentSpawnInput.tools`): each named tool the parent's
 * allowlist allows, by an exact id it matches or any id when the parent has none. Never wider than the
 * parent's; at most `MAX_SPAWN_TOOLS`.
 */
function narrowedToTools(policy: TaskExecutionPolicy, tools: readonly string[]): TaskExecutionPolicy {
  if (tools.length > MAX_SPAWN_TOOLS)
    throw new TaviError("INVALID_INPUT", `a spawn may name at most ${MAX_SPAWN_TOOLS} tools for its worker, not ${tools.length}`);
  const parent = policy.toolAllowlist;
  const allowed =
    parent === undefined
      ? [...new Set(tools)]
      : [...new Set(tools)].filter((tool) => parent.some((pattern) => toolPatternMatches(pattern, tool)));
  return { ...policy, toolAllowlist: allowed };
}

/**
 * The policy a spawned worker inherits, failing closed but not silently.
 *
 * A spawning actor is always a task today, so a missing `runId` is a caller
 * bug; a missing *row* for a real run id means the parent is gone. Either way
 * the child gets the conservative default — and the failure is reported, so a
 * silently unattended worker is observable rather than invisible.
 */
/** The parent task's durable policy, or `undefined` (reported) when there is no parent row to read it from. */
async function inheritedExecutionPolicy(
  ctx: AgentCommunicationContext,
  parentRunId: string | undefined,
): Promise<TaskExecutionPolicy | undefined> {
  const { options } = ctx;
  if (parentRunId === undefined) {
    options.onDiagnostic?.("a spawn request carried no parent run id; the worker inherits the unattended default", {});
    return undefined;
  }
  const policy = (await options.tasks.get(parentRunId))?.executionPolicy;
  if (policy === undefined) {
    options.onDiagnostic?.("a spawn request named a parent task with no durable row; the worker inherits the unattended default", {
      parentRunId,
    });
    return undefined;
  }
  return policy;
}

export async function spawn(ctx: AgentCommunicationContext, input: AgentSpawnInput): Promise<AgentSpawnResult> {
  const { options, now, newId } = ctx;
  const existing = await options.delegations.getByOperationKey(input.actor.workspaceId, input.actor.principalId, input.operationKey);
  if (existing !== undefined) {
    return { workerAgentId: existing.workerAgentId, workerTaskId: existing.workerTaskId, created: false };
  }
  const sharedMemoryRecordIds = input.sharedMemoryRecordIds ?? [];
  if (sharedMemoryRecordIds.length > MAX_SHARED_MEMORY_RECORD_IDS) {
    throw new TaviError(
      "INVALID_INPUT",
      `sharedMemoryRecordIds has ${sharedMemoryRecordIds.length} entries, exceeding the ${MAX_SHARED_MEMORY_RECORD_IDS}-record bound`,
    );
  }
  // If the spawning actor is itself a restricted worker (its own task has
  // a delegation row), both the memory-grant check below AND the budget
  // enforcement just below that need it — re-derived from `delegations`
  // the same way `contextFrom` re-derives it for a worker's own context.
  const callerDelegation = input.actor.runId === undefined ? undefined : await options.delegations.getByWorkerTaskId(input.actor.runId);
  // Delegation preserves one root budget across spawn depth — an absent
  // `input.budget` inherits the parent's own budget unchanged, never
  // becoming unbounded partway down a chain a parent already bounded.
  // `maxSpawnDepth` and `maxConcurrentWorkers` are
  // enforced, with defaults when no budget names them;
  // `maxMessages`/`maxMessageBytes`/`maxMailboxMessages` need their own
  // cross-cutting counters and remain a disclosed, separate gap.
  const depth = (callerDelegation?.depth ?? 0) + 1;
  const effectiveBudget = mergeBudget(callerDelegation?.budget, input.budget);
  // A budget narrows the defaults, never widens them.
  const maxDepth = Math.min(effectiveBudget?.maxSpawnDepth ?? DEFAULT_MAX_SPAWN_DEPTH, DEFAULT_MAX_SPAWN_DEPTH);
  if (depth > maxDepth) {
    throw new TaviError("QUOTA_EXCEEDED", `spawn would create a worker at depth ${depth}, past this tree's limit of ${maxDepth} levels`);
  }
  // Counted over the whole tree from its root: a tree's running workers, wherever they sit.
  const treeRootTaskId = callerDelegation?.rootTaskId ?? input.actor.runId;
  const maxConcurrent = Math.min(effectiveBudget?.maxConcurrentWorkers ?? DEFAULT_MAX_CONCURRENT_WORKERS, DEFAULT_MAX_CONCURRENT_WORKERS);
  if (treeRootTaskId !== undefined) {
    const running = await options.delegations.countRunningInTree(input.actor.workspaceId, treeRootTaskId);
    if (running >= maxConcurrent) {
      // Named, so the model (and the person) can tell which to wait for or
      // cancel: a worker waiting on an approval or a question counts until it ends.
      const blocking = await options.delegations.listRunningInTree(input.actor.workspaceId, treeRootTaskId, QUOTA_NAMED_WORKERS);
      const named = blocking
        .map((worker) => `${worker.workerTaskId} (${worker.agentDefinitionId ?? "worker"}, ${worker.status})`)
        .join(", ");
      throw new TaviError(
        "QUOTA_EXCEEDED",
        `spawn would run ${running + 1} workers at once in this tree, past its limit of ${maxConcurrent}; wait for one to finish` +
          (named === ""
            ? ""
            : `. Not ended: ${named}${running > blocking.length ? `, and ${running - blocking.length} more` : ""} — a worker waiting on an approval or a question counts until it ends`),
        { details: { running, limit: maxConcurrent, workers: blocking.map((worker) => worker.workerTaskId) } },
      );
    }
  }
  if (sharedMemoryRecordIds.length > 0) {
    // Validated against the spawning actor's OWN read authorization —
    // never the worker's, which doesn't exist yet.
    // `authority: "operator"` is a fixed placeholder here: authority only
    // gates write paths (propose/approve) elsewhere in MemoryService, not
    // the scope-resolution this read exercises, so its value is
    // immaterial to what this check actually verifies.
    if (options.memory === undefined) {
      throw new TaviError("INVALID_INPUT", "sharedMemoryRecordIds was provided but no memory service is configured to validate it against");
    }
    // If the spawning actor is itself a restricted worker (its own task
    // has a delegation row), the read check below must apply that SAME
    // restriction — otherwise a restricted worker could grant a
    // grandchild access to a personal-scope record it was never itself
    // delegated, reopening the escalation `scopeRestricted` enforcement
    // exists to close.
    const validatingActor: MemoryActor = {
      principalId: input.actor.principalId,
      workspaceId: input.actor.workspaceId,
      ...(input.actor.agentId === undefined ? {} : { agentId: input.actor.agentId }),
      ...(input.actor.runId === undefined ? {} : { runId: input.actor.runId }),
      caller: input.actor.caller,
      authority: "operator",
      // A group conversation's turn reads only its chat's notes, so it can hand on no other record.
      ...(input.actor.memoryReach === undefined ? {} : { reach: input.actor.memoryReach }),
      ...(callerDelegation === undefined
        ? {}
        : {
            scopeRestricted: true,
            ...(callerDelegation.sharedMemoryRecordIds === undefined ? {} : { allowedRecordIds: callerDelegation.sharedMemoryRecordIds }),
          }),
    };
    for (const recordId of sharedMemoryRecordIds) {
      try {
        await options.memory.get({ actor: validatingActor, recordId });
      } catch {
        throw new TaviError("INVALID_INPUT", `sharedMemoryRecordIds includes ${recordId}, which the spawning actor cannot itself read`);
      }
    }
  }
  // The worker's own agent identity: opaque and unrelated to
  // `agentDefinitionId` (see agent-communication.ts's contracts-side
  // header comment on why the latter has no registry yet).
  const workerAgentId = newId("agent");
  // The root `recordSpawn` below writes, else the spawner: what `contextFrom`
  // reads back from the row (`rootTaskId ?? parentTaskId`) on later turns.
  const chatTaskId = (callerDelegation ? callerDelegation.rootTaskId : input.actor.runId) ?? input.actor.runId;
  // A backgrounded worker's row is written as soon as its task exists,
  // before any of its nodes runs, so one that ends — however soon — finds
  // it, and its result its parent. A joined worker's is written
  // after its turn, as before: a retried spawn then finds no row until the
  // worker's first turn is done, and joins it again rather than answering early.
  const record = async (workerTaskId: string): Promise<void> => {
    await options.delegations.recordSpawn({
      operationKey: input.operationKey,
      workspaceId: input.actor.workspaceId,
      principalId: input.actor.principalId,
      workerTaskId,
      workerAgentId,
      ...(input.actor.runId === undefined ? {} : { parentTaskId: input.actor.runId }),
      ...definedOnly({ rootTaskId: callerDelegation ? callerDelegation.rootTaskId : (input.actor.runId ?? workerTaskId) }),
      createdAt: now(),
      depth,
      ...(sharedMemoryRecordIds.length > 0 ? { sharedMemoryRecordIds: [...sharedMemoryRecordIds] } : {}),
      ...(input.agentDefinitionId === undefined ? {} : { agentDefinitionId: input.agentDefinitionId }),
      ...(effectiveBudget === undefined ? {} : { budget: effectiveBudget }),
      // Held to the spawning turn's channel for its whole life.
      ...(input.actor.heldChannel === undefined ? {} : { heldChannel: input.actor.heldChannel }),
      ...(input.actor.heldConnectionId === undefined ? {} : { heldConnectionId: input.actor.heldConnectionId }),
      // Held to rules for the spawning turn's front end for its whole life.
      ...(input.actor.frontEnd === undefined ? {} : { frontEnd: input.actor.frontEnd }),
    });
  };
  let signalAdmitted: (task: { readonly taskId: string; readonly created: boolean }) => void = () => undefined;
  const whenAdmitted = new Promise<{ readonly taskId: string; readonly created: boolean }>((resolve) => {
    signalAdmitted = resolve;
  });
  // The parent's policy (a host may hand it in for a parent not admitted yet), narrowed to the tools the spawn
  // names: a worker sent to do one thing is offered the tools for it, and their schemas, alone.
  const inherited = input.parentPolicy ?? (await inheritedExecutionPolicy(ctx, input.actor.runId));
  const parentPolicy = inherited ?? DEFAULT_TASK_POLICY;
  const policy = input.tools === undefined ? parentPolicy : narrowedToTools(parentPolicy, input.tools);
  // Backgrounded for a spawner that hears back from its worker — an attended one, or a schedule's fire,
  // which is not over until it has read its workers' results (`hearsLateResults`). Any other (a routine's,
  // a heartbeat's, a worker's, one stored under the default policy), or one with no task, joins its worker.
  const backgrounded =
    input.background === true &&
    (policy.mode === "attended" ||
      (callerDelegation === undefined && inherited?.schedulingWritesDenied === true && inherited.workerWaitsAllowed));
  const running = options.workflow.admit({
    ...(backgrounded
      ? {
          onAdmitted: async (value) => {
            await record(value.taskId);
            signalAdmitted({ taskId: value.taskId, created: value.created });
          },
        }
      : {}),
    // `runId: "pending-admission"` is this codebase's own placeholder
    // for "not yet admitted" (matches `apps/cli/src/main.ts`'s identical
    // literal for a brand-new `kind: "start"` admission). Built directly
    // rather than through `contextFrom`: no delegation row exists yet for
    // this worker (recordSpawn below hasn't run), so `contextFrom`'s own
    // lookup would find nothing and return an unrestricted context —
    // `memoryScopeRestricted: true` is set unconditionally here for
    // every worker's first turn, matching what `contextFrom` reconstructs
    // for every turn after.
    context: {
      ...(await contextFrom(ctx, input.actor, "pending-admission")),
      memoryScopeRestricted: true,
      ...(sharedMemoryRecordIds.length > 0 ? { delegatedMemoryRecordIds: sharedMemoryRecordIds } : {}),
      // The chat it is delegated from, as `recordSpawn` below records its root.
      ...(chatTaskId === undefined ? {} : { chatTaskId }),
      // The persona the spawner asked for. This is what
      // makes `agentDefinitionId` load-bearing instead of "accepted and then
      // completely ignored": the worker's every turn resolves it, so a
      // `news-relevance` worker runs under its own instructions rather than
      // its orchestrator's. Admission validates the reference, so an unknown
      // id fails the spawn rather than silently running with the base prompt.
      ...(input.agentDefinitionId === undefined ? {} : { agentDefinitionId: input.agentDefinitionId }),
      // The channel the spawning turn is held to: a turn sent from a
      // messaging conversation cannot leave the messaging profile by
      // delegating, as a chat task's worker is held to its origin.
      ...(input.actor.heldChannel === undefined ? {} : { heldChannel: input.actor.heldChannel }),
      ...(input.actor.heldConnectionId === undefined ? {} : { heldConnectionId: input.actor.heldConnectionId }),
      // The spawning turn's memory reach: a group's worker reads only its chat's notes
      // from its first turn, before its delegation row exists for the workflow to judge it by.
      ...(input.actor.memoryReach === undefined ? {} : { memoryReach: input.actor.memoryReach }),
      // The spawning chat's memory mode: a worker of an off or private chat is off
      // from its first turn, before its delegation row exists for the composition to read it by.
      ...(input.actor.chatMemoryMode === undefined ? {} : { chatMemoryMode: input.actor.chatMemoryMode }),
      // The front end the spawning turn was typed in: a
      // canvas turn cannot leave a `web`-scoped deny by delegating.
      ...(input.actor.frontEnd === undefined ? {} : { frontEnd: input.actor.frontEnd }),
      // The worker starts with its spawning call's context label: a spawn from a clean
      // turn starts clean, one from a tainted turn tainted, with the sources that tainted it. A caller that
      // names no label but says the call was tainted hands on a bare taint, read as untrusted, source unknown.
      ...spawnLabel(input.actor),
      // What the spawning task knows: its prompt is the spawner's words, not a person's.
      ...(input.actor.knownUrls === undefined ? {} : { inheritedKnownUrls: input.actor.knownUrls }),
    },
    operationKey: input.operationKey,
    kind: "start",
    // A spawned worker inherits its creating task's policy from the durable
    // row: a scheduled (unattended) parent must not be able to obtain a human
    // question by delegating it to a child. Reading the parent rather
    // than taking a parameter keeps every later worker turn — which
    // `contextFrom` rebuilds with no policy field — on the same policy.
    executionPolicy: policy,
    // A spawned worker is an agent's task, recorded durably.
    origin: "agent",
    // Never shown as a chat.
    chatKind: "worker",
    prompt: input.input,
  });
  if (backgrounded) {
    // The spawner goes on once the worker's task exists; a failure before
    // that (an unknown persona, a refused admission) is the spawn's own.
    const first = await Promise.race([
      whenAdmitted,
      running.then((admission) => ({ taskId: admission.taskId, created: admission.created })),
    ]);
    running.catch((error: unknown) =>
      options.onDiagnostic?.("a background worker's turn failed", { workerTaskId: first.taskId, error: errorMessage(error) }),
    );
    return { workerAgentId, workerTaskId: first.taskId, created: first.created };
  }
  const admission = await running;
  // Written after `admit` resolves, with the same operationKey: a crash
  // between the two means a retry's `admit` resolves the identical task, so
  // this write still only happens once real work has a durable home.
  await record(admission.taskId);
  return { workerAgentId, workerTaskId: admission.taskId, created: admission.created };
}
