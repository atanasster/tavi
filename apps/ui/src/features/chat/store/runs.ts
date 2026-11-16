import type { RunState, TranscriptEntry } from "@tavi/client/browser";
import type { TranscriptEntry as SavedTurn } from "@tavi/contracts";
import { definedOnly } from "@tavi/contracts/util";

import type { CanvasRun } from "./types.js";

/** The codes a task fails with when it was cancelled rather than broken: no further prompt can change that. */
export const CANCELLED_CODES: ReadonlySet<string> = new Set(["CANCELLED", "TASK_CANCELLED"]);

/** Whether a turn ended in its task's cancel. */
export function isCancelled(run: RunState): boolean {
  return run.status === "failed" && run.outcome?.kind === "failed" && CANCELLED_CODES.has(run.outcome.errorCode);
}

/** An entry as its cancelled task reads: `reason` is the cancel's own, and nothing about the turn is still open. */
export function cancelledEntry(entry: CanvasRun, reason: string): CanvasRun {
  return {
    ...without(entry, "error"),
    deciding: undefined,
    aborting: false,
    run: {
      ...entry.run,
      status: "failed",
      outcome: { kind: "failed", errorCode: "CANCELLED", message: reason },
      pending: [],
      waiting: undefined,
      review: undefined,
    },
  };
}

/** How the owner words a cancel on a turn's end: what follows it is the reason. */
const CANCELLED_BY = /^Task was cancelled by .*?: /u;

/** A cancelled turn's line, from a recorded reason or a turn's end. It names nobody: a heartbeat, a routine or a parent agent can cancel too. */
export function cancelledWords(message: string): string {
  const reason = message.replace(CANCELLED_BY, "").replace(/[\s.]+$/u, "");
  return reason === "" ? "This was cancelled." : `This was cancelled: ${reason}.`;
}

/** Why an answer cannot be sent while the owner is out of reach. */
export const RECONNECT_TO_ANSWER = "Reconnect to the owner to answer.";

/**
 * Why a run's question cannot be answered yet, from any surface that shows it
 * (the transcript's card, the chat panel's): a round or a review comes first,
 * or the owner is out of reach — the answer would be dropped. `wording` says
 * where the round and the review are, as each surface places them.
 */
export function questionBlocker(
  run: CanvasRun,
  connected: boolean,
  wording: { readonly round: string; readonly review: string },
): { readonly kind: "round" | "review" | "connection"; readonly text: string } | undefined {
  if (run.run.pending.length > 0) return { kind: "round", text: wording.round };
  if (run.run.review !== undefined) return { kind: "review", text: wording.review };
  if (!connected) return { kind: "connection", text: RECONNECT_TO_ANSWER };
  return undefined;
}

export const questionKey = (waiting: { readonly deadlineAt: string; readonly question?: string }, identity = ""): string =>
  `${identity}\0${waiting.deadlineAt}\0${waiting.question ?? ""}`;

/**
 * What plugins' own code published for a chat: its turns' `plugin.state`
 * merged oldest first, so each key keeps its newest value. The values are the
 * runs' own, so an unchanged key stays the same reference.
 */
export function chatPluginState(
  runs: readonly CanvasRun[],
  taskId: string | undefined,
): Readonly<Record<string, Readonly<Record<string, unknown>>>> {
  const merged: Record<string, Record<string, unknown>> = {};
  if (taskId === undefined) return merged;
  for (const run of runs) {
    if (run.run.taskId !== taskId && run.continues !== taskId) continue;
    for (const [pluginId, values] of Object.entries(run.run.pluginState)) merged[pluginId] = { ...merged[pluginId], ...values };
  }
  return merged;
}

/**
 * Plugins' status lines for a chat: each turn's lines laid over
 * the ones before, oldest first, so a line set on one turn stays until a later
 * turn sets another or clears it (a turn that cleared one has it among
 * `pluginStatusSeen` and absent from its `pluginStatus`).
 */
export function chatPluginStatus(runs: readonly CanvasRun[], taskId: string | undefined): Readonly<Record<string, string>> {
  const merged = new Map<string, string>();
  if (taskId === undefined) return {};
  for (const run of runs) {
    if (run.run.taskId !== taskId && run.continues !== taskId) continue;
    for (const pluginId of run.pluginStatusSeen ?? Object.keys(run.run.pluginStatus)) {
      const line = run.run.pluginStatus[pluginId];
      if (line === undefined) merged.delete(pluginId);
      else merged.set(pluginId, line);
    }
  }
  return Object.fromEntries(merged);
}

