import {
  untrustedLabel,
  agentWordsLabel,
  type ContentLabel,
  MAX_AGENT_ENVELOPE_INLINE_BYTES,
  TaviError,
  boundAgentWaitDeadline,
  agentMessageGrant,
  type AgentActor,
  type AgentEnvelope,
  type InvocationContext,
  type TaskRecord,
  type FrontEnd,
  type TurnChannel,
} from "@tavi/contracts";
import { errorMessage } from "@tavi/contracts/util";
import type { AgentCommunicationServiceOptions } from "../agent-communication.js";

export const DEFAULT_PROTOCOL_VERSION = 1;

/** What a turn is held to besides its task's origin: carried from a spawning turn to its worker, and a worker's result to its parent's wake. */
export interface Hold {
  readonly heldChannel?: TurnChannel | undefined;
  readonly heldConnectionId?: string | undefined;
  readonly frontEnd?: FrontEnd | undefined;
}
/** The statuses a task ends in: a worker task in one will never run again. */
export const TERMINAL_TASK_STATUSES: ReadonlySet<string> = new Set(["completed", "failed", "stopped", "cancelled"]);

/** The id of the `result` envelope announcing a worker's ending: its last admission's, so one ending is one envelope. */
export function workerResultMessageId(workerTaskId: string, latest: { readonly admissionId: string } | undefined): string {
  return `worker-result-${latest?.admissionId ?? workerTaskId}`;
}

/** The correlation id a worker's `result` to its parent carries: the only one a `result` may settle a wait under. */
export function workerResultCorrelationId(workerTaskId: string): string {
  return `worker-result:${workerTaskId}`;
}

/** How far up a delegation chain `cancel` looks for its caller: deeper than any spawn depth allows. */
const MAX_DELEGATION_ANCESTRY = 64;

/**
 * What the service's operations share, built once by `createAgentCommunicationService`: its options, the
 * clock and id source they resolve to, and the two in-memory maps.
 */
export interface AgentCommunicationContext {
  readonly options: AgentCommunicationServiceOptions;
  readonly now: () => string;
  readonly newId: (prefix: string) => string;
  readonly leaseMs: number;
  /**
   * `expectedReplySchema` (a live `z.ZodType` in practice, `unknown` at
   * this port boundary — see `agent-communication.ts`'s header comment)
   * is held only in-process, keyed by the request's `messageId`, and
   * consumed once by
   * the matching `reply`. Never persisted: it has no serializable wire
   * form this contract defines, and a restart between `request` and
   * `reply` already loses the ability to validate against it (disclosed,
   * not solved, in that header comment).
   *
   * A request that never gets a (successful) `reply` — its wait times out,
   * or the requester's task is cancelled — would otherwise leak its entry
   * for the life of the process. Each entry
   * carries its own `deadlineAt` so `pruneExpiredReplySchemas` can evict it
   * once that deadline passes, called opportunistically from `request`
   * rather than adding a second scheduler; `cancel` evicts immediately
   * rather than waiting for the deadline, since cancellation makes the
   * eventual reply moot right away.
   */
  readonly expectedReplySchemas: Map<string, { readonly schema: unknown; readonly deadlineAt: string }>;
  /**
   * Tasks a worker's result owes a wake, with the channel
   * the worker's spawning turn was held to and the front end it was typed in:
   * set when the result comes, taken
   * by `wakeIfOwed` once the task neither runs nor waits — at once, or when
   * its admission ends. In memory: a restart loses it, and the result stays
   * in the mailbox for the task's next turn.
   */
  readonly owed: Map<string, Hold>;
}

/**
 * `taskId` is looked up against `delegations.getByWorkerTaskId` on every
 * call, not only at spawn: the checkpointed `invocation` channel has no
 * reducer, so each admission that touches a task rebuilds its
 * `InvocationContext` from scratch via this function, and a worker's
 * `memoryScopeRestricted`/`delegatedMemoryRecordIds` pair would silently
 * revert to unrestricted on its very next turn (wake/reply) if it were
 * only ever set once, at the moment `spawn` first admits the task.
 * `spawn`'s own first-admission call
 * constructs its context separately (the delegation row does not exist
 * until *after* that admission resolves), so this lookup path only ever
 * serves a worker's second and later turns.
 */
