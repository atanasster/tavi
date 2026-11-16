import { useEffect } from "react";

import type { CanvasStore } from "../chat/store/types.js";
import { usePoll } from "../../hooks/use-poll.js";
import type { shellState } from "./shell.js";

/** How often an open chat's notices are read again. */
const NOTICE_POLL_MS = 10_000;

/** What the chat on screen needs read that no stream brings: its workers' needs as it opens, and its notices. */
export function useChatReads(
  store: CanvasStore,
  current: ReturnType<typeof shellState>["current"],
  state: ReturnType<CanvasStore["getSnapshot"]>,
): void {
  // Read when a chat opens; the chat list's refresh reads it again while its workers wait.
  useEffect(() => {
    if (current?.taskId !== undefined && state.connection === "ready") void store.loadWorkerNeeds(current.taskId);
  }, [current?.taskId, state.connection]);
  // A chat's notices: read when it opens and every 10 s while it is open; they arrive on no stream.
  const noticesOf = current?.taskId;
  usePoll(
    () => {
      if (noticesOf !== undefined) void store.loadNotices(noticesOf);
    },
    NOTICE_POLL_MS,
    { enabled: noticesOf !== undefined && state.connection === "ready", immediate: true },
    [noticesOf],
  );
}
