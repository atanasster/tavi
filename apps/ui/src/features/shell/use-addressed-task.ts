import { useEffect, useRef, useState } from "react";

import { errorMessage } from "@tavi/contracts/util";

import type { CanvasStore } from "../chat/store/types.js";
import type { Navigate, PageRoute } from "./route.js";

/**
 * The chat the address names, opened in the store; and, when it cannot be,
 * the sentence saying so, which the next page change takes back.
 */
export function useAddressedTask(page: PageRoute, store: CanvasStore, navigate: Navigate): string | undefined {
  /** A deep link this page could not open, in words the pane shows. */
  const [routeError, setRouteError] = useState<string>();
  /** The tasks whose `openTask` this page has already asked for, so one is asked once. */
  const opening = useRef(new Set<string>());
  /**
   * The one page change a failure's own correction makes, which must not take
   * the sentence explaining it back. Every other change of page — a click,
   * Back — is the reader going somewhere, and the sentence goes with it.
   */
  const correcting = useRef(false);
  useEffect(() => {
    if (correcting.current) {
      correcting.current = false;
      return;
    }
    setRouteError(undefined);
  }, [page]);
  /**
   * The session the URL names is opened, so `/tasks/<taskId>` is the session
   * it points at rather than whatever the page happened to hold. A task the
   * page already has — a click that opened it, a replayed turn — costs no
   * read: the selection is written where it is read, not asked for again.
   */
  useEffect(() => {
    const taskId = page.taskId;
    if (taskId === undefined || opening.current.has(taskId) || store.getSnapshot().runs.some((run) => run.run.taskId === taskId)) return;
    opening.current.add(taskId);
    void store
      .openTask(taskId)
      .catch((error: unknown) => {
        setRouteError(`Chat ${taskId} could not be opened: ${errorMessage(error)}. Showing this page's chats instead.`);
        // The address bar must not keep naming a session this page cannot show.
        correcting.current = true;
        navigate((current) => ({ ...current, taskId: undefined }), { replace: true });
      })
      .finally(() => opening.current.delete(taskId));
  }, [page.taskId, store, navigate]);
  return routeError;
}
