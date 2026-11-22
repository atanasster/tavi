import { useEffect, useRef } from "react";

import { ConnectedApps, type AppsWhere } from "../apps/ConnectedApps.js";
import { IdeasSettings } from "../ideas/IdeasSettings.js";
import type { SettingsView } from "../shell/route.js";
import { useWorkspace } from "../shell/Workspace.js";
import { ChannelsSettings } from "./ChannelsSettings.js";
import { CredentialsSettings } from "./CredentialsSettings.js";
import { GeneralSettings } from "./GeneralSettings.js";
import { ModelBrowser } from "./ModelBrowser.js";
import { PermissionsSettings } from "./PermissionsSettings.js";
import { PluginsSettings } from "./PluginsSettings.js";
import { SystemPromptSettings } from "./SystemPromptSettings.js";
import { WebSearchSettings } from "./WebSearchSettings.js";
import { useT } from "../../lib/i18n.js";
import { Notice } from "../../ui/Parts.js";

/** Settings' views, under the one route they belong to; the nav between them is in the left column (`SettingsNav`). */
export function Settings({
  view,
  ruleId,
  apps = { tab: "connected" },
  onApps = () => undefined,
  onOpenTask,
  onModelsChanged,
  onReset,
  onRunSetup,
  onPluginOff,
  pluginRevision = 0,
  ideas = false,
}: {
  readonly view: SettingsView;
  /** A rule Permissions points out: the one an approval's "Always" row linked to. */
  readonly ruleId?: string | undefined;
  /** Where Connected apps is (its tab, an app, its connect sheet), and how to go elsewhere in it. */
  readonly apps?: AppsWhere;
  readonly onApps?: (where: AppsWhere) => void;
  /** Opens a chat in place, from an app's Recent activity. */
  readonly onOpenTask?: ((taskId: string) => void) | undefined;
  /**
   * Leaving Models may have moved the workspace's default, which the footer
   * strip names: it is re-read rather than left to disagree with this view
   * until the page is reloaded.
   */
  readonly onModelsChanged?: () => void;
  /** The owner accepted a reset: the page starts over once it is back. */
  readonly onReset?: () => void;
  /** *Run setup again*: every Welcome step, done ones included; absent where the owner offers no setup. */
  readonly onRunSetup?: (() => void) | undefined;
  /** Plugins disabled or rejected a version of a plugin: its status lines leave the chats. */
  readonly onPluginOff?: (pluginId: string) => void;
  /** The Center feed's `plugin` revision, which Connected apps re-reads its list on. */
  readonly pluginRevision?: number;
  /** The owner offers Ideas: Settings → Ideas is shown. */
  readonly ideas?: boolean;
}) {
  const t = useT();
  const { workspaceId } = useWorkspace();
  const wasModels = useRef(view === "models");
  useEffect(() => {
    // Only on the way out of Models, so browsing the other two costs no read.
    if (wasModels.current && view !== "models") onModelsChanged?.();
    wasModels.current = view === "models";
  }, [view, onModelsChanged]);
  return (
    <>
      {view === "ideas" ? ideas ? <IdeasSettings key={workspaceId} /> : <Notice>{t("settings.page.noIdeas")}</Notice> : null}
      {view === "general" ? <GeneralSettings key={workspaceId} onReset={onReset} onRunSetup={onRunSetup} /> : null}
      {view === "apps" ? (
        <ConnectedApps key={workspaceId} revision={pluginRevision} where={apps} onWhere={onApps} onOpenTask={onOpenTask} />
      ) : null}
      {view === "models" ? <ModelBrowser /> : null}
      {view === "search" ? <WebSearchSettings /> : null}
      {view === "messaging" || view === "people" ? <ChannelsSettings key={`${workspaceId}:${view}`} people={view === "people"} /> : null}
      {view === "credentials" ? <CredentialsSettings /> : null}
      {view === "plugins" ? <PluginsSettings workspaceId={workspaceId} onPluginOff={onPluginOff} /> : null}
      {view === "permissions" ? <PermissionsSettings key={workspaceId} highlight={ruleId} /> : null}
      {/* Keyed by workspace: the editor's draft belongs to one workspace's prompt,
          and a switch must remount rather than carry it across. */}
      {view === "system-prompt" ? <SystemPromptSettings key={workspaceId} /> : null}
    </>
  );
}
