import { type ModelPort, type ModelCallSite, MAX_MODEL_TOOLS, TaviError } from "@tavi/contracts";
import { errorMessage } from "@tavi/contracts/util";
import { TOOL_SEARCH_ID, toolRevision, toolSearchDescriptorFor } from "../../../tools/tool-routing.js";
import { jsonSchemaOf } from "../../dispatch.js";
import { threadIdOf, executionLeaseOf, assertLeaseCurrent } from "../../run-config.js";
import { originSite, turnStepSite, type ModelCall, targetAt, firstReady } from "./context.js";
import { forceRollover } from "./fold.js";
import { type ModelDispatch, callModel } from "./request.js";
import type { WorkflowUpdate } from "../../state.js";

/** How the call settled, for the step's result. */
export interface CallOutcome {
  readonly outcome: Awaited<ReturnType<ModelPort["stream"]>>;
  readonly targetIndex: number;
  readonly failedOver: readonly string[];
  readonly signal: AbortSignal;
  /** The model declined the turn (nothing, twice): its answer is `NO_ANSWER_NOTICE`, and the turn is kept out of later calls. */
  readonly declined?: true;
}

/**
 * The model call: its descriptors, then each attempt — retried once on an empty answer or a context overflow, failed
 * over along the chain — until one settles. `early` is the step's result when a cancellation stops it between attempts.
 */
