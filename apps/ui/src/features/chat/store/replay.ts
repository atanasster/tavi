import { initialRunState, resumeFrom, turnEnded, type Subscription } from "@tavi/client/browser";
import { HOME_CONVERSATION_PREFIX } from "@tavi/contracts";
import { errorMessage } from "@tavi/contracts/util";

import { loadTaskRecord } from "../tasks-api.js";
import type { StoreContext } from "./context.js";
import { cancelReasonOf, promptsOf, RECORD_READ } from "./record.js";
import { without } from "./runs.js";
import { refusedAs, said, type Said } from "./said.js";
import type { CanvasRun, EndedTurn, RestoredTask } from "./types.js";

/** A chat replayed from the owner's stream: after a reload, on opening it, and to catch up with it. */
export function installReplay(ctx: StoreContext): void {
  const { client, options, recordReleased, restoredStreams, conversations, turnPending, placeLost, reopening } = ctx;
  /**
   * After a reload: the page's last task, replayed from the owner's
   * stream as its turns — one entry each, their prompts read from the task's
   * record (the stream does not carry them) and paired with the turns when
   * every turn is replayed, else listed apart — and continued by the next prompt. The
   * stream is let go once the replay is through and the task has settled; a
   * turn still running is followed on. A task whose stream the owner no longer
   * holds is read from its record.
   */
  const restore = (remembered: RestoredTask, prompts?: readonly string[], resume?: CanvasRun, onLost?: (error: Said) => void): void => {
    const { taskId } = remembered;
    if (remembered.conversationId.startsWith(HOME_CONVERSATION_PREFIX) && ctx.state.home !== taskId)
      ctx.publish({ ...ctx.state, home: taskId });
    if (remembered.conversationId) conversations.set(taskId, remembered.conversationId);
    else conversations.delete(taskId);
    let current = resume?.id ?? options.mintKey();
    if (!resume)
      ctx.publish({
        ...ctx.state,
        runs: [
          ...ctx.state.runs,
          { ...ctx.entry(current, "", { restored: true, run: initialRunState({ taskId }) }), recordedPrompts: prompts ?? [] },
        ],
      });
    const replay: { expected: number | undefined; delivered: number } = { expected: undefined, delivered: 0 };
    /** The entries this replay made, one per turn, in order. */
    const first = current;
    const turns = [first];
    /**
     * The stream carries no prompts; the record does, one per turn that ran.
     * They are paired with the replayed turns only when the counts agree — a
     * partial replay (its oldest turns no longer held) would pair them wrongly,
     * so it keeps them listed apart.
     */
    let recorded = resume ? undefined : prompts;
    const pairPrompts = (): void => {
      const paired = recorded;
      if (paired === undefined || !replay.expected || replay.delivered < replay.expected || paired.length !== turns.length) return;
      // Paired once: the live events that follow must not repaint for it.
      recorded = undefined;
      const byTurn = new Map(turns.map((id, index) => [id, paired[index]]));
      let changed = false;
      const runs = ctx.state.runs.map((run) => {
        const prompt = byTurn.get(run.id);
        if (prompt === undefined || run.prompt !== "") return run;
        changed = true;
        return { ...without(run, "recordedPrompts"), prompt };
      });
      if (changed) ctx.publish({ ...ctx.state, runs });
    };
    if (!resume && prompts === undefined) {
      // After a reload nothing is in hand: the record says what was asked.
      // With nothing replayed, `readRecord` reads it and shows its prompts.
      void loadTaskRecord(client, taskId, RECORD_READ)
        .then((answer) => {
          if (ctx.disposed || !answer.ok || replay.expected === 0) return;
          const read = promptsOf(answer.value);
          recorded = read;
          cancelReason = cancelReasonOf(answer.value);
          ctx.update(first, (run) => ({ ...run, recordedPrompts: read }));
          pairPrompts();
          projectCancel();
          release();
        })
        .catch(() => undefined);
    }
    /** The task's cancel, when its record says so: no stream may carry it, so it goes over the last turn once the replay is through. */
    let cancelReason = remembered.cancelled;
    const projectCancel = (): void => {
      if (cancelReason === undefined || replay.expected === undefined || replay.expected === 0 || replay.delivered < replay.expected)
        return;
      ctx.cancelled(current, taskId, cancelReason);
      cancelReason = undefined;
    };
    /** The turns replayed that ended, until what they used is read: one read for the whole replay, not one per turn. */
    let ended: EndedTurn[] = [];
    const readUsed = (): void => {
      if (replay.expected === undefined || replay.delivered < replay.expected || ended.length === 0) return;
      ctx.attachMemoryUsed(taskId, ended);
      ended = [];
    };
    let subscription: Subscription | undefined;
    let letGo = false;
    const settledNow = (): boolean => {
      const status = ctx.find(current)?.run.status;
      return status !== undefined && turnEnded(status);
    };
    const release = (): void => {
      if (letGo || subscription === undefined || replay.expected === undefined || replay.delivered < replay.expected || !settledNow())
        return;
      letGo = true;
      restoredStreams.delete(subscription);
      recordReleased.delete(current);
      void subscription.close();
    };
    recordReleased.set(current, release);
    /** The replay went wrong: on the resumed entry itself, the caller's to say (`onLost`), so a settled turn is not shown failed. */
    const lost = (error: Said): void => {
      if (onLost !== undefined && current === resume?.id) onLost(error);
      else ctx.failed(current, error);
    };
    client
      .subscribe(taskId, {
        from: resume ? resumeFrom(resume.run) : "beginning",
        onEvent: (event) => {
          if (ctx.disposed) return;
          replay.delivered += 1;
          const ends = event.kind === "task.completed" || event.kind === "task.failed" || event.kind === "task.stopped";
          // A turn after one that ended: an entry of its own. A person's hold of the browser between turns is not one, nor a plugin's line: they are the last turn's.
          if (
            !ends &&
            event.kind !== "resync.required" &&
            event.kind !== "browser.controlled" &&
            !event.kind.startsWith("plugin.") &&
            settledNow()
          ) {
            recordReleased.delete(current);
            current = options.mintKey();
            turns.push(current);
            recordReleased.set(current, release);
            ctx.publish({
              ...ctx.state,
              runs: [...ctx.state.runs, ctx.entry(current, "", { restored: true, continues: taskId, run: initialRunState({ taskId }) })],
            });
          }
          ctx.apply(current, event);
          if (ends) ended.push({ id: current, at: event.at });
          pairPrompts();
          readUsed();
          projectCancel();
          // Replayed whole and settled, whatever came last (a hand-back's row is no end): let go, or the chat's next turn
          // is replayed here too and drawn twice (QA 2103).
          if (letGo === false && replay.expected !== undefined && replay.delivered >= replay.expected) release();
        },
        onEnd: (error) => {
          if (error !== undefined) lost(errorMessage(error));
        },
      })
      .then((opened) => {
        if (ctx.disposed) {
          void opened.subscription?.close();
          return;
        }
        if (!opened.response.ok) {
          lost(said("chat.store.replayFailed", { taskId, message: refusedAs(opened.response, said("chat.store.refused")) }));
          return;
        }
        subscription = opened.subscription;
        if (subscription !== undefined) restoredStreams.add(subscription);
        const result = opened.response.result as { readonly replayed?: number } | undefined;
        replay.expected = result?.replayed ?? 0;
        if (replay.expected === 0) {
          // Reopening a cached ending must let the fresh record supersede it.
          // Keep its transcript while the record and any newer held events reconcile.
          if (resume && current === resume.id && ctx.find(current)?.run.cursor === resume.run.cursor)
            ctx.update(current, (run) => ({ ...without(run, "error"), run: { ...run.run, status: "unknown", outcome: undefined } }));
          ctx.readRecord(current, taskId);
          return;
        }
        pairPrompts();
        readUsed();
        projectCancel();
        release();
      })
      .catch((error: unknown) => lost(errorMessage(error)))
      .finally(() => reopening.delete(taskId));
  };

  /**
   * The chat shown here, taken up again from where its last followed turn
   * stopped, as reopening it does: a turn a channel or another front end ran
   * since — one waiting on a round, say — is drawn as an entry of its own, not
   * left unseen behind a stream the page let go. Only once its last entry has
   * settled; `at` (the list's `updatedAt`) catches up once per change, and
   * `from` is the entry to resume from when the caller knows it.
   */
  const caughtUp = new Map<string, string>();
  const catchUp = (taskId: string, { at, from }: { readonly at?: string; readonly from?: CanvasRun } = {}): void => {
    if (ctx.disposed || reopening.has(taskId)) return;
    if (at !== undefined && caughtUp.get(taskId) === at) return;
    const ofChat = ctx.state.runs.filter((run) => ctx.chatOf(run) === taskId);
    const last = ofChat.at(-1);
    // Settled: its turn ended, or it was refused before one began.
    if (last === undefined || last.queued === true || turnPending.has(last.id) || !(turnEnded(last.run.status) || last.error !== undefined))
      return;
    const place = from ?? [...ofChat].reverse().find((run) => run.run.cursor !== undefined && !placeLost.has(run.id));
    if (place === undefined) return;
    if (at !== undefined) caughtUp.set(taskId, at);
    reopening.add(taskId);
    restore({ taskId, conversationId: conversations.get(taskId) ?? "" }, [], place, (error) => {
      // Not caught up: the next change in the list, or the next refresh, tries again.
      caughtUp.delete(taskId);
      ctx.update(place.id, (run) => ({ ...run, notice: said("chat.store.catchUp", { error }) }));
    });
  };
  Object.assign(ctx, { restore, catchUp } satisfies Partial<StoreContext>);
}
