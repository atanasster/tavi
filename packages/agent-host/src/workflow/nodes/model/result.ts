import { isPersonMessage, isTrustedPublic, type ConversationUpdate, type WorkflowMessage } from "@tavi/contracts";
import { errorMessage } from "@tavi/contracts/util";
import { executionLeaseOf, assertLeaseCurrent } from "../../run-config.js";
import { cacheModelKey, type ModelCall, targetAt } from "./context.js";
import type { CallOutcome } from "./call.js";
import type { WorkflowUpdate } from "../../state.js";

/** A final step's answer when the model returned no text: the turn still ends, and says how to go on. */
const FINAL_STEP_FALLBACK = "This turn ran out of steps before an answer was written. Continue the task to go on from what was gathered.";

/** The step's result: its conversation update, the turn's tool state, the memory it used, and its answer or calls. */
export async function stepResult(ctx: ModelCall, called: CallOutcome): Promise<WorkflowUpdate> {
  const { step, finalStep, documentFound, discoveredNow, routedNow, turnPerson } = ctx;
  const { outcome, targetIndex, failedOver, signal } = called;
  const { config, admission, steerMessages, current, facts, newTurn, layout, turnAdvance } = step;
  const { contextLabelOf, gateVerdictsOf, isFailoverCode, now, options, toolContextOf, urlChannelUpdates } = step.scope;
  // The node result is checkpointed after this point, so re-check ownership:
  // the model call awaited, and this generation may have been superseded.
  await assertLeaseCurrent(options, config);

  // A fold present this turn must still land in the checkpointed state
  // even though the channel can only be written once per node per step —
  // `fold.append` carries this turn's new message(s) so one write does
  // both (see `mergeConversation`'s fold path).
  // The steers merged this step are written with it, before its answer.
  // The block this call wrote, kept on the turn's person message (updated in place, by id) so every later call
  // sends the same bytes; never onto a message this step's fold took away.
  const personNow = turnPerson === undefined ? undefined : step.conversationForThisCall.find((message) => message.id === turnPerson.id);
  const keptPerson: WorkflowMessage | undefined =
    personNow === undefined || ctx.sentDelta === undefined
      ? undefined
      : {
          ...personNow,
          contextText: ctx.sentDelta.text,
          contextShown: [...ctx.sentDelta.shown],
          ...(ctx.sentDelta.sensitive ? { sensitivity: "sensitive" as const } : {}),
        };
  // Only messages this step leaves in the conversation: one a rollover took away is not written back.
  const stillHeld = (message: WorkflowMessage): boolean => step.conversationForThisCall.some((held) => held.id === message.id);
  /**
   * The step's conversation update. `keepContext`: whether the block this call wrote is kept on the person
   * message — not after a failed call, so the next call writes it again and records the memory it shows, and
   * not after a failed forgotten check (`memoryCheckFailed`), whose block was built without the dropped ones.
   */
  const conversationUpdate = (append: readonly WorkflowMessage[], keepContext = true): ConversationUpdate => {
    const kept = keepContext && !step.memoryCheckFailed ? keptPerson : undefined;
    const steers = steerMessages.map((message) => (message.id === kept?.id ? kept : message));
    const keptHere = kept === undefined || steerMessages.some((message) => message.id === kept.id) ? [] : [kept];
    const written = new Set([...step.foldedPersons.map((message) => message.id), ...keptHere.map((message) => message.id)]);
    const persons = [
      ...step.foldedPersons.filter(stillHeld),
      // A block cleared for a forgotten memory is written back, so the checkpoint keeps no copy of it.
      ...step.forgottenPersons.filter(
        (message) => stillHeld(message) && !written.has(message.id) && !steerMessages.some((steer) => steer.id === message.id),
      ),
      ...keptHere,
    ];
    return step.fold === undefined
      ? [...steers, ...persons, ...append]
      : { ...step.fold, append: [...step.fold.append, ...steers, ...persons, ...append] };
  };
  // What the step writes of the offered tools' state: under `v2` the epoch's discovered and routed tools
  // (both cleared when this turn begins a new epoch; the routed ones as this call offered them), under
  // `v1` a turn's discoveries cleared when a turn begins.
  const toolState =
    layout === "v2"
      ? {
          ...(step.epochBegins ? { discoveredToolIds: [], routedToolIds: [] } : {}),
          // The document tools a mention brought in are kept as found, so a later search appends after them.
          ...(documentFound.length === 0 ? {} : { discoveredToolIds: [...discoveredNow] }),
          ...(routedNow === undefined ? {} : { routedToolIds: [...routedNow] }),
        }
      : newTurn
        ? { discoveredToolIds: [] }
        : {};
  // A call the provider served from its prompt cache: the task's later folds wait for the cached cap.
  const servedBy = cacheModelKey(targetAt(step, targetIndex));
  const cacheReadState =
    (outcome.usage.inputCacheReadTokens ?? 0) > 0 && current.promptCacheModel !== servedBy ? { promptCacheModel: servedBy } : {};
  // Under `v2` the records this call was given are the ones its block showed as retrieved evidence for the first time
  // (`systemPromptResult.memory` holds `manifest.evidence`, so a profile entry counts only when it also matched the turn's query).
  const usedMemory =
    turnPerson === undefined
      ? ctx.systemPromptResult.memory
      : ctx.systemPromptResult.memory.filter((used) => ctx.sentDelta?.shown.includes(`memory:${used.revisionId}`) === true);

  // The memories the answered call was given, for the chat's "Used here" —
  // once per call, after its last attempt, and not for a call that
  // failed or was cancelled. Best-effort, as skill attribution is.
  const memoryTurn = executionLeaseOf(config)?.admissionId;
  // A delegated worker records no use of its own: it is no chat, and its delegated ids are its spawner's.
  const workerTurn =
    current.invocation.memoryScopeRestricted === true ||
    (current.invocation.chatTaskId !== undefined && current.invocation.chatTaskId !== current.runId);
  if (
    outcome.status !== "failed" &&
    outcome.status !== "aborted" &&
    !workerTurn &&
    options.memoryUse !== undefined &&
    memoryTurn !== undefined &&
    usedMemory.length > 0
  ) {
    try {
      await options.memoryUse.record({
        taskId: current.runId,
        admissionId: memoryTurn,
        recordIds: usedMemory.map((used) => used.recordId),
        at: now(),
      });
    } catch {
      // Noting what was used never fails the model call.
    }
  }
  // And for this answer's own record: the revisions it was given and the preferences that applied,
  // kept with the saved turn. A delegated worker records none of its own.
  if (
    outcome.status !== "failed" &&
    outcome.status !== "aborted" &&
    !workerTurn &&
    (usedMemory.length > 0 || ctx.systemPromptResult.preferences > 0)
  ) {
    try {
      admission?.onMemoryUsed?.({ records: usedMemory, preferences: ctx.systemPromptResult.preferences });
    } catch (error) {
      options.onDiagnostic?.("an admission's onMemoryUsed observer threw; the turn continues", {
        taskId: current.runId,
        reason: errorMessage(error),
      });
    }
  }

  // The model's words carry what it read: stamped with the context label, so a later fold of them carries it.
  const wordsLabel = contextLabelOf(current);
  const labelled = isTrustedPublic(wordsLabel) ? {} : { label: wordsLabel };
  if (outcome.status === "failed" || outcome.status === "aborted") {
    const failed = outcome.error;
    // An abort that lands after a failed attempt is the cancellation it is,
    // not the provider's error; a chain that failed over and then failed for
    // another reason names what it failed over from, which is the cause.
    const finalText = signal.aborted
      ? "The run was cancelled during the model call."
      : `${failed?.message ?? "Model call failed"}${failedOver.length === 0 ? "" : ` (after failing over from ${failedOver.join("; ")})`}` +
        // Retrying a billing failure cannot succeed until the operator acts; say so.
        (failed?.code === "quota_exceeded"
          ? " — the provider's billing or credit limit is reached: raise the limit or top up the account, or pick another model."
          : "");
    return {
      conversation: conversationUpdate(
        [
          {
            id: `assistant-${ctx.attemptId}`,
            role: "assistant" as const,
            // A rate-limited or faulted call's partial output is no answer,
            // whether or not a target remained to fail over to.
            text: failed !== undefined && isFailoverCode(failed.code) ? "" : outcome.text,
            ...labelled,
          },
        ],
        false,
      ),
      steps: 1,
      ...turnAdvance,
      // The epoch's tool state as the step leaves it, a new epoch's reset included (`v1` keeps its own as before).
      ...(layout === "v2" ? toolState : {}),
      ...cacheReadState,
      // The fold above applies on this path too.
      contextLabel: contextLabelOf(current),
      phase: "failed" as const,
      finalText,
    };
  }

  const assistantId = `assistant-${ctx.attemptId}`;
  // A declined turn: its person messages (every one since the last answer or tool result, steers included)
  // and its notice are marked, so later calls are asked without them; the history keeps both.
  const declined = called.declined === true ? ({ declined: true } as const) : {};
  const declinedPersons =
    called.declined === true
      ? declinedTurnPersons([...step.conversationForThisCall, ...steerMessages]).map((message) => ({
          ...(message.id === keptPerson?.id ? keptPerson : message),
          declined: true as const,
        }))
      : [];
  // The context this call was shown: the per-call block, or under `v2` its turn's block.
  const shownContext = turnPerson === undefined ? ctx.systemPromptResult.context : (ctx.sentDelta?.text ?? turnPerson.contextText ?? "");
  // A call a final step returns — offered no tools under `v1`, told a call is not run under `v2` — is dropped,
  // not dispatched, so the turn ends with its answer rather than at the guard.
  const calls = finalStep ? [] : outcome.toolCalls;
  const answer = finalStep && outcome.text.trim() === "" ? FINAL_STEP_FALLBACK : outcome.text;
  // The browser pages this generation's calls type into, collected as the gate assesses them.
  const typedInto = new Set<string>();

  return {
    // The tool calls live on the assistant message that requested them: a
    // provider rejects a tool result whose id is not introduced by the
    // preceding assistant turn.
    conversation: conversationUpdate([
      {
        id: assistantId,
        role: "assistant" as const,
        text: answer,
        ...labelled,
        ...declined,
        // A native Anthropic connection's thinking, sent back with the step's tool results and kept as sent after.
        ...(outcome.reasoning === undefined ? {} : { reasoning: outcome.reasoning }),
        ...(calls.length === 0
          ? {}
          : {
              toolCalls: calls.map((call) => ({
                id: call.id,
                name: call.name,
                input: call.input,
              })),
            }),
      },
      ...declinedPersons,
    ]),
    steps: 1,
    ...turnAdvance,
    pendingToolAttemptId: ctx.attemptId,
    toolDisclosureRequired: ctx.toolDisclosureRequired,
    ...toolState,
    ...cacheReadState,
    pendingToolCalls: calls.map((call) => ({
      id: call.id,
      name: call.name,
      input: call.input,
    })),
    // Decided now and checkpointed with the calls, so a rule or grant created
    // while their round waits cannot change what the round gates.
    // Assessed in the folder this admission resolved, where the calls will run.
    gateVerdicts: await gateVerdictsOf(
      current,
      calls,
      signal,
      toolContextOf(current.invocation, config),
      `${ctx.systemPromptText}\n${shownContext}`,
      typedInto,
      facts.origin,
    ),
    // The pages its calls type into, read as the gate read them.
    ...(typedInto.size === 0 ? {} : { typedPages: [...typedInto] }),
    // Recorded before this node's fold removes the tool messages it was read from.
    contextLabel: contextLabelOf(current),
    // And the URLs they and the person's messages hold, for the same reason.
    // The URLs this generation wrote that nothing made known first: no tool result that echoes one makes it known.
    ...(await urlChannelUpdates(current, answer, calls, `${ctx.systemPromptText}\n${shownContext}`, facts.origin)),
    phase: calls.length > 0 ? ("running" as const) : ("completed" as const),
    finalText: calls.length > 0 ? "" : answer,
  };
}

/** The person messages of the turn being answered: every one after the conversation's last assistant or tool message, by id. */
function declinedTurnPersons(conversation: readonly WorkflowMessage[]): WorkflowMessage[] {
  const byId = new Map<string, WorkflowMessage>();
  for (const message of conversation) {
    if (message.role === "assistant" || message.role === "tool") byId.clear();
    else if (isPersonMessage(message)) byId.set(message.id, message);
  }
  return [...byId.values()];
}