export async function contextFrom(ctx: AgentCommunicationContext, actor: AgentActor, taskId: string): Promise<InvocationContext> {
  const { options } = ctx;
  const base: InvocationContext = { workspaceId: actor.workspaceId, principalId: actor.principalId, runId: taskId, caller: actor.caller };
  const delegation = await options.delegations.getByWorkerTaskId(taskId);
  if (delegation === undefined) return base;
  return {
    ...base,
    memoryScopeRestricted: true,
    ...(delegation.sharedMemoryRecordIds === undefined ? {} : { delegatedMemoryRecordIds: delegation.sharedMemoryRecordIds }),
    // Re-derived from the row for the same reason the memory grant is: this
    // rebuild *replaces* the checkpointed invocation wholesale (no reducer),
    // so a persona that lived only on the spawn admission was gone by the
    // worker's next turn — its `wake()` would run under the base instructions
    // and nothing would say so.
    ...(delegation.agentDefinitionId === undefined ? {} : { agentDefinitionId: delegation.agentDefinitionId }),
    // The chat it was delegated from, whose notes it reads.
    ...((delegation.rootTaskId ?? delegation.parentTaskId) === undefined
      ? {}
      : { chatTaskId: delegation.rootTaskId ?? delegation.parentTaskId }),
    // The channel its spawning turn was held to, on every turn of its own.
    ...(delegation.heldChannel === undefined ? {} : { heldChannel: delegation.heldChannel }),
    ...(delegation.heldConnectionId === undefined ? {} : { heldConnectionId: delegation.heldConnectionId }),
    // The front end its spawning turn was typed in, likewise.
    ...(delegation.frontEnd === undefined ? {} : { frontEnd: delegation.frontEnd }),
  };
}

/**
 * A task's context label as it ended: what
 * its result and its final answer carry to whoever reads them. A clean
 * worker's is trusted, so it no longer taints its parent;
 * one that fetched a page carries the page's label. Fails safe: a label
 * that cannot be read is an agent's words, untrusted.
 */
export async function endedLabel(ctx: AgentCommunicationContext, task: Pick<TaskRecord, "taskId" | "threadId">): Promise<ContentLabel> {
  const { options } = ctx;
  const unread = agentWordsLabel(task.taskId);
  try {
    return (await options.workflow.checkpoints.contextLabel?.(task.threadId)) ?? unread;
  } catch (error) {
    options.onDiagnostic?.("a task's context label could not be read; its words read as untrusted", {
      taskId: task.taskId,
      error: errorMessage(error),
    });
    return unread;
  }
}

/**
 * Resolves `taskId` and asserts it belongs to `actor`'s own workspace,
 * throwing `NOT_FOUND` otherwise — the same "don't reveal whether an
 * unauthorized object exists" shape `TaviError`'s own doc comment
 * requires, rather than a distinguishable `NOT_AUTHORIZED`. Every
 * operation (in `mail.ts` and `waits.ts`) that takes a
 * `taskId`/`recipientTaskId` calls this *before* any mutating side
 * effect, so nothing is ever delivered across workspaces.
 */
export async function assertOwnsTask(ctx: AgentCommunicationContext, actor: AgentActor, taskId: string): Promise<TaskRecord> {
  const { options } = ctx;
  const task = await options.tasks.get(taskId);
  if (task === undefined || task.workspaceId !== actor.workspaceId) {
    throw new TaviError("NOT_FOUND", `Task ${taskId} does not exist`);
  }
  return task;
}

/**
 * Whether `envelope` may settle `recipientTaskId`'s wait on its
 * correlation id: one addressed to that task, in its workspace, that is a
 * `reply` (which only `reply()` sends, past its grant and schema checks)
 * or a delegated child's own `result` under `worker-result:<child>`. Any
 * other `result` — a peer's, or one under another correlation id — is
 * delivered as a message and settles nothing.
 */
