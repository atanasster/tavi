import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { HeartbeatGetAnswer, HeartbeatHistoryAnswer, HeartbeatTickRecord } from "@tavi/contracts";

import type { Outcome } from "../../lib/ipc.js";
import { useCenterHeartbeatSlot } from "../plugin-host/CenterHeartbeatSlot.js";
import { useWorkspace } from "../shell/Workspace.js";
import { getHeartbeat, heartbeatLog, recentHeartbeatItems, type LogFilter } from "./heartbeat-api.js";
import type { HeartbeatItemView } from "./HeartbeatItem.js";

/**
 * Center → Heartbeat's state: the heartbeat, its log and what it told, read
 * on open and every `refreshMs` while the page shows; the page's notes and
 * open editors; and `apply`, the one way it writes.
 */
export function useHeartbeatPage(refreshMs: number, onChanged: (() => void) | undefined) {
  const { client, workspaceId } = useWorkspace();
  const [answer, setAnswer] = useState<HeartbeatGetAnswer | undefined>();
  const [ticks, setTicks] = useState<readonly HeartbeatTickRecord[]>([]);
  const [error, setError] = useState<string | undefined>();
  const [logError, setLogError] = useState<string | undefined>();
  const [items, setItems] = useState<readonly HeartbeatItemView[]>([]);
  const [itemsError, setItemsError] = useState<string | undefined>();
  /** The revision the next write names: the latest the page knows, even while another write is on its way. */
  const revisionRef = useRef(0);
  /** The config the owner last answered: what a queued edit of a list applies to, so two quick edits never undo each other. */
  const configRef = useRef<HeartbeatGetAnswer["config"] | undefined>(undefined);
  const panelSlot = useCenterHeartbeatSlot();
  /** Writes go one after another, each naming the revision the one before it left. */
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const [failure, setFailure] = useState<string | undefined>();
  const [note, setNote] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);
  /**
   * The instructions being edited: the text, the instructions it started from
   * (`base`) and the revision Save writes over. The revision moves on with any
   * change that leaves those instructions as they were (a toggle here, a
   * setting changed elsewhere), so only a change to the instructions refuses Save.
   */
  const [editing, setEditing] = useState<{ readonly text: string; readonly base: string; readonly revision: number } | undefined>();
  const followRevision = (seen: HeartbeatGetAnswer): void =>
    setEditing((open) => (open === undefined || seen.config.instructions !== open.base ? open : { ...open, revision: seen.revision }));
  const [history, setHistory] = useState<HeartbeatHistoryAnswer["history"] | undefined>();
  const [filter, setFilter] = useState<LogFilter>("all");
  const [confirmForget, setConfirmForget] = useState(false);
  const ids = useId();

  const load = useCallback(async () => {
    setLoading(true);
    const [got, log, recent] = await Promise.all([
      getHeartbeat(client, workspaceId),
      heartbeatLog(client, workspaceId),
      recentHeartbeatItems(client, workspaceId),
    ]);
    setLoading(false);
    if (!got.ok) {
      setError(got.message);
      return;
    }
    setError(undefined);
    revisionRef.current = got.value.revision;
    configRef.current = got.value.config;
    setAnswer(got.value);
    followRevision(got.value);
    if (log.ok) {
      setTicks(log.value.ticks);
      setLogError(undefined);
    } else setLogError(log.message);
    if (recent.ok) {
      setItems(recent.value.items);
      setItemsError(undefined);
    } else setItemsError(recent.message);
  }, [client, workspaceId]);
  useEffect(() => {
    void load();
  }, [load]);
  // The log, the next check and what it told move on their own: read again while the page is open, after any write on its way,
  // and only once the last read has settled, so a slow owner never piles reads up ahead of the person's writes. Not while
  // the page is hidden: the beat waits, and reads on the first one after it shows again.
  useEffect(() => {
    if (refreshMs <= 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const arm = (): void => {
      timer = setTimeout(() => {
        if (document.hidden) {
          arm();
          return;
        }
        // `load` shows its own failure on the page; the queue only orders reads.
        const read = queue.current.then(load).catch(() => undefined);
        queue.current = read;
        void read.then(() => {
          if (!stopped) arm();
        });
      }, refreshMs);
    };
    arm();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [load, refreshMs]);

  /**
   * One write, after any still on its way, naming the latest revision: the new
   * heartbeat, or the owner's refusal in its words — and on a conflict the
   * heartbeat read again, so the next change names the revision it is at.
   */
  const apply = (send: (revision: number) => Promise<Outcome<HeartbeatGetAnswer>>, said?: string): Promise<boolean> => {
    const written = queue.current.then(async () => {
      const outcome = await send(revisionRef.current);
      if (!outcome.ok) {
        setFailure(outcome.message);
        if (outcome.code === "CONFLICT") await load();
        return false;
      }
      revisionRef.current = outcome.value.revision;
      configRef.current = outcome.value.config;
      followRevision(outcome.value);
      setFailure(undefined);
      setAnswer(outcome.value);
      setNote(said);
      onChanged?.();
      return true;
    });
    // Ordering only: the work's own failure reaches its caller through the promise it was handed.
    queue.current = written.catch(() => undefined);
    return written;
  };
  return {
    client,
    workspaceId,
    answer,
    ticks,
    error,
    logError,
    items,
    itemsError,
    revisionRef,
    configRef,
    panelSlot,
    failure,
    setFailure,
    note,
    setNote,
    loading,
    editing,
    setEditing,
    history,
    setHistory,
    filter,
    setFilter,
    confirmForget,
    setConfirmForget,
    ids,
    load,
    apply,
  };
}

/** What `useHeartbeatPage` gives the page and its parts. */
export type HeartbeatPage = ReturnType<typeof useHeartbeatPage>;
