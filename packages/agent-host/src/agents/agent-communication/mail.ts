import {
  artifactLabel,
  joinLabels,
  untrustedLabel,
  crossPrincipalLabel,
  MAX_AGENT_ENVELOPE_INLINE_BYTES,
  TaviError,
  wireEnvelope,
  type AgentAckInput,
  type AgentArtifactGetInput,
  type AgentArtifactGetResult,
  type AgentActor,
  type AgentCancelInput,
  type AgentEnvelope,
  type AgentReceiveInput,
  type AgentReceiveResult,
  type AgentSendInput,
  type AgentSendResult,
  type AgentStatusInput,
  type AgentStatusResult,
  type AgentWaitOutcome,
  type AgentWakePolicy,
  waitResumeOperationKey,
  WORKER_RESULT_TEXT_MAX,
} from "@tavi/contracts";
import { definedOnly } from "@tavi/contracts/util";
import {
  DEFAULT_PROTOCOL_VERSION,
  contextFrom,
  endedLabel,
  assertOwnsTask,
  settlesCorrelationWait,
  mayCancel,
  offloadIfNeeded,
  type AgentCommunicationContext,
} from "./context.js";
import { owe, deliveredThroughWait, takesNoWake, wakeIfOwed, wake } from "./results.js";

/**
 * Shared by `send` and `reply`: insert the envelope, then either settle a
 * matching active wait directly (carrying the resume value a suspended
 * `agents.wait` interrupt needs — see `send`'s own comment below) or fall
 * back to a generic wake. Extracted so `reply` doesn't have to duplicate
 * `send`'s wait-aware branch to get the same "deliver through the same
 * wake-on-reply path" behavior.
 */
export async function deliverAndWake(
  ctx: AgentCommunicationContext,
  actor: AgentActor,
  recipientTaskId: string,
  envelope: AgentEnvelope & { readonly deliveryState: "pending"; readonly retentionState: "active" },
  wakePolicy: AgentWakePolicy | undefined,
): Promise<void> {
  const { options } = ctx;
  await options.mailbox.insertEnvelope(envelope);
  if ((wakePolicy ?? "if-idle") !== "if-idle") return;
  // Only a "reply", or a delegated child's own "result" under
  // `worker-result:<child>`, may settle a matching active wait — the same
  // rule `waitFor`'s own immediate-settle recheck applies
  // (`settlesCorrelationWait`). Without it, an `agents.send` carrying a
  // correlationId it merely observed (e.g. a recipient forwarding a
  // pending request's own messageId back, as a "message" or a "result")
  // could settle another task's `agents.request`-originated wait outright,
  // bypassing both `reply()`'s `agentMessageGrant` check and its
  // `expectedReplySchema` validation entirely — `send` requires only same-workspace task ownership,
  // nothing peer-messaging-specific. Any other envelope is delivered as a message.
  const activeWait =
    envelope.correlationId === undefined || !(await settlesCorrelationWait(ctx, envelope, recipientTaskId))
      ? undefined
      : await options.waits.getActiveByCorrelation(recipientTaskId, envelope.correlationId);
  if (activeWait !== undefined) {
    const outcome: AgentWaitOutcome = { kind: "replied", envelope: wireEnvelope(envelope) };
    const settled = await options.waits.settle({
      waitId: activeWait.waitId,
      outcome,
      resume: true,
      by: actor.agentId ?? actor.runId ?? "agent",
      via: "agent",
    });
    if (settled) {
      await deliveredThroughWait(ctx, outcome);
      await options.workflow.admit({
        context: await contextFrom(ctx, actor, recipientTaskId),
        operationKey: waitResumeOperationKey(activeWait.waitId),
        kind: "deadline",
        taskId: recipientTaskId,
        resume: { waitOutcome: outcome, waitId: activeWait.waitId, via: "agent", decidedBy: actor.agentId ?? actor.runId ?? "agent" },
      });
      await options.waits.markResumed(activeWait.waitId);
    }
    // If `settle` returned false, a racing admission (the expiry sweep,
    // most likely) already settled it — its resume already happened or
    // is in flight, so admitting a second one here would be redundant.
    // This is also exactly what makes "late replies to a settled wait
    // are recorded but do not reopen it" hold: the envelope above is inserted unconditionally, but no
    // second resume follows an already-settled wait.
  } else {
    // An attended recipient is woken as a worker's result wakes its parent
    // only once it neither runs nor waits — never over a
    // pending approval or review round, which a new admission would set
    // aside — else when its admission ends. An unattended one, as before.
    const recipient = await options.tasks.get(recipientTaskId);
    if (recipient !== undefined && takesNoWake(recipient)) return;
    if (recipient?.executionPolicy.mode === "attended") {
      owe(ctx, recipientTaskId, actor);
      await wakeIfOwed(ctx, recipientTaskId);
      return;
    }
    await wake(ctx, { actor, taskId: recipientTaskId });
  }
}