/** A turn still going: a prompt typed meanwhile is queued behind it. */
export const BUSY_STATUSES: ReadonlySet<string> = new Set(["running", "awaiting_approval", "review_required"]);

/** How many of a long transcript's oldest entries stay on screen. */
export const TRANSCRIPT_HEAD = 20;

/** How many of its newest. */
export const TRANSCRIPT_TAIL = 200;

/** A bounded transcript: its first entries, its last, and how many are folded away between them. */
export interface TranscriptWindow {
  readonly head: readonly TranscriptEntry[];
  /** Entries between `head` and `tail` that are not rendered; `0` when the whole transcript is. */
  readonly hidden: number;
  readonly tail: readonly TranscriptEntry[];
}

/**
 * What of `run`'s transcript is rendered: all of it while it is short or the
 * reader expanded it, otherwise its first `TRANSCRIPT_HEAD` and last
 * `TRANSCRIPT_TAIL` entries with the count of what lies between. A long task
 * must not cost a DOM node per token it ever streamed.
 */
export function transcriptWindow(run: CanvasRun): TranscriptWindow {
  const all = run.run.transcript;
  if (run.expanded === true || all.length <= TRANSCRIPT_HEAD + TRANSCRIPT_TAIL) return { head: all, hidden: 0, tail: [] };
  return {
    head: all.slice(0, TRANSCRIPT_HEAD),
    hidden: all.length - TRANSCRIPT_HEAD - TRANSCRIPT_TAIL,
    tail: all.slice(all.length - TRANSCRIPT_TAIL),
  };
}

/** `value` without `key`: the idiom this module uses to answer a field, spelled once. */
export function without<T extends object, K extends keyof T>(value: T, key: K): Omit<T, K> {
  const { [key]: _dropped, ...rest } = value;
  return rest;
}

/** The oldest pending round of `run`, when this page may decide it now: every call the owner listed has arrived. */
export function decidableRound(run: CanvasRun): RunState["pending"][number] | undefined {
  const round = run.run.pending[0];
  if (round === undefined || run.run.status !== "awaiting_approval" || run.deciding === round.steps) return undefined;
  const listed = run.roundCalls[round.steps];
  if (listed === undefined || listed.length === 0) return undefined;
  return listed.every((callId) => round.requests.some((request) => request.callId === callId)) ? round : undefined;
}

/** The run's turn this page may stop now: one going, on a task, with no abort already on its way. */
export function abortableRun(run: CanvasRun): boolean {
  return run.run.status === "running" && run.run.taskId !== undefined && !run.aborting;
}

/** A saved turn's attempt id: its entries' keys, stable across reads. */
export const savedAttemptId = (saved: SavedTurn): string => `saved-${saved.taskId}-${saved.seq}`;

/** The time since an entry's last event that counts as work: only while it was running, on the owner's clock. */
export function workedSince(run: Pick<CanvasRun, "lastAt" | "run">, at: string): number {
  if (run.run.status !== "running" || run.lastAt === undefined) return 0;
  const gap = Date.parse(at) - Date.parse(run.lastAt);
  return Number.isFinite(gap) && gap > 0 ? gap : 0;
}

/**
 * A saved turn's text and tool lines as transcript entries: what the
 * chat's restored turns and a worker's view-only transcript
 * both render.
 */
export function savedEntries(saved: SavedTurn): RunState["transcript"] {
  const attemptId = savedAttemptId(saved);
  return saved.turn.items.map((item, index) =>
    item.kind === "steer"
      ? { kind: "steer", key: `${attemptId}:${index}`, messageId: `${attemptId}:${index}`, text: item.text }
      : item.kind === "text" || item.kind === "question"
        ? {
            kind: "text",
            key: `${attemptId}:${index}`,
            attemptId,
            blockId: `${attemptId}:${index}`,
            text: item.kind === "question" ? `**Asked:** ${item.text}` : item.text,
          }
        : {
            kind: "tool",
            key: `${attemptId}:${index}`,
            attemptId,
            callId: item.callId,
            toolName: item.toolName,
            status: item.status,
            ...definedOnly({ errorCode: item.errorCode, message: item.message, durationMs: item.durationMs }),
          },
  );
}
