import {
  crossPrincipalLabel,
  EVENT_TEXT_BOUNDS,
  TaviError,
  WorkflowWaitSuspend,
  wireEnvelope,
  type AgentEnvelope,
  type AgentMailboxEnvelopeRecord,
  type AgentReplyInput,
  type AgentReplyResult,
  type AgentRequestInput,
  type AgentRequestResult,
  type AgentWaitForInput,
  type AgentWaitForResult,
  type AgentWaitOutcome,
} from "@tavi/contracts";
import { definedOnly, errorMessage } from "@tavi/contracts/util";
import {
  DEFAULT_PROTOCOL_VERSION,
  TERMINAL_TASK_STATUSES,
  workerResultCorrelationId,
  assertOwnsTask,
  settlesCorrelationWait,
  assertPeerGrant,
  pruneExpiredReplySchemas,
  capDeadlineToRootBudget,
  offloadIfNeeded,
  type AgentCommunicationContext,
} from "./context.js";
import { deliveredThroughWait } from "./results.js";
import { deliverAndWake } from "./mail.js";

/** Best-effort duck-typed Zod validation — this port never imports zod itself. */
function safeParseWith(schema: unknown, value: unknown): { readonly success: boolean; readonly message?: string } {
  if (
    schema === null ||
    typeof schema !== "object" ||
    !("safeParse" in schema) ||
    typeof (schema as { safeParse?: unknown }).safeParse !== "function"
  ) {
    return { success: true };
  }
  const result = (schema as { safeParse: (v: unknown) => { success: boolean; error?: { message?: string } } }).safeParse(value);
  return result.success
    ? { success: true }
    : { success: false, message: result.error?.message ?? "reply does not match the request's expected schema" };
}

