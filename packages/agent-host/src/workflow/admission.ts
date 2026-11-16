import {
  isUntrusted,
  type AdmissionOutcome,
  type AdmissionResult,
  type AdmitInput,
  type InvocationContext,
  type FrontEnd,
  type TurnChannel,
  type MemoryReach,
  type ChatMemoryMode,
  TaviError,
  ROUND_REFUSED,
  pendingRoundFromAdmission,
  resumeIntentIdentity,
  type WorkflowInvocationResult,
  type WorkflowInvokeOptions,
  type WorkflowMessage,
  type WorkflowPort,
  ATTENDED_TASK_POLICY,
  parseAgentState,
  type ModTurnOutcome,
  type ModelEvent,
  type ToolDispatchEvent,
} from "@tavi/contracts";
import { definedOnly, errorMessage } from "@tavi/contracts/util";
import {
  seedMessages,
  inboundMessages,
  inboundIntentOf,
  noticeMessages,
  stoppedNoteMessages,
  triggerIntentOf,
  triggerMessages,
  withoutWorkflowFields,
} from "./admission-input.js";
import { abortCode, roundRefusal, STOPPED_TURN } from "./dispatch.js";
import { AsyncCheckpointSaver } from "./checkpoint.js";
import { latestCheckpointOf, type CompiledWorkflowGraph, type WorkflowThreadState } from "./graph.js";
import type { createRunInvocation } from "./invocation.js";
import { stricterChatMemoryMode } from "./options.js";
import type { WorkflowScope } from "./scope.js";
import { TURN_COMPLETE_HOOKS_WAIT_MS } from "./tool-hooks.js";
import type { TurnSupport } from "./turns.js";

export type AdmissionScope = WorkflowScope &
  TurnSupport & { readonly compiled: CompiledWorkflowGraph; readonly runInvocation: ReturnType<typeof createRunInvocation> };

/** What a turn on a cancelled task ends in: failed, with the cancel's own words. */
function cancelledOutcome(cancellation: {
  readonly requestedBy: string;
  readonly reason: string;
}): AdmissionOutcome & WorkflowInvocationResult {
  return {
    status: "failed",
    finalText: `Task was cancelled by ${cancellation.requestedBy}: ${cancellation.reason}`,
    error: { code: "CANCELLED", message: cancellation.reason },
  };
}

/** The adapter's `admit`. */
/** A Home with no turn yet: the person's first message is its first turn. */
export function createOpenHome({
  newId,
  now,
  options,
  promptPolicy,
}: Pick<AdmissionScope, "newId" | "now" | "options" | "promptPolicy">): NonNullable<WorkflowPort["openHome"]> {
  return async ({ workspaceId, principalId }) =>
    await options.tasks.openHome({
      workspaceId,
      principalId,
      operationKey: `open-home:${principalId}`,
      kind: "start",
      intent: { prompt: "" },
      checkpointNamespace: options.checkpointNamespace ?? "",
      chatKind: "home",
      // As a Home the canvas starts: its conversation and its source read the same.
      origin: "web",
      executionPolicy: ATTENDED_TASK_POLICY,
      newTaskId: newId("task"),
      newThreadId: newId("thread"),
      newAdmissionId: newId("admission"),
      now: now(),
      prompt: promptPolicy,
    });
}

