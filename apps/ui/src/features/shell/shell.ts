import type { TaskListRow } from "@tavi/contracts";
import type { ToolCard } from "@tavi/client/browser";
import { firstLine } from "../../lib/format.js";
import { isCancelled } from "../chat/store/runs.js";
import type { CanvasRun, CanvasState } from "../chat/store/types.js";
import { translateNow } from "../../lib/i18n.js";
import { saidRecord } from "./said.js";

/**
 * The shell's pure parts: the status vocabulary every zone
 * reads a badge from, the sessions the sidebar lists, the groups it orders
 * them by, and the figures a chat may honestly show. Kept out of the
 * components so they can be asserted without a DOM, and so the sidebar, the
 * transcript and the reply footers can never disagree — all three read these.
 */

/**
 * The A2A status set the events already imply. `unknown` is tavi's
 * seventh: after a `resync.required` the page genuinely does not know where a
 * task stands, and saying `submitted` or `working` in its place is a guess.
 */
export type SessionStatus = "submitted" | "working" | "input-required" | "completed" | "stopped" | "canceled" | "failed" | "unknown";

/** A listed chat's status in the same words as a session's, with a Home's `idle` between turns: ready for the next prompt. */
export const TASK_STATUS_LABELS: Readonly<Record<TaskListRow["status"], string>> = saidRecord({
  submitted: "shell.status.submitted",
  working: "shell.status.working",
  "input-required": "shell.status.inputRequired",
  completed: "shell.status.completed",
  stopped: "shell.status.stopped",
  canceled: "shell.status.canceled",
  failed: "shell.status.failed",
  unknown: "shell.status.unknown",
  idle: "shell.status.idle",
});

/** The word for a chat's status in its header: Home between turns is ready, as the chats list says, never done. */
export function headerStatusLabel(status: SessionStatus, home: boolean): string {
  return TASK_STATUS_LABELS[home ? listedStatus({ chatKind: "home" }, status) : status];
}

/** What one entry is doing, in the one vocabulary every zone renders from. */
export function runStatus(run: CanvasRun): SessionStatus {
  // An entry that could not be started or followed is failed, whatever its
  // stream last said: the page cannot speak for it any more.
  if (run.error !== undefined) return "failed";
  switch (run.run.status) {
    case "idle":
      return "submitted";
    case "running":
      return "working";
    case "awaiting_approval":
    case "waiting":
    case "review_required":
      return "input-required";
    case "completed":
      return "completed";
    case "stopped":
      return "stopped";
    case "failed":
      return isCancelled(run.run) ? "canceled" : "failed";
    case "unknown":
      return "unknown";
  }
}

/** What Retry sends after a chat's last turn: a failed turn's prompt. A turn that was cancelled did what was asked: nothing to retry. */
export function retryPromptOf(last: CanvasRun | undefined): string | undefined {
  return last?.run.status === "failed" && runStatus(last) !== "canceled" ? last.prompt : undefined;
}

/**
 * One row of the sidebar, and what the main pane shows: a task, with every
 * turn of it this page holds (a continued prompt is a new entry of the same
 * task). An entry with no task yet — a prompt whose run has not been
 * admitted — is a session of its own until its first event names one.
 */
export interface Session {
  /** The task, or the lone entry's id before a task is known. */
  readonly key: string;
  readonly taskId: string | undefined;
  /** What the owner calls the task (`shellState`), else the first prompt this page saw, clamped to one line. */
  readonly title: string;
  /** What the task is doing: its latest turn's status. */
  readonly status: SessionStatus;
  /** Its turns, oldest first. */
  readonly runs: readonly CanvasRun[];
}

/** What a session is called: its first prompt's first line, or what it is instead. */
function titleOf(runs: readonly CanvasRun[]): string {
  for (const run of runs) {
    const first = firstLine(run.prompt);
    if (first !== "") return first;
  }
  // Never a task or operation id: they say nothing to a person.
  return translateNow(runs.some((run) => run.restored === true) ? "shell.session.earlier" : "shell.session.untitled");
}