export async function waitFor(ctx: AgentCommunicationContext, input: AgentWaitForInput): Promise<AgentWaitForResult> {
  const { options, newId } = ctx;
  await assertOwnsTask(ctx, input.actor, input.taskId);
  // `capDeadlineToRootBudget` below caps using `taskId`'s OWN delegation
  // row — safe only because a task always waits on its own behalf, never
  // another same-workspace task's. `assertOwnsTask` alone only checks
  // workspace membership, not that `taskId` is the caller's own task
  // (`send`/`request`/`getArtifact` all separately validate `actor.runId`
  // for this same class of concern). `taskId` is never model-facing (only trusted internal
  // dispatch code supplies it), so this is defense-in-depth for a future
  // direct caller, not a fix to an exploitable gap today.
  if (input.actor.runId !== undefined && input.actor.runId !== input.taskId) {
    throw new TaviError("INVALID_INPUT", "waitFor's taskId must be the calling actor's own task");
  }

  // Direct self-waits are rejected: a task waiting on its own completion can never
  // settle — it can't observe itself finishing while it's still the one
  // running this call.
  if (input.waitingOnWorkerTaskId !== undefined && input.waitingOnWorkerTaskId === input.taskId) {
    throw new TaviError("INVALID_INPUT", "a task cannot wait on itself");
  }

  // Capped by the remaining root-task deadline, not used as given —
  // deterministic across a graph replay,
  // since the delegation row this reads from was already durable before
  // this task's own turn ever started.
  const deadlineAt = await capDeadlineToRootBudget(ctx, input.taskId, input.deadlineAt);

  // `input.waitId` is only ever set by the graph's direct dispatch,
  // deriving it deterministically from
  // checkpointed state so a replayed node calls this with the exact same
  // id every time — never a fresh `newId()` per call, which would
  // re-register a new row (and a new `interrupt()` payload) on every
  // replay and break the "deterministic payload" requirement `interrupt`
  // depends on.
  const waitId = input.waitId ?? newId("wait");

  // The durable-row check comes first, before either recheck below: on a
  // graph replay that reaches this call again (e.g. the resumed pass
  // after `send()`'s wait-aware branch settled this exact wait and
  // admitted `kind: "deadline"`), the settlement already happened
  // out-of-band — trust the durable record over re-deriving the answer
  // from a fresh recheck, which could race or disagree with what was
  // actually recorded.
  const existing = await options.waits.get(waitId);
  if (existing?.state === "settled" && existing.settledOutcome !== undefined) {
    return { waitId, outcome: existing.settledOutcome };
  }

  // Shared by both the immediate-settle and deferred paths below, so the
  // registration sequence (and any future field it gains) is written
  // once. Idempotent: `prepare` is `ON CONFLICT ... DO NOTHING` and
  // `activate` only transitions a `prepared` row, so calling this again
  // for the same `waitId` (a replay that didn't find a settled row
  // above) is a safe no-op on the parts already done.
  const registerWait = async (): Promise<void> => {
    await options.waits.prepare({
      waitId,
      taskId: input.taskId,
      ...(input.correlationId === undefined ? {} : { correlationId: input.correlationId }),
      ...(input.waitingOnWorkerTaskId === undefined ? {} : { waitingOnWorkerTaskId: input.waitingOnWorkerTaskId }),
      deadlineAt,
      ...(input.choices === undefined ? {} : { choices: input.choices }),
      ...(input.question === undefined ? {} : { question: input.question.slice(0, EVENT_TEXT_BOUNDS.question) }),
      ...(input.handoff === undefined ? {} : { handoff: input.handoff }),
      ...(input.connect === undefined ? {} : { connect: input.connect }),
    });
    await options.waits.activate(waitId);
  };
  const settleImmediately = async (outcome: AgentWaitOutcome): Promise<AgentWaitForResult> => {
    await registerWait();
    // Settled by the peer's reply or the worker's end found already there.
    await options.waits.settle({ waitId, outcome, by: input.waitingOnWorkerTaskId ?? "agent", via: "agent" });
    const winner = await options.waits.get(waitId);
    if (winner?.settledOutcome === undefined) throw new TaviError("CONFLICT", "Wait settlement was not persisted");
    // The envelope it returns is read through the wait: no turn reads it again.
    await deliveredThroughWait(ctx, winner.settledOutcome);
    return { waitId, outcome: winner.settledOutcome };
  };

  // Register before checking replies/completion: a reply arriving during an
  // awaited read can now settle the active row; an earlier reply is read below.
  await registerWait();
  const registered = await options.waits.get(waitId);
  if (registered?.settledOutcome !== undefined) return { waitId, outcome: registered.settledOutcome };
  // Answered in advance: settled as given, never delivered.
  if (input.standing !== undefined) {
    await options.waits.settle({ waitId, outcome: input.standing.outcome, by: input.standing.by, via: input.standing.via });
    const winner = await options.waits.get(waitId);
    if (winner?.settledOutcome === undefined) throw new TaviError("CONFLICT", "Wait settlement was not persisted");
    return { waitId, outcome: winner.settledOutcome };
  }
  if (input.correlationId !== undefined) {
    // Only an envelope addressed to this task, in its workspace, that may
    // settle its wait: another task's, under the same correlation id, is
    // neither its answer nor this task's to mark read.
    let reply: AgentMailboxEnvelopeRecord | undefined;
    for (const envelope of await options.mailbox.listByCorrelation(input.correlationId)) {
      if (envelope.workspaceId !== input.actor.workspaceId) continue;
      if (await settlesCorrelationWait(ctx, envelope, input.taskId)) {
        reply = envelope;
        break;
      }
    }
    if (reply !== undefined) {
      // Labelled for its reader: another principal's words read as theirs.
      // Its stored label was already set for this task's principal when
      // it was sent; a sender no longer known keeps that one.
      const sender = await options.tasks.get(reply.senderTaskId);
      const label =
        sender === undefined
          ? reply.label
          : crossPrincipalLabel(reply.label, { taskId: reply.senderTaskId, principalId: sender.principalId }, input.actor.principalId);
      return await settleImmediately({ kind: "replied", envelope: wireEnvelope({ ...reply, ...definedOnly({ label }) }) });
    }
  }
  if (input.waitingOnWorkerTaskId !== undefined) {
    const worker = await options.tasks.get(input.waitingOnWorkerTaskId);
    if (worker !== undefined && TERMINAL_TASK_STATUSES.has(worker.status)) {
      // With its answer, when it already came back.
      // Only the worker's own, to this task: another task's envelope under its correlation is no answer of it.
      const result = (await options.mailbox.listByCorrelation(workerResultCorrelationId(input.waitingOnWorkerTaskId)))
        .filter(
          (envelope) =>
            envelope.kind === "result" &&
            envelope.senderTaskId === input.waitingOnWorkerTaskId &&
            envelope.recipientTaskId === input.taskId &&
            envelope.workspaceId === input.actor.workspaceId,
        )
        .at(-1);
      return await settleImmediately({
        kind: worker.status === "failed" || worker.status === "stopped" ? "worker-failed" : "worker-completed",
        ...(result === undefined ? {} : { envelope: wireEnvelope(result) }),
      });
    }
  }

  // Nothing settles immediately. The durable row is registered so the
  // scheduler's expiry sweep and `send()`'s wait-aware branch have state
  // to act on, and the caller (workflow/nodes/tools/waits.ts's
  // runWaitCall, for a real graph dispatch) is signaled to suspend via a real LangGraph interrupt —
  // this plugin cannot call `interrupt()` itself (must not
  // import LangGraph classes), so it throws a plain marker instead.
  await registerWait();
  // Delivered only now, with the row active: an answer that arrives the
  // instant the question lands settles this wait rather than finding none.
  // The resume it admits queues behind this turn in
  // the workflow's per-task `serialize`, and a resume that finds the thread
  // already past the interrupt replays to this call, which returns the
  // settled outcome above.
  if (input.deliver !== undefined) {
    try {
      await input.deliver();
    } catch (error) {
      const cancelled = await options.waits.settle({
        waitId,
        outcome: { kind: "cancelled", error: { code: "DELIVERY_FAILED", message: errorMessage(error).slice(0, 500) } },
        by: "policy",
        via: "policy",
      });
      // Losing the settle means an answer already won: the question reached
      // the person despite the failure, so their answer is the result.
      if (!cancelled) {
        const winner = await options.waits.get(waitId);
        if (winner?.settledOutcome !== undefined) return { waitId, outcome: winner.settledOutcome };
      }
      throw error;
    }
  }
  throw new WorkflowWaitSuspend({
    waitId,
    ...(input.correlationId === undefined ? {} : { correlationId: input.correlationId }),
    ...(input.waitingOnWorkerTaskId === undefined ? {} : { waitingOnWorkerTaskId: input.waitingOnWorkerTaskId }),
    // Bounded as the event that shows it is: a longer one would fail the
    // interrupt payload's parse and, with it, the suspension it only describes.
    ...(input.question === undefined ? {} : { question: input.question.slice(0, EVENT_TEXT_BOUNDS.question) }),
    ...definedOnly({
      choices: input.choices,
      context: input.context,
      handoff: input.handoff,
      connect: input.connect,
    }),
    deadlineAt,
  });
}

