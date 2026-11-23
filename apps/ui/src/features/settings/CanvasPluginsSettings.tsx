import { useId, useState } from "react";

import {
  BUILTIN_ROLE_PLUGINS,
  channelDisclosure,
  PLUGIN_UI_MAX_MESSAGES_PER_SECOND,
  PluginUiAnswerSchema,
  WorkspaceSettingsAnswerSchema,
  resolveContributions,
  uiPlacementsFor,
  type PluginUiContribution,
  type PluginUiEntry,
  type PluginUiSlot,
  type UiPlacementsSetting,
  type UiRolesSetting,
  type WorkspaceSettingsAnswer,
} from "@tavi/contracts";

import { useFloodedPlugins } from "../plugin-host/floods.js";
import { ask, type Outcome, type SettingsClient } from "../../lib/ipc.js";
import { Failure, Notice, Pending, StatusNote } from "../../ui/Parts.js";
import { Select } from "../../ui/Select.js";
import { useLoaded } from "../../hooks/use-loaded.js";
import { Empty } from "../../ui/Empty.js";
import { Button } from "../../ui/Button.js";
import { useWorkspace } from "../shell/Workspace.js";
import { translateCore, translateNow, useT } from "../../lib/i18n.js";
import type { UiKey } from "../../locales/en.js";
import { withParts } from "../../ui/with-parts.js";

/**
 * Settings → Plugins → Canvas:
 * which plugin is the **Browser view** for this workspace, and where each UI
 * contribution is shown. The same document `tavi plugins ui` writes
 * (`uiRoles`, `uiPlacements`), each write a compare-and-set on the revision
 * read, so a change made elsewhere meanwhile is a conflict, not undone.
 *
 * Choosing a plugin that receives a channel (the browser's pages) asks again,
 * showing its disclosure: approving a plugin is not consent to let it watch
 * the browser. A chosen plugin that can no longer fill the role (disabled,
 * rejected, removed) is reported, and the built-in fills it meanwhile.
 * Everything applies at once, without a restart.
 */

interface CanvasData {
  readonly entries: readonly PluginUiEntry[];
  readonly settings: WorkspaceSettingsAnswer;
}

async function loadCanvas(client: SettingsClient, workspaceId: string): Promise<Outcome<CanvasData>> {
  const [ui, settings] = await Promise.all([
    ask<unknown>(client, "plugins", { action: "ui", workspaceId }),
    ask<unknown>(client, "workspace-settings", { action: "get", workspaceId }),
  ]);
  if (!ui.ok) return ui;
  if (!settings.ok) return settings;
  const entries = PluginUiAnswerSchema.safeParse(ui.value);
  const document = WorkspaceSettingsAnswerSchema.safeParse(settings.value);
  if (!entries.success || !document.success) return { ok: false, message: translateNow("settings.canvas.unreadable") };
  return { ok: true, value: { entries: entries.data.entries, settings: document.data } };
}

/** The places a contribution can be put, as the picker offers them. */
const PLACES: readonly {
  readonly value: string;
  readonly label: UiKey;
  readonly slots: readonly PluginUiSlot[] | "hidden" | undefined;
}[] = [
  { value: "manifest", label: "settings.canvas.place.manifest", slots: undefined },
  { value: "top", label: "settings.canvas.place.top", slots: ["chat.panel.top"] },
  { value: "tab", label: "settings.canvas.place.tab", slots: ["chat.panel.tab"] },
  { value: "both", label: "settings.canvas.place.both", slots: ["chat.panel.top", "chat.panel.tab"] },
  // The Center's and Welcome's own slots: every place a person may assign. The takeover overlay is never one.
  { value: "browser", label: "settings.canvas.place.browser", slots: ["center.browser"] },
  { value: "heartbeat", label: "settings.canvas.place.heartbeat", slots: ["center.heartbeat"] },
  { value: "welcome", label: "settings.canvas.place.welcome", slots: ["onboarding.step"] },
  { value: "hidden", label: "settings.canvas.place.hidden", slots: "hidden" },
];

