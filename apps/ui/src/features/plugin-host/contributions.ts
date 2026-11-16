import { PluginUiAnswerSchema, WorkspaceSettingsAnswerSchema } from "@tavi/contracts";
import { useEffect, useState } from "react";

import { useResetOnChange } from "../../hooks/use-reset-on-change.js";
import { ask, type Outcome, type SettingsClient } from "../../lib/ipc.js";
import { resolveContributions, type ResolvedContribution, type RoleFallback } from "./slots.js";

/**
 * The UI plugin contributions this workspace shows: the owner's loadable ones (`plugins ui`) narrowed by the workspace's
 * `uiRoles` and `uiPlacements`, read again whenever the Command Center's
 * `plugin` change kind moves. A disabled, rejected or deselected plugin's
 * contributions leave the list at once — and the frames showing them are
 * torn down with them, since rejection is revocation.
 */

export interface PluginContributions {
  readonly contributions: readonly ResolvedContribution[];
  readonly fallbacks: readonly RoleFallback[];
  /** Why they could not be read, in words; the last good list is kept meanwhile. */
  readonly error: string | undefined;
}

const NONE: PluginContributions = { contributions: [], fallbacks: [], error: undefined };

/** One read of both answers, resolved. */
async function loadPluginContributions(client: SettingsClient, workspaceId: string): Promise<Outcome<Omit<PluginContributions, "error">>> {
  const [ui, settings] = await Promise.all([
    ask<unknown>(client, "plugins", { action: "ui" }),
    ask<unknown>(client, "workspace-settings", { action: "get", workspaceId }),
  ]);
  if (!ui.ok) return ui;
  if (!settings.ok) return settings;
  const entries = PluginUiAnswerSchema.safeParse(ui.value);
  const document = WorkspaceSettingsAnswerSchema.safeParse(settings.value);
  if (!entries.success || !document.success) return { ok: false, message: "the owner's answer about UI plugins could not be read" };
  return { ok: true, value: resolveContributions(entries.data.entries, document.data.settings) };
}

/**
 * The contributions, for as long as `enabled` (the owner offers `plugins`):
 * read on mount, on a new workspace, and each time `revision` (the feed's
 * `plugin` count) moves. A failed read keeps what was shown, except that a
 * workspace change starts from nothing.
 */
export function usePluginContributions(
  client: SettingsClient,
  workspaceId: string,
  enabled: boolean,
  revision: number,
): PluginContributions {
  const [state, setState] = useState<PluginContributions>(NONE);
  useResetOnChange([workspaceId], () => setState(NONE));
  useEffect(() => {
    if (!enabled) {
      setState(NONE);
      return;
    }
    let current = true;
    void loadPluginContributions(client, workspaceId).then((outcome) => {
      if (!current) return;
      setState((previous) => (outcome.ok ? { ...outcome.value, error: undefined } : { ...previous, error: outcome.message }));
    });
    return () => {
      current = false;
    };
  }, [client, workspaceId, enabled, revision]);
  return state;
}
