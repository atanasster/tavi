import { errorMessage } from "@tavi/contracts/util";
import { combineFolds } from "../../compaction.js";
import { withoutMemoryBlocks, shownRevisionIds, showedForgotten, showsUnverifiable } from "../../context-block.js";
import { isSummaryMessage, planEpochRollover, buildEpochRolloverFold } from "../../epoch.js";
import { mergeConversation } from "../../state.js";
import { type ModelStep, targetAt, firstReady } from "./context.js";

/** The step's folds before its messages are built: forgotten memory left out, and an epoch rollover. */
export async function foldBeforeCall(step: ModelStep): Promise<void> {
  const { current, newTurn, layout } = step;
  const {
    compactionKeepRecentMessages,
    epochRolledOver,
    epochRolloverMessages,
    epochSummaryUntrusted,
    labelledFold,
    newId,
    now,
    options,
    spanLabel,
  } = step.scope;
  // Fold before building this call's messages, so archived-away content
  // never reaches the model the step it's folded. No stage-1 fold runs
  // here any more (see the fold defaults): an epoch rollover
  // keeps the conversation clear of its bound — everything before
  // the recent tail, the person's requests and earlier summaries too
  // (stage-1 `[compaction]` summaries from older checkpoints included),
  // becomes one epoch summary. A call without its result keeps its message
  // (a pair is folded whole or not at all), so a round that still holds it
  // keeps it.
  if (layout === "v2" && options.forgottenMemory !== undefined) {
    const shownIds = shownRevisionIds(step.conversationForThisCall);
    if (shownIds.length > 0 || showsUnverifiable(step.conversationForThisCall)) {
      try {
        const forgotten =
          shownIds.length === 0 ? new Set<string>() : await options.forgottenMemory(current.invocation.workspaceId, shownIds);
        const before = step.conversationForThisCall;
        // A block whose preference names no revision (written before they did) is dropped as if forgotten.
        const view = withoutMemoryBlocks(before, showedForgotten(forgotten));
        if (view !== before) {
          step.conversationForThisCall = [...view];
          step.forgottenPersons = step.conversationForThisCall.filter((message, index) => message !== before[index]);
        }
      } catch (error) {
        // What is still in force cannot be told: no kept block that showed memory is sent this call
        // (nothing is written back), rather than one that may hold a forgotten record.
        step.memoryCheckFailed = true;
        step.conversationForThisCall = [...withoutMemoryBlocks(step.conversationForThisCall, true)];
        options.onDiagnostic?.("whether a chat's shown memories were forgotten could not be read; its memory blocks are left out", {
          taskId: current.runId,
          error: errorMessage(error),
        });
      }
    }
  }
  const rolloverPlan = planEpochRollover(step.conversationForThisCall, {
    triggerAt: epochRolloverMessages,
    keepRecent: compactionKeepRecentMessages,
  });
  if (rolloverPlan !== undefined) {
    step.pendingFlush = { conversation: step.conversationForThisCall, removeIds: rolloverPlan.removeIds };
    const rollover = labelledFold(
      await buildEpochRolloverFold(
        options.artifacts,
        current.invocation,
        step.conversationForThisCall,
        rolloverPlan.removeIds,
        newId,
        now,
        [],
        {
          untrusted: await epochSummaryUntrusted(current.runId),
          label: spanLabel(step.conversationForThisCall, rolloverPlan.removeIds, current),
        },
      ),
      step.conversationForThisCall,
      current,
    );
    if (rollover !== undefined) {
      step.fold = combineFolds(step.fold, rollover);
      step.conversationForThisCall = mergeConversation(step.conversationForThisCall, rollover);
      step.epochBegins = newTurn;
      await epochRolledOver(current.runId, rollover);
    }
  }
}

/**
 * Fold everything before the recent tail into an epoch summary now,
 * whatever the trigger: what the pre-call check and a provider's
 * context-overflow refusal both fall back to. False when nothing could be
 * folded.
 */
export async function forceRollover(step: ModelStep): Promise<boolean> {
  const { config, admission, authorizedModels, current } = step;
  const {
    compactionKeepRecentMessages,
    conversationTainted,
    epochRolledOver,
    epochSummaryUntrusted,
    flushBeforeRollover,
    labelledFold,
    newId,
    now,
    options,
    spanLabel,
  } = step.scope;
  const plan = planEpochRollover(step.conversationForThisCall, { triggerAt: 0, keepRecent: compactionKeepRecentMessages });
  // Folding only earlier summaries frees nothing: a new epoch every step would follow.
  const byId = new Map(step.conversationForThisCall.map((message) => [message.id, message]));
  if (plan !== undefined && plan.removeIds.every((id) => isSummaryMessage(byId.get(id)))) return false;
  if (plan !== undefined)
    await flushBeforeRollover(
      authorizedModels,
      targetAt(step, await firstReady(step)),
      current.invocation,
      step.conversationForThisCall,
      plan.removeIds,
      conversationTainted(current),
      admission?.signal ?? config?.signal,
    );
  const rollover =
    plan === undefined
      ? undefined
      : labelledFold(
          await buildEpochRolloverFold(
            options.artifacts,
            current.invocation,
            step.conversationForThisCall,
            plan.removeIds,
            newId,
            now,
            [],
            {
              untrusted: await epochSummaryUntrusted(current.runId),
              label: spanLabel(step.conversationForThisCall, plan.removeIds, current),
            },
          ),
          step.conversationForThisCall,
          current,
        );
  if (rollover === undefined) return false;
  step.fold = combineFolds(step.fold, rollover);
  step.conversationForThisCall = mergeConversation(step.conversationForThisCall, rollover);
  await epochRolledOver(current.runId, rollover);
  return true;
}
