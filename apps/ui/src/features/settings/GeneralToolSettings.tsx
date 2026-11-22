import {
  DEFAULT_TASKS_HOME,
  DEFAULT_TOOL_DEFERRAL,
  DEFAULT_VIDEO_KEEP_DAYS,
  MAX_VIDEO_KEEP_DAYS,
  MCP_PLUGIN_PREFIX,
  SERPAPI_CREDENTIAL_REF,
  TasksHomeSchema,
  ToolDeferralSchema,
  tasksHomeServer,
  type TasksHome,
} from "@tavi/contracts";

import { useEffect, useState } from "react";

import { useLoaded } from "../../hooks/use-loaded.js";
import { translateNow, useT } from "../../lib/i18n.js";
import type { UiKey } from "../../locales/en.js";
import { Select } from "../../ui/Select.js";
import { loadModels } from "./models-api.js";
import { mcpActions } from "./plugins-api.js";
import type { SettingSectionProps } from "./types.js";
import { workspaceSettingsActions } from "./workspace-api.js";
import { Button } from "../../ui/Button.js";
import { useWorkspace } from "../shell/Workspace.js";
import { Command } from "../../ui/Command.js";
import { mapOutcome } from "../../lib/ipc.js";
import { credentialActions } from "./credentials-api.js";
import { KeyField } from "./PasswordInput.js";
import { withParts } from "../../ui/with-parts.js";

/**
 * The video tools: on by default, with the
 * person's own FFmpeg, each video read in a confined, capped run.
 */
export function VideoTools({ answer, busy, run }: SettingSectionProps) {
  const t = useT();
  const { client, workspaceId } = useWorkspace();
  // Each answer shows the days in effect, so after a save the field is the owner's number.
  const shown = String(answer.effective.videoKeepDays ?? DEFAULT_VIDEO_KEEP_DAYS);
  const [draft, setDraft] = useState(shown);
  useEffect(() => setDraft(shown), [shown]);
  const days = Number(draft);
  const validDays = Number.isInteger(days) && days >= 1 && days <= MAX_VIDEO_KEEP_DAYS;
  return (
    <>
      <h2>{t("settings.tools.video.title")}</h2>
      <p>{withParts(t("settings.tools.video.body"), { command: <Command>tavi config set video.enabled off</Command> })}</p>
      <p>
        <label>
          <input
            type="checkbox"
            aria-label={t("settings.tools.video.label")}
            checked={answer.effective.videoEnabled !== false}
            disabled={busy !== undefined}
            onChange={(event) =>
              void run("video", () => workspaceSettingsActions.setVideoEnabled(client, workspaceId, event.target.checked, answer.revision))
            }
          />{" "}
          {t("settings.tools.video.check")}
        </label>
      </p>
      <form
        className="actions"
        onSubmit={(event) => {
          event.preventDefault();
          if (validDays)
            void run("video-days", () => workspaceSettingsActions.setVideoKeepDays(client, workspaceId, Number(draft), answer.revision));
        }}
      >
        {/* biome-ignore lint/a11y/noLabelWithoutControl: the days input is inside the label, placed in its sentence by withParts */}
        <label>
          {withParts(t("settings.tools.video.keep"), {
            field: (
              <span className="video-days">
                <input
                  name="days"
                  type="number"
                  min={1}
                  max={MAX_VIDEO_KEEP_DAYS}
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  aria-label={t("settings.tools.video.daysLabel")}
                  disabled={busy !== undefined}
                />{" "}
                {t("settings.tools.video.days")}
              </span>
            ),
          })}
        </label>
        <Button variant="primary" type="submit" disabled={busy !== undefined || !validDays || draft === shown}>
          {busy === "video-days" ? t("ui.parts.saving") : t("settings.action.save")}
        </Button>
      </form>
      <p className="meta-sm">{t("settings.tools.video.frames")}</p>
    </>
  );
}
/** Where a free SerpApi key is had: 250 searches a month. */
const SERPAPI_SIGN_UP_URL = "https://serpapi.com/users/sign_up";

/**
 * Flight search: Kiwi.com's public search, and Google Flights beside it —
 * its own page for one-way trips, or SerpApi with the person's key for round
 * trips too — each of which can be off.
 */
