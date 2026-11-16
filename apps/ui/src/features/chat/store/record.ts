import { initialRunState, pendingRoundsOf, recordedStateOf, type RecordedTask, type RunState, seedSuspension } from "@tavi/client/browser";
import {
  type ApprovalsListResult,
  MEMORY_USED_READS,
  MEMORY_USED_RETRY_MS,
  type TranscriptEntry as SavedTurn,
  savedTurnAfter,
  TURN_STOPPED_MESSAGE,
  type TranscriptPage,
} from "@tavi/contracts";
import { definedOnly, errorMessage } from "@tavi/contracts/util";

import { refusal } from "../../../lib/ipc.js";
import { admissionPrompt, loadTaskRecord, loadTranscriptPage, type TaskRecord } from "../tasks-api.js";
import type { StoreContext } from "./context.js";
import { cancelledEntry, savedAttemptId, savedEntries, without } from "./runs.js";
import type { CanvasRun, CanvasStore, EndedTurn } from "./types.js";

/** The prompts of a task's turns that ran, in order: a queued or refused admission has no turn yet. */
export function promptsOf(record: RecordedTask): string[] {
  return (record.admissions ?? []).flatMap((admission) => {
    if (admission.state === "pending" || admission.state === "refused") return [];
    const prompt = admissionPrompt(admission);
    return prompt === undefined ? [] : [prompt];
  });
}

/** The reason a cancelled task's record gives ("" with none); undefined for a task not cancelled. */
export function cancelReasonOf(record: TaskRecord): string | undefined {
  return recordedStateOf(record).kind === "cancelled" ? (record.cancellations?.[0]?.reason ?? "") : undefined;
}

/** A saved turn's taint, as a run's state keeps it. */
function savedTaint(saved: SavedTurn): Pick<RunState, "tainted" | "knownUrls"> {
  if (saved.turn.tainted !== true) return {};
  return saved.turn.knownUrls === undefined ? { tainted: true } : { tainted: true, knownUrls: saved.turn.knownUrls };
}

/** A task record read as the store reads one: by the client's own deadline, a wordless refusal "refused". */
export const RECORD_READ = { timeoutMs: null, refused: "refused" } as const;

