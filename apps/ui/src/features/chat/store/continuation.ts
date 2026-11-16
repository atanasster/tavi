import { CLIENT_TIMEOUT, recordedStateOf, resumeFrom } from "@tavi/client/browser";
import { errorMessage } from "@tavi/contracts/util";

import { loadTaskRecord } from "../tasks-api.js";
import type { StoreContext } from "./context.js";
import { RECORD_READ } from "./record.js";
import { without } from "./runs.js";

/** How long a continuation's recorded prompt may go without its turn speaking before the task's record is read. */
const CONTINUE_SETTLE_MS = 5_000;

/** Prompts that continue a chat: queued behind its turn, sent as its next one, and watched until it speaks. */
export function installContinuation(ctx: StoreContext): void {
  const {
    client,
    options,
    streams,
    conversations,
    queuedPrompts,
    attachmentsOf,
    turnPending,
    placeLost,
    resumingPlace,
    foreignTurn,
    watches,
    gaveUp,
  } = ctx;
  /**
   * A prompt that continues task `taskId`, as the terminal's chat
   * does: its stream followed from now, then the prompt sent as a
   * `reply` into its conversation, which the owner admits as a new turn of
   * the same task. The entry's id is the reply's message id, so a resend is
   * the same message.
   */
  /** The oldest prompt queued behind `taskId`'s turn, sent now as its next turn. False when none waits. */
  const sendQueued = (taskId: string): boolean => {
    const waiting = queuedPrompts.get(taskId) ?? [];
    const id = waiting.shift();
    if (waiting.length === 0) queuedPrompts.delete(taskId);
    const queuedEntry = id === undefined ? undefined : ctx.find(id);
    if (id === undefined || queuedEntry === undefined) return false;
    if (ctx.settled === taskId) ctx.settled = undefined;
    for (const earlier of ctx.state.runs)
      if (earlier.id !== id && earlier.queued !== true && (earlier.run.taskId === taskId || earlier.continues === taskId))
        ctx.retire(earlier.id);
    ctx.update(id, (run) => without(without(run, "queued"), "steering"));
    continueTask(id, taskId, queuedEntry.prompt, conversations.get(taskId));
    return true;
  };
  /** A queued prompt the turn of `taskId` took: out of the queue and off the page — the turn shows it. */
  const dropSteered = (taskId: string, id: string): void => {
    const waiting = queuedPrompts.get(taskId);
    if (waiting === undefined || !waiting.includes(id)) return;
    const rest = waiting.filter((queued) => queued !== id);
    if (rest.length === 0) queuedPrompts.delete(taskId);
    else queuedPrompts.set(taskId, rest);
    ctx.publish({ ...ctx.state, runs: ctx.state.runs.filter((run) => run.id !== id) });
  };
  /** A task that will take no further turn: what was queued behind it is not sent. */
  const dropQueued = (taskId: string, error: string): void => {
    for (const id of queuedPrompts.get(taskId) ?? []) ctx.update(id, (run) => ({ ...without(run, "queued"), error }));
    queuedPrompts.delete(taskId);
  };
  const continueTask = (id: string, taskId: string, prompt: string, conversationId: string | undefined): void => {
    if (ctx.disposed) return;
    /** Not continued: said, and the task stays the one the next prompt continues. */
    const stop = (error: string): void => {
      ctx.unfollow(id);
      ctx.failed(id, error);
      // What was queued after it waits on a turn that did not happen: not sent either, so the order holds.
      dropQueued(taskId, "The prompt before this one was not sent, so this one was not either.");
      ctx.settles(id, taskId);
    };
    /**
     * Never reached the owner: the message leaves the transcript and goes back
     * in the box, said in plain words, and the chat stays as it was — not
     * failed, since nothing of it ran — the one the next prompt continues.
     */
    const notSent = (why: string): void => {
      ctx.unfollow(id);
      dropQueued(taskId, "The prompt before this one was not sent, so this one was not either.");
      const files = attachmentsOf.get(id) !== undefined;
      attachmentsOf.delete(id);
      const wasLast = ctx.state.runs.at(-1)?.id === id;
      if (wasLast) ctx.settled = taskId;
      ctx.publish({
        ...ctx.state,
        runs: ctx.state.runs.filter((run) => run.id !== id),
        unsent: {
          key: id,
          text: prompt,
          message: `Not sent: ${why}. Your message is back in the box${files ? " (attach its files again)" : ""}: send it again.`,
        },
      });
    };
    /** Why the owner did not take a message, in words for the reader: a timeout names no protocol command. */
    const why = (
      failure: { readonly code?: string | undefined; readonly message?: string | undefined } | undefined,
      fallback: string,
    ): string => (failure?.code === CLIENT_TIMEOUT ? "the owner did not answer in time" : (failure?.message ?? fallback));
    // From where the chat's last followed turn stopped: a plugin's line cleared between the turns, say on its disable, is seen.
    const before = [...ctx.state.runs]
      .reverse()
      .find((run) => run.id !== id && ctx.chatOf(run) === taskId && run.run.cursor !== undefined && !placeLost.has(run.id));
    if (before !== undefined) resumingPlace.add(id);
    /** Whether the place's replay held another turn, which the page has not drawn. */
    let foreign = false;
    void (async () => {
      const opened = await client.subscribe(taskId, {
        ...(before === undefined ? {} : { from: resumeFrom(before.run) }),
        ...ctx.following(id),
      });
      if (ctx.disposed) {
        void opened.subscription?.close();
        return;
      }
      if (!opened.response.ok) {
        notSent(why(opened.response.error, "the owner refused to follow the chat"));
        return;
      }
      if (opened.subscription !== undefined) streams.set(id, opened.subscription);
      /**
       * The place's replay held another turn: followed from now, as
       * before resuming places — what plugins showed stays applied. Answers
       * whether the continuation goes on.
       */
      const fromNowIfForeign = async (): Promise<boolean> => {
        if (!foreignTurn.delete(id)) return true;
        foreign = true;
        resumingPlace.delete(id);
        void streams.get(id)?.close();
        streams.delete(id);
        const again = await client.subscribe(taskId, ctx.following(id));
        if (ctx.disposed) {
          void again.subscription?.close();
          return false;
        }
        if (!again.response.ok) {
          notSent(why(again.response.error, "the owner refused to follow the chat"));
          return false;
        }
        if (again.subscription !== undefined) streams.set(id, again.subscription);
        return true;
      };
      if (!(await fromNowIfForeign())) return;
      // What the record holds before the reply: a turn admitted since is this one.
      const read = await loadTaskRecord(client, taskId, RECORD_READ);
      if (ctx.disposed) return;
      if (!read.ok) {
        notSent(why(read, "the chat's record could not be read"));
        return;
      }
      if (!(await fromNowIfForeign())) return;
      watches.set(id, { taskId, before: (read.value.admissions ?? []).length });
      resumingPlace.delete(id);
      turnPending.add(id);
      // By its conversation when the page knows it, else by the task, which the owner opens one for.
      const files = attachmentsOf.get(id);
      const payload = {
        workspaceId: options.workspaceId,
        ...(conversationId === undefined ? { taskId } : { conversationId }),
        text: prompt,
        clientMessageId: id,
        ...(files === undefined ? {} : { attachments: [...files] }),
      };
      const { response: reply } = await ctx.sendOnceMore(() => client.request("reply", payload));
      attachmentsOf.delete(id);
      if (ctx.disposed) return;
      if (reply.ok || reply.error?.code === CLIENT_TIMEOUT) {
        if (reply.ok) {
          const answered = (reply.result as { readonly conversationId?: unknown } | undefined)?.conversationId;
          if (typeof answered === "string") conversations.set(taskId, answered);
          // A prompt sent into the turn before, which that turn took: no turn of its own follows.
          if ((reply.result as { readonly steered?: unknown } | undefined)?.steered === true) {
            turnPending.delete(id);
            ctx.unwatch(id);
            ctx.unfollow(id);
            ctx.publish({ ...ctx.state, runs: ctx.state.runs.filter((run) => run.id !== id) });
            ctx.settles(id, taskId);
            return;
          }
        }
        if (!reply.ok)
          ctx.update(id, (run) => ({
            ...run,
            notice: "The owner did not answer: the prompt may have been recorded. Still following the chat.",
          }));
        if (turnPending.has(id)) watch(id);
        return;
      }
      // A conversation the owner no longer has is forgotten: the next send names the task.
      if (reply.error?.code === "NOT_FOUND") conversations.delete(taskId);
      notSent(why(reply.error, reply.error?.code ?? "the owner refused it"));
      // Refused, perhaps for what that other turn left (a round to decide): the page draws it, so it can be decided here.
      if (foreign && before !== undefined && reply.error?.code !== "NOT_FOUND") ctx.catchUp(taskId, { from: before });
    })().catch((error: unknown) => stop(errorMessage(error)));
  };

  /**
   * A continuation whose turn has not spoken, watched: the owner answers
   * `reply` once the prompt is recorded, before its turn is admitted, and an
   * owner restart may erase a turn's events. A while from now the task's
   * record is read — again after every resync, and after a read that failed —
   * and says which it is: a turn in flight (watched on), one admitted since
   * the reply that ran unseen (its ending read back, as a resync's is), or
   * none (said, and the stream kept, so a turn that starts later still shows).
   */
  const watch = (id: string): void => {
    if (ctx.disposed) return;
    const watched = watches.get(id);
    if (watched === undefined) return;
    clearTimeout(watched.timer);
    watched.timer = setTimeout(() => {
      if (!turnPending.has(id) || watches.get(id) !== watched) return;
      const { taskId } = watched;
      void loadTaskRecord(client, taskId, RECORD_READ).then((answer) => {
        if (ctx.disposed || !turnPending.has(id) || watches.get(id) !== watched) return;
        if (!answer.ok) {
          ctx.update(id, (run) => ({ ...run, notice: `Could not read task ${taskId}'s record (${answer.message}); trying again.` }));
          watch(id);
          return;
        }
        const recorded = answer.value;
        if (recordedStateOf(recorded).kind === "live") {
          watch(id);
          return;
        }
        turnPending.delete(id);
        ctx.unwatch(id);
        if ((recorded.admissions ?? []).length > watched.before) {
          // Its turn was admitted and ended while the stream could not say so.
          ctx.readRecord(id, taskId);
          return;
        }
        gaveUp.add(id);
        ctx.update(id, (run) => ({
          ...without(run, "notice"),
          error: `The prompt was recorded (message ${id}), but task ${taskId} has not started its turn. It shows here if it does.`,
        }));
        ctx.settles(id, taskId);
      });
    }, options.settleMs ?? CONTINUE_SETTLE_MS);
  };
  Object.assign(ctx, { sendQueued, dropSteered, dropQueued, continueTask, watch } satisfies Partial<StoreContext>);
}
