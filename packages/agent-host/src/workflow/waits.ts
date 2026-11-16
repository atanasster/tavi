import {
  TRUSTED_PUBLIC,
  untrustedLabel,
  envelopeLabel,
  unlabelledEnvelope,
  type AgentWaitOutcome,
  type ContentLabel,
  type BrowserHandoffPort,
  waitRowId,
  type WorkflowWaitRequest,
  type WorkflowWaitSuspend,
} from "@tavi/contracts";
import { definedOnly } from "@tavi/contracts/util";

/**
 * The canonical tool id `toolsNode` special-cases:
 * dispatched by calling `options.agents.waitFor` directly rather
 * than through `dispatchTool`, so a thrown `WorkflowWaitSuspend` reaches
 * `interrupt()` instead of being caught and turned into a `TOOL_FAILED`
 * tool-result message the way every other tool's thrown error is.
 */
export const AGENTS_WAIT_TOOL_ID = "agents.wait";

/** `ask_user` shares `agents.wait`'s node-dispatched shape. */
export const ASK_USER_TOOL_ID = "operator.ask_user";

/**
 * `agents.wait`'s interrupt payload and model-facing input are both
 * imported from `@tavi/contracts` — `WorkflowWaitRequestSchema` (parallel
 * to `ApprovalRequestSchema`, not a variant of it) and `AgentWaitInputSchema`
 * — rather than declared locally, so `toolsNode`'s validation and
 * `agent-tools.ts`'s model-facing registration can never drift out of sync.
 */
export function toWaitInterruptPayload(error: WorkflowWaitSuspend): WorkflowWaitRequest {
  return {
    waitId: error.waitId,
    deadlineAt: error.deadlineAt,
    ...(error.correlationId === undefined ? {} : { correlationId: error.correlationId }),
    ...(error.waitingOnWorkerTaskId === undefined ? {} : { waitingOnWorkerTaskId: error.waitingOnWorkerTaskId }),
    // What `operator.ask_user` asked: `task.waiting` carries it.
    ...definedOnly({
      question: error.question,
      choices: error.choices,
      context: error.context,
      handoff: error.handoff,
      connect: error.connect,
    }),
  };
}

/**
 * A browser call that must wait for a person: its session is under a
 * person's control now, or — on a replay — this very call already waited.
 * Only a call made alone becomes a wait (waits must be sole calls); one in a
 * batch is refused by the session, and the model is told to call it alone.
 */
export async function browserCallWaits(
  port: BrowserHandoffPort,
  current: { readonly runId: string; readonly steps: number },
  call: { readonly id: string; readonly input: unknown },
): Promise<{ readonly sessionId: string } | undefined> {
  const sessionId = (call.input as { readonly sessionId?: unknown } | null)?.sessionId;
  if (typeof sessionId !== "string" || sessionId === "") return undefined;
  if (await port.recorded(waitRowId(current.runId, current.steps, call.id))) return { sessionId };
  return port.controlState({ taskId: current.runId, sessionId }) === "agent" ? undefined : { sessionId };
}

/**
 * Whether a person may be handed the browser: an attended run only.
 * A routine or schedule with human checkpoints may ask questions, but nobody
 * is at the canvas to take a page over.
 */
export function handoffAllowed(policy: { readonly mode: string; readonly humanQuestionsAllowed: boolean }): boolean {
  return policy.mode === "attended" && policy.humanQuestionsAllowed;
}

/**
 * The task whose words a tool result carries: an `agents.wait`
 * envelope's sender, the task `agents.status` reads, the worker an
 * `agents.spawn` answers for (a routine's research evidence).
 */
export function speakingTaskOf(toolName: string | undefined, output: unknown): string | undefined {
  if (toolName === AGENTS_WAIT_TOOL_ID) return waitOutcomeOf(output)?.envelope?.senderTaskId;
  if (typeof output !== "object" || output === null) return undefined;
  const id =
    toolName === "agents.status"
      ? (output as { readonly taskId?: unknown }).taskId
      : toolName === "agents.spawn"
        ? (output as { readonly workerTaskId?: unknown }).workerTaskId
        : undefined;
  return typeof id === "string" ? id : undefined;
}

/** A settled wait's outcome in an `agents.wait` result, when the result is one. */
function waitOutcomeOf(output: unknown): AgentWaitOutcome | undefined {
  if (typeof output !== "object" || output === null || !("outcome" in output)) return undefined;
  const outcome = (output as { readonly outcome?: unknown }).outcome;
  return typeof outcome === "object" && outcome !== null ? (outcome as AgentWaitOutcome) : undefined;
}

/**
 * What an `agents.wait` result is labelled: the
 * envelope that settled it carries its sender's label at send time — a
 * worker's result its final label, a peer's reply its sender's — and one from
 * before labels reads as an agent's words, untrusted (`envelopeLabel`). Words
 * that came with no envelope (an answer to a bare wait) read so too. An
 * outcome with no words (a timeout, a cancel, a worker's end without its
 * result) and an error of the dispatch's own carry nothing.
 */
export function waitOutputLabel(output: unknown): ContentLabel {
  const outcome = waitOutcomeOf(output);
  if (outcome === undefined) return TRUSTED_PUBLIC;
  if (outcome.envelope !== undefined) return envelopeLabel(outcome.envelope);
  const worded =
    outcome.replyText !== undefined || outcome.other !== undefined || (outcome.answers?.length ?? 0) > 0 || outcome.handoff !== undefined;
  return worded ? untrustedLabel("agent") : TRUSTED_PUBLIC;
}

/** An `agents.wait` result as the model reads it: the envelope's label is the result's, never its text. */
export function unlabelledWaitOutput(output: unknown): unknown {
  const outcome = waitOutcomeOf(output);
  if (outcome?.envelope?.label === undefined) return output;
  return { ...(output as object), outcome: { ...outcome, envelope: unlabelledEnvelope(outcome.envelope) } };
}
