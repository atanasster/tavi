import { IPC_MAX_PROMPT_CHARS, NeedsAnswerSchema, type PendingQuestionRow } from "@tavi/contracts";
import { errorMessage } from "@tavi/contracts/util";

import { decideRound } from "../../center/approvals-api.js";
import type { CardOutcome } from "../../center/InboxRoundCard.js";
import type { StoreContext } from "./context.js";
import { answerStatus } from "./questions.js";
import type { CanvasStore, WorkerAnswer, WorkerNeeds } from "./types.js";

/** A root chat's workers' questions still to be answered here: not one whose answer is on its way or recorded. */
export function openWorkerQuestions(needs: WorkerNeeds | undefined): readonly PendingQuestionRow[] {
  return (
    needs?.questions.filter((question) => {
      const answer = needs.answers[question.waitId];
      return answer === undefined || answer.status === "failed";
    }) ?? []
  );
}

/** How many roots' worker needs the page keeps: the chat on screen and the few before it. */
export const WORKER_ROOTS_KEPT = 4;

/** What a root chat's workers wait on the reader for, and answering them there. */
export function installWorkers(ctx: StoreContext): void {
  const { client, options } = ctx;
  /** Per root chat, the latest read of its workers' needs: an older answer is dropped. */
  const workerReads = new Map<string, number>();
  /** The owner refused a root's needs: it predates workers' questions answered in their root chat, and none are read again. */
  let workersUnsupported = false;
  const loadWorkerNeeds: CanvasStore["loadWorkerNeeds"] = async (rootTaskId) => {
    if (workersUnsupported || ctx.disposed) return;
    const generation = (workerReads.get(rootTaskId) ?? 0) + 1;
    workerReads.set(rootTaskId, generation);
    let answer;
    try {
      answer = await client.request("approvals", { action: "needs", workspaceId: options.workspaceId, rootTaskId });
    } catch {
      return;
    }
    if (ctx.disposed || workerReads.get(rootTaskId) !== generation) return;
    const listed = answer.ok ? NeedsAnswerSchema.safeParse(answer.result) : undefined;
    // An owner from before workers' questions were answered in their root chat refuses the root, or drops it and lists the whole workspace
    // (no `handoffs`, which a root's listing always carries): its workers' needs are not read again.
    if (listed?.success !== true || listed.data.handoffs === undefined) {
      if ((!answer.ok && answer.error?.code === "INVALID_INPUT") || (listed?.success === true && listed.data.handoffs === undefined))
        workersUnsupported = true;
      return;
    }
    // The root's own question is its stream's, never a worker's.
    const questions = listed.data.needs.flatMap((need) =>
      need.kind === "question" && need.question.taskId !== rootTaskId ? [need.question] : [],
    );
    const handoffs = listed.data.handoffs.filter((row) => row.taskId !== rootTaskId);
    const approvals = listed.data.needs.flatMap((need) =>
      need.kind === "approval" && need.approval.taskId !== rootTaskId ? [need.approval] : [],
    );
    const previous = ctx.state.workers?.[rootTaskId]?.answers ?? {};
    const listedWait = (waitId: string): boolean => questions.some((question) => question.waitId === waitId);
    // A question closed since keeps only an answer recorded from here, as its receipt. One still
    // listed after an answer of unknown fate was not recorded (an answer settles the wait): it may be sent again.
    const answers = Object.fromEntries(
      Object.entries(previous).flatMap(([waitId, sent]): [string, WorkerAnswer][] => {
        if (sent.status === "uncertain" && listedWait(waitId))
          return [[waitId, { ...sent, status: "failed", message: "The answer was not recorded." }]];
        return sent.status === "recorded" || sent.status === "sending" || listedWait(waitId) ? [[waitId, sent]] : [];
      }),
    );
    const kept = Object.entries(ctx.state.workers ?? {})
      .filter(([root]) => root !== rootTaskId)
      .slice(-(WORKER_ROOTS_KEPT - 1));
    const decided = ctx.state.workers?.[rootTaskId]?.decided;
    ctx.publish({
      ...ctx.state,
      workers: {
        ...Object.fromEntries(kept),
        [rootTaskId]: { questions, handoffs, approvals, answers, ...(decided === undefined ? {} : { decided }) },
      },
    });
  };
  const answerWorker: CanvasStore["answerWorker"] = (rootTaskId, waitId, text) => {
    const needs = ctx.state.workers?.[rootTaskId];
    const question = needs?.questions.find((row) => row.waitId === waitId);
    if (
      needs === undefined ||
      question === undefined ||
      ctx.state.connection !== "ready" ||
      !text.trim() ||
      text.length > IPC_MAX_PROMPT_CHARS
    )
      return;
    const sent = needs.answers[waitId];
    if (sent !== undefined && sent.status !== "failed") return;
    const settle = (answer: WorkerAnswer): void => {
      const current = ctx.state.workers?.[rootTaskId];
      if (ctx.disposed || current === undefined) return;
      ctx.publish({
        ...ctx.state,
        workers: { ...ctx.state.workers, [rootTaskId]: { ...current, answers: { ...current.answers, [waitId]: answer } } },
      });
    };
    settle({ text, status: "sending", question });
    void (async () => {
      // At the worker's wait, by its task: never a turn of the root.
      const send = () =>
        client.request("approvals", { action: "answer", workspaceId: options.workspaceId, taskId: question.taskId, answer: text, waitId });
      try {
        const { response, retried } = await ctx.sendOnceMore(send);
        if (ctx.disposed) return;
        const { status, message } = answerStatus(response, retried, "The answer was refused");
        settle({ text, status, question, ...(message === undefined ? {} : { message }) });
      } catch (error) {
        settle({ text, status: "uncertain", question, message: errorMessage(error) });
      }
      void ctx.loadWorkerNeeds(rootTaskId);
    })();
  };
  const decideWorkerRound: CanvasStore["decideWorkerRound"] = (rootTaskId, round, decision) => {
    const settle = (outcome: CardOutcome): void => {
      const current = ctx.state.workers?.[rootTaskId];
      if (ctx.disposed || current === undefined) return;
      const held = { ...current, decided: { ...current.decided, [round.key]: outcome } };
      ctx.publish({ ...ctx.state, workers: { ...ctx.state.workers, [rootTaskId]: held } });
    };
    settle({ kind: "busy" });
    void (async () => {
      const { approved, scope, decisions, note } = decision;
      const outcome = await decideRound(client, {
        workspaceId: options.workspaceId,
        taskId: round.taskId,
        steps: round.steps,
        decidedBy: options.principal,
        approved,
        scope,
        decisions,
        note,
      });
      if (outcome.ok) settle({ kind: "done", approved, scope });
      else
        settle(
          outcome.settled === undefined ? { kind: "error", message: outcome.message } : { kind: "settled", text: "Decided elsewhere." },
        );
      await ctx.loadWorkerNeeds(rootTaskId);
    })();
  };
  Object.assign(ctx, { loadWorkerNeeds, answerWorker, decideWorkerRound } satisfies Partial<StoreContext>);
}
