import {
  MAX_AGENT_ENVELOPE_INLINE_BYTES,
  wireEnvelope,
  type AgentActor,
  type AgentMailboxEnvelopeRecord,
  type AgentWaitOutcome,
  type AgentWakeInput,
  type TaskRecord,
  waitResumeOperationKey,
  WORKER_RESULT_TEXT_MAX,
} from "@tavi/contracts";
import { definedOnly, errorMessage } from "@tavi/contracts/util";
import {
  DEFAULT_PROTOCOL_VERSION,
  type Hold,
  TERMINAL_TASK_STATUSES,
  workerResultMessageId,
  workerResultCorrelationId,
  contextFrom,
  endedLabel,
  type AgentCommunicationContext,
} from "./context.js";

/** `text` cut to at most `maxBytes` of UTF-8, never inside a character. */
function clipUtf8(text: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  if (encoder.encode(text).length <= maxBytes) return text;
  let cut = "";
  let bytes = 0;
  for (const character of text) {
    const size = encoder.encode(character).length;
    if (bytes + size + 3 > maxBytes) break;
    cut += character;
    bytes += size;
  }
  return `${cut}…`;
}

/**
 * Whether a task takes a turn to read a worker's result that comes after its
 * own turn: an attended one, or a schedule's fire, whose run is not over until
 * it has read what the workers it spawned in the background answered.
 */
function hearsLateResults(task: Pick<TaskRecord, "origin" | "executionPolicy">): boolean {
  return task.executionPolicy.mode === "attended" || (task.origin === "schedule" && task.executionPolicy.schedulingWritesDenied === true);
}

/**
 * Whether `taskId` waits on a person or a peer: an active wait row (a
 * question, a worker, a reply), or its latest outcome is a suspension (an
 * approval or review round, which has no wait row). A new admission over a
 * pending round sets it aside, so nothing wakes such a task.
 */
async function suspended(ctx: AgentCommunicationContext, taskId: string): Promise<boolean> {
  const { options } = ctx;
  if ((await options.waits.getActiveByTask(taskId)) !== undefined) return true;
  return (await options.tasks.latestSettledAdmission(taskId))?.result?.status === "waiting";
}

/** What an owed wake is held to: a sender's hold joins one already owed, never replacing it with none. */
export function owe(ctx: AgentCommunicationContext, taskId: string, hold: Hold): void {
  const { owed } = ctx;
  const earlier = owed.get(taskId);
  const heldChannel = hold.heldChannel ?? earlier?.heldChannel;
  const heldConnectionId = hold.heldConnectionId ?? earlier?.heldConnectionId;
  const frontEnd = hold.frontEnd ?? earlier?.frontEnd;
  owed.set(taskId, definedOnly({ heldChannel, heldConnectionId, frontEnd }));
}

/** The envelope a wait's outcome carried was delivered through the wait: no turn reads it again. */
export async function deliveredThroughWait(ctx: AgentCommunicationContext, outcome: AgentWaitOutcome | undefined): Promise<void> {
  const { options } = ctx;
  const messageId = outcome?.envelope?.messageId;
  if (messageId === undefined) return;
  try {
    await options.mailbox.setDeliveryState(messageId, "acknowledged");
  } catch (error) {
    options.onDiagnostic?.("an envelope delivered through a wait could not be marked read", { messageId, error: errorMessage(error) });
  }
}

/**
 * A task ended for good, or one its person stopped: what arrives waits in its mailbox, and a stopped one reads it at
 * their next reply. Not Home, which never ends and reads ready after a Stop as after any turn: its worker's result is
 * taken up as it would be then.
 */
export function takesNoWake(task: Pick<TaskRecord, "status" | "chatKind">): boolean {
  return task.status === "cancelled" || (task.status === "stopped" && task.chatKind !== "home");
}