/**
 * Each session's turns as `sessionsOf` last handed them out, by key: a session
 * whose turns are the same objects in the same order gets the same array back,
 * so what the canvas works out from it is not worked out again on every store change.
 */
let handedOut = new Map<string, readonly CanvasRun[]>();
function sameTurns(before: readonly CanvasRun[] | undefined, now: readonly CanvasRun[]): before is readonly CanvasRun[] {
  return before !== undefined && before.length === now.length && before.every((run, index) => run === now[index]);
}

/** The page's entries as sessions, in the order their first turn arrived. */
export function sessionsOf(runs: readonly CanvasRun[]): readonly Session[] {
  const order: string[] = [];
  const byKey = new Map<string, CanvasRun[]>();
  for (const run of runs) {
    const key = run.run.taskId ?? run.continues ?? run.id;
    const kept = byKey.get(key);
    if (kept === undefined) {
      order.push(key);
      byKey.set(key, [run]);
    } else kept.push(run);
  }
  const next = new Map<string, readonly CanvasRun[]>();
  const sessions = order.map((key) => {
    const fresh = byKey.get(key) ?? [];
    const before = handedOut.get(key);
    const kept = sameTurns(before, fresh) ? before : fresh;
    next.set(key, kept);
    const last = kept.at(-1);
    return {
      key,
      taskId: kept.find((run) => run.run.taskId !== undefined)?.run.taskId,
      title: titleOf(kept),
      // A cancel is final: a prompt left queued behind it, refused for that, does not make the chat failed.
      status: last === undefined ? "submitted" : kept.some((run) => isCancelled(run.run)) ? "canceled" : runStatus(last),
      runs: kept,
    };
  });
  handedOut = next;
  return sessions;
}

/**
 * How many sessions are waiting on the reader — the header count, and the tab
 * title's. It counts **this page's** sessions only: the workspace's other
 * needs-bearing tasks need the owner's own query, so the header
 * says which it is rather than pretending to be total.
 */
export function needsCount(sessions: readonly Session[]): number {
  return sessions.reduce((count, session) => (session.status === "input-required" ? count + 1 : count), 0);
}

/**
 * The figures the footer strip may show. Tokens, cost, context % and
 * tok/s are **not** here: a figure with no source is shown as absent, never
 * estimated. `metrics.ts` holds the list and the reason for each.
 */
export interface SessionStats {
  /**
   * Working time: the sum of each entry's `activeMs` — the time between its
   * events while it was running, or its record's executions' summed spans —
   * so a running task's figure advances as its events arrive, never on a
   * browser clock, and a round waiting on a person or a night between turns
   * is not in it. Absent before the first event, and for a replayed turn
   * whose stamps the page never saw. A resync does not move it: its stamp is
   * when the page rebound, not when the task last worked.
   * `metrics.ts` says what else is not measured, and why.
   */
  readonly elapsedMs: number | undefined;
  /** Tool calls the session has made, folded out of the window or not. */
  readonly tools: number | undefined;
}

/** Reconcile task-wide snapshots with retained turns, keeping each call once. */
export function sessionToolGroups(session: Session) {
  const groups = session.runs.map((run) => ({ run, cards: [] as ToolCard[] }));
  const saved = new Map<string, { card: ToolCard; group: number }>();
  const identity = (card: ToolCard) => JSON.stringify([card.attemptId, card.callId]);
  for (const [index, run] of session.runs.entries()) {
    for (const card of run.recordedHistory?.tools ?? []) saved.set(identity(card), { card, group: index });
  }
  const streamed = new Set<string>();
  for (const group of groups) {
    for (const card of group.run.run.transcript) {
      if (card.kind !== "tool" || streamed.has(card.key)) continue;
      streamed.add(card.key);
      const previous = saved.get(identity(card));
      saved.delete(identity(card));
      // A later snapshot can finish a call whose stream ended mid-dispatch.
      const finished = previous?.card.status === "completed" || previous?.card.status === "failed";
      const pending = card.status === "running" || card.status === "interrupted";
      group.cards.push(previous === undefined ? card : { ...previous.card, ...(finished && pending ? {} : card) });
    }
  }
  for (const { card, group } of saved.values()) groups[group]?.cards.push(card);
  return groups;
}

