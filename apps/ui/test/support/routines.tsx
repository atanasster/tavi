import type { ReactElement } from "react";

import { RunInspector } from "../../src/features/routines/RunInspector.js";
import type { SettingsClient } from "../../src/lib/ipc.js";
import { InWorkspace } from "./workspace.js";

/**
 * What the owner answers a run inspector's `routines` request with: `inspect`
 * for the run itself, an empty ledger and no sources, and nothing for the rest.
 */
export function inspectorAnswer(raw: unknown, inspect: unknown): unknown {
  const action = (raw as Record<string, unknown>)["action"];
  return action === "inspect"
    ? inspect
    : action === "ledger"
      ? { events: [] }
      : action === "sources"
        ? { sources: [], nextAfterSourceId: null }
        : {};
}

/** The inspector of run `run` of the routine "LLM news", in UTC, over `client`. */
export const inspectorPage = (client: SettingsClient): ReactElement => (
  <InWorkspace client={client} workspaceId="default">
    <RunInspector timeZone="UTC" routineId="routine" routineName="LLM news" runId="run" onBack={() => {}} onFollow={async () => {}} />
  </InWorkspace>
);
