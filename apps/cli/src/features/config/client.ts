import { emitError, emitJson } from "../../cli/output.js";
import { EXIT } from "../../cli/exit.js";
import {
  BUILTIN_ROLE_PLUGINS,
  DEFAULT_KEPT_MODEL_REQUESTS,
  maxOutputTokensOf,
  DEFAULT_PROMPT_LAYOUT,
  toolDeferralOf,
  tasksHomeOf,
  localeOf,
  DEFAULT_BROWSER_DOWNLOAD_MAX_MIB,
  DEFAULT_BROWSER_SESSION_IDLE_MINUTES,
  DEFAULT_VIDEO_KEEP_DAYS,
  DEFAULT_PARALLEL_READS,
  DEFAULT_TAINT_MODE,
  DEFAULT_INJECTION_DETECTOR_MODE,
  sandboxNetworkModeOf,
  TaviError,
  DEFAULT_WORKSPACE_ID,
  type WorkspaceSettingKey,
  WORKSPACE_SETTING_KEYS,
  formatHomeDmIdentity,
  homeDmLinkIdentities,
  homeDmLinkPrivacyNote,
  type WorkspaceSettingsAnswer,
} from "@tavi/contracts";
import { recordedConnectionProviders, registerBuiltinChannelsOf } from "../channels/catalog.js";
import { nowTimestamp } from "@tavi/contracts/util";
import { operatorActor } from "../../server/config-commands.js";
import { applyWorkspaceSetting, workspaceSettingsAnswerFor } from "../../server/workspace-settings-commands.js";
import type { ConfigCommandOptions, ConfigKey } from "./parse.js";
import type { CliIo } from "../../cli/io.js";
import { configFailureReporter, runFamily } from "../../cli/owner.js";
import type { ResolvedDataDirectory } from "../../cli/store.js";

/** An idle limit as `tavi config get` shows it: minutes, or that a session stays open until it is closed. */
const idleMinutesText = (minutes: number): string => (minutes === 0 ? "until closed" : `${String(minutes)} minutes`);

/** The CLI's dotted key for each settings-document key, and back. */
const CONFIG_KEY_TO_SETTING: Readonly<Record<ConfigKey, WorkspaceSettingKey>> = {
  "workspace.timezone": "timezone",
  "operator.name": "operatorName",
  "workspace.locale": "locale",
  "activity.summaries": "activitySummaries",
  "activity.summaryModel": "activitySummaryModel",
  "browser.noThumbnailHosts": "browserNoThumbnailHosts",
  "browser.sessionIdleMinutes": "browserSessionIdleMinutes",
  "browser.downloadMaxMiB": "browserDownloadMaxMiB",
  "desktop.grantedApps": "desktopGrantedApps",
  "browser.visionEngine": "browserVisionEngine",
  "ui.roles": "uiRoles",
  "ui.placements": "uiPlacements",
  "chat.home": "homeChat",
  "chat.home-dm": "homeDmLink",
  "models.keptRequests": "keptModelRequests",
  "models.maxOutputTokens": "maxOutputTokens",
  "scheduled.monthlyTokenBudget": "scheduledMonthlyTokenBudget",
  "models.promptLayout": "promptLayout",
  "models.toolDeferral": "toolDeferral",
  "tasks.home": "tasksHome",
  "travel.flightSearch": "travelFlightSearch",
  "travel.googleFlights": "travelGoogleFlights",
  "skills.suggestions": "skillSuggestions",
  "pdf.enabled": "pdfEnabled",
  "video.enabled": "videoEnabled",
  "video.keepDays": "videoKeepDays",
  "tools.redactResults": "redactToolResults",
  "tools.parallelReads": "parallelReads",
  memory: "memory",
  "security.taint": "securityTaint",
  "security.injectionDetector": "securityInjectionDetector",
  "mcp.servers": "mcpServers",
  "mcp.people": "mcpPeople",
  "sandbox.domains": "sandboxDomains",
  "sandbox.network": "sandboxNetwork",
};
const SETTING_TO_CONFIG_KEY: Readonly<Record<WorkspaceSettingKey, ConfigKey>> = {
  timezone: "workspace.timezone",
  operatorName: "operator.name",
  locale: "workspace.locale",
  activitySummaries: "activity.summaries",
  activitySummaryModel: "activity.summaryModel",
  browserNoThumbnailHosts: "browser.noThumbnailHosts",
  browserSessionIdleMinutes: "browser.sessionIdleMinutes",
  browserDownloadMaxMiB: "browser.downloadMaxMiB",
  desktopGrantedApps: "desktop.grantedApps",
  browserVisionEngine: "browser.visionEngine",
  uiRoles: "ui.roles",
  uiPlacements: "ui.placements",
  homeChat: "chat.home",
  homeDmLink: "chat.home-dm",
  keptModelRequests: "models.keptRequests",
  maxOutputTokens: "models.maxOutputTokens",
  scheduledMonthlyTokenBudget: "scheduled.monthlyTokenBudget",
  promptLayout: "models.promptLayout",
  toolDeferral: "models.toolDeferral",
  tasksHome: "tasks.home",
  travelFlightSearch: "travel.flightSearch",
  travelGoogleFlights: "travel.googleFlights",
  skillSuggestions: "skills.suggestions",
  pdfEnabled: "pdf.enabled",
  videoEnabled: "video.enabled",
  videoKeepDays: "video.keepDays",
  redactToolResults: "tools.redactResults",
  parallelReads: "tools.parallelReads",
  memory: "memory",
  securityTaint: "security.taint",
  securityInjectionDetector: "security.injectionDetector",
  mcpServers: "mcp.servers",
  mcpPeople: "mcp.people",
  sandboxDomains: "sandbox.domains",
  sandboxNetwork: "sandbox.network",
};

