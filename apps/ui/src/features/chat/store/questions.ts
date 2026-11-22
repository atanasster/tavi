import { said, type Said } from "./said.js";
import { CLIENT_TIMEOUT, type ClientResponse } from "@tavi/client/browser";
import { IPC_MAX_PROMPT_CHARS } from "@tavi/contracts";
import { errorMessage } from "@tavi/contracts/util";

import type { StoreContext } from "./context.js";
import { questionKey } from "./runs.js";
import type { CanvasStore } from "./types.js";

/**
 * How an answer to a question stands after its send and any retry: recorded;
 * unknown — a timeout, or (`retriedByTask`) a retry refused because the first
 * was recorded, so nobody sends it a third time; or refused.
 */
export function answerStatus(
  response: ClientResponse,
  retriedByTask: boolean,
  refused: Said,
): { readonly status: "recorded" | "uncertain" | "failed"; readonly message: Said | undefined } {
  if (response.ok) return { status: "recorded", message: undefined };
  if (retriedByTask && response.error?.code === "CONFLICT") return { status: "uncertain", message: response.error.message };
  return { status: response.error?.code === CLIENT_TIMEOUT ? "uncertain" : "failed", message: response.error?.message ?? refused };
}

/** Answering a chat's question. */
export function installQuestions(ctx: StoreContext): void {
  const { client, options, conversations } = ctx;
  const answerQuestion: CanvasStore["answerQuestion"] = (id, text) => {
    const current = ctx.find(id);
    const waiting = current?.run.waiting;
    const taskId = current?.run.taskId;
    const conversationId = taskId === undefined ? undefined : conversations.get(taskId);
    if (
      !current ||
      !waiting?.question ||
      taskId === undefined ||
      ctx.state.connection !== "ready" ||
      current.run.pending.length ||
      current.run.review ||
      !text.trim() ||
      text.length > IPC_MAX_PROMPT_CHARS
    )
      return;
    const key = questionKey(waiting, current.questionId);
    if (current.answer?.key === key && current.answer.status !== "failed") return;
    const clientMessageId = options.mintKey();
    ctx.update(id, (run) => ({ ...run, answer: { key, text, status: "sending" } }));
    const finish = (status: "recorded" | "uncertain" | "failed", message?: Said) => {
      if (!ctx.disposed)
        ctx.update(id, (run) =>
          run.answer?.key === key
            ? { ...run, answer: { key, text, status, ...(message === undefined || message === "" ? {} : { message }) } }
            : run,
        );
    };
    void (async () => {
      // A task started here answers in its own conversation; any other — a
      // schedule's, a chat's — is answered by its task.
      const send = () =>
        conversationId === undefined
          ? client.request("approvals", {
              action: "answer",
              workspaceId: options.workspaceId,
              taskId,
              answer: text,
              ...(waiting.waitId === undefined ? {} : { waitId: waiting.waitId }),
            })
          : client.request("reply", { workspaceId: options.workspaceId, conversationId, text, clientMessageId });
      try {
        const { response, retried } = await ctx.sendOnceMore(send);
        if (ctx.disposed) return;
        const { status, message } = answerStatus(response, retried && conversationId === undefined, said("chat.store.replyRefused"));
        finish(status, message);
      } catch (error) {
        finish("uncertain", errorMessage(error));
      }
    })();
  };
  Object.assign(ctx, { answerQuestion } satisfies Partial<StoreContext>);
}