/** A task's record and saved history, read back where the stream no longer holds them. */
export function installRecord(ctx: StoreContext): void {
  const { client, options, recordReleased, held, reading } = ctx;
  /** A saved turn as a page entry: its prompt, its text and tool lines, and how it ended. */
  const savedRun = (saved: SavedTurn): CanvasRun => {
    const attemptId = savedAttemptId(saved);
    const transcript = savedEntries(saved);
    const { outcome } = saved.turn;
    const run: RunState = {
      ...initialRunState({ taskId: saved.taskId }),
      transcript,
      // A turn that waited was taken up again by a later one: what it ended in is history.
      status: outcome.status === "failed" || outcome.status === "stopped" ? outcome.status : "completed",
      ...(outcome.status === "completed"
        ? { outcome: { kind: "completed" as const, finalText: outcome.finalText ?? "" } }
        : outcome.status === "failed"
          ? { outcome: { kind: "failed" as const, errorCode: outcome.errorCode ?? "FAILED", message: outcome.message ?? "" } }
          : outcome.status === "stopped"
            ? { outcome: { kind: "stopped" as const, message: outcome.message ?? TURN_STOPPED_MESSAGE } }
            : {}),
      // Its links are drawn as they streamed: a novel one in a tainted turn names its host and asks.
      ...savedTaint(saved),
    };
    return {
      ...ctx.entry(attemptId, saved.turn.prompt ?? "", {
        restored: true,
        run,
      }),
      seq: saved.seq,
      memorySeq: saved.seq,
      ...(saved.turn.memoryUsed === undefined ? {} : { memoryUsed: saved.turn.memoryUsed }),
      startedAt: saved.createdAt,
      lastAt: saved.createdAt,
    };
  };
  /** The chat's saved turns back to `since`, oldest first: as many pages as that takes. A page refused ends the read with what it has. */
  const savedSince = async (taskId: string, since: number): Promise<readonly SavedTurn[]> => {
    const saved: SavedTurn[] = [];
    let before: number | undefined;
    do {
      const page = await loadTranscriptPage(client, options.workspaceId, taskId, before);
      if (ctx.disposed || !page.ok) break;
      saved.unshift(...page.value.entries);
      before = page.value.nextBefore;
    } while (before !== undefined && Date.parse(saved[0]?.createdAt ?? "") > since);
    return saved;
  };
  /**
   * What turns of a chat used, once they settled: a turn sent from this page, or those a replay
   * drew. A turn's saved turn is the chat's first saved at or after its end and before the next
   * turn's end (the turn is saved just after its end event), read a few times while the owner
   * saves the newest. Best effort: no chip, rather than a wrong one.
   */
  const attachMemoryUsed = (taskId: string, ended: readonly EndedTurn[], tries = 0): void => {
    const oldest = Date.parse(ended[0]?.at ?? "");
    const last = ended.at(-1);
    if (ctx.disposed || last === undefined || Number.isNaN(oldest)) return;
    void savedSince(taskId, oldest)
      .then((saved) => {
        if (ctx.disposed) return;
        const found = new Map(
          ended.flatMap((turn, index) => {
            const own = savedTurnAfter(saved, turn.at);
            const next = ended[index + 1]?.at;
            return own === undefined || (next !== undefined && Date.parse(own.createdAt) >= Date.parse(next))
              ? []
              : [[turn.id, own] as const];
          }),
        );
        if (!found.has(last.id) && tries < MEMORY_USED_READS)
          setTimeout(() => attachMemoryUsed(taskId, [last], tries + 1), MEMORY_USED_RETRY_MS);
        if (found.size === 0) return;
        ctx.publish(
          {
            ...ctx.state,
            runs: ctx.state.runs.map((run) => {
              const own = found.get(run.id);
              if (own === undefined || run.memorySeq !== undefined) return run;
              return {
                ...run,
                memorySeq: own.seq,
                ...(own.turn.memoryUsed === undefined ? {} : { memoryUsed: own.turn.memoryUsed }),
                // A taint the stream did not carry (joined late, an older owner) is kept from the saved turn.
                ...(own.turn.tainted === true && run.run.tainted !== true ? { run: { ...run.run, ...savedTaint(own) } } : {}),
              };
            }),
          },
          false,
        );
        // The read shows its own failure on the run; this only ends the chain.
      })
      .catch(() => undefined);
  };
  /**
   * A page of `taskId`'s saved history placed: `runs` in place of the page's,
   * where the next page back begins noted (or that none remains), and the
   * page's notices put among its turns — an epoch divider the newest few of a
   * poll may not name.
   */
  const withEarlier = (taskId: string, page: TranscriptPage, runs: readonly CanvasRun[]): void => {
    const { [taskId]: _old, ...earlier } = ctx.state.earlier ?? {};
    ctx.publish({ ...ctx.state, runs, earlier: page.nextBefore === undefined ? earlier : { ...earlier, [taskId]: page.nextBefore } });
    if (page.notices !== undefined && page.notices.length > 0) ctx.putNotices(taskId, page.notices);
  };
  /** The newest page of `taskId`'s saved history, in place of a restored entry the stream could no longer fill. */
  const showSaved = (id: string, taskId: string): void => {
    void loadTranscriptPage(client, options.workspaceId, taskId)
      .then((page) => {
        const shown = ctx.find(id);
        // Only an entry that still shows nothing of its turns is replaced.
        if (ctx.disposed || !page.ok || page.value.entries.length === 0 || shown === undefined || shown.run.transcript.length > 0) return;
        const saved = page.value.entries.map(savedRun);
        const last = saved.at(-1);
        // The last saved turn keeps the entry's id, so what follows it (a continuation, its stream) still finds it.
        // The entry keeps all it had (an error, its continuation, its record) and gains the turn's prompt and lines.
        const replaced = saved.slice(0, -1).concat(
          last === undefined
            ? []
            : [
                {
                  ...shown,
                  prompt: last.prompt,
                  ...definedOnly({ seq: last.seq, memorySeq: last.memorySeq, memoryUsed: last.memoryUsed }),
                  run: {
                    ...shown.run,
                    transcript: last.run.transcript,
                    ...(last.run.tainted === true ? { tainted: true as const } : {}),
                    ...(last.run.knownUrls === undefined ? {} : { knownUrls: last.run.knownUrls }),
                  },
                },
              ],
        );
        withEarlier(
          taskId,
          page.value,
          ctx.state.runs.flatMap((run) => (run.id === id ? replaced : [run])),
        );
      })
      .catch(() => undefined);
  };
  /** The task of entry `id` was cancelled: a cancel may reach no stream, a stopped chat's say, so the record's stands over its last turn. */
  const cancelled = (id: string, taskId: string, reason: string): void => {
    if (ctx.settled === taskId) ctx.settled = undefined;
    ctx.update(id, (run) => cancelledEntry(run, reason));
    ctx.dropQueued(taskId, "The chat was cancelled, so this prompt was not sent.");
  };
  /**
   * What a resync erased from the stream, read back from the task's record (as
   * the TUI does). The entry's frames are held for as long as the read runs,
   * so none is folded into a state the read is about to replace.
   */
  const readRecord = (id: string, taskId: string): void => {
    held.set(id, held.get(id) ?? []);
    reading.set(id, (reading.get(id) ?? 0) + 1);
    void (async () => {
      const answer = await loadTaskRecord(client, taskId, RECORD_READ);
      if (ctx.disposed) return;
      if (!answer.ok) {
        ctx.failed(id, `could not read task ${taskId}'s record: ${answer.message}`);
        return;
      }
      const document = answer.value;
      // The record's prompts are the whole chat's: those its earlier entries on the page already show are not this one's.
      const runs = ctx.state.runs;
      const at = runs.findIndex((run) => run.id === id);
      const chat = at === -1 ? undefined : ctx.chatOf(runs[at] as CanvasRun);
      const shownBefore = runs
        .slice(0, Math.max(at, 0))
        .filter((run) => chat !== undefined && ctx.chatOf(run) === chat)
        .reduce((count, run) => count + (run.recordedPrompts?.length ?? 0) + (run.prompt === "" ? 0 : 1), 0);
      const prompts = promptsOf(document).slice(shownBefore);
      const recorded = recordedStateOf(document);
      /** Whether the record's ending was applied: not when the stream moved on while it was read. */
      let applied = false;
      const settle = (change: (run: CanvasRun) => CanvasRun): void =>
        ctx.update(id, (run) => {
          // The stream moved on while the record was read: it speaks for itself.
          if (run.run.status !== "unknown" && run.run.status !== "idle") return run;
          applied = true;
          // The "reading where it stands" notice is answered now; a change may set its own.
          return change({
            ...without(without(run, "notice"), "recordedPrompts"),
            ...(prompts.length ? { prompt: prompts.join("\n\n") } : {}),
            // Several turns' prompts in one entry: no one turn to rewind to.
            ...(prompts.length > 1 ? { merged: true as const } : {}),
            ...(document.history === undefined
              ? {}
              : {
                  recordedHistory: document.history,
                  ...definedOnly({
                    startedAt: document.history.startedAt,
                    lastAt: document.history.lastAt,
                    activeMs: document.history.activeMs,
                  }),
                }),
            notice: "The owner no longer holds this chat’s earlier turns. Showing its recorded prompts and outcome.",
          });
        });
      // A Home a schedule started has no turn to show yet, only its notices.
      if (document.task?.chatKind === "home" && (document.admissions ?? []).length === 0) {
        settle((run) => ({
          ...run,
          noTurn: true,
          run: { ...run.run, status: "completed", outcome: { kind: "completed", finalText: "" } },
        }));
        if (applied) {
          ctx.unfollow(id);
          ctx.settles(id, taskId);
        }
        return;
      }
      if (recorded.kind === "live") {
        settle((run) => run);
        return;
      }
      // A queued event is newer evidence than this terminal snapshot. Let
      // the held stream decide both status and whether its subscription ends.
      if (
        (held.get(id)?.length ?? 0) > 0 &&
        (recorded.kind === "cancelled" ||
          recorded.ending.kind === "completed" ||
          recorded.ending.kind === "failed" ||
          recorded.ending.kind === "stopped")
      )
        return;
      if (recorded.kind === "cancelled") {
        // As with a stop: the owner's notice stands only where no saved turn takes the stream's place.
        settle((run) => (document.history === undefined ? run : without(run, "notice")));
        if (!applied) return;
        cancelled(id, taskId, cancelReasonOf(document) ?? "");
        showSaved(id, taskId);
        ctx.unfollow(id);
        return;
      }
      const ending = recorded.ending;
      if (ending.kind === "approval") {
        const listedRows = await ctx.pendingRows(taskId);
        if (!listedRows.ok) {
          ctx.failed(id, `could not list task ${taskId}'s pending calls: ${refusal(listedRows, "refused")}`);
          return;
        }
        const { rounds } = pendingRoundsOf(taskId, (listedRows.result as ApprovalsListResult).rows);
        settle((run) => ({
          ...run,
          run: seedSuspension(run.run, { pending: rounds }),
          approvalHistory: { ...run.approvalHistory, ...Object.fromEntries(rounds.map((round) => [round.steps, round])) },
          // Listed whole: the rows are each round's call set.
          roundCalls: {
            ...run.roundCalls,
            ...Object.fromEntries(rounds.map((round) => [round.steps, round.requests.map((request) => request.callId)])),
          },
        }));
        return;
      }
      if (ending.kind === "waiting") {
        const { kind: _kind, ...waiting } = ending;
        settle((run) => ({ ...run, run: seedSuspension(run.run, { waiting }) }));
        return;
      }
      if (ending.kind === "review") {
        const steps = ending.steps;
        settle((run) => ({
          ...run,
          artifacts: [],
          reviewBusy: false,
          reviewError: "",
          run: seedSuspension(run.run, { review: { steps, requests: ending.requests } }),
        }));
        return;
      }
      settle((run) =>
        ending.kind === "stopped"
          ? // As it read when it stopped. The owner's notice stands only where no saved turn takes the stream's place.
            {
              ...(document.history === undefined ? run : without(run, "notice")),
              run: { ...run.run, status: "stopped", outcome: { kind: "stopped", message: ending.message } },
            }
          : ending.kind === "completed"
            ? {
                // As with a stop: the notice stands only where no saved turn takes the stream's place.
                ...(document.history === undefined
                  ? {
                      ...run,
                      notice:
                        "The chat finished while the page was away. The owner no longer holds its earlier turns; showing the recorded prompts and outcome.",
                    }
                  : without(run, "notice")),
                run: { ...run.run, status: "completed", outcome: { kind: "completed", finalText: document.task?.finalText ?? "" } },
              }
            : {
                ...run,
                run: { ...run.run, status: "failed" },
                error: `the chat failed${ending.reason === undefined ? "" : `: ${ending.reason}`}`,
              },
      );
      // What the owner no longer holds of the stream, its saved history has.
      if (applied) showSaved(id, taskId);
      // Only an ending the page shows makes the task the one the next prompt
      // continues — and, settled, its stream says nothing more.
      if (applied && (held.get(id)?.length ?? 0) === 0) {
        ctx.unfollow(id);
        ctx.settles(id, taskId);
      }
    })()
      .catch((error: unknown) => ctx.failed(id, errorMessage(error)))
      .finally(() => {
        const left = (reading.get(id) ?? 1) - 1;
        if (left > 0) {
          reading.set(id, left);
          return;
        }
        reading.delete(id);
        ctx.releaseHeld(id);
        recordReleased.get(id)?.();
      });
  };
  const loadEarlier: CanvasStore["loadEarlier"] = (taskId) => {
    const before = ctx.state.earlier?.[taskId];
    if (before === undefined) return;
    void loadTranscriptPage(client, options.workspaceId, taskId, before)
      .then((page) => {
        if (ctx.disposed || !page.ok || ctx.state.earlier?.[taskId] !== before) return;
        const older = page.value.entries.map(savedRun);
        const at = ctx.state.runs.findIndex((run) => run.run.taskId === taskId);
        withEarlier(
          taskId,
          page.value,
          at === -1 ? ctx.state.runs : [...ctx.state.runs.slice(0, at), ...older, ...ctx.state.runs.slice(at)],
        );
        // The read shows its own failure on the run; this only ends the chain.
      })
      .catch(() => undefined);
  };
  Object.assign(ctx, { savedRun, attachMemoryUsed, cancelled, readRecord, loadEarlier } satisfies Partial<StoreContext>);
}
