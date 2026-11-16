import {
  clampWaitAnswer,
  matchChoiceAnswer,
  type AgentWaitOutcome,
  type MemoryActor,
  type NeedAnswered,
  type PersistencePort,
} from "@tavi/contracts";

import type { ChannelApprovals } from "./channel-approvals.js";

/** What `approvals answer` reports; see `NeedAnsweredSchema`. */
type NeedAnswerResult = NeedAnswered;

export type NeedAnswerOutcome =
  | { readonly ok: true; readonly result: NeedAnswerResult }
  | { readonly ok: false; readonly error: { readonly code: "NOT_FOUND" | "CONFLICT" | "INVALID_INPUT"; readonly message: string } };

/**
 * Answer a task's open question from any surface its owner controls: the web, a terminal — whatever channel the task
 * started from. Authorized as a round decision is: the task must be in the
 * caller's workspace, and the caller's own — or the caller the workspace's
 * operator, who answers a person's question for them (Allowed people). The answer is read against the
 * question's options exactly as a typed chat answer is, and the
 * question's chat messages say where it was answered.
 */
export async function answerNeed(
  deps: {
    readonly repositories: Pick<PersistencePort["repositories"], "tasks" | "agentWaits">;
    readonly channelApprovals: Pick<ChannelApprovals, "answerQuestion">;
    /** The principal a workspace belongs to; without it, only a task's own principal answers its questions. */
    readonly operatorOf?: (workspaceId: string) => string | undefined;
  },
  input: { readonly actor: MemoryActor; readonly taskId: string; readonly waitId?: string; readonly answer: string; readonly via: string },
): Promise<NeedAnswerOutcome> {
  const task = await deps.repositories.tasks.get(input.taskId);
  // Another workspace's task, or another person's, is not found: it is not this caller's to know of.
  const answers =
    task !== undefined && (task.principalId === input.actor.principalId || deps.operatorOf?.(task.workspaceId) === input.actor.principalId);
  if (task === undefined || task.workspaceId !== input.actor.workspaceId || !answers) {
    return { ok: false, error: { code: "NOT_FOUND", message: `No task ${input.taskId} of yours in this workspace` } };
  }
  const wait = await deps.repositories.agentWaits.getActiveByTask(task.taskId);
  // A browser handoff is ended in the live view, never answered; a connect wait by connecting or *Not now*.
  const question =
    wait !== undefined &&
    wait.correlationId === undefined &&
    wait.waitingOnWorkerTaskId === undefined &&
    wait.handoff === undefined &&
    wait.connect === undefined
      ? wait
      : undefined;
  if (question === undefined || (input.waitId !== undefined && question.waitId !== input.waitId)) {
    return { ok: false, error: { code: "CONFLICT", message: "This question was already answered, or has closed." } };
  }
  const answer = input.answer.trim();
  const matched = question.choices === undefined ? undefined : matchChoiceAnswer(answer, question.choices);
  if (matched !== undefined && "refusal" in matched) return { ok: false, error: { code: "INVALID_INPUT", message: matched.refusal } };
  const replyText = clampWaitAnswer(answer);
  const outcome: AgentWaitOutcome = {
    kind: "answered",
    replyText,
    ...(matched === undefined ? {} : { answers: [...matched.answers], ...(matched.other === undefined ? {} : { other: matched.other }) }),
  };
  if (
    !(await deps.channelApprovals.answerQuestion({
      actor: input.actor,
      taskId: task.taskId,
      waitId: question.waitId,
      outcome,
      via: input.via,
    }))
  ) {
    return { ok: false, error: { code: "CONFLICT", message: "This question was already answered, or has closed." } };
  }
  return {
    ok: true,
    result: {
      taskId: task.taskId,
      waitId: question.waitId,
      answers: matched === undefined ? [] : [...matched.answers],
      ...(matched === undefined ? { other: replyText } : matched.other === undefined ? {} : { other: matched.other }),
    },
  };
}
