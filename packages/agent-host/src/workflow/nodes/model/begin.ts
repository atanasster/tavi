import type { z } from "zod";
import { isPersonMessage, type PromptLayout, type RunPhaseSchema, parseAgentState } from "@tavi/contracts";
import { errorMessage } from "@tavi/contracts/util";
import { threadIdOf, assertLeaseCurrent } from "../../run-config.js";
import type { WorkflowScope } from "../../scope.js";
import type { PromptMessage } from "../../tool-hooks.js";
import type { ModelStep } from "./context.js";
import type { RunnableConfig } from "@langchain/core/runnables";
import type { WorkflowState, WorkflowUpdate } from "../../state.js";

/**
 * The step's start: its route's baseline, the lease and cancellation checks, the person's steers joined, and the
 * turn's step guard. `early` is the step's result when it stops here.
 */
export async function beginModelStep(
  scope: WorkflowScope,
  state: WorkflowState,
  config: RunnableConfig,
): Promise<{ readonly step: ModelStep } | { readonly early: WorkflowUpdate }> {
  const { authorizeModels, maxStepsOf, observers, options, promptThroughHooks, refreshLease, stepFactsOf, takeSteers, turnBaseline } =
    scope;
  const parsed = parseAgentState(state);
  // A chat with no saved route runs the default as configured when its turn began.
  const modelChain = await turnBaseline(threadIdOf(config), parsed.invocation);
  const admission = observers.get(threadIdOf(config));
  const authorizedModels = authorizeModels(parsed.invocation, config);
  // Fence unconditionally: a missing lease means the invocation is not
  // authorized to write, not that it may proceed.
  await assertLeaseCurrent(options, config);
  // Cancellation stops the loop at the next node boundary, not only at admission.
  const cancellation = await options.cancellations.get(parsed.runId);
  if (cancellation !== undefined) {
    return {
      early: {
        phase: "failed" as const,
        finalText: `Task was cancelled by ${cancellation.requestedBy}: ${cancellation.reason}`,
      },
    };
  }
  await refreshLease(config);
  if (admission?.signal?.aborted === true) {
    return { early: { phase: "failed" as const, finalText: "The run was cancelled before the model call." } };
  }
  // Steering: what the person sent into this running turn joins it
  // now, as their messages, before the call that reads them. They are
  // written with this step's own update (and `turnSteers` with them), so a
  // step that never checkpoints — a crash, a cancellation mid-call — leaves
  // them claimed but not held, and the admission's end hands them back.
  const steered = await takeSteers(parsed, config);
  const steerMessages: PromptMessage[] = [];
  for (const steer of steered) {
    steerMessages.push({ id: steer.steerId, role: "user" as const, text: steer.text, createdAt: steer.createdAt });
    // A steer is a prompt too: plugins' prompt hooks may add to it, never drop it.
    steerMessages.push(
      ...(
        await promptThroughHooks(
          parsed.runId,
          parsed.invocation,
          steer.text,
          true,
          (index) => `${steer.steerId}-${index}`,
          admission?.signal ?? config?.signal,
        )
      ).context,
    );
  }
  const current = steerMessages.length === 0 ? parsed : { ...parsed, conversation: [...parsed.conversation, ...steerMessages] };
  // What this step reads of its task, each once: its row, policy, origin, rules, memory settings, chat memory,
  // layout, tool deferral and offered list (`StepFacts`).
  const facts = stepFactsOf(current.invocation, current.runId);
  for (const steer of steered) {
    try {
      admission?.onSteer?.({ messageId: steer.messageId, text: steer.text });
    } catch (error) {
      options.onDiagnostic?.("an admission's onSteer observer threw; the turn continues", {
        taskId: parsed.runId,
        reason: errorMessage(error),
      });
    }
  }
  // Per turn: a conversation that goes on for many turns is not
  // failed by its step count — only, at length, by its bounded size
  // (`boundConversation`). A user message newer than the turn's starts one
  // — a steer too: its guards count again from it, bounded by
  // `STEERS_PER_TURN` steers an admission.
  // The person's: a notices block, background or summary written as data is no turn. A
  // rollover that folded the person's newest message away (a wake turn's) leaves the turn as it was.
  const latestUser = [...current.conversation].reverse().find(isPersonMessage)?.id;
  const newTurn = latestUser !== undefined && latestUser !== current.turnMessageId;
  // `models.promptLayout`: `v2` keeps what leads the cached prefix — the tools array, a turn's context
  // block — the same from call to call; `v1` is the layout every release before it sent.
  const layout: PromptLayout = (await facts.layout()) ?? "v1";
  const turnStepsSoFar = newTurn ? 0 : current.turnSteps;
  /** What every return that took a model step writes of the turn. */
  const turnAdvance = {
    turnSteps: turnStepsSoFar + 1,
    ...(latestUser === undefined ? {} : { turnMessageId: latestUser }),
    ...(newTurn ? { turnToolCalls: 0 } : {}),
    ...(steered.length === 0 ? {} : { turnSteers: [...current.turnSteers, ...steered.map((steer) => steer.steerId)] }),
  };
  const taskMaxSteps = await maxStepsOf(current.runId);
  if (turnStepsSoFar >= taskMaxSteps) {
    return {
      early: {
        phase: "failed" satisfies z.infer<typeof RunPhaseSchema>,
        finalText: `Bounded loop guard reached after ${taskMaxSteps} model steps.`,
      },
    };
  }
  return {
    step: {
      scope,
      config,
      admission,
      authorizedModels,
      steered,
      steerMessages,
      current,
      facts,
      latestUser,
      newTurn,
      layout,
      turnStepsSoFar,
      turnAdvance,
      taskMaxSteps,
      modelChain,
      epochBegins: false,
      fold: undefined,
      conversationForThisCall: current.conversation,
      foldedPersons: [],
      forgottenPersons: [],
      memoryCheckFailed: false,
      pendingFlush: undefined,
    },
  };
}