export function sessionStats(session: Session): SessionStats {
  // Working time, summed per entry: the gaps between turns, and the waits on a
  // person inside one, are not in it. An entry with no working time measured
  // (an older owner's record) counts its own span, never the chat's.
  const spans = session.runs.flatMap((run) => {
    if (run.activeMs !== undefined) return [run.activeMs];
    const span = run.startedAt === undefined || run.lastAt === undefined ? Number.NaN : Date.parse(run.lastAt) - Date.parse(run.startedAt);
    return Number.isFinite(span) && span >= 0 ? [span] : [];
  });
  return {
    elapsedMs: spans.length === 0 ? undefined : spans.reduce((total, span) => total + span, 0),
    tools: sessionToolGroups(session).reduce((count, group) => count + group.cards.length, 0),
  };
}

/**
 * The session the main pane and the inspector describe: the one the
 * reader selected, or the newest the page holds. A selection the page no
 * longer has (a retired continuation) falls back to the newest rather than
 * blanking every zone at once.
 */
export function selectedSession(sessions: readonly Session[], selected: string | undefined): Session | undefined {
  if (selected === undefined) return sessions.at(-1);
  // A session is keyed by its operation key until `run.started` names its task,
  // and by the task after: a selection made in that window is the same session,
  // not a disappeared one, so its entries are looked through before giving up.
  return (
    sessions.find((session) => session.key === selected) ??
    sessions.find((session) => session.runs.some((run) => run.id === selected)) ??
    sessions.at(-1)
  );
}

/** The whole shell's derived state, computed once per repaint and read by every zone. */
export interface ShellState {
  readonly sessions: readonly Session[];
  readonly needs: number;
  /** The session the reader is looking at: what the main pane and the chords act on. */
  readonly current: Session | undefined;
  /**
   * The session the **next prompt** acts on: the page's last, whatever the
   * reader is browsing. The sidebar lets the two diverge, and what the
   * composer says has to follow this one rather than `current`.
   */
  readonly acting: Session | undefined;
}

/** Only an ask event received after the read began may supersede the projection. */
/**
 * A listed chat's status from its latest turn's: a Home's finished turn leaves
 * it `idle`, never `completed` or `failed` — a chat that never ends, as the owner's list says it.
 */
function listedStatus(row: Pick<TaskListRow, "chatKind">, status: SessionStatus): TaskListRow["status"] {
  // A stopped turn leaves Home ready, as a finished one does.
  return row.chatKind === "home" && (status === "completed" || status === "failed" || status === "stopped" || status === "canceled")
    ? "idle"
    : status;
}
/**
 * Whether a run's live state is older news than the listed row: its needs were already observed by the list. A turn
 * running with events newer than the row is not: the list was polled while the owner had not yet recorded the
 * decision that started it (an approval just given), and its "needs you" is stale.
 */
function observedByList(state: CanvasState, run: CanvasRun, taskId: string, rowUpdatedAt: string | undefined): boolean {
  if (!run.needsRevision) return true;
  if (run.needsRevision !== state.directory?.observedNeeds?.[taskId]) return false;
  return !(run.run.status === "running" && rowUpdatedAt !== undefined && (run.lastAt ?? "") > rowUpdatedAt);
}

