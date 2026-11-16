import { isAttendedOrigin, isPersonMessage, TaviError } from "@tavi/contracts";
import { TOOL_SEARCH_ID, toolSearchDescriptor } from "../../../tools/tool-routing.js";
import { jsonSchemaOf } from "../../dispatch.js";
import { buildSystemPromptText } from "../../prompt.js";
import { contextQueryFrom, turnRetrievalQueryFrom } from "../../retrieval.js";
import { threadIdOf, executionLeaseOf, assertLeaseCurrent } from "../../run-config.js";
import type { WorkflowScope } from "../../scope.js";
import { type ModelCall, targetAt, firstReady, turnQueryOptions, callView, noteMemoryUnavailable } from "./context.js";

/** Task routing: the step's model chain, held for the turn, and the flush of what its rollover folds. */
export async function routeTask(ctx: ModelCall): Promise<void> {
  const { step, executionPolicy, offeredTools, stepFacts, contextBudget } = ctx;
  const { config, admission, authorizedModels, current, facts } = step;
  const { conversationTainted, flushBeforeRollover, options, turnBaselines } = step.scope;
  if (options.taskRouting !== undefined) {
    const lease = executionLeaseOf(config);
    if (lease === undefined) throw new TaviError("UNAVAILABLE", "Task routing requires an execution lease");
    const admissionIntent = config?.configurable?.["routingAdmission"] as { newTask: boolean; explicit: boolean } | undefined;
    const task = await facts.task();
    const route = await options.taskRouting.prepare({
      scope: { workspaceId: current.invocation.workspaceId, principalId: current.invocation.principalId },
      fence: { taskId: current.runId, generation: lease.generation, ownerSession: options.ownerSession },
      turnId: lease.admissionId,
      newTask: admissionIntent?.newTask === true,
      explicit: admissionIntent?.explicit === true,
      interactive: isAttendedOrigin(task?.origin) && executionPolicy.mode === "attended",
      prompt: contextQueryFrom(step.conversationForThisCall) ?? "",
      // UTF-8 bytes conservatively bound text tokens; include schemas, history and framing.
      requestBytes:
        Buffer.byteLength(
          JSON.stringify({
            systemPromptText: ctx.systemPromptText,
            context: ctx.systemPromptResult.context,
            stepFacts,
            conversation: callView(ctx),
            tools: offeredTools.map((tool) => ({
              id: tool.id,
              description: tool.description,
              schema: tool.id === TOOL_SEARCH_ID ? toolSearchDescriptor.inputJsonSchema : jsonSchemaOf(options.tools, tool.id),
            })),
          }),
        ) +
        4096 +
        (options.routing === undefined ? 0 : contextBudget * 12),
      signal: admission?.signal ?? config?.signal ?? new AbortController().signal,
      isCurrent: async () => {
        await assertLeaseCurrent(options, config);
        return (
          (await options.cancellations.get(current.runId)) === undefined &&
          options.access.missingPermissions(current.invocation, ["models.invoke"]).length === 0
        );
      },
    });
    await assertLeaseCurrent(options, config);
    if (route !== undefined) step.modelChain = [route.target, ...route.fallback];
  }
  // The turn's first step decides its chain; a later step of it runs the same.
  const turnHold = turnBaselines.get(threadIdOf(config));
  if (turnHold !== undefined) {
    turnHold.held ??= step.modelChain;
    step.modelChain = turnHold.held;
  }
  // The route is final: what this step's rollover folds is proposed now, on the turn's own target unless `extraction` is bound.
  if (step.pendingFlush !== undefined)
    await flushBeforeRollover(
      authorizedModels,
      targetAt(step, await firstReady(step)),
      current.invocation,
      step.pendingFlush.conversation,
      step.pendingFlush.removeIds,
      conversationTainted(current),
      admission?.signal ?? config?.signal,
    );
}

/** Context routing: the memory and skills the router picks for the step, refreshed when they change. */
export async function routeContext(ctx: ModelCall): Promise<void> {
  const { step, executionPolicy, contextKept } = ctx;
  const { config, current, facts } = step;
  const { options } = step.scope;
  const routingTask = await facts.task();
  if (!contextKept && options.routing !== undefined && isAttendedOrigin(routingTask?.origin) && executionPolicy.mode === "attended") {
    const scope = { workspaceId: current.invocation.workspaceId, principalId: current.invocation.principalId };
    const settings = (await options.routing.service.configuration(scope)).settings;
    if (settings.enabled && (settings.modes.memory !== "off" || settings.modes.skills !== "off")) {
      const lease = executionLeaseOf(config);
      if (lease === undefined) throw new TaviError("UNAVAILABLE", "Context routing requires an execution lease");
      const routingService = options.routing.service;
      ctx.refreshRoutedContext = (baselineOnly) => refreshRoutedContextWith(ctx, lease, routingService, baselineOnly);
      await ctx.refreshRoutedContext(false);
    }
  }
}

/** The step's routed context, read again (`baselineOnly`: the unrouted baseline only). */
async function refreshRoutedContextWith(
  ctx: ModelCall,
  lease: NonNullable<ReturnType<typeof executionLeaseOf>>,
  routingService: NonNullable<WorkflowScope["options"]["routing"]>["service"],
  baselineOnly: boolean,
): Promise<void> {
  const { step, timezone, preparedContextAdvice, turnMemory, mandatoryPrefix, contextLimits } = ctx;
  const { config, admission, current } = step;
  const { options } = step.scope;
  ctx.contextProjection = undefined;
  ctx.contextIsCurrent = undefined;
  ctx.systemPromptResult = await buildSystemPromptText(
    turnMemory,
    options.skills,
    options.mailbox,
    options.skillRollout,
    contextLimits,
    mandatoryPrefix,
    current.invocation,
    turnRetrievalQueryFrom(step.conversationForThisCall, turnQueryOptions(step, timezone)),
    {
      onProjection: (data, isCurrent) => {
        ctx.contextProjection = { ...data, turnId: lease.admissionId, step: current.steps };
        ctx.contextIsCurrent = isCurrent;
      },
      baselineOnly,
      ...(preparedContextAdvice === undefined ? {} : { prepared: preparedContextAdvice }),
      service: routingService,
      fence: { taskId: current.runId, generation: lease.generation, ownerSession: options.ownerSession },
      turnId: lease.admissionId,
      step: current.steps,
      prompt: [...current.conversation].reverse().find(isPersonMessage)?.text ?? "",
      signal: admission?.signal ?? config?.signal ?? new AbortController().signal,
      isCurrent: async () => {
        await assertLeaseCurrent(options, config);
        return (
          (await options.cancellations.get(current.runId)) === undefined &&
          options.access.missingPermissions(current.invocation, ["models.invoke"]).length === 0
        );
      },
    },
    undefined,
    options.skillUsage,
  );
  await assertLeaseCurrent(options, config);
  noteMemoryUnavailable(step, ctx.systemPromptResult);
  ctx.systemPromptText = ctx.systemPromptResult.text;
}
