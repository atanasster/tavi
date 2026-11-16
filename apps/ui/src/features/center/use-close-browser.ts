import { useState } from "react";

import type { SettingsClient } from "../../lib/ipc.js";
import { closeBrowserSession } from "./browser-api.js";

/**
 * The operator's **Close browser** for a session whose task has ended,
 * shared by the Command Center's card and the chat panel's Details: whether it
 * is closing or closed, and why the last attempt failed — cleared on the next.
 */
export function useCloseBrowser(client: SettingsClient, workspaceId: string, sessionId: string) {
  const [state, setState] = useState<"open" | "closing" | "closed">("open");
  const [failure, setFailure] = useState<string>();
  const close = async (): Promise<void> => {
    setState("closing");
    setFailure(undefined);
    const outcome = await closeBrowserSession(client, workspaceId, sessionId);
    setState(outcome.ok ? "closed" : "open");
    if (!outcome.ok) setFailure(outcome.message);
  };
  return { state, failure, close };
}