export function FlightSearch({ answer, busy, run }: SettingSectionProps) {
  const t = useT();
  const { client, workspaceId } = useWorkspace();
  const search = answer.effective.travelFlightSearch !== false;
  const google = answer.effective.travelGoogleFlights !== false;
  // Whether a SerpApi key is stored: the references only, never a value. An owner that answers no list shows no key form.
  const credentials = useLoaded(() => credentialActions.list(client));
  const listed = credentials.data?.credentials;
  const keyStored = Array.isArray(listed) ? listed.includes(SERPAPI_CREDENTIAL_REF) : undefined;
  const [key, setKey] = useState("");
  return (
    <>
      <h2>{t("settings.tools.flights.title")}</h2>
      <p>
        {withParts(t("settings.tools.flights.body"), {
          command: <Command>tavi config set travel.flightSearch off</Command>,
          google: <code>travel.googleFlights off</code>,
        })}
      </p>
      <p>
        <label>
          <input
            type="checkbox"
            checked={search}
            disabled={busy !== undefined}
            onChange={(event) =>
              void run("flights", () =>
                workspaceSettingsActions.setFlights(client, workspaceId, "travelFlightSearch", event.target.checked, answer.revision),
              )
            }
          />{" "}
          {t("settings.tools.flights.kiwi")}
        </label>
      </p>
      <p>
        <label>
          <input
            type="checkbox"
            checked={google}
            disabled={busy !== undefined}
            onChange={(event) =>
              void run("google-flights", () =>
                workspaceSettingsActions.setFlights(client, workspaceId, "travelGoogleFlights", event.target.checked, answer.revision),
              )
            }
          />{" "}
          {t("settings.tools.flights.google")}
        </label>
      </p>
      {!google || keyStored === undefined ? null : keyStored ? (
        <div className="cluster">
          <p className="muted">{t("settings.tools.flights.keyStored")}</p>
          <Button
            variant="ghost"
            size="sm"
            disabled={busy !== undefined}
            onClick={() =>
              void run("serpapi-key", async () => {
                const removed = await credentialActions.remove(client, SERPAPI_CREDENTIAL_REF);
                if (removed.ok) credentials.reload();
                return mapOutcome(removed, () => translateNow("settings.tools.flights.keyRemoved"));
              })
            }
          >
            {t("settings.tools.flights.removeKey")}
          </Button>
        </div>
      ) : (
        <form
          className="form"
          onSubmit={(event) => {
            event.preventDefault();
            if (key.trim() === "") return;
            void run("serpapi-key", async () => {
              const stored = await credentialActions.set(client, { reference: SERPAPI_CREDENTIAL_REF, value: key });
              if (stored.ok) {
                setKey("");
                credentials.reload();
              }
              return mapOutcome(stored, () => translateNow("settings.tools.flights.keySaved"));
            });
          }}
        >
          <p className="muted">
            {withParts(t("settings.tools.flights.noKey"), {
              serpapi: (
                <a href={SERPAPI_SIGN_UP_URL} target="_blank" rel="noreferrer">
                  SerpApi
                </a>
              ),
            })}
          </p>
          <KeyField label={t("settings.tools.flights.key")} id="serpapi-key" value={key} onChange={setKey} />
          <div className="actions">
            <Button type="submit" variant="primary" size="sm" disabled={busy !== undefined || key.trim() === ""}>
              {busy === "serpapi-key" ? t("settings.rhumb.storing") : t("settings.rhumb.store")}
            </Button>
          </div>
        </form>
      )}
    </>
  );
}
/** The model choice meaning the default: the `fast` role when bound, else each task's own model. */
const OWN_MODEL = "";
/**
 * Task summaries: the switch, and which model writes them. Summaries are on
 * by default and use the `fast` role's model when bound, else the task's own
 * model; no remote model summarizes a task that ran on a local connection.
 */
export function TaskSummaries({
  answer,
  on,
  busy,
  run,
}: SettingSectionProps & {
  /** Whether summaries are on, as the owner answered it. */
  readonly on: boolean;
}) {
  const t = useT();
  const { client, workspaceId } = useWorkspace();
  const models = useLoaded(() => loadModels(client, workspaceId));
  const stored = answer.settings.activitySummaryModel;
  const current = stored === undefined ? OWN_MODEL : `${stored.connectionId}/${stored.model}`;
  const choices = (models.data?.models ?? []).map((model) => ({
    value: `${model.connectionId}/${model.modelId}`,
    label: `${model.displayName ?? model.modelId} (${model.connectionLabel})`,
  }));
  // The saved value stays selectable even when its connection no longer lists it.
  if (current !== OWN_MODEL && !choices.some((choice) => choice.value === current)) choices.unshift({ value: current, label: current });
  return (
    <>
      <h2>{t("settings.tools.summaries.title")}</h2>
      <p>
        {withParts(t("settings.tools.summaries.body"), {
          fast: <strong>{t("settings.tools.summaries.fast")}</strong>,
          command: <Command>tavi config set activity.summaries off</Command>,
        })}
      </p>
      <p>
        <label>
          <input
            type="checkbox"
            checked={on}
            disabled={busy !== undefined}
            onChange={(event) =>
              void run("summaries", () => workspaceSettingsActions.setSummaries(client, workspaceId, event.target.checked, answer.revision))
            }
          />{" "}
          {t("settings.tools.summaries.check")}
        </label>
      </p>
      <p className="muted">{t("settings.tools.summaries.modelHint")}</p>
      {/* An inline trigger as a direct child of .settings would miss its centred column. */}
      <div className="actions">
        <Select
          aria-label={t("settings.tools.summaries.modelLabel")}
          value={current}
          disabled={busy !== undefined || !on}
          onChange={(event) => {
            const value = event.target.value;
            if (value === current) return;
            void run("summary-model", () =>
              workspaceSettingsActions.setSummaryModel(client, workspaceId, value === OWN_MODEL ? undefined : value, answer.revision),
            );
          }}
        >
          <option value={OWN_MODEL}>{t("settings.tools.summaries.ownModel")}</option>
          {choices.map((choice) => (
            <option key={choice.value} value={choice.value}>
              {choice.label}
            </option>
          ))}
        </Select>
      </div>
    </>
  );
}