/** The picker's value for an override; `custom` for one these choices do not express (set with `tavi plugins ui place`). */
function placeOf(override: UiPlacementsSetting[string] | undefined): string {
  if (override === undefined) return "manifest";
  if (override === "hidden") return "hidden";
  const slots = override.slots
    .map((placement) => placement.slot)
    .sort()
    .join(",");
  return PLACES.find((place) => Array.isArray(place.slots) && [...place.slots].sort().join(",") === slots)?.value ?? "custom";
}

/** Keyed by its caller on the workspace and the plugins' states, so it reads again when either changes. */
export function CanvasPluginsSettings({ workspaceId }: { readonly workspaceId: string }) {
  const t = useT();
  const { client } = useWorkspace();
  const { data, error, reload } = useLoaded(() => loadCanvas(client, workspaceId));
  const flooded = useFloodedPlugins();
  const [pending, setPending] = useState<{ readonly pluginId: string; readonly disclosure: string } | undefined>();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string>();
  const id = useId();
  if (error !== undefined) return <Failure>{error}</Failure>;
  if (data === undefined) return <Pending className="notice" status />;
  const { entries, settings } = data;
  const { fallbacks } = resolveContributions(entries, settings.settings);
  const candidates = entries.filter((entry) => entry.ui.contributions.some((contribution) => contribution.role === "browser-view"));
  const builtin = BUILTIN_ROLE_PLUGINS["browser-view"];
  const chosen = settings.settings.uiRoles?.["browser-view"] ?? builtin;

  const write = async (
    key: "uiRoles" | "uiPlacements",
    value: UiRolesSetting | UiPlacementsSetting | undefined,
    said: string,
  ): Promise<void> => {
    setBusy(true);
    const outcome = await ask(
      client,
      "workspace-settings",
      value === undefined
        ? { action: "unset", workspaceId, key, expectedRevision: settings.revision }
        : { action: "set", workspaceId, key, value: JSON.stringify(value), expectedRevision: settings.revision },
    );
    setBusy(false);
    setNote(outcome.ok ? said : outcome.code === "CONFLICT" ? t("settings.canvas.conflict") : outcome.message);
    reload();
  };
  const setRole = (pluginId: string): void => {
    const roles: Record<string, string> = { ...(settings.settings.uiRoles ?? {}) };
    if (pluginId === builtin) delete roles["browser-view"];
    else roles["browser-view"] = pluginId;
    void write(
      "uiRoles",
      Object.keys(roles).length === 0 ? undefined : (roles as UiRolesSetting),
      pluginId === "off" ? t("settings.canvas.roleOff") : t("settings.canvas.roleSet", { pluginId }),
    );
  };
  const choose = (pluginId: string): void => {
    setNote(undefined);
    const contribution = entries
      .find((entry) => entry.pluginId === pluginId)
      ?.ui.contributions.find((candidate) => candidate.role === "browser-view");
    // The built-in is trusted; another plugin that receives the browser's pages is asked about first.
    if (pluginId !== builtin && pluginId !== "off" && contribution !== undefined && contribution.channels.length > 0) {
      setPending({ pluginId, disclosure: channelDisclosure(contribution.channels, contribution.disclosure, translateCore) });
      return;
    }
    setRole(pluginId);
  };
  const place = (entry: PluginUiEntry, contribution: PluginUiContribution, value: string): void => {
    const key = `${entry.pluginId}/${contribution.id}`;
    const placements: Record<string, UiPlacementsSetting[string]> = { ...(settings.settings.uiPlacements ?? {}) };
    const slots = PLACES.find((candidate) => candidate.value === value)?.slots;
    if (slots === undefined) delete placements[key];
    else if (slots === "hidden") placements[key] = "hidden";
    else placements[key] = { slots: uiPlacementsFor(slots, contribution.placements) };
    void write(
      "uiPlacements",
      Object.keys(placements).length === 0 ? undefined : (placements as UiPlacementsSetting),
      t("settings.canvas.placed", { title: contribution.title }),
    );
  };

  return (
    <div className="canvas-plugins">
      <div className="settings-fields">
        <label>
          {t("settings.canvas.browserView")}
          <Select
            id={`${id}-role`}
            aria-label={t("settings.canvas.browserView")}
            value={chosen}
            disabled={busy || pending !== undefined}
            onChange={(event) => choose(event.target.value)}
          >
            {candidates.some((entry) => entry.pluginId === builtin) ? (
              <option value={builtin}>{t("settings.canvas.builtIn")}</option>
            ) : chosen === builtin ? (
              <option value={builtin}>{t("settings.canvas.builtInUnavailable")}</option>
            ) : null}
            {candidates
              .filter((entry) => entry.pluginId !== builtin)
              .map((entry) => (
                <option key={entry.pluginId} value={entry.pluginId}>
                  {entry.pluginId}
                </option>
              ))}
            {/* A chosen plugin that can no longer fill the role still shows as chosen. */}
            {chosen !== builtin && chosen !== "off" && !candidates.some((entry) => entry.pluginId === chosen) ? (
              <option value={chosen}>{t("settings.canvas.unavailable", { pluginId: chosen })}</option>
            ) : null}
            <option value="off">{t("settings.canvas.off")}</option>
          </Select>
        </label>
      </div>
      {fallbacks.map((fallback) => (
        <Failure key={fallback.role} role="status">
          {t(fallback.using === undefined ? "settings.canvas.fallbackNone" : "settings.canvas.fallbackBuiltIn", {
            pluginId: fallback.wanted,
          })}
        </Failure>
      ))}
      {pending !== undefined ? (
        <Notice as="div" role="alertdialog" aria-labelledby={`${id}-confirm`}>
          <p id={`${id}-confirm`}>
            {withParts(t("settings.canvas.wouldSee", { disclosure: pending.disclosure }), {
              plugin: <strong>{pending.pluginId}</strong>,
            })}
          </p>
          <Button
            variant="primary"
            disabled={busy}
            onClick={() => {
              const chosenPlugin = pending.pluginId;
              setPending(undefined);
              setRole(chosenPlugin);
            }}
          >
            {t("settings.canvas.use", { pluginId: pending.pluginId })}
          </Button>{" "}
          <Button disabled={busy} onClick={() => setPending(undefined)}>
            {t("ui.confirm.cancel")}
          </Button>
        </Notice>
      ) : null}
      <StatusNote note={note} />
      {entries.length === 0 ? (
        <Empty>{t("settings.canvas.empty")}</Empty>
      ) : (
        <ul className="rows">
          {entries.flatMap((entry) =>
            entry.ui.contributions.map((contribution) => {
              const key = `${entry.pluginId}/${contribution.id}`;
              return (
                <li key={key} className="row">
                  <span className="plugin-info">
                    <strong>{contribution.title}</strong> <span className="muted">{key}</span>
                    <span className="muted">
                      {contribution.channels.length === 0
                        ? t("settings.canvas.receivesNothing")
                        : t("settings.canvas.receives", { channels: contribution.channels.join(", ") })}
                    </span>
                    {flooded.has(key) ? (
                      <Failure as="span" role="status">
                        {t("settings.canvas.flooded", { max: String(PLUGIN_UI_MAX_MESSAGES_PER_SECOND) })}
                      </Failure>
                    ) : null}
                  </span>
                  <span className="actions">
                    <Select
                      aria-label={t("settings.canvas.whereLabel", { title: contribution.title, pluginId: entry.pluginId })}
                      value={placeOf(settings.settings.uiPlacements?.[key])}
                      disabled={busy}
                      onChange={(event) => place(entry, contribution, event.target.value)}
                    >
                      {PLACES.filter(
                        // A Welcome step receives no channel: one that does would be dropped there, so it is not offered.
                        (option) => option.value !== "welcome" || contribution.channels.length === 0,
                      ).map((option) => (
                        <option key={option.value} value={option.value}>
                          {t(option.label)}
                        </option>
                      ))}
                      {placeOf(settings.settings.uiPlacements?.[key]) === "custom" ? (
                        <option value="custom" disabled>
                          {t("settings.canvas.chosenElsewhere")}
                        </option>
                      ) : null}
                    </Select>
                  </span>
                </li>
              );
            }),
          )}
        </ul>
      )}
    </div>
  );
}
