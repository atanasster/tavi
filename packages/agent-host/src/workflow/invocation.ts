import type { RunnableConfig } from "@langchain/core/runnables";
import { Command, isInterrupted } from "@langchain/langgraph";
import {
  TRUSTED_PUBLIC,
  isUntrusted,
  joinLabels,
  isTrustedPublic,
  type ContentLabel,
  type ConversationFold,
  type InvocationContext,
  STEERS_PER_TURN,
  TaviError,
  type ToolRegistryPort,
  type WorkflowInterrupt,
  type WorkflowInvocationResult,
  type WorkflowInvokeOptions,
  type WorkflowMessage,
  type WorkflowResumeDecision,
  type WorkflowReviewInterrupt,
  type WorkflowWaitInterrupt,
  type WorkflowWaitRequest,
  WorkflowWaitRequestSchema,
  parseAgentState,
} from "@tavi/contracts";
import { definedOnly, errorMessage } from "@tavi/contracts/util";
import { REWIND_NOTE_ID, REWIND_NOTE, rewoundFrom, inboundUrlKeys, supersededCallResults } from "./admission-input.js";
import { ApprovalRequestSchema, ReviewRequestListSchema } from "./approval.js";
import { abortCode, graphFailureCode, STOPPED_TURN } from "./dispatch.js";
import { ADMISSION_FLUSH_TIMEOUT_MS, isSummaryMessage, planEpochRollover, buildEpochRolloverFold } from "./epoch.js";
import { invokeGraph, type CompiledWorkflowGraph, type WorkflowThreadState } from "./graph.js";
import { extractInterrupts, pendingInterruptOf, resumeStillApplies } from "./interrupts.js";
import type { WorkflowScope } from "./scope.js";

/** Effect classification for a tool name, defaulting to the most restrictive read. */
function effectOf(registry: ToolRegistryPort, toolName: string): string {
  return registry.get(toolName)?.effect ?? "external";
}