export async function settlesCorrelationWait(
  ctx: AgentCommunicationContext,
  envelope: Pick<AgentEnvelope, "kind" | "workspaceId" | "senderTaskId" | "recipientTaskId" | "correlationId">,
  recipientTaskId: string,
): Promise<boolean> {
  const { options } = ctx;
  if (envelope.correlationId === undefined || envelope.recipientTaskId !== recipientTaskId) return false;
  if (envelope.kind === "reply") return true;
  if (envelope.kind !== "result" || envelope.correlationId !== workerResultCorrelationId(envelope.senderTaskId)) return false;
  const delegation = await options.delegations.getByWorkerTaskId(envelope.senderTaskId);
  return delegation?.parentTaskId === recipientTaskId && delegation.workspaceId === envelope.workspaceId;
}

/**
 * Whether `actor` may cancel `taskId`: its own task, a task it delegated
 * to, directly or through its workers (same principal), or any task for
 * the system actor (no `runId`) that stops a schedule's run and its
 * worker tree. A worker never cancels its parent or a task it did not spawn.
 */
export async function mayCancel(ctx: AgentCommunicationContext, actor: AgentActor, taskId: string): Promise<boolean> {
  const { options } = ctx;
  if (actor.runId === undefined || actor.runId === taskId) return true;
  const seen = new Set<string>();
  let current = taskId;
  while (seen.size < MAX_DELEGATION_ANCESTRY && !seen.has(current)) {
    seen.add(current);
    const delegation = await options.delegations.getByWorkerTaskId(current);
    if (
      delegation?.parentTaskId === undefined ||
      delegation.workspaceId !== actor.workspaceId ||
      delegation.principalId !== actor.principalId
    )
      return false;
    if (delegation.parentTaskId === actor.runId) return true;
    current = delegation.parentTaskId;
  }
  return false;
}

/**
 * Peer messaging's "explicit recipient grant, not merely knowing an ID"
 * requirement — `request`/`reply` only,
 * never `send`/`spawn` (ownership already authorizes those).
 */
/** Both callers (`request`/`reply`) have already validated `actor.runId` is defined by the time this runs. */
export async function assertPeerGrant(
  ctx: AgentCommunicationContext,
  actor: AgentActor,
  actorTaskId: string,
  recipientAgentId: string,
): Promise<void> {
  const { options } = ctx;
  const context = await contextFrom(ctx, actor, actorTaskId);
  const missing = options.access.missingPermissions(context, [agentMessageGrant(recipientAgentId)]);
  if (missing.length > 0) {
    throw new TaviError("NOT_AUTHORIZED", `Peer messaging to agent ${recipientAgentId} is not granted`, {
      details: { missingPermissions: missing },
    });
  }
}

export function pruneExpiredReplySchemas(ctx: AgentCommunicationContext, atTime: string): void {
  const { expectedReplySchemas } = ctx;
  for (const [messageId, entry] of expectedReplySchemas) {
    if (entry.deadlineAt <= atTime) expectedReplySchemas.delete(messageId);
  }
}

/**
 * Caps a caller-supplied `deadlineAt` at the remaining root-task budget,
 * so every request/wait deadline is finite and persisted.
 * `AgentDelegatedBudget.expiresAt` is narrowed/inherited down a
 * delegation chain by `mergeBudget` in `spawn`, so the
 * "remaining root-task deadline" for ANY task is exactly its own
 * delegation row's `budget.expiresAt` — no separate cascading
 * budget/deadline system is needed. A task with no delegation row
 * (never spawned — an orchestrator's own root task) has no cap: only a WORKER whose
 * spawning caller (or an ancestor of it) set `budget.expiresAt` is ever
 * capped, matching "root-task" exactly — the
 * root itself is uncapped, everything delegated from it is bounded by
 * what it allowed.
 */
