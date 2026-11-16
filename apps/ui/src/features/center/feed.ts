import { CENTER_CHANGE_KINDS, type CenterChangeKind, type CenterSummaryAnswer } from "@tavi/contracts";
import { useEffect, useRef, useState } from "react";

import type { SettingsClient } from "../../lib/ipc.js";
import { loadSummary, watchCenter } from "./api.js";
import { todayIn } from "../../lib/time.js";

/**
 * The Command Center's live feed: the summary
 * once, then `center watch` from its cursor, again and again. A watch that
 * names what changed refetches the summary and tells the sections which kinds
 * moved, so each refetches only its own list. Nothing here moves focus or
 * speaks: a live update is a repaint, not an event the reader is interrupted by.
 */

/** The first wait after a failure, and the most any wait grows to. */
export const FEED_RETRY_MS = 5_000;
export const FEED_RETRY_MAX_MS = 30_000;

/** What the loop reports, as it happens. */
export interface FeedHandlers {
  readonly summary: (summary: CenterSummaryAnswer) => void;
  readonly changed: (kinds: readonly CenterChangeKind[]) => void;
  /** Why the feed is not current, in words; `undefined` once it is again. */
  readonly failed: (message: string | undefined) => void;
}

/** A wait that ends early, and quietly, when the feed is stopped. */
export type FeedSleep = (ms: number, signal: AbortSignal) => Promise<void>;

const sleepFor: FeedSleep = (ms, signal) =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done);
  });

/**
 * Follows the owner's change feed until `signal` aborts. Pure of React, so the
 * loop is asserted over a fake client.
 *
 * - A failed read waits (5 s, doubling to 30 s) and tries again; a success
 *   resets the wait.
 * - A cursor the owner refuses (`INVALID_INPUT`: another workspace's, or an
 *   older build's) is dropped, and the summary is read afresh for a new one.
 * - A summary read after the first — a resync — reports every kind as
 *   changed, since what moved while the feed was lost is unknown.
 * - The watch's cursor is kept after a change, not the refetched summary's:
 *   anything that moves between the two is reported by the next watch.
 * - A quiet watch after the workspace zone's date has moved reads the summary
 *   again, so "today" rolls over at midnight on a workspace where nothing
 *   happens. The date is the browser clock's in the summary's zone, compared
 *   with its own reading at the last summary, so a clock that disagrees with
 *   the owner's costs one read per day, not one per watch.
 */
export async function followCenter(
  client: SettingsClient,
  workspaceId: string,
  handlers: FeedHandlers,
  signal: AbortSignal,
  sleep: FeedSleep = sleepFor,
): Promise<void> {
  let cursor: string | undefined;
  let loaded = false;
  let wait = 0;
  let zone: string | undefined;
  let seenDate: string | undefined;
  const today = (): string => todayIn(zone);
  const took = (summary: CenterSummaryAnswer): void => {
    zone = summary.timezone;
    seenDate = today();
    handlers.summary(summary);
  };
  const retry = async (message: string): Promise<void> => {
    handlers.failed(message);
    wait = wait === 0 ? FEED_RETRY_MS : Math.min(FEED_RETRY_MAX_MS, wait * 2);
    await sleep(wait, signal);
  };
  while (!signal.aborted) {
    if (cursor === undefined) {
      const summary = await loadSummary(client, workspaceId);
      if (signal.aborted) return;
      if (!summary.ok) {
        await retry(summary.message);
        continue;
      }
      wait = 0;
      handlers.failed(undefined);
      took(summary.value);
      if (loaded) handlers.changed(CENTER_CHANGE_KINDS);
      loaded = true;
      cursor = summary.value.cursor;
      continue;
    }
    const watched = await watchCenter(client, workspaceId, cursor);
    if (signal.aborted) return;
    if (!watched.ok) {
      if (watched.code === "INVALID_INPUT") cursor = undefined;
      await retry(watched.message);
      continue;
    }
    wait = 0;
    handlers.failed(undefined);
    cursor = watched.value.cursor;
    const rolledOver = seenDate !== undefined && today() !== seenDate;
    if (watched.value.changed.length === 0 && !rolledOver) continue;
    if (watched.value.changed.length > 0) handlers.changed(watched.value.changed);
    const summary = await loadSummary(client, workspaceId);
    if (signal.aborted) return;
    if (summary.ok) {
      took(summary.value);
    } else {
      // The counts are stale until a summary reads again: resync from one.
      cursor = undefined;
      await retry(summary.message);
    }
  }
}

/** How many times each kind has changed since the feed started: a section's refetch key. */
export type FeedRevisions = Readonly<Partial<Record<CenterChangeKind, number>>>;

export interface CenterFeed {
  readonly summary: CenterSummaryAnswer | undefined;
  readonly error: string | undefined;
  readonly revisions: FeedRevisions;
}

/**
 * The feed, for as long as the component is mounted and `enabled` (the owner
 * advertises `center`). A new workspace starts a new feed and forgets the
 * last one's summary; unmounting, or losing the feature, stops it.
 */
export function useCenterFeed(client: SettingsClient, workspaceId: string, enabled: boolean): CenterFeed {
  const [summary, setSummary] = useState<CenterSummaryAnswer>();
  const [error, setError] = useState<string>();
  const [revisions, setRevisions] = useState<FeedRevisions>({});
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    setSummary(undefined);
    setError(undefined);
    void followCenter(
      client,
      workspaceId,
      {
        summary: setSummary,
        failed: setError,
        changed: (kinds) =>
          setRevisions((current) => {
            const next = { ...current };
            for (const kind of kinds) next[kind] = (next[kind] ?? 0) + 1;
            return next;
          }),
      },
      controller.signal,
    );
    return () => controller.abort();
  }, [client, workspaceId, enabled]);
  return { summary: enabled ? summary : undefined, error: enabled ? error : undefined, revisions };
}

/**
 * A section refetch key that moves at most once per `ms`: the first change
 * after a quiet spell at once, later ones folded into one read when the spell
 * is over. For a kind that moves on every page the agent opens (`browser`),
 * so a section does not reread its lists several times a second.
 */
export function useThrottledRevision(revision: number, ms: number): number {
  const [shown, setShown] = useState(revision);
  /** When the shown revision last moved (the mount counts: the section read then). */
  const moved = useRef<number | undefined>(undefined);
  if (moved.current === undefined) moved.current = Date.now();
  useEffect(() => {
    if (revision === shown) return;
    const apply = (): void => {
      moved.current = Date.now();
      setShown(revision);
    };
    const wait = (moved.current ?? 0) + ms - Date.now();
    if (wait <= 0) {
      apply();
      return;
    }
    const timer = setTimeout(apply, wait);
    return () => clearTimeout(timer);
  }, [revision, shown, ms]);
  return shown;
}
