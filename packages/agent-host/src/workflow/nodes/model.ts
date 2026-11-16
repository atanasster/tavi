import type { WorkflowScope } from "../scope.js";
import type { WorkflowNode } from "../state.js";
import { beginModelStep } from "./model/begin.js";
import { callWithFailover } from "./model/call.js";
import { foldBeforeCall } from "./model/fold.js";
import { resolveInstructions } from "./model/instructions.js";
import { offerTools } from "./model/offer.js";
import { buildModelCall } from "./model/prompt.js";
import { foldUnderPressure } from "./model/pressure.js";
import { stepResult } from "./model/result.js";
import { routeContext, routeTask } from "./model/routing.js";

/** The model node: one model step of a turn, its context, folds and rollovers. */
export function createModelNode(scope: WorkflowScope): WorkflowNode {
  const { newId } = scope;
  const modelNode: WorkflowNode = async (state, config) => {
    const begun = await beginModelStep(scope, state, config);
    if ("early" in begun) return begun.early;
    const { step } = begun;
    await foldBeforeCall(step);
    const attemptId = newId("attempt");
    const instructions = await resolveInstructions(step);
    const offer = await offerTools(step, instructions);
    // The system prompt is built here, in `model/prompt.ts` (rather than
    // just before the model call, where earlier steps built it), so stage
    // 2's trigger estimate in `model/pressure.ts` can include it:
    // `buildSystemPromptText` can append up to `maxContextTokens` of
    // resolved preferences and retrieved evidence when `memory` is
    // configured, which is real pressure on the same call stage 2 exists to
    // relieve: its estimate covers the system prompt as well as
    // `conversationForThisCall`.
    const ctx = await buildModelCall(step, instructions, offer, attemptId);
    await routeTask(ctx);
    await routeContext(ctx);
    await foldUnderPressure(ctx);
    const called = await callWithFailover(ctx);
    if ("early" in called) return called.early;
    return await stepResult(ctx, called);
  };
  return modelNode;
}
