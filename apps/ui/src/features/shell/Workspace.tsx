import { createContext, useContext, useMemo, type ReactNode } from "react";

import type { SettingsClient } from "../../lib/ipc.js";

/** The client the page asks the owner through, and the workspace it acts in. */
export interface Workspace {
  readonly client: SettingsClient;
  readonly workspaceId: string;
}

const WorkspaceContext = createContext<Workspace | undefined>(undefined);

/** The workspace's time zone (its settings' `timezone`); undefined until known, which formats in the browser's own. */
export const TimeZoneContext = createContext<string | undefined>(undefined);

/** The client, the workspace and its time zone, for every view under it: the shell provides them once. */
export function WorkspaceProvider({
  client,
  workspaceId,
  timeZone,
  children,
}: {
  readonly client: SettingsClient;
  readonly workspaceId: string;
  readonly timeZone: string | undefined;
  readonly children: ReactNode;
}) {
  const workspace = useMemo(() => ({ client, workspaceId }), [client, workspaceId]);
  return (
    <WorkspaceContext.Provider value={workspace}>
      <TimeZoneContext.Provider value={timeZone}>{children}</TimeZoneContext.Provider>
    </WorkspaceContext.Provider>
  );
}

/** The client and workspace the page acts in, for a view under `WorkspaceProvider`. */
export function useWorkspace(): Workspace {
  const workspace = useContext(WorkspaceContext);
  if (workspace === undefined) throw new Error("useWorkspace needs a WorkspaceProvider above it");
  return workspace;
}

/** The workspace's time zone, for a view that shows a time without being handed one. */
export function useTimeZone(): string | undefined {
  return useContext(TimeZoneContext);
}
