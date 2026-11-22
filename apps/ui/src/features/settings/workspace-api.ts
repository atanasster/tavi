import {
  RESET_INSTANCE_CONFIRMATION,
  type ResetInstanceResult,
  type WorkspaceSettingsAnswer,
  type TaintMode,
  type InjectionDetectorMode,
  type TasksHome,
  type ToolDeferral,
  DEFAULT_TASKS_HOME,
  DEFAULT_TOOL_DEFERRAL,
  tasksHomeServer,
} from "@tavi/contracts";

import { translateNow } from "../../lib/i18n.js";
import { ask, mapOutcome, type Outcome, type SettingsClient } from "../../lib/ipc.js";

/**
 * Reset the instance: the owner answers, then stops, deletes its data
 * directory's state and starts again on the empty directory. Every workspace
 * goes, not only the one this page shows.
 */
export const resetInstance = (client: SettingsClient): Promise<Outcome<ResetInstanceResult>> =>
  ask<ResetInstanceResult>(client, "reset-instance", { confirm: RESET_INSTANCE_CONFIRMATION });

/**
 * The workspace settings document. Each write
 * asserts the revision the page read, so a change made meanwhile from the CLI
 * is a conflict the page reports rather than silently replaces.
 */
export const workspaceSettingsActions = {
  load: (client: SettingsClient, workspaceId: string) =>
    ask<WorkspaceSettingsAnswer>(client, "workspace-settings", { action: "get", workspaceId }),
  async setTimezone(
    client: SettingsClient,
    workspaceId: string,
    timezone: string,
    expectedRevision: number,
  ): Promise<Outcome<string | undefined>> {
    const written = await ask<WorkspaceSettingsAnswer>(client, "workspace-settings", {
      action: "set",
      workspaceId,
      key: "timezone",
      value: timezone,
      expectedRevision,
    });
    return mapOutcome(written, (value) => translateNow("settings.workspace.timezoneSet", { zone: value.effective.timezone }));
  },
  async useHostTimezone(client: SettingsClient, workspaceId: string, expectedRevision: number): Promise<Outcome<string | undefined>> {
    const written = await ask<WorkspaceSettingsAnswer>(client, "workspace-settings", {
      action: "unset",
      workspaceId,
      key: "timezone",
      expectedRevision,
    });
    return mapOutcome(written, (value) => translateNow("settings.workspace.hostZone", { zone: value.hostTimezone }));
  },
  /** Task summaries on or off. On is the default, so turning them on clears the key. */
  async setSummaries(
    client: SettingsClient,
    workspaceId: string,
    on: boolean,
    expectedRevision: number,
  ): Promise<Outcome<string | undefined>> {
    const written = await ask<WorkspaceSettingsAnswer>(
      client,
      "workspace-settings",
      on
        ? { action: "unset", workspaceId, key: "activitySummaries", expectedRevision }
        : { action: "set", workspaceId, key: "activitySummaries", value: "off", expectedRevision },
    );
    return mapOutcome(written, () => translateNow(on ? "settings.workspace.summariesOn" : "settings.workspace.summariesOff"));
  },
  /** The model that writes summaries (`connection/model`), or `undefined` for the default (the `fast` role, else each task's own model). */
  async setSummaryModel(
    client: SettingsClient,
    workspaceId: string,
    target: string | undefined,
    expectedRevision: number,
  ): Promise<Outcome<string | undefined>> {
    const written = await ask<WorkspaceSettingsAnswer>(
      client,
      "workspace-settings",
      target === undefined
        ? { action: "unset", workspaceId, key: "activitySummaryModel", expectedRevision }
        : { action: "set", workspaceId, key: "activitySummaryModel", value: target, expectedRevision },
    );
    return mapOutcome(written, () =>
      target === undefined
        ? translateNow("settings.workspace.summaryModelDefault")
        : translateNow("settings.workspace.summaryModel", { target }),
    );
  },
  /** The hosts whose pages get no browser thumbnail: a comma-separated list, or `none`. The owner validates it. */
  async setNoThumbnailHosts(
    client: SettingsClient,
    workspaceId: string,
    hosts: string,
    expectedRevision: number,
  ): Promise<Outcome<string | undefined>> {
    const written = await ask<WorkspaceSettingsAnswer>(client, "workspace-settings", {
      action: "set",
      workspaceId,
      key: "browserNoThumbnailHosts",
      value: hosts,
      expectedRevision,
    });
    return mapOutcome(written, (value) =>
      (value.effective.browserNoThumbnailHosts ?? []).length === 0
        ? translateNow("settings.workspace.thumbnailsAll")
        : translateNow("settings.workspace.thumbnailsSaved"),
    );
  },
  /** The flight search, or its Google Flights back end, on or off. On is the default, so turning one on clears its key. */
  async setFlights(
    client: SettingsClient,
    workspaceId: string,
    key: "travelFlightSearch" | "travelGoogleFlights",
    on: boolean,
    expectedRevision: number,
  ): Promise<Outcome<string | undefined>> {
    const written = await ask<WorkspaceSettingsAnswer>(
      client,
      "workspace-settings",
      on ? { action: "unset", workspaceId, key, expectedRevision } : { action: "set", workspaceId, key, value: "off", expectedRevision },
    );
    return mapOutcome(written, () =>
      translateNow(
        key === "travelFlightSearch"
          ? on
            ? "settings.workspace.flightsOn"
            : "settings.workspace.flightsOff"
          : on
            ? "settings.workspace.googleFlightsOn"
            : "settings.workspace.googleFlightsOff",
      ),
    );
  },
  /** `skills.suggestions`: whether the agent may offer, unasked, to save a procedure as a skill. On is the default, so turning it on clears the key. */
  async setSkillSuggestions(
    client: SettingsClient,
    workspaceId: string,
    on: boolean,
    expectedRevision: number,
  ): Promise<Outcome<string | undefined>> {
    const written = await ask<WorkspaceSettingsAnswer>(
      client,
      "workspace-settings",
      on
        ? { action: "unset", workspaceId, key: "skillSuggestions", expectedRevision }
        : { action: "set", workspaceId, key: "skillSuggestions", value: "off", expectedRevision },
    );
    return mapOutcome(written, () => translateNow(on ? "settings.workspace.skillSuggestionsOn" : "settings.workspace.skillSuggestionsOff"));
  },
  /** `models.toolDeferral`. `auto` is the default, so choosing it clears the key. */
  async setToolDeferral(
    client: SettingsClient,
    workspaceId: string,
    mode: ToolDeferral,
    expectedRevision: number,
  ): Promise<Outcome<string | undefined>> {
    const written = await ask<WorkspaceSettingsAnswer>(
      client,
      "workspace-settings",
      mode === DEFAULT_TOOL_DEFERRAL
        ? { action: "unset", workspaceId, key: "toolDeferral", expectedRevision }
        : { action: "set", workspaceId, key: "toolDeferral", value: mode, expectedRevision },
    );
    return mapOutcome(written, () =>
      translateNow(
        mode === "auto"
          ? "settings.workspace.deferralAuto"
          : mode === "on"
            ? "settings.workspace.deferralOn"
            : "settings.workspace.deferralOff",
      ),
    );
  },
  /** `tasks.home`: Tavi's own to-do list, or a connected MCP server's. Tavi is the default, so choosing it clears the key. */
  async setTasksHome(
    client: SettingsClient,
    workspaceId: string,
    home: TasksHome,
    expectedRevision: number,
  ): Promise<Outcome<string | undefined>> {
    const written = await ask<WorkspaceSettingsAnswer>(
      client,
      "workspace-settings",
      home === DEFAULT_TASKS_HOME
        ? { action: "unset", workspaceId, key: "tasksHome", expectedRevision }
        : { action: "set", workspaceId, key: "tasksHome", value: home, expectedRevision },
    );
    const server = tasksHomeServer(home);
    return mapOutcome(written, () =>
      server === undefined
        ? translateNow("settings.workspace.tasksHomeTavi")
        : translateNow("settings.workspace.tasksHomeServer", { server }),
    );
  },
  /** Masking credential shapes in tool results on or off. On is the default, so turning it on clears the key. */
  async setRedactToolResults(
    client: SettingsClient,
    workspaceId: string,
    on: boolean,
    expectedRevision: number,
  ): Promise<Outcome<string | undefined>> {
    const written = await ask<WorkspaceSettingsAnswer>(
      client,
      "workspace-settings",
      on
        ? { action: "unset", workspaceId, key: "redactToolResults", expectedRevision }
        : { action: "set", workspaceId, key: "redactToolResults", value: "off", expectedRevision },
    );
    return mapOutcome(written, () => translateNow(on ? "settings.workspace.redactOn" : "settings.workspace.redactOff"));
  },
  /** The video tools on or off. On is the default, so turning them on clears the key. */
  async setVideoEnabled(
    client: SettingsClient,
    workspaceId: string,
    on: boolean,
    expectedRevision: number,
  ): Promise<Outcome<string | undefined>> {
    const written = await ask<WorkspaceSettingsAnswer>(
      client,
      "workspace-settings",
      on
        ? { action: "unset", workspaceId, key: "videoEnabled", expectedRevision }
        : { action: "set", workspaceId, key: "videoEnabled", value: "off", expectedRevision },
    );
    return mapOutcome(written, () => translateNow(on ? "settings.workspace.videoOn" : "settings.workspace.videoOff"));
  },
  /** How many days a video taken from outside is kept. */
  async setVideoKeepDays(
    client: SettingsClient,
    workspaceId: string,
    days: number,
    expectedRevision: number,
  ): Promise<Outcome<string | undefined>> {
    const written = await ask<WorkspaceSettingsAnswer>(client, "workspace-settings", {
      action: "set",
      workspaceId,
      key: "videoKeepDays",
      value: String(days),
      expectedRevision,
    });
    return mapOutcome(written, () => translateNow("settings.workspace.videoKeepDays", { count: days }));
  },
  /**
   * `security.taint`. The owner refuses a page's change
   * that lowers it: `tavi permissions taint <mode>` does that.
   */
  async setTaint(
    client: SettingsClient,
    workspaceId: string,
    mode: TaintMode,
    expectedRevision: number,
  ): Promise<Outcome<string | undefined>> {
    const written = await ask<WorkspaceSettingsAnswer>(client, "workspace-settings", {
      action: "set",
      workspaceId,
      key: "securityTaint",
      value: mode,
      expectedRevision,
    });
    if (!written.ok) return written;
    const said = translateNow(
      mode === "enforce"
        ? "settings.workspace.taintEnforce"
        : mode === "observe"
          ? "settings.workspace.taintObserve"
          : "settings.workspace.taintOff",
    );
    return {
      ok: true,
      value:
        written.value.taintPolicy === undefined
          ? said
          : `${said} ${translateNow("settings.workspace.taintPolicy", { policy: written.value.taintPolicy })}`,
    };
  },
  /**
   * `security.injectionDetector`: a detector hit only
   * adds a warning to a call's approval, so a page may set it either way.
   */
  async setInjectionDetector(
    client: SettingsClient,
    workspaceId: string,
    mode: InjectionDetectorMode,
    expectedRevision: number,
  ): Promise<Outcome<string | undefined>> {
    const written = await ask<WorkspaceSettingsAnswer>(client, "workspace-settings", {
      action: "set",
      workspaceId,
      key: "securityInjectionDetector",
      value: mode,
      expectedRevision,
    });
    if (!written.ok) return written;
    return {
      ok: true,
      value:
        mode === "off"
          ? translateNow("settings.workspace.injectionOff")
          : mode === "patterns"
            ? translateNow("settings.workspace.injectionPatterns")
            : translateNow("settings.workspace.injectionModel"),
    };
  },
  /** Back to the shipped list: the key is cleared. */
  async resetNoThumbnailHosts(client: SettingsClient, workspaceId: string, expectedRevision: number): Promise<Outcome<string | undefined>> {
    const written = await ask<WorkspaceSettingsAnswer>(client, "workspace-settings", {
      action: "unset",
      workspaceId,
      key: "browserNoThumbnailHosts",
      expectedRevision,
    });
    return mapOutcome(written, () => translateNow("settings.workspace.thumbnailsReset"));
  },
};

/**
 * The zones the picker offers: the platform's list, with `current` added when
 * the platform omits it (an alias such as `Asia/Calcutta` resolves but is not
 * listed), so the saved value is always selectable.
 */
export function timeZoneOptions(current: string): readonly string[] {
  const listed = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
  return listed.includes(current) ? listed : [current, ...listed];
}
