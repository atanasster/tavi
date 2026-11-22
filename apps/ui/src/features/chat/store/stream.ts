import { CLIENT_TIMEOUT, isEventOrderError, reduceRun, resumeFrom, roundCallIds, type RunOptions } from "@tavi/client/browser";
import type { ApprovalsListResult, ClientEvent, RunPayload, RunResult } from "@tavi/contracts";
import { errorMessage } from "@tavi/contracts/util";

import type { StoreContext } from "./context.js";
import { BUSY_STATUSES, CANCELLED_CODES, without, workedSince } from "./runs.js";
import { refusedAs, said, type Said } from "./said.js";
import type { CanvasRun } from "./types.js";

/** How many times a stream that lost its place is resumed before the page gives up on it. */
const ORDER_RESUMES = 3;

/**
 * What reaches a chat's stream between its turns: a plugin's line, notice or pane value, and the row a person's hold of
 * a page the turn kept adds when it is handed back. None is the task going again.
 */
const BETWEEN_TURN_KINDS: ReadonlySet<ClientEvent["kind"]> = new Set([
  "plugin.status",
  "plugin.notice",
  "plugin.state",
  "browser.controlled",
]);

/**
 * The events that must be on screen the moment they arrive: every one of them
 * either asks the reader for something or ends the task. They bypass the
 * repaint batch (`paint.ts`), so a decision is never a frame late.
 */
export const BLOCKING_KINDS: ReadonlySet<ClientEvent["kind"]> = new Set([
  "run.started",
  "approval.required",
  "task.waiting",
  "task.review_required",
  "task.completed",
  "task.failed",
  "task.stopped",
  "resync.required",
] satisfies ClientEvent["kind"][]);