/** Whether the agent may offer, unasked, to save a procedure that worked as a skill (`skills.suggestions`). */
export function SkillSuggestions({ answer, busy, run }: SettingSectionProps) {
  const t = useT();
  const { client, workspaceId } = useWorkspace();
  return (
    <>
      <h2>{t("settings.tools.skills.title")}</h2>
      <p>{withParts(t("settings.tools.skills.body"), { command: <Command>tavi config set skills.suggestions off</Command> })}</p>
      <p>
        <label>
          <input
            type="checkbox"
            aria-label={t("settings.tools.skills.label")}
            checked={answer.effective.skillSuggestions !== false}
            disabled={busy !== undefined}
            onChange={(event) =>
              void run("skill-suggestions", () =>
                workspaceSettingsActions.setSkillSuggestions(client, workspaceId, event.target.checked, answer.revision),
              )
            }
          />{" "}
          {t("settings.tools.skills.check")}
        </label>
      </p>
    </>
  );
}

const TOOL_DEFERRAL_LABELS: { readonly auto: UiKey; readonly on: UiKey; readonly off: UiKey } = {
  auto: "settings.tools.deferral.auto",
  on: "settings.tools.deferral.on",
  off: "settings.tools.deferral.off",
};

/** Whether a chat's rarely used tools wait behind `tools.search` (`models.toolDeferral`). */
export function ToolDeferralChoice({ answer, busy, run }: SettingSectionProps) {
  const t = useT();
  const { client, workspaceId } = useWorkspace();
  const current = answer.effective.toolDeferral ?? answer.settings.toolDeferral ?? DEFAULT_TOOL_DEFERRAL;
  return (
    <>
      <h2>{t("settings.tools.deferral.title")}</h2>
      <p>
        {withParts(t("settings.tools.deferral.body"), {
          search: <code>tools.search</code>,
          command: <Command>tavi config set models.toolDeferral auto</Command>,
        })}
      </p>
      <div className="actions">
        <Select
          aria-label={t("settings.tools.deferral.label")}
          value={current}
          disabled={busy !== undefined}
          onChange={(event) => {
            const parsed = ToolDeferralSchema.safeParse(event.target.value);
            if (!parsed.success || parsed.data === current) return;
            void run("tool-deferral", () => workspaceSettingsActions.setToolDeferral(client, workspaceId, parsed.data, answer.revision));
          }}
        >
          {ToolDeferralSchema.options.map((mode) => (
            <option key={mode} value={mode}>
              {t(TOOL_DEFERRAL_LABELS[mode])}
            </option>
          ))}
        </Select>
      </div>
    </>
  );
}

/**
 * Where the person keeps their to-dos (`tasks.home`): Tavi's own list, or a
 * task app connected as an MCP server — one this workspace allows and has
 * enabled. The saved home stays selectable when its server is no longer listed.
 */
export function TasksHomeChoice({ answer, busy, run }: SettingSectionProps) {
  const t = useT();
  const { client, workspaceId } = useWorkspace();
  const servers = useLoaded(() => mcpActions.list(client, workspaceId), [client, workspaceId]);
  const current: TasksHome = answer.effective.tasksHome ?? answer.settings.tasksHome ?? DEFAULT_TASKS_HOME;
  const homes = (servers.data?.servers.servers ?? [])
    .filter((server) => server.allowed && server.enabled && server.pluginId.startsWith(MCP_PLUGIN_PREFIX))
    .map((server) => ({ home: `mcp:${server.pluginId.slice(MCP_PLUGIN_PREFIX.length)}`, label: server.name }))
    .filter((choice) => TasksHomeSchema.safeParse(choice.home).success);
  const currentServer = tasksHomeServer(current);
  if (currentServer !== undefined && !homes.some((choice) => choice.home === current))
    homes.unshift({ home: current, label: currentServer });
  return (
    <>
      <h2>{t("settings.tools.tasksHome.title")}</h2>
      <p>{withParts(t("settings.tools.tasksHome.body"), { command: <Command>{"tavi config set tasks.home mcp:<server>"}</Command> })}</p>
      <div className="actions">
        <Select
          aria-label={t("settings.tools.tasksHome.label")}
          value={current}
          disabled={busy !== undefined}
          onChange={(event) => {
            const parsed = TasksHomeSchema.safeParse(event.target.value);
            if (!parsed.success || parsed.data === current) return;
            void run("tasks-home", () => workspaceSettingsActions.setTasksHome(client, workspaceId, parsed.data, answer.revision));
          }}
        >
          <option value={DEFAULT_TASKS_HOME}>Tavi</option>
          {homes.map((choice) => (
            <option key={choice.home} value={choice.home}>
              {choice.label}
            </option>
          ))}
        </Select>
      </div>
    </>
  );
}