export async function send(ctx: AgentCommunicationContext, input: AgentSendInput): Promise<AgentSendResult> {
  const { now, newId } = ctx;
  if (input.actor.runId === undefined || input.actor.runId.length === 0) {
    throw new TaviError("INVALID_INPUT", "send requires an actor with a runId (the sender's own task)");
  }
  // Checked before any write: a rejected send must never have a delivery
  // side effect (a caller catching the throw should be able to assume
  // nothing happened).
  const recipient = await assertOwnsTask(ctx, input.actor, input.recipientTaskId);
  // The sender's label at send time; another principal's words also read as theirs.
  const label = crossPrincipalLabel(
    input.actor.label,
    { taskId: input.actor.runId, principalId: input.actor.principalId },
    recipient.principalId,
  );
  const messageId = newId("msg");
  const payload = await offloadIfNeeded(ctx, {
    workspaceId: input.actor.workspaceId,
    runId: input.actor.runId,
    ...definedOnly({
      content: input.content,
      artifactId: input.artifactId,
      label,
    }),
  });
  const envelope: AgentEnvelope & { readonly deliveryState: "pending"; readonly retentionState: "active" } = {
    messageId,
    protocolVersion: DEFAULT_PROTOCOL_VERSION,
    workspaceId: input.actor.workspaceId,
    // No agent-identity registry exists yet (see `agent-communication.ts`'s
    // header comment): the best-available identity is used, falling back
    // through agentId -> the sender's own task id -> its principal.
    senderAgentId: input.actor.agentId ?? input.actor.runId,
    senderTaskId: input.actor.runId,
    recipientAgentId: input.recipientAgentId,
    recipientTaskId: input.recipientTaskId,
    kind: input.kind,
    createdAt: now(),
    deliveryState: "pending",
    retentionState: "active",
    ...definedOnly({
      content: payload.content,
      artifactId: payload.artifactId,
      label,
      correlationId: input.correlationId,
      causationId: input.causationId,
      expiresAt: input.expiresAt,
    }),
  };
  // Wake is `"if-idle"` or `"none"`; `"if-idle"` is the default since a
  // sent message that never wakes its recipient would otherwise sit
  // unprocessed until an unrelated turn happens to `receive` it. An
  // active wait matching this correlation id needs its own resume path,
  // not the generic wake(): wake()'s `kind: "reply"` admission carries
  // no resume value, which is fine for nudging an idle task to check its
  // mailbox but cannot deliver the settled outcome a suspended
  // `agents.wait` interrupt is actually waiting on — `deliverAndWake`
  // handles that branch.
  await deliverAndWake(ctx, input.actor, input.recipientTaskId, envelope, input.wake);
  return { messageId, accepted: true };
}

export async function receive(ctx: AgentCommunicationContext, input: AgentReceiveInput): Promise<AgentReceiveResult> {
  const { options, now, newId, leaseMs } = ctx;
  await assertOwnsTask(ctx, input.actor, input.taskId);
  const claimLeaseId = newId("lease");
  const leaseExpiresAt = new Date(Date.parse(now()) + (input.leaseMs ?? leaseMs)).toISOString();
  const envelopes = await options.mailbox.claim({
    taskId: input.taskId,
    limit: input.limit,
    leaseId: claimLeaseId,
    leaseExpiresAt,
  });
  return { envelopes, leaseId: claimLeaseId, leaseExpiresAt };
}

export async function ack(ctx: AgentCommunicationContext, input: AgentAckInput): Promise<void> {
  const { options } = ctx;
  await assertOwnsTask(ctx, input.actor, input.taskId);
  await options.mailbox.acknowledge({
    taskId: input.taskId,
    leaseId: input.leaseId,
    messageIds: input.acknowledgedMessageIds,
  });
}

export async function status(ctx: AgentCommunicationContext, input: AgentStatusInput): Promise<AgentStatusResult> {
  const task = await assertOwnsTask(ctx, input.actor, input.taskId);
  const finalText = task.finalText === null || task.finalText === "" ? undefined : task.finalText.slice(0, WORKER_RESULT_TEXT_MAX);
  const summary = task.summary === null || task.summary === undefined ? undefined : task.summary;
  return {
    taskId: task.taskId,
    status: task.status,
    ...(finalText === undefined ? {} : { finalText }),
    ...(summary === undefined ? {} : { summary }),
    // Its words are labelled as the task ended: a clean worker's are trusted, one that read a page's are not.
    // Another principal's task's words also read as theirs.
    ...(finalText === undefined && summary === undefined
      ? {}
      : { label: crossPrincipalLabel(await endedLabel(ctx, task), task, input.actor.principalId) }),
  };
}

