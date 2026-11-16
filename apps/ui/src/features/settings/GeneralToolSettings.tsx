import {
  DEFAULT_TASKS_HOME,
  DEFAULT_TOOL_DEFERRAL,
  DEFAULT_VIDEO_KEEP_DAYS,
  MAX_VIDEO_KEEP_DAYS,
  MCP_PLUGIN_PREFIX,
  TasksHomeSchema,
  ToolDeferralSchema,
  tasksHomeServer,
  type TasksHome,
} from "@tavi/contracts";

import { useLoaded } from "../../hooks/use-loaded.js";
import { Select } from "../../ui/Select.js";
import { loadModels } from "./models-api.js";
import { mcpActions } from "./plugins-api.js";
import type { SettingSectionProps } from "./types.js";
import { workspaceSettingsActions } from "./workspace-api.js";
import { Button } from "../../ui/Button.js";
import { useWorkspace } from "../shell/Workspace.js";
import { Command } from "../../ui/Command.js";

/**
 * The video tools: on by default, with the
 * person's own FFmpeg, each video read in a confined, capped run.
 */
export function VideoTools({ answer, busy, run }: SettingSectionProps) {
  const { client, workspaceId } = useWorkspace();
  return (
    <>
      <h2>Video</h2>
      <p>
        The agent can read a video&rsquo;s facts and take its frames with the FFmpeg installed on this machine, each video read in a sandbox
        with no network. Off, the video tools refuse. Or use <Command>tavi config set video.enabled off</Command>.
      </p>
      <p>
        <label>
          <input
            type="checkbox"
            aria-label="let the agent read videos"
            checked={answer.effective.videoEnabled !== false}
            disabled={busy !== undefined}
            onChange={(event) =>
              void run("video", () => workspaceSettingsActions.setVideoEnabled(client, workspaceId, event.target.checked, answer.revision))
            }
          />{" "}
          Let the agent read videos
        </label>
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const days = Number(new FormData(event.currentTarget).get("days"));
          if (Number.isInteger(days) && days >= 1 && days <= MAX_VIDEO_KEEP_DAYS)
            void run("video-days", () => workspaceSettingsActions.setVideoKeepDays(client, workspaceId, days, answer.revision));
        }}
      >
        <label>
          Keep videos from chats and uploads for{" "}
          <input
            name="days"
            type="number"
            min={1}
            max={MAX_VIDEO_KEEP_DAYS}
            defaultValue={answer.effective.videoKeepDays ?? DEFAULT_VIDEO_KEEP_DAYS}
            aria-label="days a video is kept"
            disabled={busy !== undefined}
          />{" "}
          days
        </label>{" "}
        <Button type="submit" disabled={busy !== undefined}>
          Save
        </Button>
      </form>
      <p className="meta-sm">Frames taken from a video stay with their chat after the video itself is gone.</p>
    </>
  );
}
/**
 * Flight search: Kiwi.com's public search, and the
 * Google Flights back end — unofficial, best effort — each of which can be off.
 */
export function FlightSearch({ answer, busy, run }: SettingSectionProps) {
  const { client, workspaceId } = useWorkspace();
  const search = answer.effective.travelFlightSearch !== false;
  const google = answer.effective.travelGoogleFlights !== false;
  return (
    <>
      <h2>Flight search</h2>
      <p>
        Flight questions go first to Kiwi.com&rsquo;s public flight search, which is sent the trip &mdash; places, dates and passengers
        &mdash; and asked before each search. Google Flights is used to confirm a fare or when that search fails: it has no official
        interface, so it is <strong>best effort</strong> and runs only when you ask about flights. Or use{" "}
        <Command>tavi config set travel.flightSearch off</Command> and <code>travel.googleFlights off</code>.
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
          Search flights with Kiwi.com
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
          Use Google Flights (best effort, unofficial)
        </label>
      </p>
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
      <h2>Task summaries</h2>
      <p>
        When a task finishes, one short model call gives it a title and a one-line summary for Activity. The <strong>Fast</strong>{" "}
        role&rsquo;s model writes it when one is bound, else the model the task itself used; a task that ran on a local model is never
        summarized by a remote one. Off, tasks keep the first line of their prompt as the title. Or use{" "}
        <Command>tavi config set activity.summaries off</Command>.
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
          Summarize finished tasks
        </label>
      </p>
      <p className="muted">A model chosen here writes every summary instead, under the same rule for a task that ran on a local model.</p>
      {/* An inline trigger as a direct child of .settings would miss its centred column. */}
      <div className="actions">
        <Select
          aria-label="summary model"
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
          <option value={OWN_MODEL}>Fast role, else each task&rsquo;s own model</option>
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
  const { client, workspaceId } = useWorkspace();
  return (
    <>
      <h2>Skill suggestions</h2>
      <p>
        After a task that took several steps and worked, the agent may offer to save how it did it as a skill. An offer always waits for
        your review in the Command Center and is never used until you approve it; asking for one works either way. Or use{" "}
        <Command>tavi config set skills.suggestions off</Command>.
      </p>
      <p>
        <label>
          <input
            type="checkbox"
            aria-label="suggest saving procedures as skills"
            checked={answer.effective.skillSuggestions !== false}
            disabled={busy !== undefined}
            onChange={(event) =>
              void run("skill-suggestions", () =>
                workspaceSettingsActions.setSkillSuggestions(client, workspaceId, event.target.checked, answer.revision),
              )
            }
          />{" "}
          Suggest saving procedures as skills
        </label>
      </p>
    </>
  );
}

const TOOL_DEFERRAL_LABELS = {
  auto: "Automatic: wait behind search, except on a local model",
  on: "Always wait behind search",
  off: "Never: offer every tool in every chat",
} as const;

/** Whether a chat's rarely used tools wait behind `tools.search` (`models.toolDeferral`). */
export function ToolDeferralChoice({ answer, busy, run }: SettingSectionProps) {
  const { client, workspaceId } = useWorkspace();
  const current = answer.effective.toolDeferral ?? answer.settings.toolDeferral ?? DEFAULT_TOOL_DEFERRAL;
  return (
    <>
      <h2>Rarely used tools</h2>
      <p>
        A chat is shown its common tools and finds the rest with <code>tools.search</code>, which keeps each request smaller and faster. A
        small or local model may not think to search, so by default it gets the whole list. Or use{" "}
        <Command>tavi config set models.toolDeferral auto</Command>.
      </p>
      <div className="actions">
        <Select
          aria-label="tool deferral"
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
              {TOOL_DEFERRAL_LABELS[mode]}
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
      <h2>Your to-do list</h2>
      <p>
        Where &ldquo;add to my list&rdquo; goes: Tavi&rsquo;s own list, or a task app you connected as an MCP server (Todoist, say). With a
        server, Tavi&rsquo;s own list keeps only its internal follow-ups; nothing is synced between them. Or use{" "}
        <Command>{"tavi config set tasks.home mcp:<server>"}</Command>.
      </p>
      <div className="actions">
        <Select
          aria-label="to-do list"
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
