import type { WorkflowMessage } from "@tavi/contracts";
import { defaultEstimateTokens } from "../../../context/context.js";
import { TOOL_SEARCH_ID, toolSearchDescriptor } from "../../../tools/tool-routing.js";
import {
  DEFAULT_COMPACTION_MODEL_TRIGGER_TOKENS,
  COMPACTION_WINDOW_FRACTION,
  CONTEXT_WINDOW_HARD_FRACTION,
  KEEP_RECENT_WINDOW_FRACTION,
  KEEP_RECENT_MIN_TOKENS,
  KEEP_RECENT_MAX_TOKENS,
  COMPACTION_FOLD_TARGET_FRACTION,
  COMPACTION_SUMMARY_HEAD_TOKENS,
  COMPACTION_CIRCUIT_BREAKER_THRESHOLD,
  estimateMessageTokens,
  planModelSummaryFold,
  combineFolds,
} from "../../compaction.js";
import { contextBlockText, personsBehindFold, turnContextDelta } from "../../context-block.js";
import { jsonSchemaOf } from "../../dispatch.js";
import { EPOCH_MARKER_PATTERN } from "../../epoch.js";
import { DEFAULT_COMPACTION_SUMMARY_MAX_OUTPUT_TOKENS, createModelSummarizer, buildModelSummaryFold } from "../../model-summary.js";
import { threadIdOf } from "../../run-config.js";
import { mergeConversation } from "../../state.js";
import { cacheModelKey, unknownWindowTriggerFor, type ModelCall, targetAt, firstReady, callView } from "./context.js";
import { forceRollover } from "./fold.js";