export function directoryRows(state: CanvasState, workspaceId: string): readonly TaskListRow[] {
  // A session is made from its runs, so each has a last one.
  const latest = new Map(
    sessionsOf(state.runs).flatMap((session) => {
      const last = session.runs.at(-1);
      return last === undefined ? [] : [[session.taskId, last] as const];
    }),
  );
  return (state.directory?.rows ?? [])
    .filter((row) => row.workspaceId === workspaceId)
    .map((row) => {
      const run = latest.get(row.taskId);
      if (
        !run ||
        run.error ||
        (run.run.workspaceId && run.run.workspaceId !== workspaceId) ||
        observedByList(state, run, row.taskId, row.updatedAt)
      )
        return row;
      return {
        ...row,
        status: listedStatus(row, runStatus(run)),
        needs: run.run.status === "unknown" ? row.needs : [...new Set([...asksOf(run), ...(row.descendantNeeds ?? [])])],
        updatedAt: run.lastAt ?? row.updatedAt,
      };
    });
}
function asksOf(run: CanvasRun): TaskListRow["needs"] {
  return [
    ...(run.run.pending.length ? ["approval" as const] : []),
    ...(run.run.review ? ["review" as const] : []),
    ...(run.run.waiting?.handoff
      ? ["handoff" as const]
      : run.run.waiting?.connect
        ? ["connect" as const]
        : run.run.waiting?.question
          ? ["question" as const]
          : []),
  ];
}
function workspaceNeeds(state: CanvasState, workspaceId: string): number {
  const rows = directoryRows(state, workspaceId);
  const needs = new Set(rows.filter((row) => row.needs.length).map((row) => row.taskId));
  for (const row of state.directory?.needs ?? [])
    if (row.workspaceId === workspaceId && !rows.some((listed) => listed.taskId === row.taskId)) needs.add(row.taskId);
  for (const session of sessionsOf(state.runs)) {
    const run = session.runs.at(-1);
    if (
      run === undefined ||
      !session.taskId ||
      run.error ||
      run.run.status === "unknown" ||
      (run.run.workspaceId && run.run.workspaceId !== workspaceId)
    )
      continue;
    const listed = [...rows, ...(state.directory?.needs ?? [])].find(
      (row) => row.workspaceId === workspaceId && row.taskId === session.taskId,
    );
    if (observedByList(state, run, session.taskId, listed?.updatedAt)) continue;
    if (
      asksOf(run).length ||
      [...rows, ...(state.directory?.needs ?? [])].some(
        (row) => row.workspaceId === workspaceId && row.taskId === session.taskId && row.descendantNeeds?.length,
      )
    )
      needs.add(session.taskId);
    else needs.delete(session.taskId);
  }
  return needs.size;
}

/**
 * What the owner calls a chat, when the page knows: its listed title — the
 * reader's rename, the generated title, or "Home" for the person's Home (in the page's language) — else
 * "Home" for the page's own Home. The page's first-prompt title is only the
 * fallback, so the header does not show a prompt and then flip to the owner's
 * name once the chat panel reads it.
 */
function ownerTitle(state: CanvasState, taskId: string | undefined): string | undefined {
  if (taskId === undefined) return undefined;
  const row = [...(state.directory?.rows ?? []), ...(state.directory?.needs ?? [])].find((candidate) => candidate.taskId === taskId);
  // Home's own title is stored in English: said in the page's language, as a rename is not.
  if (row?.titleSource === "home") return translateNow("shell.session.home");
  const listed = row?.title;
  if (listed !== undefined && listed.trim() !== "") return listed;
  return taskId === state.home ? translateNow("shell.session.home") : undefined;
}

export function shellState(state: CanvasState, selected: string | undefined, workspaceId = "default"): ShellState {
  const sessions = sessionsOf(state.runs).map((session) => {
    const title = ownerTitle(state, session.taskId);
    return title === undefined || title === session.title ? session : { ...session, title };
  });
  const current = selectedSession(sessions, selected);
  return {
    sessions,
    needs: state.directory === undefined ? needsCount(sessions) : workspaceNeeds(state, workspaceId),
    current,
    acting: sessions.at(-1),
  };
}