export async function announceWorkerResult(ctx: AgentCommunicationContext, workerTaskId: string): Promise<void> {
  const { options, now } = ctx;
  const delegation = await options.delegations.getByWorkerTaskId(workerTaskId);
  const parentTaskId = delegation?.parentTaskId;
  const worker = await options.tasks.get(workerTaskId);
  // A cancelled worker reports nothing: its cancel settled what waited on it.
  if (
    delegation === undefined ||
    parentTaskId === undefined ||
    worker === undefined ||
    worker.status === "cancelled" ||
    !TERMINAL_TASK_STATUSES.has(worker.status)
  )
    return;
  // Exactly once per ending: the envelope's id is the worker's last
  // admission, so the same ending announced twice is one envelope, and a
  // later answer of the same worker (woken again) is a new one.
  const latest = await options.tasks.latestAdmission(workerTaskId);
  const messageId = workerResultMessageId(workerTaskId, latest);
  if ((await options.mailbox.getEnvelope(messageId)) !== undefined) return;
  const correlationId = workerResultCorrelationId(workerTaskId);
  // A worker that already sent its parent a `result` itself during this
  // ending's admission said it: the announce is recorded, read (so neither
  // a turn nor the startup sweep takes it up), and the parent gets one
  // result, not two.
  // Only for a worker that completed: one that failed after sending a partial
  // result still says so.
  const explicit =
    latest === undefined || worker.status !== "completed"
      ? []
      : await options.mailbox.listSent({
          senderTaskId: workerTaskId,
          recipientTaskId: parentTaskId,
          kind: "result",
          since: latest.createdAt,
        });
  const text = (worker.finalText ?? "").slice(0, WORKER_RESULT_TEXT_MAX);
  const full = `Worker ${workerTaskId} (${delegation.agentDefinitionId ?? delegation.workerAgentId}) ${worker.status}${text === "" ? "." : `:\n${text}`}`;
  // An envelope's inline content is bounded in bytes (`MAX_AGENT_ENVELOPE_INLINE_BYTES`),
  // or its row no longer parses: what does not fit is kept whole in an artifact.
  const inline = clipUtf8(full, MAX_AGENT_ENVELOPE_INLINE_BYTES);
  // The worker's label as it ended: its answer, inline or kept whole, is read as that.
  const label = await endedLabel(ctx, worker);
  let artifactId: string | undefined;
  if (inline !== full && explicit.length === 0 && options.artifacts !== undefined) {
    try {
      artifactId = (
        await options.artifacts.putArtifact({
          workspaceId: worker.workspaceId,
          runId: workerTaskId,
          contentType: "text/plain",
          body: full,
          extension: "txt",
          label,
        })
      ).artifactId;
    } catch (error) {
      options.onDiagnostic?.("a worker's full answer could not be kept as an artifact; its envelope carries the start", {
        workerTaskId,
        error: errorMessage(error),
      });
    }
  }
  const envelope: AgentMailboxEnvelopeRecord = {
    messageId,
    protocolVersion: DEFAULT_PROTOCOL_VERSION,
    workspaceId: worker.workspaceId,
    senderAgentId: delegation.workerAgentId,
    senderTaskId: workerTaskId,
    // The parent's own agent identity when it is a worker too, else its task, as `send` names a sender.
    recipientAgentId: (await options.delegations.getByWorkerTaskId(parentTaskId))?.workerAgentId ?? parentTaskId,
    recipientTaskId: parentTaskId,
    kind: "result",
    createdAt: now(),
    deliveryState: explicit.length > 0 ? "acknowledged" : "pending",
    retentionState: "active",
    correlationId,
    content: inline,
    ...(artifactId === undefined ? {} : { artifactId }),
    label,
  };
  try {
    await options.mailbox.insertEnvelope(envelope);
  } catch (error) {
    // Lost a race to the same ending's other announce: it sent the envelope.
    if ((await options.mailbox.getEnvelope(messageId)) !== undefined) return;
    throw error;
  }
  const actor: AgentActor = {
    workspaceId: worker.workspaceId,
    principalId: worker.principalId,
    runId: workerTaskId,
    agentId: delegation.workerAgentId,
    caller: "agent",
  };
  // A parent waiting on this worker is resumed with the result — the
  // worker's own, when it sent one.
  const waiting = await options.waits.getActiveByTask(parentTaskId);
  if (waiting?.waitingOnWorkerTaskId === workerTaskId) {
    const carried = explicit.at(-1) ?? envelope;
    const outcome: AgentWaitOutcome = {
      kind: worker.status === "failed" || worker.status === "stopped" ? "worker-failed" : "worker-completed",
      envelope: wireEnvelope(carried),
    };
    if (await options.waits.settle({ waitId: waiting.waitId, outcome, resume: true, by: workerTaskId, via: "agent" })) {
      await deliveredThroughWait(ctx, outcome);
      await options.workflow.admit({
        context: await contextFrom(ctx, actor, parentTaskId),
        operationKey: waitResumeOperationKey(waiting.waitId),
        kind: "deadline",
        taskId: parentTaskId,
        resume: { waitOutcome: outcome, waitId: waiting.waitId, via: "agent", decidedBy: workerTaskId },
      });
      await options.waits.markResumed(waiting.waitId);
    }
    return;
  }
  // The worker's own `result` already went the way a message goes.
  if (explicit.length > 0) return;
  // Otherwise a parent that hears back from its workers takes a turn to read it — now, when it
  // neither runs nor waits, else once its admission ends and it does
  // neither (`wakeIfOwed`). A parent suspended on a round or a question is
  // never woken over it: a new admission would set the round aside. Any
  // other — nobody there to read on — keeps it in its mailbox.
  const parent = await options.tasks.get(parentTaskId);
  if (parent === undefined || !hearsLateResults(parent) || takesNoWake(parent)) return;
  owe(ctx, parentTaskId, delegation);
  await wakeIfOwed(ctx, parentTaskId);
}