export async function capDeadlineToRootBudget(ctx: AgentCommunicationContext, taskId: string, requested: string): Promise<string> {
  const { options, now } = ctx;
  // Stored deadlines are compared as text (the expiry sweep, reply-schema pruning), which is chronological only for
  // UTC timestamps of one shape: a model's `+02:00` deadline is parsed and written back in UTC. A malformed one
  // fails loudly rather than producing a wrong answer.
  if (Number.isNaN(Date.parse(requested))) throw new TaviError("INVALID_INPUT", `deadlineAt "${requested}" is not a valid timestamp`);
  // Every task's wait is held to the host's farthest deadline, a root orchestrator's too: it has no budget to cap it.
  const deadlineAt = boundAgentWaitDeadline(requested, now());
  const cap = (await options.delegations.getByWorkerTaskId(taskId))?.budget?.expiresAt;
  if (cap === undefined) return deadlineAt;
  const capMs = Date.parse(cap);
  // `cap` is schema-guaranteed valid; a NaN here would mean corrupted
  // durable state, not a caller mistake — fail the same way rather than
  // silently treating an uncapped deadline as unbounded.
  if (Number.isNaN(capMs)) {
    throw new TaviError("INTERNAL", `delegated budget expiresAt "${cap}" for task ${taskId} is not a valid timestamp`);
  }
  return Date.parse(deadlineAt) > capMs ? cap : deadlineAt;
}

/**
 * Payload offload: content over the 2 KiB
 * inline cap publishes through the artifact store instead of being
 * rejected, returning an `artifactId` reference in place of inline
 * `content`. When the caller already supplied an explicit `artifactId`
 * (bypassing inline content entirely), this is a no-op — offload only
 * ever applies to `content`, never overrides a caller's own reference.
 * A failed admission leaves an orphan for the existing artifact sweep:
 * the artifact is published *before* the
 * envelope insert that references it, so a failure after this point
 * (e.g. a `getActiveByTask` uniqueness violation surfacing downstream)
 * leaves an unreferenced artifact for the existing sweep, not a
 * dangling reference to nothing.
 */
export async function offloadIfNeeded(
  ctx: AgentCommunicationContext,
  input: {
    readonly workspaceId: string;
    readonly runId?: string;
    readonly content?: string;
    readonly artifactId?: string;
    /** The sender's label; none reads as an agent's words, untrusted. */
    readonly label?: ContentLabel;
  },
): Promise<{ readonly content?: string; readonly artifactId?: string }> {
  const { options } = ctx;
  if (input.content === undefined) {
    return input.artifactId === undefined ? {} : { artifactId: input.artifactId };
  }
  const byteLength = new TextEncoder().encode(input.content).length;
  if (byteLength <= MAX_AGENT_ENVELOPE_INLINE_BYTES) {
    return { content: input.content, ...(input.artifactId === undefined ? {} : { artifactId: input.artifactId }) };
  }
  if (input.artifactId !== undefined) {
    // A caller supplying both an explicit `artifactId` and oversized
    // `content` gets a clear failure rather than either silently
    // dropping their artifact reference (offloading `content` would
    // overwrite it) or silently truncating `content` — `content`
    // alongside an explicit `artifactId` is meant to be a short
    // accompanying note, not a second payload.
    throw new TaviError(
      "INVALID_INPUT",
      `Envelope content (${byteLength} UTF-8 bytes) exceeds the ${MAX_AGENT_ENVELOPE_INLINE_BYTES}-byte inline cap; ` +
        "an accompanying note alongside an explicit artifactId must fit inline, not be offloaded itself",
    );
  }
  if (options.artifacts === undefined) {
    throw new TaviError(
      "INVALID_INPUT",
      `Envelope content (${byteLength} UTF-8 bytes) exceeds the ${MAX_AGENT_ENVELOPE_INLINE_BYTES}-byte inline cap, and no artifact store is configured to offload it`,
    );
  }
  const artifact = await options.artifacts.putArtifact({
    workspaceId: input.workspaceId,
    ...(input.runId === undefined ? {} : { runId: input.runId }),
    contentType: "text/plain",
    body: input.content,
    extension: "txt",
    // Its sender's label, as its envelope carries it; none, an agent's words, untrusted.
    label: input.label ?? (input.runId === undefined ? untrustedLabel("agent") : agentWordsLabel(input.runId)),
  });
  return { artifactId: artifact.artifactId };
}