/** Runs one admitted invocation through the graph and reads its outcome. */
export function createRunInvocation(scope: WorkflowScope & { readonly compiled: CompiledWorkflowGraph }) {
  const {
    admittedFolders,
    authorizeModels,
    channelReplyOf,
    compactionFailures,
    compactionKeepRecentMessages,
    compiled,
    contextLabelOf,
    conversationTainted,
    epochRolledOver,
    epochRolloverMessages,
    epochSummaryUntrusted,
    flushBeforeRollover,
    inheritedLabelOf,
    labelOf,
    labelledFold,
    newId,
    now,
    observers,
    options,
    previousLabelState,
    rewindMarker,
    selectedPromptSnapshot,
    spanLabel,
    stepCeiling,
    takeFreshContext,
    targetWaiting,
    turnBaseline,
    turnBaselines,
  } = scope;
  async function runInvocation(
    input: {
      readonly context: InvocationContext;
      readonly threadId: string;
      readonly messages: readonly {
        readonly id: string;
        readonly role: "system" | "user" | "assistant" | "tool";
        readonly text: string;
        readonly createdAt: string;
        /** An `inbound-…` block's label: whose words it holds. */
        readonly label?: ContentLabel;
      }[];
      readonly resume?: WorkflowResumeDecision;
      readonly recoverPendingStart?: boolean;
      readonly routingAdmission?: { newTask: boolean; explicit: boolean };
      /** The URLs the senders of the turn's agent mail wrote (`workerModelUrls`): model-written here too. */
      readonly carriedModelUrls?: readonly string[];
      /**
       * The admission's own reading of the thread's checkpoint, taken under its lease before the graph
       * runs: nothing else writes the thread until then, so the previous state is read from it.
       */
      readonly priorState?: () => Promise<WorkflowThreadState>;
    },
    invokeOptions?: WorkflowInvokeOptions,
  ): Promise<WorkflowInvocationResult> {
    const config: RunnableConfig & { durability?: "exit" | "async" | "sync" } = {
      // The completed model response and its tool-call
      // identities must be durable BEFORE the tools node dispatches.
      // The framework default is `async`, which runs the next step while the
      // checkpoint write is still in flight. Measured against a saver whose `put`
      // completes asynchronously — the shape of the pinned saver, which awaits
      // serialization — `async` left zero durable writes when the tools node ran;
      // `sync` left all of them.
      durability: "sync",
      configurable: {
        thread_id: input.threadId,
        routingAdmission: input.routingAdmission,
        // The lease rides in the runnable config so every node can fence its own
        // side effects without reading adapter state that another admission on
        // the same adapter could have replaced.
        ...(invokeOptions?.executionLease === undefined ? {} : { executionLease: invokeOptions.executionLease }),
      },
      // Each steer an admission merges starts the turn's guards again,
      // so one invocation may take up to `STEERS_PER_TURN + 1` turns' steps.
      // A step that calls a tool passes four nodes (model, approve, tools,
      // review): fewer here and a turn that spends its steps on tools hits the
      // framework's limit before its own step guard, which ends it with an answer.
      recursionLimit: (options.steers === undefined ? 1 : STEERS_PER_TURN + 1) * stepCeiling * 4 + 8,
      ...(invokeOptions?.signal === undefined ? {} : { signal: invokeOptions.signal }),
    };

    /**
     * A later turn of an existing task keeps the persona its first turn was
     * admitted with.
     *
     * The `invocation` channel has no reducer, so a non-resume turn *replaces*
     * the checkpointed context wholesale with the one its caller supplied. Every
     * caller that admits a follow-up turn against an existing task builds that
     * context from what it has to hand — an inbound chat message has the
     * conversation's task id and the sender, not the agent the conversation was
     * routed to — so `@sdaddy, run the brief` ran under the persona and the
     * operator's very next message in the same conversation ran under the base
     * prompt, silently. (The spawn path hit the same channel behaviour and fixed
     * it by rebuilding the context from the delegation row; a chat conversation
     * has no such row, and the checkpoint is the only place the choice lives.)
     *
     * Only the persona is carried, and only when the caller named none: an
     * explicit id still wins, and identity — workspace, principal, caller — is
     * always the admitting caller's, never the checkpoint's.
     */
    // Read once for a non-resume admission: the persona it carries and the
    // rollover it may need both come from it. A first turn has no checkpoint,
    // and a corrupt one must not fail the turn — what it would have given (the
    // persona, a rollover) is what is lost, never the task.
    const previousState =
      input.resume !== undefined
        ? undefined
        : await (input.priorState?.() ?? compiled.getState(config)).then(
            (state) => state,
            () => undefined,
          );
    const carriedContext = ((): InvocationContext => {
      if (input.resume !== undefined || input.context.agentDefinitionId !== undefined) return input.context;
      const checkpointed = (previousState?.values as { readonly invocation?: InvocationContext } | undefined)?.invocation;
      const agentDefinitionId = checkpointed?.agentDefinitionId;
      return agentDefinitionId === undefined ? input.context : { ...input.context, agentDefinitionId };
    })();

    /**
     * Whether the thread is still suspended on the interrupt this resume answers
     * ("settled but not committed").
     *
     * A resume admission that crashed after its checkpoint write and before its
     * commit is re-admitted under its key once its lease has ended — but its
     * thread has already moved past the interrupt: it finished, or suspended on
     * the *next* round. Resuming with the decision again would hand it to
     * whatever `interrupt()` runs next — the next round's call, when a provider
     * reuses call ids — which is exactly the hazard the round key exists to
     * prevent. Such a resume continues from the checkpoint instead: the thread
     * runs what it had left (or nothing), and a node suspended on the next round
     * suspends again, so the admission records where the thread actually is.
     * A state that cannot be read keeps the resume, as before.
     */
    const resumeApplies = input.resume !== undefined && (await resumeStillApplies(compiled, config, input.resume));

    const recoverCommittedInput =
      input.recoverPendingStart === true &&
      input.messages.length > 0 &&
      (await (async () => {
        const previous = await compiled.getState(config);
        const values = previous.values as { conversation?: readonly { id: string }[]; invocation?: InvocationContext };
        return (
          values.invocation?.workspaceId === input.context.workspaceId &&
          values.invocation.principalId === input.context.principalId &&
          input.messages.every((message) => values.conversation?.some((stored) => stored.id === message.id))
        );
      })());
    turnBaselines.set(input.threadId, {});
    const admittedMessages: WorkflowMessage[] = input.messages.map((message) => ({
      id: message.id,
      role: message.role,
      text: message.text,
      ...(message.label === undefined ? {} : { label: message.label }),
    }));
    /**
     * An epoch rollover as the admission joins: a chat that reached its
     * bound before rollovers existed — or that this admission's messages would
     * carry past the trigger — folds first, in the same write that adds them,
     * so it takes its next turn instead of failing. Only on a thread that is
     * not suspended: a pending interrupt refers to calls the fold could take,
     * so a rollover waits for the model node, once the thread is resumed.
     */
    /**
     * A rewind as the admission joins: the chat's conversation goes
     * back to before the rewound turn's messages, with a note in their place,
     * and this admission's join after. It only shrinks the conversation, so
     * no rollover is planned alongside it.
     */
    const admissionRewind =
      recoverCommittedInput || previousState === undefined || pendingInterruptOf(previousState) !== undefined
        ? undefined
        : await (async (): Promise<ConversationFold | undefined> => {
            const marker = await rewindMarker(input.context.runId);
            if (marker === undefined) return undefined;
            const conversation =
              (previousState.values as { readonly conversation?: readonly WorkflowMessage[] } | undefined)?.conversation ?? [];
            const at = rewoundFrom(conversation, marker);
            // All folded into an epoch summary already: there is nothing left to cut, and the hold is cleared at the turn's end.
            if (at < 0) return undefined;
            return {
              removeIds: conversation.slice(at).map((message) => message.id),
              summary: { id: REWIND_NOTE_ID, role: "system", text: REWIND_NOTE },
              append: admittedMessages,
            };
          })();
    const admissionRollover =
      admissionRewind !== undefined || recoverCommittedInput || previousState === undefined
        ? undefined
        : await (async (): Promise<ConversationFold | undefined> => {
            const conversation =
              (previousState.values as { readonly conversation?: readonly WorkflowMessage[] } | undefined)?.conversation ?? [];
            if (conversation.length === 0 || pendingInterruptOf(previousState) !== undefined) return undefined;
            // Fresh context: a person asked for this message to start a new epoch, whatever the chat's length.
            const fresh = admittedMessages.some((message) => message.role === "user") && (await takeFreshContext(input.context.runId));
            const plan = planEpochRollover([...conversation, ...admittedMessages], {
              triggerAt: fresh ? 0 : epochRolloverMessages,
              keepRecent: fresh ? 0 : compactionKeepRecentMessages,
            });
            if (plan === undefined) return undefined;
            // Folding only earlier summaries frees nothing (as `forceRollover` holds).
            const byId = new Map(conversation.map((message) => [message.id, message]));
            if (fresh && plan.removeIds.every((id) => isSummaryMessage(byId.get(id)))) return undefined;
            // The flush runs beside the archive, through the same dispatch checks as the
            // turn's calls, on the target the turn will use — the task's saved route, else the
            // first of the workspace's chain not cooling down (or the `extraction` role) — and is cut sooner: the person waits.
            const saved = await options.taskRouting
              ?.effectiveTarget?.({ workspaceId: input.context.workspaceId, principalId: input.context.principalId }, input.context.runId)
              .catch(() => undefined);
            const chain = await turnBaseline(input.threadId, input.context);
            const flushTarget =
              saved ??
              (await (async () => {
                for (const target of chain) if (!(await targetWaiting(target))) return target;
                return chain[0];
              })());
            if (flushTarget === undefined) throw new TaviError("NOT_CONFIGURED", "no model target is configured for this chat");
            const tainted =
              isUntrusted(inheritedLabelOf(input.context)) || conversationTainted(previousLabelState(previousState.values, conversation));
            const [, rollover] = await Promise.all([
              flushBeforeRollover(
                authorizeModels(carriedContext, config),
                flushTarget,
                carriedContext,
                conversation,
                plan.removeIds,
                tainted,
                invokeOptions?.signal,
                ADMISSION_FLUSH_TIMEOUT_MS,
              ),
              epochSummaryUntrusted(input.context.runId).then(async (untrusted) =>
                labelledFold(
                  await buildEpochRolloverFold(
                    options.artifacts,
                    carriedContext,
                    conversation,
                    plan.removeIds,
                    newId,
                    now,
                    admittedMessages,
                    { untrusted, label: spanLabel(conversation, plan.removeIds, previousLabelState(previousState.values, conversation)) },
                  ),
                  conversation,
                  previousLabelState(previousState.values, conversation),
                ),
              ),
            ]);
            if (rollover !== undefined) await epochRolledOver(input.context.runId, rollover);
            return rollover;
          })().catch((error: unknown) => {
            // Not yet inside the graph's `finally`: the turn's entry goes with the failed admission.
            turnBaselines.delete(input.threadId);
            throw error;
          });
    // A message admitted while the thread is suspended (an approval, a question, a browser handoff) moves past it:
    // the calls it held are answered as not run, before the message, and are no longer pending.
    const superseded =
      recoverCommittedInput || input.resume !== undefined || previousState === undefined || pendingInterruptOf(previousState) === undefined
        ? []
        : supersededCallResults(previousState.values);
    const graphInput = recoverCommittedInput
      ? null
      : input.resume === undefined
        ? {
            stateVersion: 1 as const,
            runId: input.context.runId,
            invocation: carriedContext,
            phase: "running" as const,
            // A new admission is a new turn, prompted or not — an agent
            // wake, a message with no text: the guards count it from nothing.
            // A resume (a decision, an answer) keeps the turn it resumes.
            turnSteps: 0,
            turnToolCalls: 0,
            // Its steers are its own: the cap counts from none.
            turnSteers: [],
            // A rollover here begins a new epoch, and a rewind takes turns back: the discovered and routed tools go with them.
            ...(admissionRollover === undefined && admissionRewind === undefined ? {} : { discoveredToolIds: [], routedToolIds: [] }),
            conversation: admissionRewind ?? admissionRollover ?? [...superseded, ...admittedMessages],
            ...(superseded.length === 0 ? {} : { pendingToolCalls: [], denials: {} }),
            // A rollover here folds what it was read from before any node sees it, and a side
            // chat's background is untrusted from its first step: either is kept in the flag.
            // So is a worker spawned from a tainted conversation.
            // A worker knows what its spawner knew, never what its prompt names.
            // An inbound block's URLs are known as a tool result's are: it is untrusted quoted
            // content, not the person's message — and a URL the model wrote first never becomes known by it.
            ...(() => {
              const known = [...(input.context.inheritedKnownUrls ?? []), ...inboundUrlKeys(admittedMessages, previousState?.values)];
              return known.length === 0 ? {} : { knownUrls: known };
            })(),
            ...(input.carriedModelUrls === undefined || input.carriedModelUrls.length === 0 ? {} : { modelUrls: input.carriedModelUrls }),
            // Their labels join the context label, with what the caller handed on (`inheritedLabel`).
            ...(() => {
              const previous =
                (previousState?.values as { readonly conversation?: readonly WorkflowMessage[] } | undefined)?.conversation ?? [];
              const label = joinLabels(
                joinLabels(
                  inheritedLabelOf(input.context),
                  admissionRollover === undefined ? TRUSTED_PUBLIC : contextLabelOf(previousLabelState(previousState?.values, previous)),
                ),
                labelOf(admittedMessages),
              );
              return isTrustedPublic(label) ? {} : { contextLabel: label };
            })(),
          }
        : resumeApplies
          ? new Command({ resume: input.resume })
          : null;

    // `graph.invoke` accepts a state update, a resume Command, or `null` —
    // continue from the checkpoint; the overloads disagree on the input type,
    // so the union is narrowed here.
    observers.set(input.threadId, invokeOptions ?? {});
    if (options.turnFolder !== undefined) {
      admittedFolders.set(input.threadId, {
        ...(input.context.folder === undefined ? {} : { folder: input.context.folder }),
        ...(input.context.folderUnavailable === undefined ? {} : { folderUnavailable: input.context.folderUnavailable }),
      });
    }
    compactionFailures.delete(input.threadId);
    let result: unknown;
    try {
      // Ensure/bind/validate the task's selected base *before* the graph runs,
      // and inside this error boundary so a refusal becomes the normal failed
      // outcome and the execution lease is still released by the caller's
      // `finally`. A model-node read alone is not enough: a resume can execute
      // tools (an effect) before any model call happens, and a missing snapshot
      // must stop that rather than surface afterwards. Recorded-outcome
      // replay and cancellation short-circuit before this call, so their
      // existing behavior is unchanged.
      //
      // This is intentionally the same `selectedPromptSnapshot` the model node calls
      // per turn, not a
      // cache: consolidating the two would move the corruption check inside the
      // graph, where a resumed effect can already have run. See its own comment
      // for the three-case contract.
      await selectedPromptSnapshot(input.context.runId, input.context.workspaceId, invokeOptions?.executionLease?.admissionId);
      result = await invokeGraph(compiled, graphInput, config);
    } catch (error) {
      const taviError = TaviError.from(error, "MODEL_FAILED");
      const code = graphFailureCode(error, invokeOptions?.signal);
      if (code === "STOPPED") return STOPPED_TURN;
      return {
        status: "failed",
        finalText: taviError.message,
        error: { code, message: taviError.message },
      };
    } finally {
      observers.delete(input.threadId);
      admittedFolders.delete(input.threadId);
      turnBaselines.delete(input.threadId);
    }

    if (isInterrupted(result)) {
      const payloads = extractInterrupts(result);
      // Three interrupt kinds share this one suspension point: an approval
      // request (`approveNode`), a wait request (`toolsNode`'s
      // `agents.wait` branch), and an artifact-review request
      // (`reviewNode`). All three are structurally
      // distinct siblings, never variants of one another,
      // and a single
      // checkpoint never has more than one pending at once, so trying each
      // shape in turn is unambiguous rather than a guess. Review is tried
      // first only because its required fields (`artifactId`, no
      // `summary`/`input`) are the most structurally distinct from the
      // other two, making a false-positive parse the least likely of any
      // ordering — not because it is more common.
      const reviewParsed = ReviewRequestListSchema.safeParse(payloads[0]);
      if (reviewParsed.success) {
        const reviewInterruptPayload: WorkflowReviewInterrupt = { requests: reviewParsed.data.requests };
        return { status: "waiting", finalText: "", reviewInterrupt: reviewInterruptPayload };
      }
      const waitParsed = WorkflowWaitRequestSchema.safeParse(payloads[0]);
      if (waitParsed.success) {
        const wait: WorkflowWaitRequest = {
          waitId: waitParsed.data.waitId,
          deadlineAt: waitParsed.data.deadlineAt,
          ...definedOnly({
            correlationId: waitParsed.data.correlationId,
            waitingOnWorkerTaskId: waitParsed.data.waitingOnWorkerTaskId,
            handoff: waitParsed.data.handoff,
            connect: waitParsed.data.connect,
          }),
        };
        // Carried through so a client attaching after the question was asked can
        // still show what is being asked.
        const waitInterruptPayload: WorkflowWaitInterrupt = {
          wait,
          ...definedOnly({
            question: waitParsed.data.question,
            context: waitParsed.data.context,
            choices: waitParsed.data.choices,
            handoff: waitParsed.data.handoff,
            connect: waitParsed.data.connect,
          }),
        };
        return { status: "waiting", finalText: "", waitInterrupt: waitInterruptPayload };
      }
      const parsed = ApprovalRequestSchema.safeParse(payloads[0]);
      if (!parsed.success) {
        // None of the three known shapes matched. Falling
        // through to an empty `interrupt: { requests: [] }` — a
        // "waiting" outcome with nothing to decide and no way to
        // resume it — would wedge the task permanently. Fail
        // loudly instead: an unrecognized interrupt payload is a real
        // defect, not a state a caller should be asked to silently
        // accept and never be able to resolve.
        const message = "Interrupted with a payload that matched no known suspension shape (approval, wait, or review)";
        return { status: "failed", finalText: message, error: { code: "INTERNAL", message } };
      }
      const interruptPayload: WorkflowInterrupt = {
        requests: parsed.data.requests.map((entry) => ({
          callId: entry.callId,
          toolName: entry.toolName,
          summary: entry.summary,
          input: entry.input,
          // The raised effect the request carries, else the tool's own.
          effect: entry.effect ?? effectOf(options.tools, entry.toolName),
          ...definedOnly({
            risk: entry.risk,
            display: entry.display,
            allowedScopes: entry.allowedScopes,
            subjects: entry.subjects,
            scopeGroup: entry.scopeGroup,
            tainted: entry.tainted,
            askWhenTainted: entry.askWhenTainted,
            attendedOnly: entry.attendedOnly,
            gateReason: entry.gateReason,
            provenance: entry.provenance,
          }),
          // Carried through from the interrupt payload so the waiting admission's
          // durable outcome records the round: a resumed turn re-reads it
          // to refuse a decision meant for a superseded round.
          steps: entry.steps,
        })),
      };
      return { status: "waiting", finalText: "", interrupt: interruptPayload };
    }

    const state = parseAgentState(result);
    if (state.phase !== "failed") {
      const channelReply = await channelReplyOf(state);
      return { status: "completed", finalText: state.finalText, ...(channelReply === undefined ? {} : { channelReply }) };
    }
    // The caller's signal fired: `tavi abort`, Ctrl-C, or a service manager's
    // SIGTERM stopped this turn. The nodes report it as an ordinary
    // failed phase, so it is classified here, where the signal is still in hand —
    // otherwise an abort is indistinguishable from a provider failure, and
    // `MODEL_FAILED` invites a retry nobody asked for.
    if (invokeOptions?.signal?.aborted === true) {
      return abortCode(invokeOptions.signal) === "STOPPED"
        ? STOPPED_TURN
        : { status: "failed", finalText: state.finalText, error: { code: "ABORTED", message: state.finalText } };
    }
    // A cancel recorded without aborting the turn (`tavi cancel`, `agents.cancel`, a routine's cancel, a
    // conversation's reset) ends it at the next node as failed: it is a cancel, not a model failure.
    const cancelled = await options.cancellations.get(input.context.runId).catch((error: unknown) => {
      options.onDiagnostic?.("a failed turn's cancellation could not be read; it is reported as failed", {
        taskId: input.context.runId,
        reason: errorMessage(error),
      });
      return undefined;
    });
    if (cancelled !== undefined)
      return { status: "failed", finalText: state.finalText, error: { code: "CANCELLED", message: state.finalText } };
    return { status: "failed", finalText: state.finalText, error: { code: "MODEL_FAILED", message: state.finalText } };
  }
  return runInvocation;
}
