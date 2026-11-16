import { normaliseUntrustedText, type InvocationContext, type ModelPort } from "@tavi/contracts";
import { chooseRoleTarget, type ConnectionLocality } from "@tavi/agent-host/task-summarizer";
import { classifierSaysInjection, INJECTION_CLASSIFIER_INSTRUCTIONS, type InjectionClassifier } from "@tavi/runtime";

/** A model target: a connection and a model on it. */
interface Target {
  readonly connectionId: string;
  readonly model: string;
}

export interface InjectionClassifierDeps {
  /** The task's model calls, oldest first: its generations name the chat's own target and the connections it used. */
  readonly attempts: (
    taskId: string,
  ) => Promise<readonly { readonly purpose: string; readonly connectionId: string; readonly model: string }[]>;
  /** The workspace's `fast` role binding, if any. */
  readonly fastBinding: (workspaceId: string) => Promise<Target | undefined>;
  readonly locality: (connectionId: string) => Promise<ConnectionLocality | undefined>;
  readonly models: Pick<ModelPort, "stream">;
  readonly newId: () => string;
  readonly now: () => string;
}

/**
 * `security.injectionDetector = model`'s classifier for one task: the
 * `fast` role, or the chat's own target when the chat used a
 * local connection — never a remote model for a local chat (as the idle
 * review chooses, `chooseRoleTarget`). No target is no call and no hit. The
 * call is an `evaluation` whose request the ledger does not keep (it is page
 * text read again); anything but a completed `INJECTION` answer is no hit.
 * The text goes with the envelope's normalisation: a chat token in it is
 * quoted, never a turn of the classifier's own conversation.
 */
export function injectionClassifierFor(
  deps: InjectionClassifierDeps,
  input: { readonly workspaceId: string; readonly taskId: string; readonly invocation: InvocationContext },
): InjectionClassifier {
  return async (text, call) => {
    const calls = (await deps.attempts(input.taskId)).filter((attempt) => attempt.purpose === "generation");
    const latest = calls.at(-1);
    const own = latest === undefined ? undefined : { connectionId: latest.connectionId, model: latest.model };
    const bound = await deps.fastBinding(input.workspaceId);
    const target = await chooseRoleTarget({ own, bound, used: calls.map((attempt) => attempt.connectionId), locality: deps.locality });
    if (target === undefined) return false;
    const attemptId = deps.newId();
    const outcome = await deps.models.stream(
      {
        connectionId: target.connectionId,
        model: target.model,
        runId: input.taskId,
        attemptId,
        attemptNumber: 1,
        purpose: "evaluation",
        maxOutputTokens: 16,
        // A one-word verdict: a reasoning model thinking at length would spend the cap and answer nothing.
        reasoningEffort: "low",
        messages: [
          { id: `${attemptId}-system`, role: "system", text: INJECTION_CLASSIFIER_INSTRUCTIONS, createdAt: deps.now() },
          { id: `${attemptId}-input`, role: "user", text: normaliseUntrustedText(text), createdAt: deps.now() },
        ],
        tools: [],
      },
      { signal: call.signal, onEvent: () => {}, context: input.invocation, keepRequest: false, site: "classifier" },
    );
    return outcome.status === "completed" && classifierSaysInjection(outcome.text);
  };
}