export function createAdmit(scope: AdmissionScope) {
  const {
    claimTurnMailbox,
    compiled,
    conversationTainted,
    inheritedLabelOf,
    keepSeed,
    leaseMs,
    newId,
    now,
    observeHooks,
    options,
    originOf,
    promptPolicy,
    heartbeatPromptPolicy,
    promptThroughHooks,
    runInvocation,
    saver,
    serialize,
    settleRewind,
    settleTurnMailbox,
    takeSeed,
    turnConnectionOf,
  } = scope;
  /**
   * The single admission path.
   *
   * Task creation and the admission intent commit together under the caller's
   * operation key, so a retry resolves the same task rather than starting a
   * second thread. An admission that already has a durable outcome returns it
   * without running the graph again — that is what stops a replay from
   * repeating an effect whose result is already known.
   */
  async function admit(input: AdmitInput, invokeOptions?: WorkflowInvokeOptions): Promise<AdmissionResult> {
    // Fail closed on an unknown or disabled persona, *before* any task row is
    // written. A reference that does not resolve is a configuration mistake
    // (a typo in `sdaddy`, or an agent that was removed), and starting a task
    // that would silently run under the wrong instructions is worse than
    // refusing it. Checked here rather than at prompt-build time because this
    // is the one path every admission takes — start, schedule, spawn, resume.
    //
    // A definition removed *after* admission deliberately does not fail the
    // task's later turns: the work is already in flight, and refusing every
    // turn would strand it. Those turns degrade to the base prompt, which is
    // the documented cost of holding a reference rather than a snapshot.
    // Validated only when this admission *creates* a task (`taskId` absent).
    // A resume re-supplies the context the checkpoint already holds, so
    // re-checking there would let an operator's later `agents remove` strand a
    // task that is already in flight — refusing a resume of work that has
    // legitimately started. Creation is where a bad reference must be caught;
    // a later turn of an existing task degrades instead (see the model node).
    if (options.agentDefinitions !== undefined && input.context.agentDefinitionId !== undefined && input.taskId === undefined) {
      const definition = await options.agentDefinitions.get(input.context.workspaceId, input.context.agentDefinitionId);
      if (definition === undefined) {
        throw new TaviError(
          "INVALID_INPUT",
          `No agent definition ${input.context.agentDefinitionId} exists in workspace ${input.context.workspaceId}`,
          {
            details: { agentDefinitionId: input.context.agentDefinitionId },
          },
        );
      }
      if (!definition.enabled) {
        throw new TaviError("INVALID_INPUT", `Agent definition ${definition.agentId} is disabled`, {
          details: { agentDefinitionId: definition.agentId },
        });
      }
    }

    // A resumed tools node may execute before the next model node. Refuse a
    // target assertion before admitting any work or consuming approval input.
    if (input.taskId !== undefined && options.taskRouting !== undefined) {
      const target = await options.taskRouting.effectiveTarget?.(
        { workspaceId: input.context.workspaceId, principalId: input.context.principalId },
        input.taskId,
      );
      const expected = options.explicitModelTarget;
      if (
        target !== undefined &&
        expected !== undefined &&
        ((expected.connectionId !== undefined && expected.connectionId !== target.connectionId) ||
          (expected.model !== undefined && expected.model !== target.model))
      ) {
        throw new TaviError("INVALID_INPUT", "Explicit target does not match the task's effective saved model route");
      }
    }

    const intent =
      input.resume === undefined
        ? {
            prompt: input.prompt ?? "",
            ...inboundIntentOf(input),
            ...triggerIntentOf(input),
            ...(input.explicitModelSelection === true ? { explicitModelSelection: true } : {}),
          }
        : { resume: resumeIntentIdentity(input.resume) };

    const admitted = await options.tasks.admit({
      workspaceId: input.context.workspaceId,
      principalId: input.context.principalId,
      ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
      operationKey: input.operationKey,
      kind: input.kind,
      intent,
      checkpointNamespace: options.checkpointNamespace ?? "",
      // Forwarded whenever supplied. The *repository* is what applies it only in
      // its task-creating branch and ignores it on a follow-up, which is what
      // keeps a reply or wake from upgrading the policy; this is
      // skipped on a follow-up too, so the invariant holds on both sides rather
      // than resting on the repository alone.
      ...(input.taskId !== undefined || input.executionPolicy === undefined ? {} : { executionPolicy: input.executionPolicy }),
      // Forwarded, not dropped: whether an approval round belongs
      // to an operator or to a schedule fire in flight is decided by origin, and that decision has
      // no source if the admitting caller's origin never reaches the store.
      ...(input.origin === undefined ? {} : { origin: input.origin }),
      ...(input.originScheduleId === undefined ? {} : { originScheduleId: input.originScheduleId }),
      // What chat a new task is; a follow-up keeps its own.
      ...(input.taskId !== undefined || input.chatKind === undefined ? {} : { chatKind: input.chatKind }),
      ...(input.taskId !== undefined || input.parentChatId === undefined ? {} : { parentChatId: input.parentChatId }),
      // A new chat's memory mode: private is set here or never.
      ...(input.taskId !== undefined || input.memoryMode === undefined ? {} : { memoryMode: input.memoryMode }),
      // A new chat's instructions, saved with its task; a follow-up's are the chat panel's to change.
      ...(input.taskId !== undefined || input.chatInstructions === undefined ? {} : { chatInstructions: input.chatInstructions }),
      newTaskId: input.taskId === undefined && input.newTaskId !== undefined ? input.newTaskId : newId("task"),
      newThreadId: newId("thread"),
      newAdmissionId: newId("admission"),
      now: now(),
      // Supplied unconditionally: every production task is snapshot-bearing by
      // construction, which is what makes "a missing snapshot is corruption"
      // a structural fact rather than a scoping rule. A follow-up's
      // `start` or `reply` re-resolves the base through it too, and pins it
      // when it changed.
      prompt:
        input.origin === "heartbeat" && (await options.promptLayout?.(input.context.workspaceId)) === "v2"
          ? heartbeatPromptPolicy
          : promptPolicy,
    });

    await input.onAdmitted?.({
      taskId: admitted.task.taskId,
      threadId: admitted.task.threadId,
      admissionId: admitted.admission.admissionId,
      created: admitted.created,
      // A Home a schedule started has no turn behind it: its first message starts its stream.
      ...(admitted.created && admitted.task.chatKind === "home" && admitted.task.status === "completed" && admitted.task.finalText === null
        ? { firstTurn: true as const }
        : {}),
    });

    // A replay of an admission with a durable outcome is answered from the
    // record. Re-running it could repeat an external effect.
    if (!admitted.created && admitted.admission.result !== null) {
      const recorded = admitted.admission.result;
      // A refused admission answered nothing about the task (it is still
      // waiting), so a retry under its key is refused again. Replaying it as a
      // `failed` outcome would have every caller report a waiting task failed.
      if (admitted.admission.state === "refused") {
        throw new TaviError("CONFLICT", recorded.error?.message ?? recorded.finalText, {
          details: { reason: ROUND_REFUSED },
        });
      }
      // Re-project the task status. A crash between the outcome write and the
      // status write would otherwise leave it stale forever, because this path
      // is the one a retry takes. Only for the task's *latest* admission,
      // though: a retry of an older one — a front end replaying a start whose
      // round another front end has since decided — would otherwise roll a
      // completed task back to that admission's `waiting`.
      const projected = recorded.status;
      const latest = await options.tasks.latestSettledAdmission(admitted.task.taskId);
      if (admitted.task.status !== projected && latest?.admissionId === admitted.admission.admissionId) {
        await options.tasks.commitAdmission({
          admissionId: admitted.admission.admissionId,
          taskId: admitted.task.taskId,
          state: admitted.admission.state,
          result: recorded,
        });
      }
      return {
        taskId: admitted.task.taskId,
        threadId: admitted.task.threadId,
        outcome: recorded,
        created: false,
        replay: true,
      };
    }

    // Cancellation is authoritative and checked before any work is admitted: a
    // reply cannot revive cancelled work, and no node runs for a cancelled task.
    const cancellation = await options.cancellations.get(admitted.task.taskId);
    if (cancellation !== undefined) {
      const cancelled = cancelledOutcome(cancellation);
      await options.tasks.commitAdmission({
        admissionId: admitted.admission.admissionId,
        taskId: admitted.task.taskId,
        state: "failed",
        result: cancelled,
      });
      return {
        taskId: admitted.task.taskId,
        threadId: admitted.task.threadId,
        outcome: cancelled,
        created: admitted.created,
        replay: false,
      };
    }

    const execution = await serialize(admitted.task.taskId, async () => {
      // Re-read the admission inside the serialized region. A competing caller
      // with the same operation key may have committed while this one waited,
      // and re-reading here is what stops the retry from doing the work twice.
      const settled = await options.tasks.getAdmission(admitted.task.taskId, admitted.admission.operationKey);
      if (settled?.result !== null && settled?.result !== undefined) {
        if (settled.state === "refused") {
          throw new TaviError("CONFLICT", settled.result.error?.message ?? settled.result.finalText, {
            details: { reason: ROUND_REFUSED },
          });
        }
        return { outcome: settled.result, replayed: true } as const;
      }

      // The round precondition, checked here — inside the task's queue,
      // before the lease and any node — because a caller's own read of "what is
      // pending" happens before the queue and cannot see a decision that
      // settled the round while it waited. On a mismatch the admission is
      // committed `refused`, which projects nothing onto the task: it stays
      // waiting, never failed.
      // (This admission has no outcome yet — the re-read above would have
      // answered it — so the latest settled admission is never this one.)
      const refusal =
        input.resume?.expectedSteps === undefined
          ? undefined
          : roundRefusal(
              pendingRoundFromAdmission(await options.tasks.latestSettledAdmission(admitted.task.taskId)),
              input.resume,
              input.resume.expectedSteps,
            );
      if (refusal !== undefined) {
        await options.tasks.commitAdmission({
          admissionId: admitted.admission.admissionId,
          taskId: admitted.task.taskId,
          state: "refused",
          result: { status: "failed", finalText: refusal, error: { code: "CONFLICT", message: refusal } },
        });
        throw new TaviError("CONFLICT", refusal, { details: { reason: ROUND_REFUSED } });
      }

      // The invocation slot is taken before any node runs and released after,
      // so two admissions for one task cannot overlap.
      const lease = await options.executions.acquire({
        taskId: admitted.task.taskId,
        ownerSession: options.ownerSession,
        admissionId: admitted.admission.admissionId,
        leaseMs,
        now: options.now === undefined ? { execution: true } : { fixed: now() },
      });

      // Release always: a throw in the invocation must not wedge the slot.
      // A crash before release leaves the slot active until its lease expires,
      // which the operator reclaim path handles deliberately.
      try {
        await options.tasks.setAdmissionState(admitted.admission.admissionId, "claimed");
        // The execution slot is held and every precondition has passed,
        // so this admission is now *the* running one for its task — which
        // `onAdmitted`, fired before the serialized region, cannot promise: an
        // admission queued behind another of the same task, or a retry that is
        // about to replay, has been admitted but will never be claimed.
        // An observer: a throw here would leave the admission `claimed` with no
        // node run and no result — the shape a crash leaves — so it is
        // reported rather than allowed to abandon the claim.
        try {
          input.onClaimed?.({
            taskId: admitted.task.taskId,
            threadId: admitted.task.threadId,
            admissionId: admitted.admission.admissionId,
            created: admitted.created,
          });
        } catch (error) {
          options.onDiagnostic?.("an admission's onClaimed callback threw; the admission continues", {
            taskId: admitted.task.taskId,
            reason: errorMessage(error),
          });
        }
        // The thread's checkpoint as this turn finds it, read once and on first use: the lease is
        // held, so nothing writes the thread before this admission's graph runs, and every reading
        // until then — the reply target, the folder's taint, the mailbox, the persona — sees one state.
        let checkpointRead: Promise<WorkflowThreadState> | undefined;
        const priorState = (): Promise<WorkflowThreadState> =>
          (checkpointRead ??= compiled.getState({ configurable: { thread_id: admitted.task.threadId } }));
        // The channel this turn is held to: the composition's
        // reading of the caller's context — a reply into a messaging
        // conversation, or a worker whose spawning turn was held — or one a
        // spawning turn handed down. Only `messaging` is honoured from a
        // caller, and a held channel only ever narrows the rules, so no
        // caller can lift one. A reading that fails holds the turn: the
        // narrower answer is the safe one.
        // A prompt-less wake (an agent's result) has no message of
        // the person's to reply to: it goes on in the conversation the chat
        // last replied into, so a woken conversation Home can still answer
        // there — and is held as that conversation is.
        const callerContext: InvocationContext = await (async () => {
          if (
            input.taskId === undefined ||
            input.kind !== "reply" ||
            input.prompt !== undefined ||
            input.resume !== undefined ||
            input.context.messagingReplyTo !== undefined
          )
            return input.context;
          try {
            const state = await priorState();
            const replyTo = (state.values as { readonly invocation?: InvocationContext } | undefined)?.invocation?.messagingReplyTo;
            return replyTo === undefined ? input.context : { ...input.context, messagingReplyTo: replyTo };
          } catch {
            return input.context;
          }
        })();
        const readChannel = async (): Promise<string | undefined> => {
          try {
            return await options.turnChannel?.({ ...withoutWorkflowFields(callerContext), runId: admitted.task.taskId });
          } catch {
            return "messaging";
          }
        };
        // A side chat opened from a messaging conversation is held as its parent is:
        // its seed quotes that conversation, whoever wrote it.
        const parentHeld = async (): Promise<boolean> => {
          try {
            let parentId = admitted.task.parentChatId;
            for (let depth = 0; parentId !== undefined && depth < 8; depth += 1) {
              if ((await originOf(parentId)) === "messaging") return true;
              // An ancestor whose record cannot be read is held, as one that cannot be read at all.
              const record = await options.tasks.get(parentId);
              if (record === undefined) return true;
              parentId = record.parentChatId;
            }
            return parentId !== undefined;
          } catch {
            return true;
          }
        };
        const heldChannel: TurnChannel | undefined =
          input.context.heldChannel === "messaging" || (await readChannel()) === "messaging" || (await parentHeld())
            ? "messaging"
            : undefined;
        // How far its memory reaches: a group conversation's turn reads only its chat's
        // notes. A caller's "chat-only" is kept, as it only narrows; a reading that fails narrows too.
        const memoryReach: MemoryReach | undefined =
          input.context.memoryReach === "chat-only" ||
          (await (async () => {
            try {
              return await options.memoryReach?.(admitted.task.taskId, admitted.task);
            } catch {
              return "chat-only" as const;
            }
          })()) === "chat-only"
            ? "chat-only"
            : undefined;
        // Its chat's memory mode: the stricter of the chat's as read and a caller's (a
        // worker's spawning chat's, before its delegation row exists); a reading that fails is off.
        const chatMemoryMode: ChatMemoryMode | undefined = stricterChatMemoryMode(
          input.context.chatMemoryMode,
          await (async () => {
            try {
              return (await options.chatMemory?.(admitted.task.taskId, admitted.task))?.mode;
            } catch {
              return "off" as const;
            }
          })(),
        );
        // The connection a held turn came in on: its own, a worker's spawning turn's, or the waking actor's.
        const heldConnectionId: string | undefined =
          heldChannel === undefined
            ? undefined
            : await (async () => {
                try {
                  return (
                    (await turnConnectionOf({ ...withoutWorkflowFields(callerContext), runId: admitted.task.taskId })) ??
                    input.context.heldConnectionId
                  );
                } catch {
                  return input.context.heldConnectionId;
                }
              })();
        // The front end this turn is held to: a worker's
        // spawning turn's, from its row, else the one its caller set from the
        // connection. Any value only narrows the rules.
        const frontEnd: FrontEnd | undefined = await (async () => {
          try {
            return (
              (await options.turnFrontEnd?.({ ...withoutWorkflowFields(callerContext), runId: admitted.task.taskId })) ??
              callerContext.frontEnd
            );
          } catch {
            return callerContext.frontEnd;
          }
        })();
        // The chat's working folder for this turn: resolved once, here,
        // from the chat's record — a worker's is its root chat's, a held turn
        // sees only the managed folder, and the conversation's sticky taint is
        // carried for `sandbox.run`. A folder that cannot be
        // resolved does not refuse the turn: its tools report why.
        const turnFolder = options.turnFolder;
        const folderStamp: Pick<InvocationContext, "folder" | "folderUnavailable"> =
          turnFolder === undefined
            ? {}
            : await (async () => {
                // The checkpoint — none for a new chat; `null` when it cannot be read: held tainted then, and a resume
                // held, the narrower answers. (`admitted.created` says the admission is new, not the task.)
                const checkpointed = await (async () => {
                  try {
                    const state = await priorState();
                    return state.values === undefined || Object.keys(state.values as object).length === 0
                      ? undefined
                      : parseAgentState(state.values);
                  } catch {
                    return null;
                  }
                })();
                // A worker spawned from a tainted conversation starts tainted.
                const tainted =
                  isUntrusted(inheritedLabelOf(input.context)) ||
                  checkpointed === null ||
                  (checkpointed !== undefined && conversationTainted(checkpointed));
                // A resume runs as the turn it resumes: held as that turn was, whoever answered.
                const held: TurnChannel | undefined =
                  heldChannel ??
                  (input.resume !== undefined && (checkpointed === null || checkpointed?.invocation.heldChannel === "messaging")
                    ? "messaging"
                    : undefined);
                try {
                  const folder = await turnFolder(
                    { ...withoutWorkflowFields(callerContext), runId: admitted.task.taskId },
                    { heldChannel: held, tainted, origin: admitted.task.origin ?? undefined, task: admitted.task },
                  );
                  return folder === undefined ? {} : { folder };
                } catch (error) {
                  const message =
                    error instanceof Error && error.message !== "" ? error.message : "This chat's working folder could not be resolved.";
                  return { folderUnavailable: message.slice(0, 1_000) };
                }
              })();
        // The agent-mailbox envelopes this turn reads:
        // claimed under the admission, quoted as one data message, and read
        // once the turn ran — handed back when it never did.
        const mailbox = await claimTurnMailbox(
          input,
          admitted.task.taskId,
          admitted.task.threadId,
          admitted.admission.admissionId,
          priorState,
        );
        // What plugins' turn observers are told: the turn's kind, then its outcome, usage and tool calls.
        const turnKind = input.kind === "cancel" ? undefined : input.kind;
        const turnContext: InvocationContext = {
          ...withoutWorkflowFields(callerContext),
          runId: admitted.task.taskId,
          ...(admitted.task.parentChatId === undefined ? {} : { parentChatId: admitted.task.parentChatId }),
          // When this turn began: the admission's own time, so a
          // re-run of the same admission after a restart keeps it. A resume
          // never replaces the checkpointed context, so it keeps its turn's.
          turnStartedAt: admitted.admission.createdAt,
          // The channel this turn is held to, read above.
          ...(heldChannel === undefined ? {} : { heldChannel }),
          ...(heldConnectionId === undefined ? {} : { heldConnectionId }),
          // The front end it was typed in, read above.
          ...(frontEnd === undefined ? {} : { frontEnd }),
          // How far its memory reaches, read above.
          ...(memoryReach === undefined ? {} : { memoryReach }),
          // Its chat's memory mode, read above.
          ...(chatMemoryMode === undefined ? {} : { chatMemoryMode }),
          // The chat's folder, read above.
          ...folderStamp,
          // A schedule fire's delivery target: only a schedule's task sends to it as a reply.
          ...(admitted.task.origin === "schedule" && callerContext.scheduleDelivery !== undefined
            ? { scheduleDelivery: callerContext.scheduleDelivery }
            : {}),
          // How it tells its person, likewise only on a schedule's task.
          ...(admitted.task.origin === "schedule" && callerContext.scheduleNotify !== undefined
            ? { scheduleNotify: callerContext.scheduleNotify }
            : {}),
        };
        // What its observers are told the turn is: a resume runs as the turn it resumes — its channel,
        // connection and front end are the checkpoint's, as its tool hooks see them, not whoever answered.
        const observedContext: InvocationContext =
          input.resume === undefined
            ? turnContext
            : await (async () => {
                try {
                  const state = await priorState();
                  const held = (state.values as { readonly invocation?: InvocationContext } | undefined)?.invocation;
                  // The checkpoint's whole context, as the tool hooks read it: its reply target and stamp
                  // too, so a connection read afresh is read as theirs is, never from whoever answered.
                  return held === undefined ? turnContext : { ...held, runId: turnContext.runId };
                } catch {
                  return turnContext;
                }
              })();
        // A turn held to a messaging conversation (a resume as the turn it resumes): the saved turn records it, and
        // automatic capture never reads it (invariant 6).
        if (observedContext.heldChannel === "messaging") {
          try {
            invokeOptions?.onHeldChannel?.("messaging");
          } catch (error) {
            options.onDiagnostic?.("an admission's onHeldChannel observer threw; the turn continues", {
              taskId: admitted.task.taskId,
              reason: errorMessage(error),
            });
          }
        }
        const turnUsage: Record<"inputTokens" | "outputTokens" | "inputCacheReadTokens" | "inputCacheWriteTokens", number> = {
          inputTokens: 0,
          outputTokens: 0,
          inputCacheReadTokens: 0,
          inputCacheWriteTokens: 0,
        };
        let turnToolCalls = 0;
        let invocation: WorkflowInvocationResult;
        let dropped = false;
        let notRun = false;
        // Whether its observers heard the turn start, and its end: a turn that throws is told as failed.
        let observedTurn = false;
        let toldComplete = false;
        try {
          // A new prompt or reply, never a resume: plugins' prompt hooks see it before the turn starts.
          let submitted: Awaited<ReturnType<typeof promptThroughHooks>> | "cancelled";
          try {
            submitted =
              input.prompt !== undefined && input.resume === undefined && (input.kind === "start" || input.kind === "reply")
                ? await promptThroughHooks(
                    admitted.task.taskId,
                    turnContext,
                    input.prompt,
                    false,
                    (index) => `${admitted.admission.admissionId}-${index}`,
                    invokeOptions?.signal,
                  )
                : { context: [] };
          } catch (error) {
            // Cancelled while its prompt hooks ran: the turn ends aborted and committed, as a cancel during the turn does.
            if (invokeOptions?.signal?.aborted !== true) throw error;
            submitted = "cancelled";
          }
          dropped = submitted !== "cancelled" && submitted.drop !== undefined;
          notRun = submitted === "cancelled" || dropped;
          // A new chat's background is not lost with a turn that never ran: its next turn reads it.
          if (notRun && admitted.created && input.seed !== undefined) keepSeed(admitted.task.taskId, input.seed);
          // A dropped or cancelled prompt is no turn: its observers hear nothing.
          const observed = turnKind !== undefined && submitted !== "cancelled" && submitted.drop === undefined;
          observedTurn = observed;
          if (observed)
            void observeHooks(
              "turn.start",
              admitted.task.taskId,
              observedContext,
              (envelope) => ({ envelope, kind: turnKind }),
              async () => undefined,
              invokeOptions?.signal,
            );
          // A follow-up's unread seed, taken once its turn runs.
          const followSeed =
            input.taskId === undefined || submitted === "cancelled" || submitted.drop !== undefined
              ? undefined
              : takeSeed(admitted.task.taskId);
          try {
            // A dropped prompt runs no turn: the person is told why, and nothing reaches the model.
            invocation =
              submitted === "cancelled"
                ? abortCode(invokeOptions?.signal) === "STOPPED"
                  ? STOPPED_TURN
                  : {
                      status: "failed",
                      finalText: "The run was cancelled before it started.",
                      error: { code: "ABORTED", message: "The run was cancelled before it started." },
                    }
                : submitted.drop !== undefined
                  ? { status: "completed", finalText: submitted.drop }
                  : await runInvocation(
                      {
                        routingAdmission: {
                          newTask: admitted.created,
                          explicit: input.explicitModelSelection === true || options.explicitModelSelection === true,
                        },
                        recoverPendingStart: options.recoverPendingStart === true && !admitted.created && input.kind === "start",
                        // A side chat reads its parent's chat notes on every turn:
                        // taken from the task's record, never from the caller.
                        context: turnContext,
                        threadId: admitted.task.threadId,
                        messages: [
                          // A new chat's background (a side chat's seed): context ahead
                          // of the prompt, never the person's prompt. Its preamble and
                          // summary in the channel epoch summaries use; the quoted
                          // excerpt as a labelled user-role message, out of the instructions.
                          ...seedMessages(input.taskId === undefined ? input.seed : followSeed, admitted.admission.admissionId, now),
                          // The notices posted into the chat since its last turn:
                          // one labelled data block, a user-role message ahead of the
                          // prompt, never instructions — and only with a prompt, so a
                          // notice never makes a turn of its own.
                          ...noticeMessages(input, admitted.admission.admissionId, now),
                          // The task as it was found: a turn starting moves it on only later.
                          ...stoppedNoteMessages(
                            input,
                            input.prompt !== undefined && input.resume === undefined && admitted.task.status === "stopped",
                            admitted.admission.admissionId,
                            now,
                          ),
                          // What agents sent the chat (a worker's result): data, never instructions.
                          // Its label always set, a trusted one too: a `mailbox-` block without one is from before labels, read untrusted.
                          ...(mailbox === undefined
                            ? []
                            : [
                                {
                                  id: `mailbox-${admitted.admission.admissionId}`,
                                  role: "user" as const,
                                  text: mailbox.text,
                                  label: mailbox.label,
                                  createdAt: now(),
                                },
                              ]),
                          ...(input.prompt === undefined
                            ? []
                            : [
                                {
                                  id: `input-${admitted.admission.admissionId}`,
                                  role: "user" as const,
                                  text: input.prompt,
                                  createdAt: now(),
                                },
                              ]),
                          // What a channel admitted that is not the person's own words: another
                          // member's message, a forward, an email's quoted part — labelled quoted data, after the prompt.
                          ...inboundMessages(input, admitted.admission.admissionId, now),
                          // What started a run from outside (a webhook call's payload, an email): labelled quoted data,
                          // whose URLs are never made known.
                          ...triggerMessages(input, admitted.admission.admissionId, now),
                          // What plugins added to it: quoted data, after it.
                          ...submitted.context,
                        ],
                        ...(input.resume === undefined ? {} : { resume: input.resume }),
                        ...(mailbox === undefined || mailbox.modelUrls.length === 0 ? {} : { carriedModelUrls: mailbox.modelUrls }),
                        priorState,
                      },
                      {
                        ...invokeOptions,
                        ...(options.turnHooks === undefined
                          ? {}
                          : {
                              onModelEvent: (event: ModelEvent) => {
                                const usage = event.type === "model.result" ? event.usage : undefined;
                                if (usage !== undefined) {
                                  for (const key of [
                                    "inputTokens",
                                    "outputTokens",
                                    "inputCacheReadTokens",
                                    "inputCacheWriteTokens",
                                  ] as const)
                                    turnUsage[key] += usage[key] ?? 0;
                                }
                                return invokeOptions?.onModelEvent?.(event);
                              },
                              onToolEvent: (event: ToolDispatchEvent) => {
                                if (event.phase === "started") turnToolCalls += 1;
                                return invokeOptions?.onToolEvent?.(event);
                              },
                            }),
                        executionLease: {
                          taskId: lease.taskId,
                          generation: lease.generation,
                          admissionId: admitted.admission.admissionId,
                        },
                      },
                    );
          } catch (error) {
            // It never ran: the seed it took goes back for the next turn.
            if (followSeed !== undefined) keepSeed(admitted.task.taskId, followSeed);
            throw error;
          }
          // A cancel wins over a stop, whichever came first: the record stays `cancelled`, so the stream says so too.
          if (invocation.status === "stopped") {
            const cancellation = await options.cancellations.get(admitted.task.taskId).catch((error: unknown) => {
              options.onDiagnostic?.("a stopped turn's cancellation could not be read; it is reported as stopped", {
                taskId: admitted.task.taskId,
                reason: errorMessage(error),
              });
              return undefined;
            });
            if (cancellation !== undefined) invocation = cancelledOutcome(cancellation);
          }
          if (observed) {
            toldComplete = true;
            // A cancel ends a turn as failed; its observers are told it was cancelled.
            const outcome: ModTurnOutcome =
              invocation.status === "stopped" ||
              (invocation.status === "failed" &&
                (invokeOptions?.signal?.aborted === true || invocation.error?.code === "ABORTED" || invocation.error?.code === "CANCELLED"))
                ? "cancelled"
                : invocation.status;
            // Waited for briefly, so what its hooks show lands on the task's stream before the turn's end does.
            // Told even of a cancelled turn (they saw it start); past the wait they are stopped, not left running into the next turn, and that is no failure of theirs.
            const waited = new AbortController();
            const cap = setTimeout(
              () => waited.abort(new TaviError("CANCELLED", "the turn ended before its turn.complete hooks answered")),
              TURN_COMPLETE_HOOKS_WAIT_MS,
            );
            const told = observeHooks(
              "turn.complete",
              admitted.task.taskId,
              observedContext,
              (envelope) => ({ envelope, outcome, usage: turnUsage, toolCalls: turnToolCalls }),
              async () => ({}),
              waited.signal,
            );
            // Raced as well: a port that does not honour the signal still never holds the turn past its wait.
            const ended = await Promise.race([
              told,
              new Promise<undefined>((resolve) => waited.signal.addEventListener("abort", () => resolve(undefined), { once: true })),
            ]);
            clearTimeout(cap);
            // What they suggest the person does next: with the turn, never on a channel.
            // Only for a turn that ended: a waiting one is resumed by an answer, not a prompt.
            const suggestions = outcome === "completed" || outcome === "failed" ? (ended?.suggestions ?? []) : [];
            if (suggestions.length > 0) {
              try {
                invokeOptions?.onSuggestions?.(suggestions);
              } catch (error) {
                options.onDiagnostic?.("an admission's onSuggestions observer threw; the turn ends as it was", {
                  taskId: admitted.task.taskId,
                  reason: errorMessage(error),
                });
              }
            }
          }
        } finally {
          // A turn whose invocation threw still ends for its observers, as failed; not waited for, since the throw goes on.
          if (observedTurn && !toldComplete) {
            // Stopped at the same wait as a turn that ended, or at a cancel, so nothing it shows lands after the turn.
            const waited = new AbortController();
            const cap = setTimeout(
              () => waited.abort(new TaviError("CANCELLED", "the turn ended before its turn.complete hooks answered")),
              TURN_COMPLETE_HOOKS_WAIT_MS,
            );
            const onCancel = () => waited.abort(invokeOptions?.signal?.reason);
            invokeOptions?.signal?.addEventListener("abort", onCancel, { once: true });
            void observeHooks(
              "turn.complete",
              admitted.task.taskId,
              observedContext,
              (envelope) => ({
                envelope,
                outcome: invokeOptions?.signal?.aborted === true ? "cancelled" : "failed",
                usage: turnUsage,
                toolCalls: turnToolCalls,
              }),
              async () => ({}),
              waited.signal,
            ).finally(() => {
              clearTimeout(cap);
              invokeOptions?.signal?.removeEventListener("abort", onCancel);
            });
          }
          // Read or handed back by what the checkpoint holds, never by how the run ended.
          await settleTurnMailbox(admitted.task.taskId, admitted.task.threadId, mailbox);
        }

        // The steers this admission took: those its checkpoint holds
        // are consumed; any other claim — a step that never checkpointed — is
        // handed back, for the chat's next turn. Inside the task's queue, so
        // no later admission's model call can claim in between. Best effort:
        // a claim left over is handed back by the next admission's settle.
        if (options.steers !== undefined) {
          try {
            const final = await compiled.getState({ configurable: { thread_id: admitted.task.threadId } });
            const values = final.values as
              | { readonly turnSteers?: readonly string[]; readonly conversation?: readonly WorkflowMessage[] }
              | undefined;
            await options.steers.settle(admitted.task.taskId, [
              ...(values?.turnSteers ?? []),
              ...(values?.conversation ?? []).map((message) => message.id),
            ]);
          } catch (error) {
            options.onDiagnostic?.("a turn's steers could not be settled", { taskId: admitted.task.taskId, reason: errorMessage(error) });
          }
        }

        // Commit while this generation is still current, so a delayed
        // invocation can never overwrite the authoritative projection.
        await options.executions.assertCurrentGeneration(admitted.task.taskId, lease.generation, options.ownerSession);
        const durable: AdmissionOutcome = {
          status: invocation.status,
          finalText: invocation.finalText,
          ...definedOnly({
            interrupt: invocation.interrupt,
            waitInterrupt: invocation.waitInterrupt,
            reviewInterrupt: invocation.reviewInterrupt,
            error: invocation.error,
            channelReply: invocation.channelReply,
          }),
        };
        // Record the application receipt for the checkpoint that is durable
        // now. `durability: "sync"` is what makes "now" true.
        // Its id and namespace in one read from the owner's saver; listed from any other.
        const checkpoint =
          saver instanceof AsyncCheckpointSaver
            ? await saver.latest(admitted.task.threadId)
            : await latestCheckpointOf(saver, admitted.task.threadId);
        if (checkpoint !== undefined)
          await options.receipts.record({
            taskId: admitted.task.taskId,
            threadId: admitted.task.threadId,
            checkpointNamespace: checkpoint.checkpointNamespace,
            checkpointId: checkpoint.checkpointId,
            admissionId: admitted.admission.admissionId,
            source: "admission",
            now: { fixed: now() },
          });

        await options.tasks.commitAdmission({
          admissionId: admitted.admission.admissionId,
          taskId: admitted.task.taskId,
          state: invocation.status === "failed" ? "failed" : "committed",
          result: durable,
          // The task's recorded namespace comes from the checkpoint the graph
          // actually wrote, not from configuration, and is recorded with the outcome.
          ...(checkpoint === undefined ? {} : { checkpointNamespace: checkpoint.checkpointNamespace }),
        });
        if (options.rewinds !== undefined) await settleRewind(admitted.task.taskId, admitted.task.threadId);
        if (options.pruneCheckpoints !== undefined) {
          try {
            await options.pruneCheckpoints(admitted.task.threadId);
          } catch (error) {
            options.onDiagnostic?.("a turn's older checkpoints could not be pruned", {
              taskId: admitted.task.taskId,
              reason: errorMessage(error),
            });
          }
        }
        if (options.onTurnEnded !== undefined && invocation.status !== "waiting") {
          try {
            await options.onTurnEnded({ taskId: admitted.task.taskId, workspaceId: turnContext.workspaceId, folder: turnContext.folder });
          } catch (error) {
            options.onDiagnostic?.("a turn's end could not be handled", { taskId: admitted.task.taskId, reason: errorMessage(error) });
          }
        }
        // Not part of the durable record: a replay of a dropped prompt says why again, but is not a new drop.
        return {
          outcome: { ...durable, ...(dropped ? { dropped: true as const } : {}), ...(notRun ? { notRun: true as const } : {}) },
          replayed: false,
        } as const;
      } finally {
        await options.executions.release({
          taskId: admitted.task.taskId,
          generation: lease.generation,
          ownerSession: options.ownerSession,
          now: options.now === undefined ? { execution: true } : { fixed: now() },
        });
      }
    });

    return {
      taskId: admitted.task.taskId,
      threadId: admitted.task.threadId,
      outcome: execution.outcome,
      created: admitted.created,
      replay: execution.replayed,
    };
  }
  return admit;
}
