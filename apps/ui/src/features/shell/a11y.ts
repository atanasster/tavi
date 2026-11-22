import { useEffect, useRef } from "react";

import { ANNOUNCER_ID, say } from "../../hooks/use-announce.js";
import { inLastMinutes, lastMinutesSentence } from "../needs/NeedCard.js";
import { runStatus, type Session } from "./shell.js";
import { cancelledWords } from "../chat/store/runs.js";
import type { CanvasState } from "../chat/store/types.js";
import { translateNow } from "../../lib/i18n.js";

/**
 * What the page says out loud.
 *
 * Tokens are **not** announced: they stream into a plain node, and an
 * `aria-live` region over a token stream reads a letter at a time. What is
 * announced is the handful of discrete events a reader acts on — responding,
 * complete, a question, an approval, a review, stopped, failed — the
 * connection when it is not ready, how many sessions are waiting (or, with the
 * Command Center, how much waits there, and a reminder as it fires), and where
 * a prompt just sent went: queued behind the running turn, or into Home.
 *
 * There is exactly **one** region, and it lives in `index.html` so it is in
 * the accessibility tree before the bundle runs: a live region inserted
 * together with its first message is commonly missed, and the first message is
 * the one that matters. An action's note ("Saved.") is said through the same
 * region (`useAnnounce`) rather than a region of its own — two polite queues
 * interleave, and an `alert` beside them preempts both to say what the one
 * region has already said.
 */

export { ANNOUNCER_ID };

/** What the page would say about `state` now, or nothing. */
export interface AnnouncementInput {
  readonly state: CanvasState;
  /** The session the reader is looking at: the one whose card and chords are in front of them. */
  readonly current: Session | undefined;
  /** How many of this page's sessions are waiting on the reader. */
  readonly needs: number;
  /**
   * What the page itself has to say, not the store's state — a session the
   * address named that could not be opened. Said first, because it is
   * why the page in front of the reader is not the one they asked for.
   */
  readonly notice?: string | undefined;
  /**
   * The Command Center, when the owner offers it: what waits on the reader
   * there (every task's decisions, memory proposals and fired reminders), said
   * in place of this page's own sessions, and the reminders fired since the
   * page opened that are not yet done, each said by its text.
   */
  readonly center?: { readonly waiting: number; readonly reminders: readonly string[] } | undefined;
  /** The clock a question's last minutes are read against; without one they are not said (the inbox's card says them). */
  readonly now?: number | undefined;
}

/**
 * The one sentence the page would say now, or nothing. It is derived rather
 * than fired at the moment of an event, so a reader who misses one
 * announcement is not left with a stale one: the next state replaces it.
 *
 * Its subject is the session the reader is **looking at** — the same one the
 * approve, reject and stop chords act on — so what is heard and what a chord
 * would do can never describe different tasks.
 */
export function announcementOf({ state, current, needs, notice, center, now }: AnnouncementInput): string | undefined {
  const parts = [
    notice === undefined || notice === "" ? undefined : notice,
    ...(center?.reminders ?? []).map((text) => translateNow("shell.announcer.reminder", { text })),
    statusSentence(state, current, now),
    center !== undefined
      ? center.waiting > 0
        ? translateNow("shell.announcer.centerWaiting", { count: center.waiting })
        : undefined
      : needs > 0
        ? translateNow(state.directory?.needsTruncated ? "shell.announcer.chatsNeedAtLeast" : "shell.announcer.chatsNeed", { count: needs })
        : undefined,
  ].filter((part): part is string => part !== undefined);
  return parts.length === 0 ? undefined : parts.join(" ");
}