/** One `tavi config get` line: the value in effect, and whether it is set or the default. */
function configLine(answer: WorkspaceSettingsAnswer, key: WorkspaceSettingKey): string {
  const set = answer.settings[key] !== undefined;
  const hosts = (list: readonly string[]): string => (list.length === 0 ? "none" : list.join(","));
  const value =
    key === "timezone"
      ? answer.effective.timezone
      : key === "operatorName"
        ? (answer.settings.operatorName ?? "unset")
        : key === "locale"
          ? (answer.effective.locale ?? localeOf(answer.settings))
          : key === "activitySummaries"
            ? answer.effective.activitySummaries
              ? "on"
              : "off"
            : key === "homeChat"
              ? answer.effective.homeChat === true
                ? "on"
                : "off"
              : key === "travelFlightSearch"
                ? answer.effective.travelFlightSearch === false
                  ? "off"
                  : "on"
                : key === "travelGoogleFlights"
                  ? answer.effective.travelGoogleFlights === false
                    ? "off"
                    : "on"
                  : key === "skillSuggestions"
                    ? answer.effective.skillSuggestions === false
                      ? "off"
                      : "on"
                    : key === "pdfEnabled"
                      ? answer.effective.pdfEnabled === false
                        ? "off"
                        : "on"
                      : key === "videoEnabled"
                        ? answer.effective.videoEnabled === false
                          ? "off"
                          : "on"
                        : key === "videoKeepDays"
                          ? `${String(answer.effective.videoKeepDays ?? answer.settings.videoKeepDays ?? DEFAULT_VIDEO_KEEP_DAYS)} days`
                          : key === "browserSessionIdleMinutes"
                            ? idleMinutesText(
                                answer.effective.browserSessionIdleMinutes ??
                                  answer.settings.browserSessionIdleMinutes ??
                                  DEFAULT_BROWSER_SESSION_IDLE_MINUTES,
                              )
                            : key === "browserVisionEngine"
                              ? (answer.effective.browserVisionEngine ?? answer.settings.browserVisionEngine ?? "generic")
                              : key === "browserDownloadMaxMiB"
                                ? `${String(answer.effective.browserDownloadMaxMiB ?? answer.settings.browserDownloadMaxMiB ?? DEFAULT_BROWSER_DOWNLOAD_MAX_MIB)} MiB`
                                : key === "redactToolResults"
                                  ? answer.effective.redactToolResults === false
                                    ? "off"
                                    : "on"
                                  : key === "parallelReads"
                                    ? String(answer.effective.parallelReads ?? answer.settings.parallelReads ?? DEFAULT_PARALLEL_READS)
                                    : key === "homeDmLink"
                                      ? answer.settings.homeDmLink === undefined || answer.settings.homeDmLink.length === 0
                                        ? "off"
                                        : `${answer.settings.homeDmLink.map(formatHomeDmIdentity).join(",")}${answer.effective.homeDmLink === true ? "" : " (off: chat.home is off)"}`
                                      : key === "desktopGrantedApps"
                                        ? (answer.settings.desktopGrantedApps ?? []).length === 0
                                          ? "none"
                                          : (answer.settings.desktopGrantedApps ?? []).join(",")
                                        : key === "browserNoThumbnailHosts"
                                          ? hosts(answer.settings.browserNoThumbnailHosts ?? answer.effective.browserNoThumbnailHosts ?? [])
                                          : key === "uiRoles"
                                            ? answer.settings.uiRoles === undefined
                                              ? "built-in"
                                              : JSON.stringify(answer.settings.uiRoles)
                                            : key === "uiPlacements"
                                              ? answer.settings.uiPlacements === undefined
                                                ? "each manifest's own"
                                                : JSON.stringify(answer.settings.uiPlacements)
                                              : key === "memory"
                                                ? answer.settings.memory === undefined
                                                  ? "defaults"
                                                  : JSON.stringify(answer.settings.memory)
                                                : // The mode in force: an owner's `serve --taint-policy` over the workspace's own.
                                                  key === "securityTaint"
                                                  ? `${answer.effective.securityTaint ?? answer.settings.securityTaint ?? DEFAULT_TAINT_MODE}${answer.taintPolicy === undefined ? "" : ` (serve --taint-policy; this workspace's own is ${answer.settings.securityTaint ?? DEFAULT_TAINT_MODE})`}`
                                                  : key === "securityInjectionDetector"
                                                    ? (answer.effective.securityInjectionDetector ??
                                                      answer.settings.securityInjectionDetector ??
                                                      DEFAULT_INJECTION_DETECTOR_MODE)
                                                    : key === "sandboxDomains"
                                                      ? hosts(answer.settings.sandboxDomains ?? [])
                                                      : key === "sandboxNetwork"
                                                        ? sandboxNetworkModeOf(answer.settings)
                                                        : key === "mcpServers" || key === "mcpPeople"
                                                          ? (answer.settings[key] ?? []).length === 0
                                                            ? "none"
                                                            : (answer.settings[key] ?? []).join(",")
                                                          : key === "keptModelRequests"
                                                            ? String(
                                                                answer.effective.keptModelRequests ??
                                                                  answer.settings.keptModelRequests ??
                                                                  DEFAULT_KEPT_MODEL_REQUESTS,
                                                              )
                                                            : key === "maxOutputTokens"
                                                              ? String(
                                                                  answer.effective.maxOutputTokens ?? maxOutputTokensOf(answer.settings),
                                                                )
                                                              : key === "toolDeferral"
                                                                ? (answer.effective.toolDeferral ?? toolDeferralOf(answer.settings))
                                                                : key === "tasksHome"
                                                                  ? (answer.effective.tasksHome ?? tasksHomeOf(answer.settings))
                                                                  : key === "promptLayout"
                                                                    ? (answer.effective.promptLayout ??
                                                                      answer.settings.promptLayout ??
                                                                      DEFAULT_PROMPT_LAYOUT)
                                                                    : key === "scheduledMonthlyTokenBudget"
                                                                      ? answer.settings.scheduledMonthlyTokenBudget === undefined
                                                                        ? "none"
                                                                        : `${String(answer.settings.scheduledMonthlyTokenBudget)} tokens a month`
                                                                      : answer.settings.activitySummaryModel === undefined
                                                                        ? "the fast role when bound, else the task's own model"
                                                                        : `${answer.settings.activitySummaryModel.connectionId}/${answer.settings.activitySummaryModel.model}`;
  const fallback = key === "timezone" ? "(default: host zone)" : "(default)";
  return `${SETTING_TO_CONFIG_KEY[key]} = ${value} ${set ? "(set)" : fallback}\n`;
}

/**
 * `tavi config`: read and change the workspace
 * settings, on a live owner over IPC or directly when none serves the data
 * directory — the same split as `tavi system-prompt`, with the write built by
 * the same `applyWorkspaceSetting` on both paths.
 */
export async function configCommand(options: ResolvedDataDirectory<ConfigCommandOptions>, io: CliIo): Promise<number> {
  const workspaceId = options.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const key = options.key === undefined ? undefined : CONFIG_KEY_TO_SETTING[options.key];
  // A change that leaves DMs linked to Home — setting the link, or turning
  // Home back on under a stored one — says what that shares and with which
  // identities: on stdout under the setting, or on stderr
  // beside a JSON answer.
  const linkNote = (answer: WorkspaceSettingsAnswer): string | undefined =>
    options.action !== "get" && (key === "homeDmLink" || key === "homeChat") && answer.effective.homeDmLink === true
      ? homeDmLinkPrivacyNote(homeDmLinkIdentities(answer.settings))
      : undefined;
  const render = (answer: WorkspaceSettingsAnswer): number => {
    const note = linkNote(answer);
    if (options.format === "json") {
      emitJson(io, answer);
      if (note !== undefined) emitError(io, note);
      return EXIT.ok;
    }
    const keys: readonly WorkspaceSettingKey[] = key === undefined ? WORKSPACE_SETTING_KEYS : [key];
    for (const shown of keys) io.stdout(configLine(answer, shown));
    if (note !== undefined) io.stdout(`\n${note}\n`);
    return EXIT.ok;
  };
  const reportConfigFailure = configFailureReporter(options.format, io);
  // Choosing a plugin for a role shows it the browser: that goes through the
  // disclosure `plugins ui set-role` asks to be confirmed.
  if (options.action === "set" && key === "uiRoles" && options.value !== undefined) {
    let chosen: unknown;
    try {
      chosen = JSON.parse(options.value);
    } catch {
      chosen = undefined;
    }
    const builtins = new Set<string>([...Object.values(BUILTIN_ROLE_PLUGINS), "off"]);
    // Only a known role's choice: anything else is the document's own refusal.
    const named =
      chosen !== null && typeof chosen === "object"
        ? Object.entries(chosen as Record<string, unknown>).filter(
            ([role, value]) => role in BUILTIN_ROLE_PLUGINS && typeof value === "string" && !builtins.has(value),
          )
        : [];
    if (named.length > 0) {
      return reportConfigFailure(
        new TaviError(
          "INVALID_INPUT",
          `ui.roles may name only the built-in view or off here; choose a plugin with tavi plugins ui set-role <role> <plugin-id>, which says what it would see first`,
        ),
      );
    }
  }

  return runFamily(options.dataDirectory, "workspace-settings", io, {
    label: `tavi config ${options.action}`,
    mutates: options.action !== "get",
    build: () =>
      options.action === "get"
        ? { action: "get", workspaceId }
        : {
            action: options.action,
            workspaceId,
            key,
            ...(options.value === undefined ? {} : { value: options.value }),
            ...(options.expectedRevision === undefined ? {} : { expectedRevision: options.expectedRevision }),
          },
    render: (result) => render(result as WorkspaceSettingsAnswer),
    offline: async (store) => {
      const settings = store.asPort().repositories.workspaceSettings;
      if (options.action !== "get") {
        // The parser asks a set or an unset for its setting's name.
        if (key === undefined) throw new TaviError("INVALID_INPUT", `tavi config ${options.action} needs a setting name`);
        // A chat identity is named by its channel's descriptor: the built-in channels, as an owner would register them.
        const release = await registerBuiltinChannelsOf(store.asPort().repositories);
        try {
          await applyWorkspaceSetting(settings, {
            connectionProviders: await recordedConnectionProviders(store.asPort().repositories),
            workspaceId,
            key,
            value: options.action === "set" ? options.value : undefined,
            ...(options.expectedRevision === undefined ? {} : { expectedRevision: options.expectedRevision }),
            actor: operatorActor(false),
            now: nowTimestamp(),
          });
        } finally {
          release();
        }
      }
      return render(await workspaceSettingsAnswerFor(settings, workspaceId));
    },
    failed: (error) => reportConfigFailure(error),
  });
}
