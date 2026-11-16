import { useEffect } from "react";

import type { CanvasStore } from "../chat/store/types.js";
import { LIVE_POLL_MS, usePoll } from "../../hooks/use-poll.js";

/** The chat list, read again while the page shows, and whenever a run's status, pending calls, review or question moves. */
export function useSessionsRefresh(store: CanvasStore, state: ReturnType<CanvasStore["getSnapshot"]>): void {
  const inboxVersion = state.runs
    .map((run) => `${run.id}:${run.run.status}:${run.run.pending.length}:${run.run.review?.steps ?? ""}:${run.questionId ?? ""}`)
    .join("|");
  usePoll(
    () => {
      if (!document.hidden && !store.getSnapshot().directory?.loading) void store.loadSessions(undefined, false, true);
    },
    LIVE_POLL_MS,
    { visibility: true },
    [store],
  );
  useEffect(() => {
    if (!document.hidden && !store.getSnapshot().directory?.loading) void store.loadSessions(undefined, false, true);
  }, [store, inboxVersion]);
}