export async function cancel(ctx: AgentCommunicationContext, input: AgentCancelInput): Promise<void> {
  const { options, expectedReplySchemas } = ctx;
  // `recordCancellation` (the real implementation behind `cancelTask`)
  // performs no workspace check of its own, so it must happen here.
  await assertOwnsTask(ctx, input.actor, input.taskId);
  // Scoped tighter than the workspace: a task cancels itself and what it
  // delegated, never its parent or an unrelated task.
  if (!(await mayCancel(ctx, input.actor, input.taskId))) {
    throw new TaviError("NOT_AUTHORIZED", `Task ${input.taskId} is not this task or one it delegated to`);
  }
  await options.cancelTask({
    taskId: input.taskId,
    reason: input.reason ?? "cancelled via agents.cancel",
    operator: input.actor.caller,
  });
  // A task suspended on `agents.wait` must not leave its
  // wait row `active` forever once the task itself is cancelled — nothing
  // would ever settle it otherwise: it holds no correlation a reply could
  // match, and `listActivePastDeadline` would keep surfacing it to the
  // expiry sweep for a task no admission will ever resume again. No
  // explicit resume admission is issued here: `admit()`'s own cancellation
  // pre-check (this file's suspend/resume mechanism relies on the same
  // gate approvals already use) already answers any *future* admission
  // attempt for this task with the cancelled outcome directly, without
  // ever running a graph node — so settling the wait record is the only
  // durable state this path needs to fix up.
  //
  // These two writes (`cancelTask` above, `settle` below) are not atomic:
  // a crash between them reproduces a narrower version of the exact
  // "dangling active wait" bug this fixup exists for — the sweep will
  // keep re-discovering the row and harmlessly re-attempting a no-op
  // `admit()` against an already-cancelled task, rather than the resume
  // ever going wrong (the pre-check above is what keeps it harmless). Not closed here, since doing so would mean
  // making `cancelTask` and this settle one transaction across a package
  // boundary this plugin doesn't own — left as a known, narrow residual
  // window rather than engineered away for a case with no incorrect
  // resume risk.
  const active = await options.waits.getActiveByTask(input.taskId);
  if (active !== undefined) {
    if (await options.waits.settle({ waitId: active.waitId, outcome: { kind: "cancelled" }, by: input.actor.principalId, via: "policy" }))
      await options.onWaitSettled?.(active.waitId, { kind: "cancelled" });
    // A cancelled request's own `expectedReplySchema` entry (if any —
    // only present when `active.correlationId` is a `request`'s
    // self-assigned messageId) is evicted immediately rather than left
    // for `pruneExpiredReplySchemas` to catch at its deadline: the
    // eventual reply is moot the moment the task is cancelled.
    if (active.correlationId !== undefined) {
      expectedReplySchemas.delete(active.correlationId);
    }
  }
}

export async function getArtifact(ctx: AgentCommunicationContext, input: AgentArtifactGetInput): Promise<AgentArtifactGetResult> {
  const { options } = ctx;
  if (input.actor.runId === undefined || input.actor.runId.length === 0) {
    throw new TaviError("INVALID_INPUT", "getArtifact requires an actor with a runId (the reader's own task)");
  }
  // Recipient scope, precisely: the named message must exist, be
  // addressed to the caller's own task, and actually carry the
  // artifactId being read — knowing an artifactId alone (e.g. one seen
  // in another agent's conversation) is never sufficient, matching this
  // module's "explicit... not merely knowing an ID" precedent from
  // peer-messaging's own grant check.
  const envelope = await options.mailbox.getEnvelope(input.messageId);
  if (envelope === undefined || envelope.recipientTaskId !== input.actor.runId || envelope.artifactId === undefined) {
    throw new TaviError("NOT_FOUND", `Message ${input.messageId} does not exist or carries no artifact`);
  }
  if (options.artifacts === undefined) {
    throw new TaviError("UNAVAILABLE", "No artifact store is configured");
  }
  const record = await options.artifacts.getArtifact(envelope.artifactId);
  const body = await options.artifacts.readArtifactBody(envelope.artifactId);
  if (record === undefined || body === undefined) {
    throw new TaviError("NOT_FOUND", `Artifact ${envelope.artifactId} does not exist`);
  }
  const offset = Math.max(0, input.offset ?? 0);
  // Bounded regardless of what the caller asked for — the same "never an
  // unbounded read" discipline `boundToolOutput` (`@tavi/contracts`)
  // applies to tool results generally, applied here to artifact reads
  // specifically since this bypasses that generic path entirely.
  const length = Math.min(input.length ?? MAX_AGENT_ENVELOPE_INLINE_BYTES, MAX_AGENT_ENVELOPE_INLINE_BYTES);
  const slice = body.subarray(offset, offset + length);
  return {
    artifactId: envelope.artifactId,
    contentType: record.contentType,
    byteSize: record.byteSize,
    offset,
    length: slice.byteLength,
    content: new TextDecoder().decode(slice),
    truncated: offset + slice.byteLength < record.byteSize,
    // What it was stored with. One stored before labels was an agent's
    // payload, read as untrusted then; a fold archive or an attachment says so too.
    label: record.label ?? joinLabels(artifactLabel(record), untrustedLabel("agent")),
  };
}