export async function request(ctx: AgentCommunicationContext, input: AgentRequestInput): Promise<AgentRequestResult> {
  const { now, newId, expectedReplySchemas } = ctx;
  if (input.actor.runId === undefined || input.actor.runId.length === 0) {
    throw new TaviError("INVALID_INPUT", "request requires an actor with a runId (the requester's own task)");
  }
  if (input.recipientTaskId === input.actor.runId) {
    throw new TaviError("INVALID_INPUT", "a task cannot request itself");
  }
  // Checked before any write, same discipline as `send`/`assertOwnsTask`:
  // a rejected request must never have a delivery side effect.
  await assertPeerGrant(ctx, input.actor, input.actor.runId, input.recipientAgentId);
  const recipient = await assertOwnsTask(ctx, input.actor, input.recipientTaskId);
  // The sender's label at send time; another principal's words also read as theirs.
  const label = crossPrincipalLabel(
    input.actor.label,
    { taskId: input.actor.runId, principalId: input.actor.principalId },
    recipient.principalId,
  );
  pruneExpiredReplySchemas(ctx, now());
  // Capped by the remaining root-task deadline, same as `waitFor` above.
  const deadlineAt = await capDeadlineToRootBudget(ctx, input.actor.runId, input.deadlineAt);
  // Self-correlated: the messageId this request is assigned doubles as
  // the correlation id a caller later passes to `agents.wait
  // { correlationId }` to
  // block for the matching `reply`. No new suspend mechanism needed —
  // this is exactly what that mechanism was already generic enough for.
  const messageId = newId("msg");
  if (input.expectedReplySchema !== undefined) {
    expectedReplySchemas.set(messageId, { schema: input.expectedReplySchema, deadlineAt });
  }
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
    senderAgentId: input.actor.agentId ?? input.actor.runId,
    senderTaskId: input.actor.runId,
    recipientAgentId: input.recipientAgentId,
    recipientTaskId: input.recipientTaskId,
    kind: "request",
    correlationId: messageId,
    createdAt: now(),
    deliveryState: "pending",
    retentionState: "active",
    ...definedOnly({
      content: payload.content,
      artifactId: payload.artifactId,
      label,
    }),
    // Informational only today — no mailbox sweep or repository reads
    // this back to enforce anything;
    // actual expiry for this request/waitFor pair is enforced entirely
    // through the wait row's own `deadlineAt` (`waits.prepare` above,
    // and `agent-wait-scheduler.ts`'s expiry sweep).
    expiresAt: deadlineAt,
  };
  // A fresh self-correlated request can never already have an active
  // wait registered against its own not-yet-minted messageId, so this
  // always falls through to a generic wake — `deliverAndWake` is reused
  // anyway for one code path rather than two.
  await deliverAndWake(ctx, input.actor, input.recipientTaskId, envelope, "if-idle");
  return { messageId, accepted: true };
}