/** Stage 2 and the pre-call check: the conversation folded under token pressure before the call is sent. */
export async function foldUnderPressure(ctx: ModelCall): Promise<void> {
  const { step, offeredTools, turnPerson, contextKept, turnChannels, stepFacts } = ctx;
  const { config, admission, authorizedModels, current, layout } = step;
  const {
    backgroundTarget,
    compactionFailures,
    compactionKeepRecentMessages,
    compactionMaxContextTokens,
    compactionCachedMaxContextTokens,
    compactionModelTriggerTokens,
    compactionSummaryPrompt,
    contextWindowFor,
    envelopeOfMessage,
    labelledFold,
    newId,
    now,
    options,
    spanLabel,
  } = step.scope;
  // Stage 2 (only under remaining pressure may a budgeted
  // model summarize eligible history): token pressure can arrive with far
  // fewer, much larger messages than the rollover's message count. Gated
  // by its own per-admission circuit breaker so a repeatedly failing
  // summarizer degrades to the rollover alone (by message count, and at
  // 85% of a known window below) for the rest of this admission rather
  // than retrying every turn.
  const threadId = threadIdOf(config);
  // The window of the model this call starts on: stage 2's trigger,
  // the verbatim tail and the pre-call check follow it when it is known.
  const startTarget = targetAt(step, await firstReady(step));
  const contextWindow = await contextWindowFor(startTarget);
  // The context block's manifest counts here as the system prompt's tail used to; the
  // epoch summaries it carries are the conversation's, counted with it. So do the block's own framing
  // lines when it is sent, and the offered tool schemas, which ride in every request.
  // Under `v2` the block is in the conversation (`contextText`), counted with it, but for the one this call writes.
  const estimatedContext =
    turnPerson === undefined
      ? ctx.systemPromptResult.context
      : contextKept
        ? ""
        : (turnContextDelta(callView(ctx), turnPerson, ctx.systemPromptResult.manifest, ctx.systemPromptResult.context, turnChannels)
            ?.text ?? "");
  const blockSent =
    turnPerson === undefined
      ? ctx.systemPromptResult.context.trim() !== "" ||
        step.conversationForThisCall.some((message) => message.role === "system" && EPOCH_MARKER_PATTERN.test(message.text))
      : false;
  const toolSchemaText =
    offeredTools.length === 0
      ? ""
      : JSON.stringify(
          offeredTools.map((tool) => ({
            name: tool.id,
            description: tool.description,
            parameters: tool.id === TOOL_SEARCH_ID ? toolSearchDescriptor.inputJsonSchema : jsonSchemaOf(options.tools, tool.id),
          })),
        );
  const overheadTokens =
    defaultEstimateTokens(ctx.systemPromptText) +
    defaultEstimateTokens(estimatedContext) +
    defaultEstimateTokens(stepFacts) +
    (blockSent ? defaultEstimateTokens(contextBlockText("")) : 0) +
    defaultEstimateTokens(toolSchemaText);
  // A turn's stored block is sent only under `v2`: rolled back to `v1`, it is not part of what is sent.
  const sentForm = (view: readonly WorkflowMessage[]): readonly WorkflowMessage[] =>
    layout === "v2" ? view : view.map(({ contextText: _block, ...message }) => message);
  const conversationTokens = (view: readonly WorkflowMessage[]): number =>
    sentForm(view).reduce((sum, message) => sum + estimateMessageTokens(defaultEstimateTokens, message), 0);
  // With the system prompt and facts alone past the limit, folding the
  // conversation cannot bring the request under it: no hard limit then.
  const hardLimit = contextWindow === undefined ? undefined : Math.floor(contextWindow * CONTEXT_WINDOW_HARD_FRACTION) - overheadTokens;
  const hardLimitTokens = hardLimit !== undefined && hardLimit > 0 ? hardLimit : undefined;
  if (options.artifacts !== undefined && (compactionFailures.get(threadId) ?? 0) < COMPACTION_CIRCUIT_BREAKER_THRESHOLD) {
    // Measured as the model is sent it (older tool results shrunk, `compactSupersededObservations`); the
    // fold itself archives the checkpointed messages whole. Both views share
    // ids, except older summaries converted to `foldsum-<id>`, which are user
    // role and so never folded here. The system prompt and step facts are not the conversation's to
    // fold, so they count only toward the window's hard limit.
    const modelView = sentForm(callView(ctx));
    const triggerTokens =
      compactionModelTriggerTokens ??
      (contextWindow === undefined
        ? ((await unknownWindowTriggerFor(options, startTarget)) ?? DEFAULT_COMPACTION_MODEL_TRIGGER_TOKENS)
        : Math.min(
            Math.floor(contextWindow * COMPACTION_WINDOW_FRACTION),
            current.promptCacheModel === cacheModelKey(startTarget) ? compactionCachedMaxContextTokens : compactionMaxContextTokens,
          ));
    const tokenBudget = hardLimitTokens === undefined ? triggerTokens : Math.min(triggerTokens, hardLimitTokens);
    const currentTokens = conversationTokens(modelView);
    // Past the hard limit the rollover's 40-message tail may hold what only stage 2 can take: fold to the budget, no headroom required.
    const pastHardLimit = hardLimitTokens !== undefined && currentTokens > hardLimitTokens;
    const summaryPlan = planModelSummaryFold(modelView, {
      keepRecent: compactionKeepRecentMessages,
      ...(contextWindow === undefined
        ? {}
        : {
            keepRecentTokens: Math.min(
              KEEP_RECENT_MAX_TOKENS,
              Math.max(KEEP_RECENT_MIN_TOKENS, Math.floor(contextWindow * KEEP_RECENT_WINDOW_FRACTION)),
            ),
          }),
      tokenBudget,
      // Hysteresis: a fold leaves half the trigger as headroom, its own summary counted.
      ...(pastHardLimit
        ? {}
        : {
            targetTokens: Math.floor(tokenBudget * COMPACTION_FOLD_TARGET_FRACTION),
            summaryTokens: DEFAULT_COMPACTION_SUMMARY_MAX_OUTPUT_TOKENS + COMPACTION_SUMMARY_HEAD_TOKENS,
          }),
      currentTokens,
      estimateTokens: defaultEstimateTokens,
    });
    if (summaryPlan !== undefined) {
      // Not a target waiting out a `Retry-After`, as the turn's own call is not; on the
      // `compaction` role instead when the workspace binds one it may use.
      const own = targetAt(step, await firstReady(step));
      const role = await backgroundTarget("compaction", current.invocation, own);
      // The span was sized to the turn's window: a role whose known window is smaller cannot take it whole.
      const roleWindow = role.connectionId === own.connectionId && role.model === own.model ? undefined : await contextWindowFor(role);
      const removed = new Set(summaryPlan.removeIds);
      const spanTokens =
        conversationTokens(step.conversationForThisCall.filter((message) => removed.has(message.id))) +
        DEFAULT_COMPACTION_SUMMARY_MAX_OUTPUT_TOKENS;
      const summarizer = roleWindow !== undefined && roleWindow < spanTokens ? own : role;
      const summarize = createModelSummarizer(
        authorizedModels,
        summarizer.connectionId,
        summarizer.model,
        compactionSummaryPrompt,
        DEFAULT_COMPACTION_SUMMARY_MAX_OUTPUT_TOKENS,
        newId,
        now,
        current.invocation,
        admission?.signal ?? config?.signal,
        (message) => envelopeOfMessage(current.runId, message),
      );
      const stage2Fold = labelledFold(
        await buildModelSummaryFold(
          summarize,
          options.artifacts,
          current.invocation,
          step.conversationForThisCall,
          summaryPlan.removeIds,
          newId,
          now,
          spanLabel(step.conversationForThisCall, summaryPlan.removeIds, current),
        ),
        step.conversationForThisCall,
        current,
      );
      if (stage2Fold === undefined) {
        compactionFailures.set(threadId, (compactionFailures.get(threadId) ?? 0) + 1);
      } else {
        compactionFailures.set(threadId, 0);
        step.fold = combineFolds(step.fold, stage2Fold);
        if (turnPerson !== undefined)
          step.foldedPersons = personsBehindFold(step.conversationForThisCall, summaryPlan.removeIds, turnPerson.id);
        step.conversationForThisCall = mergeConversation(step.conversationForThisCall, stage2Fold);
      }
    }
  }
  // A request estimated past 85% of the window is folded before it is sent,
  // rather than left for the provider to refuse.
  if (hardLimitTokens !== undefined && conversationTokens(callView(ctx)) > hardLimitTokens) await forceRollover(step);
}