/** Each run's stream: followed, folded into its entry, held while a record is read, and let go. */
export function installStream(ctx: StoreContext): void {
  const { client, options, streams, conversations, turnPending, resumingPlace, foreignTurn, watches, gaveUp, held, reading } = ctx;
  /** Rounds already listed (`id:steps`), so each is listed once. */
  const listed = new Set<string>();
  /** Continuations whose own turn has spoken: until then a plugin's line, notice or value on the stream is from between the turns. */
  const begun = new Set<string>();
  /** Continuations a resync reached before their turn spoke: what they show next is after a gap, not their start. */
  const gapped = new Set<string>();
  const unwatch = (id: string): void => {
    clearTimeout(watches.get(id)?.timer);
    watches.delete(id);
  };
  /**
   * An earlier entry of a task the next prompt continues: its stream closed,
   * so the new turn is drawn once, and its bridge slot freed. A continuation
   * that was said never to have started is superseded rather than shown the
   * new turn as its own.
   */
  const retire = (id: string): void => {
    if (!streams.has(id) && !gaveUp.has(id)) return;
    unfollow(id);
    // The page has moved past this entry: held frames would describe a turn
    // it no longer shows, and an unanswered read would keep them for ever.
    held.delete(id);
    reading.delete(id);
    if (gaveUp.delete(id)) {
      ctx.update(id, (run) => ({
        ...run,
        error: said("chat.store.turnMoved"),
      }));
    }
  };
  /**
   * The entry's stream closed, and whatever watched its turn stopped. Frames
   * already held are kept: the record read they are waiting on is what says
   * where the task stands, and the stream may have moved on since.
   */
  const unfollow = (id: string): void => {
    turnPending.delete(id);
    begun.delete(id);
    resumingPlace.delete(id);
    foreignTurn.delete(id);
    gapped.delete(id);
    unwatch(id);
    void streams.get(id)?.close();
    streams.delete(id);
  };
  /**
   * Apply `event`, or hold it while the entry's record is being read back. The
   * hold outranks the blocking bypass: a blocking event that arrived
   * mid-read would be folded into a state the read is about to replace, so it
   * waits with the rest and reaches the screen on release.
   */
  const apply = (id: string, event: ClientEvent): void => {
    if (ctx.disposed) return;
    const queue = held.get(id);
    if (queue !== undefined) {
      queue.push(event);
      return;
    }
    applyNow(id, event);
  };

  /** The frames an entry held while its record was read, applied in the order they arrived. */
  const releaseHeld = (id: string): void => {
    const queue = held.get(id);
    held.delete(id);
    if (queue === undefined) return;
    // Through `apply`: one of these may be another resync, which holds the rest again.
    for (const event of queue) {
      try {
        apply(id, event);
      } catch (error: unknown) {
        // The fold refused a held frame. The client stored a cursor past it
        // when the hold acknowledged it, so no resume can recover the rest:
        // stop following rather than folding later events over a hole.
        ctx.failed(id, errorMessage(error));
        unfollow(id);
        return;
      }
    }
  };

  const applyNow = (id: string, event: ClientEvent): void => {
    if (event.kind === "resync.required" && resumingPlace.delete(id)) {
      const chat = ctx.find(id)?.continues;
      ctx.dropStatus((run) => ctx.chatOf(run) === chat);
      return;
    }
    // Another turn of the task ran since the last one this page saw — a message
    // from a channel into Home, a reminder, another front end: not this prompt's,
    // and not drawn as if it were.
    if (resumingPlace.has(id) && !BETWEEN_TURN_KINDS.has(event.kind)) {
      foreignTurn.add(id);
      return;
    }
    const pendingTurn = turnPending.has(id);
    // A continuation follows its chat from where the turn before stopped: what a plugin showed in between
    // is applied, but is not its turn speaking.
    const continuing = ctx.find(id)?.continues !== undefined;
    const firstOfTurn = continuing && !begun.has(id);
    // A resync before the turn spoke: what follows is after a gap, so no longer its start, a late join kept.
    if (event.kind === "resync.required" && continuing) gapped.add(id);
    const betweenTurns = firstOfTurn && BETWEEN_TURN_KINDS.has(event.kind);
    const spoke = event.kind !== "resync.required" && !betweenTurns;
    if (spoke && continuing) begun.add(id);
    const late = spoke && gaveUp.delete(id);
    // The continued turn has spoken: what the stream says now is of it.
    if (spoke && pendingTurn) {
      turnPending.delete(id);
      unwatch(id);
    }
    // The page's last task is going again (a turn the watch gave up on, say): the next prompt does not reply into it.
    // A plugin's line, notice or value is not the task working.
    if (
      spoke &&
      !BETWEEN_TURN_KINDS.has(event.kind) &&
      event.kind !== "task.completed" &&
      event.kind !== "task.failed" &&
      event.kind !== "task.stopped" &&
      ctx.settled === event.runId &&
      ctx.state.runs.at(-1)?.id === id
    )
      ctx.settled = undefined;
    ctx.update(
      id,
      (current) => {
        // A turn the watch said had not started has: its error is taken back.
        const run: CanvasRun = late ? without(current, "error") : current;
        let next = reduceRun(run.run, event);
        // A continued turn's first event is where it starts, not a late join: the earlier turns are on the page.
        if (firstOfTurn && !gapped.has(id) && event.kind !== "resync.required") next = { ...next, truncated: false };
        // A follow-up turn resumes the task, so its stream opens with a resume boundary: the entry says it continues the task already.
        if (firstOfTurn && !gapped.has(id) && spoke && event.kind === "attempt.replaced" && event.discarded !== true) {
          next = {
            ...next,
            transcript: next.transcript.filter((entry) => !(entry.kind === "boundary" && entry.attemptId === event.attemptId)),
          };
        }
        // A decision is held until its round is no longer pending; an abort until the turn ends.
        const deciding =
          run.deciding !== undefined && next.pending.some((round) => round.steps === run.deciding) ? run.deciding : undefined;
        return {
          ...without(run, "notice"),
          ...(spoke && run.recordedHistory !== undefined ? { recordedHistory: without(run.recordedHistory, "metrics") } : {}),
          run: next,
          ...(event.kind === "plugin.status" && !(run.pluginStatusSeen ?? []).includes(event.pluginId)
            ? { pluginStatusSeen: [...(run.pluginStatusSeen ?? []), event.pluginId] }
            : {}),
          ...(BLOCKING_KINDS.has(event.kind) || event.kind === "approval.settled"
            ? { needsRevision: `${event.epoch}:${event.sequence}` }
            : {}),
          ...(next.review !== run.run.review ? { artifacts: [], reviewBusy: false, reviewError: "" } : {}),
          ...(event.kind === "task.waiting" ? { questionId: `${event.epoch}:${event.sequence}` } : {}),
          ...(event.kind === "approval.required"
            ? { approvalHistory: { ...run.approvalHistory, ...Object.fromEntries(next.pending.map((round) => [round.steps, round])) } }
            : {}),
          // A resync is the owner answering a rebind, not the task working: its
          // `at` is when this page reconnected, so it must not move the clock
          // the strip measures.
          ...(spoke && !BETWEEN_TURN_KINDS.has(event.kind)
            ? { startedAt: run.startedAt ?? event.at, lastAt: event.at, activeMs: (run.activeMs ?? 0) + workedSince(run, event.at) }
            : {}),
          deciding,
          aborting: run.aborting && next.status === "running",
          // A resync is the only event that leaves the page not knowing where the task stands.
          ...(event.kind === "resync.required" ? { notice: said("chat.store.restarted") } : {}),
        };
      },
      BLOCKING_KINDS.has(event.kind),
    );
    // A queued prompt sent into this turn is shown in it: its queued entry goes.
    if (event.kind === "turn.steered") ctx.dropSteered(event.runId, event.messageId);
    if (event.kind === "approval.required" && !listed.has(`${id}:${event.steps}`)) {
      listed.add(`${id}:${event.steps}`);
      listRound(id, event.runId, event.steps);
    }
    // Decided: the round is never listed again, so its mark is not kept either.
    if (event.kind === "approval.settled") listed.delete(`${id}:${event.steps}`);
    // Not while a continuation's turn has yet to speak: the record may still
    // show the turn before it. Its watch reads the record again, soon, and
    // tells a turn admitted since (which ran unseen) from none.
    if (event.kind === "resync.required") {
      // The reducer reset this entry's lines; the chat's earlier turns' are no more current.
      ctx.dropStatus((run) => ctx.chatOf(run) === event.runId);
      if (pendingTurn) ctx.watch(id);
      else ctx.readRecord(id, event.runId);
    }
    // A settled task says nothing more: followed on, an owner restart would
    // replay a resync over the transcript it ended with.
    if (event.kind === "task.completed" || event.kind === "task.failed" || event.kind === "task.stopped") {
      unfollow(id);
      // A replay's turns are read together, once it is through (`restore`).
      if (ctx.find(id)?.restored !== true) ctx.attachMemoryUsed(event.runId, [{ id, at: event.at }]);
      if (event.kind !== "task.failed" || !CANCELLED_CODES.has(event.errorCode)) ctx.settles(id, event.runId);
      else ctx.dropQueued(event.runId, said("chat.store.cancelledQueued"));
    }
  };

  /** Every pending approval row the owner holds for a task; each caller says its own why. */
  const pendingRows = (taskId: string) =>
    client.request("approvals", { action: "list", taskId, workspaceId: options.workspaceId, limit: 1000 });

  /** The owner's pending rows for the round: its whole call set, which the buttons wait for. */
  const listRound = (id: string, taskId: string, steps: number): void => {
    pendingRows(taskId)
      .then((answer) => {
        if (!answer.ok) {
          ctx.failed(id, said("chat.store.roundFailed", { steps, code: answer.error?.code ?? "?" }));
          return;
        }
        const calls = [...roundCallIds((answer.result as ApprovalsListResult).rows, steps)];
        ctx.update(id, (run) => ({ ...run, roundCalls: { ...run.roundCalls, [steps]: calls } }));
      })
      .catch((error: unknown) => ctx.failed(id, errorMessage(error)));
  };
  /** Follow a run's stream; one that lost its place is resumed from the last event applied. */
  const following = (id: string, resumes = 0): RunOptions => ({
    onEvent: (event) => apply(id, event),
    onEnd: (error) => {
      if (ctx.disposed) return;
      streams.delete(id);
      if (error === undefined) return;
      const run = ctx.find(id);
      const taskId = run?.run.taskId;
      if (isEventOrderError(error) && run !== undefined && taskId !== undefined && resumes < ORDER_RESUMES) {
        client
          .subscribe(taskId, { from: resumeFrom(run.run), ...following(id, resumes + 1) })
          .then((opened) => {
            if (ctx.disposed) {
              void opened.subscription?.close();
              return;
            }
            if (opened.subscription !== undefined) streams.set(id, opened.subscription);
            else if (!opened.response.ok) ctx.failed(id, refusedAs(opened.response, said("chat.store.resumeRefused")));
          })
          .catch((failure: unknown) => ctx.failed(id, errorMessage(failure)));
        return;
      }
      ctx.failed(id, isEventOrderError(error) ? said("chat.store.lostPlace") : errorMessage(error));
    },
  });

  const start = (id: string, payload: RunPayload, rejoined: boolean): void => {
    if (ctx.disposed) return;
    // A refused or failed run made no chat: the next message starts the private one *New private chat* asked for.
    const refused = (error: Said): void => {
      ctx.failed(id, error);
      if (payload.memory !== "private") return;
      ctx.freshPrivate = true;
      ctx.fresh = true;
      ctx.sideParent = undefined;
      ctx.sideNotice = undefined;
      ctx.publish(ctx.state);
    };
    client
      .run(payload, following(id))
      .then((opened) => {
        if (ctx.disposed) {
          void opened.subscription?.close();
          return;
        }
        if (opened.subscription !== undefined) streams.set(id, opened.subscription);
        if (opened.response.ok) {
          // The run's conversation: where a later prompt continues its task.
          const run = opened.response.result as RunResult | undefined;
          if (run?.conversationId !== undefined) conversations.set(run.taskId, run.conversationId);
          // What the owner could not do of what the message asked: said on its entry.
          const remark = [
            run?.modelSaved === false ? said("chat.store.modelNotSaved") : undefined,
            payload.folderAttachments === undefined ? undefined : run?.folder?.note,
          ].filter((line) => line !== undefined);
          if (remark.length > 0) ctx.update(id, (entry) => ({ ...entry, remark }));
          if (run !== undefined && payload.target === "home") {
            // Home's earlier entries on the page follow it no more: this turn is this entry's.
            // Not one whose turn still runs: its stream is how the rest of that turn reaches it.
            for (const earlier of ctx.state.runs)
              if (
                earlier.id !== id &&
                (earlier.run.taskId === run.taskId || earlier.continues === run.taskId) &&
                !BUSY_STATUSES.has(earlier.run.status)
              )
                retire(earlier.id);
            if (ctx.state.home !== run.taskId) ctx.publish({ ...ctx.state, home: run.taskId });
          }
          if (run !== undefined && ctx.state.runs.at(-1)?.id === id) ctx.remember(run.taskId);
          return;
        }
        // A timed-out admission may have started: once, the same key rejoins it rather than starting another.
        if (opened.response.error?.code === CLIENT_TIMEOUT && !rejoined) {
          start(id, payload, true);
          return;
        }
        refused(refusedAs(opened.response, said("chat.store.runRefused")));
      })
      .catch((error: unknown) => refused(errorMessage(error)));
  };
  Object.assign(ctx, { unwatch, retire, unfollow, apply, releaseHeld, following, start, pendingRows } satisfies Partial<StoreContext>);
}
