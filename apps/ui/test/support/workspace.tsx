import type { ReactNode } from "react";

import { WorkspaceProvider } from "../../src/features/shell/Workspace.js";
import type { SettingsClient } from "../../src/lib/ipc.js";

/** A client for a view that should ask the owner nothing in its test: any request fails, loudly. */
const noClient: SettingsClient = {
  request: () => Promise.reject(new Error("this test's view asked the owner, and it has no client")),
};

/**
 * A view as the shell renders it: under the workspace's client, id and time
 * zone, which views read through `useWorkspace()` / `useTimeZone()`.
 * Unnamed, the workspace is "default", its zone the browser's, and its client
 * one that refuses every request.
 */
export function InWorkspace({
  client = noClient,
  workspaceId = "default",
  timeZone,
  children,
}: {
  readonly client?: SettingsClient;
  readonly workspaceId?: string;
  readonly timeZone?: string | undefined;
  readonly children: ReactNode;
}) {
  return (
    <WorkspaceProvider client={client} workspaceId={workspaceId} timeZone={timeZone}>
      {children}
    </WorkspaceProvider>
  );
}
