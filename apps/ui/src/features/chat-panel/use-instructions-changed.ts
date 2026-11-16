import { useEffect, useState } from "react";

import type { Route } from "../shell/route.js";
import { markSeen, seenRevision } from "./seen.js";
import type { PanelTab } from "./tabs.js";

/**
 * "Changed since you last looked": the
 * Instructions icon is marked while the chat's revision is past the one the
 * reader last looked at. The first read of a chat only notes where it
 * stands; looking at the Instructions tab catches up.
 */
export function useInstructionsChanged(
  chatTaskId: string | undefined,
  revision: number | undefined,
  route: Route,
  panelOpen: boolean,
  panelTab: PanelTab,
): boolean {
  /** What the reader last looked at, and for which chat: another chat's is never compared. */
  const [lookedAt, setLookedAt] = useState<{ readonly taskId: string; readonly revision: number | undefined }>();
  useEffect(() => {
    if (chatTaskId === undefined || revision === undefined) return;
    const seen = seenRevision(chatTaskId);
    if (seen === undefined || (route === "chat" && panelOpen && panelTab === "instructions")) markSeen(chatTaskId, revision);
    setLookedAt({ taskId: chatTaskId, revision: seenRevision(chatTaskId) });
  }, [chatTaskId, revision, route, panelOpen, panelTab]);
  const lastLooked = lookedAt?.taskId === chatTaskId ? lookedAt?.revision : undefined;
  const instructionsChanged = revision !== undefined && lastLooked !== undefined && revision > lastLooked;
  return instructionsChanged;
}