export async function reply(ctx: AgentCommunicationContext, input: AgentReplyInput): Promise<AgentReplyResult> {
  const { options, now, newId, expectedReplySchemas } = ctx;
  if (input.actor.runId === undefined || input.actor.runId.length === 0) {
    throw new TaviError("INVALID_INPUT", "reply requires an actor with a runId (the replier's own task)");
  }
  const original = await options.mailbox.getEnvelope(input.requestMessageId);
  if (original === undefined || original.kind !== "request" || original.recipientTaskId !== input.actor.runId) {
    // Same "don't reveal whether an unauthorized object exists" shape as
    // `assertOwnsTask`: a reply to a request this task was never the
    // recipient of (or that doesn't exist) is NOT_FOUND, not a
    // distinguishable "wrong recipient" error.
    throw new TaviError("NOT_FOUND", `Request ${input.requestMessageId} does not exist`);
  }
  // The grant check is symmetric: replying is itself a message to the
  // original requester's agent, so it needs the same explicit grant
  // requesting them did.
  await assertPeerGrant(ctx, input.actor, input.actor.runId, original.senderAgentId);
  const recipient = await assertOwnsTask(ctx, input.actor, original.senderTaskId);
  // The sender's label at send time; another principal's words also read as theirs.
  const label = crossPrincipalLabel(
    input.actor.label,
    { taskId: input.actor.runId, principalId: input.actor.principalId },
    recipient.principalId,
  );

  const expectedSchema = expectedReplySchemas.get(input.requestMessageId);
  if (expectedSchema !== undefined) {
    const validation = safeParseWith(expectedSchema.schema, input.content);
    if (!validation.success) {
      throw new TaviError("INVALID_INPUT", `Reply does not match request ${input.requestMessageId}'s expected schema`, {
        details: { message: validation.message },
      });
    }
    // Consumed once: a second reply to the same request (a caller bug,
    // or a retried tool call) validates against nothing rather than
    // stale schema state — matching how `request`'s own messageId is
    // never reused.
    expectedReplySchemas.delete(input.requestMessageId);
  }

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
    senderAgentId: input.actor.agentId ?? input.actor.runId,
    senderTaskId: input.actor.runId,
    recipientAgentId: original.senderAgentId,
    recipientTaskId: original.senderTaskId,
    kind: "reply",
    // Correlates back to the request's self-assigned correlation id
    // (its own messageId), which is exactly what a requester's
    // `agents.wait { correlationId: <request's messageId> }` matches
    // against — both the immediate-settle recheck in `waitFor` above and
    // `deliverAndWake`'s active-wait settle path key off this.
    correlationId: original.correlationId ?? original.messageId,
    causationId: input.requestMessageId,
    createdAt: now(),
    deliveryState: "pending",
    retentionState: "active",
    ...definedOnly({
      content: payload.content,
      artifactId: payload.artifactId,
      label,
    }),
  };
  // A reply goes through the same wake-on-reply path as `send`:
  // `deliverAndWake`
  // settles a matching active wait directly (a late reply to an
  // already-settled wait is still recorded here, but never reopens it —
  // see `deliverAndWake`'s own comment) or falls back to a generic wake.
  await deliverAndWake(ctx, input.actor, original.senderTaskId, envelope, "if-idle");
  return { messageId, accepted: true };
}