export async function callWithFailover(ctx: ModelCall): Promise<{ readonly early: WorkflowUpdate } | CallOutcome> {
  const { step, finalStep, toolScope, offeredTools, toolCatalogFingerprint, toolConfigRevision, turnOrigin } = ctx;
  const { config, admission, current, layout, turnStepsSoFar } = step;
  const {
    authorizedTools,
    coolingUntil,
    isFailoverCode,
    newId,
    now,
    nowMs,
    observeHooks,
    observers,
    options,
    refreshLease,
    targetKey,
    turnTainted,
  } = step.scope;
  // A tool the task may not use is not offered, rather than offered and then
  // refused: the model cannot waste a turn on it, and no approval round is
  // raised for it. The same filtered set the facts were built from.
  ctx.descriptors = offeredTools.map((definition) => {
    if (definition.id === TOOL_SEARCH_ID) return toolSearchDescriptorFor(definition);
    const modelName = options.tools.modelNameOf(definition.id);
    if (modelName === undefined) {
      throw new TaviError("INTERNAL", `Tool ${definition.id} has no provider-safe name and cannot be offered to a model`);
    }
    return {
      id: definition.id,
      name: modelName,
      description: definition.description,
      inputJsonSchema: jsonSchemaOf(options.tools, definition.id),
    };
  });

  const signal = admission?.signal ?? config?.signal ?? new AbortController().signal;
  const outputCap = await options.maxOutputTokensFor?.(current.runId, current.invocation.workspaceId);
  // The ledger's site for this call: the adapter's own (a routine's), else the task's origin, else the call's place in its turn.
  const site: ModelCallSite = options.callSite ?? originSite(turnOrigin) ?? turnStepSite(finalStep, turnStepsSoFar);
  const cache = options.cacheFor?.(current.runId);
  let dispatch: ModelDispatch = { signal, outputCap, site, cache };

  // The conversation is tainted at this call — untrusted data read in this turn or any before it, or this
  // turn's notices block: the saved turn is marked, and automatic capture and auto-approve leave it out.
  // Told for any call, answered or not, and before it streams, with the URLs the conversation holds: the
  // canvas disarms a novel link in the words as they arrive.
  if (turnTainted(current)) {
    try {
      admission?.onUntrustedInput?.(current.knownUrls);
    } catch (error) {
      options.onDiagnostic?.("an admission's onUntrustedInput observer threw; the turn continues", {
        taskId: current.runId,
        reason: errorMessage(error),
      });
    }
  }
  let targetIndex = await firstReady(step);
  if (targetIndex > 0) {
    // Not announced as a failover — no attempt of this turn failed — but said:
    // this turn is answered by another model than the configured one.
    options.onDiagnostic?.("a model call starts past a target waiting out its Retry-After", {
      taskId: current.runId,
      skipped: step.modelChain.slice(0, targetIndex).map((target) => `${target.connectionId}/${target.model}`),
      target: `${targetAt(step, targetIndex).connectionId}/${targetAt(step, targetIndex).model}`,
    });
  }
  let outcome: Awaited<ReturnType<ModelPort["stream"]>>;
  /** The attempts of this turn that failed over, for a turn whose chain then fails for another reason. */
  const failedOver: string[] = [];
  /** Whether this call was already retried after a context-overflow refusal: once only. */
  let overflowRetried = false;
  let emptyRetried = false;
  /** Whether this call was already retried at what the key can afford: once only. */
  let affordRetried = false;
  for (;;) {
    const target = targetAt(step, targetIndex);
    if (ctx.contextIsCurrent !== undefined && !(await ctx.contextIsCurrent())) await ctx.refreshRoutedContext?.(true);
    if (ctx.contextIsCurrent !== undefined && !(await ctx.contextIsCurrent()))
      throw new TaviError("UNAVAILABLE", "Context authority or revisions changed before model dispatch; retry with fresh context");
    if (ctx.toolDisclosureRequired && options.routing !== undefined) {
      // Read afresh, as a guard: the baseline below, when routing turned off meanwhile, is this same read.
      const authorizedNow = await authorizedTools(current);
      const catalog = JSON.stringify(authorizedNow.map((tool) => [tool.id, toolRevision(options.tools, tool)]));
      if (catalog !== toolCatalogFingerprint)
        throw new TaviError(
          "UNAVAILABLE",
          "Tool authorization or definitions changed before model dispatch; retry with the current catalog",
        );
      const configuration = await options.routing.service.configuration(toolScope);
      if (configuration.revision !== toolConfigRevision) {
        if (configuration.settings.enabled && configuration.settings.modes.tools === "active")
          throw new TaviError("UNAVAILABLE", "Tool routing policy changed before dispatch");
        ctx.toolDisclosureRequired = false;
        const baseline = finalStep && layout !== "v2" ? [] : authorizedNow.filter((tool) => tool.id !== TOOL_SEARCH_ID);
        if (baseline.length > MAX_MODEL_TOOLS)
          throw new TaviError("INVALID_INPUT", `Baseline tools exceed the ${MAX_MODEL_TOOLS}-descriptor model contract`);
        ctx.descriptors = baseline.map((tool) => {
          const name = options.tools.modelNameOf(tool.id);
          if (name === undefined) throw new TaviError("INTERNAL", "Tool has no model name");
          return { id: tool.id, name, description: tool.description, inputJsonSchema: jsonSchemaOf(options.tools, tool.id) };
        });
      }
      if (ctx.toolDisclosureRequired) {
        const lease = executionLeaseOf(config);
        if (lease === undefined) throw new TaviError("UNAVAILABLE", "Tool disclosure requires a lease");
        await options.routing.repository.saveDisclosure(
          toolScope,
          { taskId: current.runId, generation: lease.generation, ownerSession: options.ownerSession },
          {
            taskId: current.runId,
            attemptId: ctx.attemptId,
            tools: offeredTools.map((tool) => ({ id: tool.id, revision: toolRevision(options.tools, tool) })),
            createdAt: now(),
          },
        );
      }
    }
    if (ctx.contextProjection !== undefined && options.routing !== undefined) {
      const lease = executionLeaseOf(config);
      if (lease === undefined) throw new TaviError("UNAVAILABLE", "Context projection requires a lease");
      await options.routing.repository.saveContextProjection(
        { workspaceId: current.invocation.workspaceId, principalId: current.invocation.principalId },
        { taskId: current.runId, generation: lease.generation, ownerSession: options.ownerSession },
        { ...ctx.contextProjection, taskId: current.runId, attemptId: ctx.attemptId, createdAt: now() },
      );
    }
    void observeHooks(
      "model.step",
      current.runId,
      current.invocation,
      (envelope) => ({ envelope, step: current.steps, model: target.model }),
      async () => undefined,
      signal,
    );
    outcome = await callModel(ctx, dispatch, target, ctx.attemptId);
    observers.get(threadIdOf(config))?.onModelEvent?.({
      type: "model.result",
      attemptId: ctx.attemptId,
      connectionId: target.connectionId,
      model: target.model,
      usage: outcome.usage,
    });
    // A call that answered nothing at all — no text, no call — is a provider's hiccup, not the turn's answer: once more.
    if (
      outcome.status === "completed" &&
      outcome.text.trim() === "" &&
      outcome.toolCalls.length === 0 &&
      !emptyRetried &&
      !signal.aborted
    ) {
      emptyRetried = true;
      await assertLeaseCurrent(options, config);
      const cancelled = await options.cancellations.get(current.runId);
      if (cancelled !== undefined) {
        return { early: { phase: "failed" as const, finalText: `Task was cancelled by ${cancelled.requestedBy}: ${cancelled.reason}` } };
      }
      await refreshLease(config);
      const supersededAttemptId = ctx.attemptId;
      ctx.attemptId = newId("attempt");
      observers.get(threadIdOf(config))?.onFailover?.({
        attemptId: ctx.attemptId,
        supersededAttemptId,
        from: target,
        to: target,
        errorCode: "provider",
        reason: `${target.connectionId}/${target.model} answered nothing — no text and no tool call; the same model is asked once more`,
      });
      continue;
    }
    if (outcome.status !== "failed" || signal.aborted) break;
    const error = outcome.error;
    // The key can pay for fewer output tokens than were asked for: ask the same model once more for no more than that.
    const affordable = error?.affordableTokens;
    if (affordable !== undefined && affordable < (dispatch.outputCap ?? Number.POSITIVE_INFINITY) && !affordRetried) {
      affordRetried = true;
      await assertLeaseCurrent(options, config);
      const cancelled = await options.cancellations.get(current.runId);
      if (cancelled !== undefined) {
        return { early: { phase: "failed" as const, finalText: `Task was cancelled by ${cancelled.requestedBy}: ${cancelled.reason}` } };
      }
      await refreshLease(config);
      dispatch = { ...dispatch, outputCap: affordable };
      const supersededAttemptId = ctx.attemptId;
      ctx.attemptId = newId("attempt");
      observers.get(threadIdOf(config))?.onFailover?.({
        attemptId: ctx.attemptId,
        supersededAttemptId,
        from: target,
        to: target,
        errorCode: error?.code ?? "quota_exceeded",
        reason: `${target.connectionId}/${target.model}'s key can pay for only ${affordable} output tokens; the same model is asked once more for no more than that`,
      });
      continue;
    }
    // Longer than the model's window: fold and ask the same model once more.
    if (error?.contextOverflow === true && !overflowRetried) {
      overflowRetried = true;
      if (await forceRollover(step)) {
        // Between attempts, as a failover checks: a lost lease or a
        // cancellation calls no further provider.
        await assertLeaseCurrent(options, config);
        const cancelled = await options.cancellations.get(current.runId);
        if (cancelled !== undefined) {
          return { early: { phase: "failed" as const, finalText: `Task was cancelled by ${cancelled.requestedBy}: ${cancelled.reason}` } };
        }
        await refreshLease(config);
        const supersededAttemptId = ctx.attemptId;
        ctx.attemptId = newId("attempt");
        observers.get(threadIdOf(config))?.onFailover?.({
          attemptId: ctx.attemptId,
          supersededAttemptId,
          from: target,
          to: target,
          errorCode: error.code,
          reason: `${target.connectionId}/${target.model} said the request is longer than its context window; the conversation was folded into an epoch summary and the same model answers`,
        });
        continue;
      }
    }
    if (error === undefined || !isFailoverCode(error.code)) break;
    if (options.routineAvailabilityFailover === true && (error.code === "model_retired" || error.code === "model_unavailable"))
      coolingUntil.set(targetKey(target), Infinity);
    if (error.retryAfterMs !== undefined) coolingUntil.set(targetKey(target), nowMs() + error.retryAfterMs);
    const next = await firstReady(step, targetIndex);
    if (next === -1) break;
    // Between attempts, as before the first: a generation that lost its
    // lease, or a task cancelled meanwhile, calls no further provider.
    await assertLeaseCurrent(options, config);
    const cancelled = await options.cancellations.get(current.runId);
    if (cancelled !== undefined) {
      return { early: { phase: "failed" as const, finalText: `Task was cancelled by ${cancelled.requestedBy}: ${cancelled.reason}` } };
    }
    await refreshLease(config);
    failedOver.push(`${target.connectionId}/${target.model}: ${error.code} (${error.message.slice(0, 200)})`);
    // A new attempt on the next target: announced before its first event,
    // and this attempt's partial output is not the conversation's.
    const supersededAttemptId = ctx.attemptId;
    ctx.attemptId = newId("attempt");
    const nextTarget = targetAt(step, next);
    observers.get(threadIdOf(config))?.onFailover?.({
      attemptId: ctx.attemptId,
      supersededAttemptId,
      from: target,
      to: nextTarget,
      errorCode: error.code,
      reason:
        `the model call failed over: ${target.connectionId}/${target.model} answered ${error.code}` +
        `${error.retryAfterMs === undefined ? "" : ` (retry after ${Math.ceil(error.retryAfterMs / 1000)}s)`}; ` +
        `${nextTarget.connectionId}/${nextTarget.model} answers, and the partial output is discarded`,
    });
    targetIndex = next;
    // Another connection is asked for the turn's own cap, not what one key could afford.
    dispatch = { ...dispatch, outputCap };
  }
  // Asked twice and still nothing, at a turn's first step: the model declined the message (a refusal streams no
  // text). Said in words, so a chat's reply is sent rather than nothing at all (Mac mini Telegram tests: a prompt
  // injection, and every message after it in that conversation, went unanswered).
  if (
    outcome.status === "completed" &&
    emptyRetried &&
    turnStepsSoFar === 0 &&
    outcome.text.trim() === "" &&
    outcome.toolCalls.length === 0 &&
    !signal.aborted
  )
    return { outcome: { ...outcome, text: NO_ANSWER_NOTICE }, targetIndex, failedOver, signal, declined: true };
  return { outcome, targetIndex, failedOver, signal };
}

/** A turn's answer when the model gave none, twice: what happened and what to do, never silence. */
export const NO_ANSWER_NOTICE =
  "I couldn't answer that: the model returned nothing, which usually means it declined the message. Rephrase it, or send /new to start a fresh conversation.";