function statusSentence(state: CanvasState, session: Session | undefined, now?: number): string | undefined {
  if (state.failure !== undefined) return translateNow("shell.announcer.disconnectedBecause", { reason: state.failure });
  if (state.connection === "reconnecting") return translateNow("shell.announcer.reconnecting");
  if (state.connection === "closed") return translateNow("shell.announcer.disconnected");
  const last = session?.runs.at(-1);
  if (last === undefined) return undefined;
  // Where a prompt just sent went: said until its turn speaks.
  if (last.queued === true) return translateNow("shell.announcer.queued");
  if (last.toHome === true && last.error === undefined && last.run.status === "idle") return translateNow("shell.announcer.sentHome");
  const { waiting, review, pending } = last.run;
  switch (runStatus(last)) {
    case "input-required": {
      if (waiting?.question !== undefined) {
        // Said once more when its last five minutes begin —
        // only with a clock: where no clock is given, another surface says it.
        return now !== undefined && inLastMinutes(waiting.deadlineAt, now)
          ? lastMinutesSentence(waiting.question)
          : translateNow("shell.announcer.question", { question: waiting.question });
      }
      if (waiting !== undefined) return translateNow("shell.announcer.waitingOn", { who: waiting.on });
      if (review !== undefined) return translateNow("shell.announcer.review", { count: review.requests.length });
      const calls = pending[0]?.requests.length ?? 0;
      return translateNow("shell.announcer.permission", { count: calls });
    }
    case "working":
      return translateNow("shell.announcer.responding");
    case "submitted":
      return translateNow("shell.announcer.submitted");
    case "completed":
      return translateNow("shell.announcer.completed");
    case "stopped":
      return translateNow("shell.announcer.stopped");
    case "canceled":
      return last.run.outcome?.kind === "failed" ? cancelledWords(last.run.outcome.message) : translateNow("shell.announcer.cancelled");
    case "failed": {
      const reason = last.error ?? (last.run.outcome?.kind === "failed" ? last.run.outcome.message : undefined);
      return reason === undefined ? translateNow("shell.announcer.failedUnfinished") : translateNow("shell.announcer.failed", { reason });
    }
    case "unknown":
      return translateNow("shell.announcer.unknown");
  }
}

/**
 * Of `items` (each an event with a key, such as a fired reminder), the texts
 * to say now: each is said with the sentence it first joined, and dropped for
 * good once the rest of that sentence (`rest`) changes. The announcement is
 * derived afresh on every change, so without this one fired reminder would be
 * read out again with every unrelated update until it is done.
 */
export function useSaidOnce(
  items: readonly { readonly key: string; readonly text: string }[],
  rest: string | undefined,
): readonly string[] {
  /** Each item's sentence when it was first said; `null` once that sentence has moved on. */
  const said = useRef(new Map<string, string | undefined | null>());
  return items.flatMap((item) => {
    const known = said.current;
    if (!known.has(item.key)) {
      known.set(item.key, rest);
      return [item.text];
    }
    const sentence = known.get(item.key);
    if (sentence !== null && sentence === rest) return [item.text];
    known.set(item.key, null);
    return [];
  });
}

/**
 * Put `text` in the region `index.html` holds, and leave it empty on the way
 * out. Writing the same text again is skipped: a repeat is not a change, and
 * re-announcing one would talk over the reader every time an unrelated delta
 * arrived.
 */
export function useAnnouncer(text: string | undefined): void {
  useEffect(() => {
    if (typeof document === "undefined") return;
    const region = document.getElementById(ANNOUNCER_ID);
    if (region === null) {
      // The id in `index.html` and the one here have drifted: said once, loudly,
      // rather than degrading to a page that silently announces nothing.
      console.warn(`tavi: no #${ANNOUNCER_ID} region in the page; nothing will be announced.`);
      return;
    }
    const next = text ?? "";
    // Through `say`, so a note written in the same commit is joined, not overwritten.
    if (next !== "" && region.textContent !== next) say(next);
    return () => {
      // A page that unmounted, or moved on to saying nothing, leaves no stale
      // sentence of its own in a region the rest of the page shares.
      if (region.textContent === next) region.textContent = "";
    };
  }, [text]);
}