export async function wakeIfOwed(ctx: AgentCommunicationContext, taskId: string): Promise<boolean> {
  const { options, owed } = ctx;
  if (!owed.has(taskId)) return false;
  const hold = owed.get(taskId) ?? {};
  // Taken before any read, so two callers never both wake for one owing.
  owed.delete(taskId);
  const keep = (): false => {
    if (!owed.has(taskId)) owed.set(taskId, hold);
    return false;
  };
  const task = await options.tasks.get(taskId);
  if (task === undefined || takesNoWake(task) || !hearsLateResults(task)) return false;
  // Running: its admission's end asks again. Waiting: the turn that resumes it asks again once it ends.
  if (task.status === "running" || task.status === "admitted" || (await suspended(ctx, taskId))) return keep();
  // Only mail not yet read is owed a turn: a turn that ran since took it.
  if ((await options.mailbox.listPending(taskId, 1)).length === 0) return false;
  await wake(ctx, {
    actor: {
      workspaceId: task.workspaceId,
      principalId: task.principalId,
      runId: taskId,
      caller: "agent",
      ...definedOnly({ heldChannel: hold.heldChannel, heldConnectionId: hold.heldConnectionId, frontEnd: hold.frontEnd }),
    },
    taskId,
  });
  return true;
}

export async function workersOutstanding(ctx: AgentCommunicationContext, taskId: string): Promise<boolean> {
  const { options } = ctx;
  if ((await options.mailbox.listPending(taskId, 1)).length > 0) return true;
  const task = await options.tasks.get(taskId);
  if (task === undefined) return false;
  // The children are checked at once: each is a few indexed reads, and any
  // one outstanding answers the question.
  const outstanding = await Promise.all(
    (await options.delegations.listChildren(task.workspaceId, taskId, 200)).map(async (child) => {
      const worker = await options.tasks.get(child.workerTaskId);
      // A cancelled worker reports nothing.
      if (worker === undefined || worker.status === "cancelled") return false;
      if (!TERMINAL_TASK_STATUSES.has(worker.status)) return true;
      // Ended, but its result not announced yet.
      const latest = await options.tasks.latestAdmission(child.workerTaskId);
      return (await options.mailbox.getEnvelope(workerResultMessageId(child.workerTaskId, latest))) === undefined;
    }),
  );
  return outstanding.includes(true);
}

export async function announceUnreported(
  ctx: AgentCommunicationContext,
  input: { readonly since: string; readonly limit?: number },
): Promise<number> {
  const { options } = ctx;
  let announced = 0;
  for (const workerTaskId of await options.delegations.listUnannouncedEnded(input.since, input.limit ?? 100)) {
    try {
      await announceWorkerResult(ctx, workerTaskId);
      announced += 1;
    } catch (error) {
      options.onDiagnostic?.("a worker's lost result could not be announced", { workerTaskId, error: errorMessage(error) });
    }
  }
  return announced;
}

export async function wake(ctx: AgentCommunicationContext, input: AgentWakeInput): Promise<void> {
  const { options, newId } = ctx;
  // Coalescing wake intents without a second concurrent writer is satisfied by the existing task-serialization
  // guarantee (one active execution slot per task) rather than
  // a bespoke dedup layer here: two overlapping wake calls both admit a
  // `"reply"` step, but only one execution can hold the task's slot at a
  // time, so the second is naturally absorbed (queued behind the first,
  // not run twice) rather than double-running the graph. This is about
  // not double-running work, not about avoiding extra bookkeeping: each
  // `wake()` call still creates its own fresh `tavi_admissions` row
  // (`operationKey: newId("wake")`), so repeated wakes are not deduped
  // at the admission-table level, only at the execution-slot level.
  const context = await contextFrom(ctx, input.actor, input.taskId);
  // Only Home is woken after a Stop (`takesNoWake`), and it must not take the wake for leave to go on.
  const stopped = (await options.tasks.get(input.taskId))?.status === "stopped";
  await options.workflow.admit({
    // The channel the waking actor is held to (a worker's spawning turn)
    // holds the woken turn too: the workflow honours only `messaging`.
    // So does the front end its spawning turn was typed in.
    context: {
      ...context,
      ...(context.heldChannel === undefined && input.actor.heldChannel !== undefined ? { heldChannel: input.actor.heldChannel } : {}),
      ...(context.heldConnectionId === undefined && input.actor.heldConnectionId !== undefined
        ? { heldConnectionId: input.actor.heldConnectionId }
        : {}),
      ...(context.frontEnd === undefined && input.actor.frontEnd !== undefined ? { frontEnd: input.actor.frontEnd } : {}),
    },
    operationKey: newId("wake"),
    kind: "reply",
    taskId: input.taskId,
    ...(stopped ? { afterStop: true } : {}),
  });
}
