import type { AsyncRepository } from "./persistence-types.js";
import { z } from "zod";

import { IdSchema, TimestampSchema } from "./ids.js";
import { CONNECTION_ID_PATTERN } from "./models-config.js";
import { BROWSER_NO_THUMBNAIL_HOSTS_MAX, DEFAULT_BROWSER_NO_THUMBNAIL_HOSTS, normalizeNoThumbnailHost } from "./browser-history.js";
import { UiPlacementsSettingSchema, UiRolesSettingSchema } from "./plugin-ui.js";
import {
  DEFAULT_KEPT_MODEL_REQUESTS,
  DEFAULT_MAX_OUTPUT_TOKENS,
  MAX_KEPT_MODEL_REQUESTS,
  MAX_MAX_OUTPUT_TOKENS,
  MIN_MAX_OUTPUT_TOKENS,
} from "./model-accounting.js";
import { EffectiveMemorySettingsSchema, MemorySettingsSchema, effectiveMemorySettings } from "./memory-settings.js";
import { DEFAULT_TAINT_MODE, TaintModeSchema, type TaintMode } from "./tool-policy.js";
import { normalizeSandboxGrant, SANDBOX_DOMAINS_MAX } from "./sandbox.js";
import { plainTextSchema } from "./ideas.js";
import { parseTokenCount } from "./schedules.js";
import { isValidTimeZone } from "./schedule-time.js";

export { isValidTimeZone };

/**
 * Per-workspace settings: one document per
 * workspace, whose first key is the workspace timezone.
 *
 * The document is stored as JSON rather than one column per key, so a later
 * step adds a key (`activitySummaries`, `activitySummaryModel`,
 * `browserNoThumbnailHosts`, `homeChat`, `keptModelRequests`, …) to `WorkspaceSettingsSchema` without a
 * migration. Every key is optional: an absent key means "use the default",
 * which for `timezone` is the owner host's zone, for `activitySummaries` is
 * on, for `browserNoThumbnailHosts` is `DEFAULT_BROWSER_NO_THUMBNAIL_HOSTS`,
 * for `homeChat` is on, and for `homeDmLink` is off.
 */

/**
 * The zone as the platform spells it (`europe/berlin` → `Europe/Berlin`), or
 * `undefined` when it is not one. Stored in this form, so two spellings of one
 * zone are never two settings.
 */
export function canonicalTimeZone(value: string): string | undefined {
  if (!isValidTimeZone(value)) return undefined;
  return new Intl.DateTimeFormat("en-US", { timeZone: value }).resolvedOptions().timeZone;
}

/** The zone this process runs in, and `UTC` when the platform does not report one. */
export function hostTimeZone(): string {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return typeof zone === "string" && isValidTimeZone(zone) ? zone : "UTC";
}

export const TimeZoneSchema = z
  .string()
  .min(1)
  .max(64)
  .refine(isValidTimeZone, { message: "expected an IANA time zone such as Europe/Berlin" });

/**
 * The settings document. Strict, so a writer cannot add a key this build does
 * not know; the repository keeps such keys from a newer build when it writes.
 */
/**
 * A connection and model named by a setting. The connection id is a slug
 * (no `/`), so `<connection>/<model>` splits at its first slash and the model
 * may hold slashes of its own (`openrouter/openai/gpt-4.1-mini`).
 */
export const SettingModelTargetSchema = z.strictObject({
  connectionId: z.string().min(1).max(64).regex(CONNECTION_ID_PATTERN),
  model: z.string().min(1).max(256),
});
export type SettingModelTarget = z.infer<typeof SettingModelTargetSchema>;

/** How many DM identities `homeDmLink` may name. */
export const HOME_DM_LINK_MAX = 16;

/** One DM identity linked to Home: a connection, and the sender id on it. */
export const HomeDmIdentitySchema = z.strictObject({
  connectionId: z.string().min(1).max(64).regex(CONNECTION_ID_PATTERN),
  senderId: z
    .string()
    .min(1)
    .max(256)
    .regex(/^[^,\s]+$/),
});
export type HomeDmIdentity = z.infer<typeof HomeDmIdentitySchema>;

/** `security.injectionDetector`'s modes. */
export const INJECTION_DETECTOR_MODES = ["off", "patterns", "model"] as const;
export const InjectionDetectorModeSchema = z.enum(INJECTION_DETECTOR_MODES);
export type InjectionDetectorMode = z.infer<typeof InjectionDetectorModeSchema>;

/**
 * `sandbox.network`'s modes: `granted`, the shell reaches only the granted
 * domains; `ask`, `sandbox.run` may also ask the person for others, for one run.
 */
export const SANDBOX_NETWORK_MODES = ["granted", "ask"] as const;
export const SandboxNetworkModeSchema = z.enum(SANDBOX_NETWORK_MODES);
export type SandboxNetworkMode = z.infer<typeof SandboxNetworkModeSchema>;

/** An MCP server's plugin id, as a workspace names it (`mcp.<name>`). */
export const MCP_SERVER_ID_PATTERN = /^mcp\.[a-z][a-z0-9]{0,18}$/;
/** Servers one workspace may list. */
export const MCP_WORKSPACE_SERVERS_MAX = 64;

/** Whether a workspace allows `pluginId` (`mcp.servers`), and whether other people's chats may use it (`mcp.people`). */
export function mcpServerAllowed(settings: WorkspaceSettings, pluginId: string): boolean {
  return settings.mcpServers?.includes(pluginId) === true;
}
export function mcpServerForPeople(settings: WorkspaceSettings, pluginId: string): boolean {
  return mcpServerAllowed(settings, pluginId) && settings.mcpPeople?.includes(pluginId) === true;
}

/** `operator.name`'s longest value. */
export const OPERATOR_NAME_MAX = 80;
/** A person's name as they gave it: one line of plain text (no control or bidirectional characters). */
export const OperatorNameSchema = plainTextSchema(OPERATOR_NAME_MAX, false);

/**
 * What drives `browser.vision_act`: Tavi's own function-tool loop, or the
 * model's native computer-use tool on a connection that offers one (a native
 * Anthropic connection, OpenAI's own API), every action still run and
 * guarded by the browser. Experimental: `generic` until the eval shows the
 * native one doing better on the same model.
 */
export const BROWSER_VISION_ENGINES = ["generic", "native"] as const;
export const BrowserVisionEngineSchema = z.enum(BROWSER_VISION_ENGINES);
export type BrowserVisionEngine = (typeof BROWSER_VISION_ENGINES)[number];

/**
 * How a model call's prompt is laid out for prompt caching (`models.promptLayout`):
 * `v2`, the cache-stable default; `v1`, the earlier layout, kept as the
 * rollback.
 */
export const PROMPT_LAYOUTS = ["v1", "v2"] as const;
export const PromptLayoutSchema = z.enum(PROMPT_LAYOUTS);
export type PromptLayout = (typeof PROMPT_LAYOUTS)[number];
export const DEFAULT_PROMPT_LAYOUT: PromptLayout = "v2";

/** The smallest and largest `scheduled.monthlyTokenBudget`. */
export const MIN_SCHEDULED_MONTHLY_TOKEN_BUDGET = 1_000;
export const MAX_SCHEDULED_MONTHLY_TOKEN_BUDGET = 1_000_000_000_000;

/** A `scheduled.monthlyTokenBudget`: a whole number of tokens in that range. */
export const ScheduledMonthlyTokenBudgetSchema = z
  .number()
  .int()
  .min(MIN_SCHEDULED_MONTHLY_TOKEN_BUDGET)
  .max(MAX_SCHEDULED_MONTHLY_TOKEN_BUDGET);

/**
 * Whether an attended chat's rarely used built-in families wait behind
 * `tools.search` (`models.toolDeferral`): `auto` defers them unless the chat
 * runs on a local model, which may not search well; `on` always, `off` never.
 * Apart from the layout, so a weak local model keeps the whole list under `v2`.
 */
export const TOOL_DEFERRALS = ["auto", "on", "off"] as const;
export const ToolDeferralSchema = z.enum(TOOL_DEFERRALS);
export type ToolDeferral = (typeof TOOL_DEFERRALS)[number];
export const DEFAULT_TOOL_DEFERRAL: ToolDeferral = "auto";

/**
 * Where the person keeps their tasks (`tasks.home`): `tavi`, Tavi's own
 * to-do list (`todos.*`), or `mcp:<server>`, a task app connected as an MCP
 * server (the Todoist preset, say). With a server, the system prompt sends
 * to-do requests there and `todos.*` keep only Tavi's internal follow-ups.
 * No two-way sync: a move is one shot.
 */
export const TasksHomeSchema = z.union([
  z.literal("tavi"),
  z.string().regex(/^mcp:[a-z][a-z0-9]{0,18}$/, 'expected "tavi" or "mcp:<server>", for example mcp:todoist'),
]);
export type TasksHome = z.infer<typeof TasksHomeSchema>;
export const DEFAULT_TASKS_HOME: TasksHome = "tavi";

/** The MCP server a task home names (`mcp:todoist` → `todoist`), or undefined for Tavi's own list. */
export function tasksHomeServer(home: TasksHome): string | undefined {
  return home.startsWith("mcp:") ? home.slice("mcp:".length) : undefined;
}

/** The most apps a workspace grants desktop control. */
export const DESKTOP_GRANTED_APPS_MAX = 64;

/** Minutes an inactive browser session stays open by default; 0 keeps it until it is closed. At most a day. */
export const DEFAULT_BROWSER_SESSION_IDLE_MINUTES = 30;
export const MAX_BROWSER_SESSION_IDLE_MINUTES = 1440;
/** The largest download the browser keeps by default, in MiB, and the largest a workspace may allow. */
export const DEFAULT_BROWSER_DOWNLOAD_MAX_MIB = 256;
export const MAX_BROWSER_DOWNLOAD_MAX_MIB = 4096;

/** How many independent read-only calls of one step run at the same time by default, and the most a workspace may allow; 1 runs them one at a time. */
export const DEFAULT_PARALLEL_READS = 8;
export const MAX_PARALLEL_READS = 32;

/** A video taken from outside is kept this many days by default, at most `MAX_VIDEO_KEEP_DAYS`. */
export const DEFAULT_VIDEO_KEEP_DAYS = 30;
export const MAX_VIDEO_KEEP_DAYS = 3650;

export const WorkspaceSettingsSchema = z.strictObject({
  /** The IANA zone "today" and relative times resolve in. Absent: the owner host's zone. */
  timezone: TimeZoneSchema.optional(),
  /**
   * `operator.name`: what the workspace's
   * operator is called, set by onboarding's about step. Absent: unnamed.
   */
  operatorName: OperatorNameSchema.optional(),
  /**
   * Whether a finished task gets a generated title and one-line summary.
   * Absent: on. Off, a task keeps its
   * prompt-derived title and no model call is made.
   */
  activitySummaries: z.boolean().optional(),
  /**
   * The model that writes those summaries instead of the one the task used.
   * Never applied to a task that ran on a local connection when this one is
   * remote: that task's own model writes its summary.
   */
  activitySummaryModel: SettingModelTargetSchema.optional(),
  /**
   * Hosts whose pages never get a browser thumbnail: exact hosts, or
   * `*.example.com` for a domain and all its
   * subdomains, in their stored (lower-case, ASCII) form. Replaces the default
   * list (`DEFAULT_BROWSER_NO_THUMBNAIL_HOSTS`); an empty list blocks nothing
   * by host (a page with a password field still gets none). Absent: the default.
   */
  browserNoThumbnailHosts: z
    .array(
      z
        .string()
        .min(1)
        .max(255)
        .refine((entry) => normalizeNoThumbnailHost(entry) === entry, { message: "expected a host or *.domain in lower case" }),
    )
    .max(BROWSER_NO_THUMBNAIL_HOSTS_MAX)
    .optional(),
  /**
   * Which plugin fills each UI role:
   * a plugin id, or `off`. Absent: the built-in (`tavi.browserview` for
   * `browser-view`). A plugin that is not enabled, approved and declaring the
   * role falls back to the built-in.
   */
  uiRoles: UiRolesSettingSchema.optional(),
  /** Per contribution (`<plugin-id>/<contribution-id>`), the slots chosen instead of its manifest's, or `hidden`. */
  uiPlacements: UiPlacementsSettingSchema.optional(),
  /**
   * Whether the workspace has a Home chat: one
   * persistent chat that `/` and a bare `tavi chat` open. Absent: off, and
   * chats work as before. Rollback is turning it off: Home stays an ordinary
   * chat, and nothing is moved out of it.
   */
  homeChat: z.boolean().optional(),
  /**
   * The operator's own DM identities whose messages are turns of their Home
   * rather than a conversation Home of their own: each a connection and the
   * sender id on it. Absent or empty: no
   * DM is linked. In effect only while `homeChat` is on, and a listed identity
   * links only a Telegram private chat whose sender's binding still names the
   * workspace's operator when the message arrives. See `homeDmLinkPrivacyNote`.
   */
  homeDmLink: z.array(HomeDmIdentitySchema).max(HOME_DM_LINK_MAX).optional(),
  /**
   * How many of a task's newest model calls keep their whole request in model
   * accounting; older calls keep usage, cost, ids and the request's
   * hash. `0` keeps none once settled. Absent: `DEFAULT_KEPT_MODEL_REQUESTS`.
   */
  keptModelRequests: z.number().int().min(0).max(MAX_KEPT_MODEL_REQUESTS).optional(),
  /**
   * The most a model call may write (its `max_tokens`), for every task without
   * a cap of its own (a heartbeat's, an idea's, used instead). Absent:
   * `DEFAULT_MAX_OUTPUT_TOKENS`.
   */
  maxOutputTokens: z.number().int().min(MIN_MAX_OUTPUT_TOKENS).max(MAX_MAX_OUTPUT_TOKENS).optional(),
  /**
   * How many tokens the workspace's scheduled work (its schedules' and
   * routines' runs, and their workers) is meant to use in a calendar month, in
   * its zone: its person is told once a month when it reaches
   * `SCHEDULED_BUDGET_NOTICE_PERCENT`. Nothing is stopped. Absent: no budget.
   */
  scheduledMonthlyTokenBudget: ScheduledMonthlyTokenBudgetSchema.optional(),
  /**
   * How a model call's prompt is laid out for prompt caching: `v2`, the
   * cache-stable layout, or `v1`, the earlier one. Absent:
   * `DEFAULT_PROMPT_LAYOUT` (`v2`). A rollback is setting `v1`.
   */
  promptLayout: PromptLayoutSchema.optional(),
  /** Whether attended chats defer rarely used built-ins behind `tools.search` (`ToolDeferral`). Absent: `auto`. */
  toolDeferral: ToolDeferralSchema.optional(),
  /** Where the person keeps their tasks (`TasksHome`). Absent: `tavi`. */
  tasksHome: TasksHomeSchema.optional(),
  /**
   * Whether `travel.flights_search` asks Kiwi.com's public flight search.
   * Absent: on. Off, the tool refuses and the agent
   * browses flight sites instead.
   */
  travelFlightSearch: z.boolean().optional(),
  /**
   * Whether the PDF tools (`pdf.read`, `pdf.view`, `pdf.fields`,
   * `pdf.render`, `pdf.fill`, `pdf.overlay`) run.
   * Absent: on. Off, they stay listed
   * and refuse every call, and no PDF upload is taken.
   */
  pdfEnabled: z.boolean().optional(),
  /**
   * Whether the video tools (`video.info`, `video.frames`, and the rest as
   * they land) run. Absent: on. Off,
   * they stay listed and refuse every call.
   */
  videoEnabled: z.boolean().optional(),
  /**
   * How many days a video taken from outside (a channel's attachment, an
   * upload) is kept before it is pruned: its frames and sheets stay with
   * their chat. Absent:
   * `DEFAULT_VIDEO_KEEP_DAYS`.
   */
  videoKeepDays: z.number().int().min(1).max(MAX_VIDEO_KEEP_DAYS).optional(),
  /**
   * How many minutes a browser session nobody is using stays open before it is
   * closed (its profile keeps sign-ins); 0 keeps it until it is closed. Absent:
   * `DEFAULT_BROWSER_SESSION_IDLE_MINUTES`.
   */
  browserSessionIdleMinutes: z.number().int().min(0).max(MAX_BROWSER_SESSION_IDLE_MINUTES).optional(),
  /** The largest file a browser download keeps, in MiB; a larger one is cancelled. Absent: `DEFAULT_BROWSER_DOWNLOAD_MAX_MIB`. */
  browserDownloadMaxMiB: z.number().int().min(1).max(MAX_BROWSER_DOWNLOAD_MAX_MIB).optional(),
  /**
   * The apps desktop control (the experimental `tavi.desktop` plugin) may see
   * and act in, by bundle id or app name, each at its built-in grant tier: a
   * browser view-only, a terminal or editor click-only, a system app in the
   * warning tier, any other app in full. A blocked app is never granted.
   * Absent or empty: none.
   */
  desktopGrantedApps: z.array(z.string().min(1).max(200)).max(DESKTOP_GRANTED_APPS_MAX).optional(),
  /** What drives acting by sight (`BROWSER_VISION_ENGINES`). Absent: `generic`. */
  browserVisionEngine: BrowserVisionEngineSchema.optional(),
  /**
   * Whether `travel.flights_search` points the agent at Google Flights — an
   * unofficial, best-effort back end — to confirm a fare or when the search
   * fails. Absent: on.
   */
  travelGoogleFlights: z.boolean().optional(),
  /**
   * Whether the agent may offer a skill (`skills.propose`) the person did not
   * ask for. Off ("never suggest skills"), only an asked-for one is taken.
   * Absent: on.
   */
  skillSuggestions: z.boolean().optional(),
  /**
   * Whether tool results — and the copy of tool inputs sent to clients — have
   * credential shapes masked before they are archived, recorded or shown to the
   * model. Absent: on.
   */
  redactToolResults: z.boolean().optional(),
  /**
   * `tools.parallelReads`: how many independent read-only calls of one model
   * step run at the same time; `1` runs every call in turn. Results, cards
   * and approvals keep call order whatever it says. Absent:
   * `DEFAULT_PARALLEL_READS`.
   */
  parallelReads: z.number().int().min(1).max(MAX_PARALLEL_READS).optional(),
  /**
   * The memory section: on or paused,
   * whether the model may suggest memory, and its limits. Absent: the defaults,
   * which are the behaviour from before the section. See `memory-settings.ts`.
   */
  memory: MemorySettingsSchema.optional(),
  /**
   * `security.taint`: how the gate's taint step
   * applies — `enforce` asks, `observe` records what it would have asked and
   * decides as before, `off` skips it (kept for one release). Absent:
   * `DEFAULT_TAINT_MODE`. An owner's `serve --taint-policy` overrides it.
   */
  securityTaint: TaintModeSchema.optional(),
  /**
   * `security.injectionDetector`: whether a
   * detector reads untrusted content — `patterns`, or `model` (patterns, then
   * a classifier call on the `fast` role, or a local chat's own model) — and
   * flags a call made after it. A hit only raises: a reason, `high` risk and
   * a warning line; it never allows, denies or lowers. Absent:
   * `DEFAULT_INJECTION_DETECTOR_MODE`.
   */
  securityInjectionDetector: InjectionDetectorModeSchema.optional(),
  /**
   * `mcp.servers`: the MCP servers
   * (`mcp.<name>`) this workspace allows. Servers are installed once per
   * owner; a workspace offers only the ones listed. Absent: none.
   */
  mcpServers: z.array(z.string().regex(MCP_SERVER_ID_PATTERN)).max(MCP_WORKSPACE_SERVERS_MAX).optional(),
  /**
   * `mcp.people`: the allowed servers whose tools other people's
   * chats (bound from channels) are offered too, with the operator's
   * credentials. Absent: the operator's own chats only.
   */
  mcpPeople: z.array(z.string().regex(MCP_SERVER_ID_PATTERN)).max(MCP_WORKSPACE_SERVERS_MAX).optional(),
  /**
   * `sandbox.domains`: the domains this
   * workspace's `sandbox.run` may reach beside the owner's
   * `serve --sandbox-domain` ones, each `host` or `*.domain`, with an optional
   * `:port`, in stored form (`normalizeSandboxDomain`). A tainted chat gets no
   * network whatever is listed. Absent: none.
   */
  sandboxDomains: z
    .array(
      z
        .string()
        .min(1)
        .max(260)
        .refine((entry) => normalizeSandboxGrant(entry) === entry, {
          message: "expected a host or *.domain, optionally with :port, in lower case, or @registries",
        }),
    )
    .max(SANDBOX_DOMAINS_MAX)
    .optional(),
  /**
   * `sandbox.network`: whether `sandbox.run` may ask the person for a domain
   * nobody granted (`ask`), named in its `requestDomains` and approved on its
   * card for that run, or reaches only the granted ones (`granted`). A chat
   * holding untrusted content never asks. Absent: `granted`.
   */
  sandboxNetwork: SandboxNetworkModeSchema.optional(),
});
export type WorkspaceSettings = z.infer<typeof WorkspaceSettingsSchema>;

/**
 * Where a workspace sets nothing. The detector ships enabled only at ≤ 1%
 * false warnings on benign pages, and `patterns` measured 0.2% (1 of 500
 * pages), so it is on by default. `model` is opt-in: it spends a
 * model call per untrusted text the patterns pass.
 */
export const DEFAULT_INJECTION_DETECTOR_MODE: InjectionDetectorMode = "patterns";

/** The detector mode in force for a workspace: its `security.injectionDetector`, else the default. */
export function injectionDetectorModeOf(settings: WorkspaceSettings): InjectionDetectorMode {
  return settings.securityInjectionDetector ?? DEFAULT_INJECTION_DETECTOR_MODE;
}

/** The `sandbox.network` mode in force for a workspace. */
export function sandboxNetworkModeOf(settings: WorkspaceSettings): SandboxNetworkMode {
  return settings.sandboxNetwork ?? "granted";
}

/** The keys `set`/`unset` address one at a time. */
export const WORKSPACE_SETTING_KEYS = [
  "timezone",
  "operatorName",
  "activitySummaries",
  "activitySummaryModel",
  "browserNoThumbnailHosts",
  "browserSessionIdleMinutes",
  "browserDownloadMaxMiB",
  "browserVisionEngine",
  "desktopGrantedApps",
  "uiRoles",
  "uiPlacements",
  "homeChat",
  "homeDmLink",
  "keptModelRequests",
  "maxOutputTokens",
  "scheduledMonthlyTokenBudget",
  "promptLayout",
  "toolDeferral",
  "tasksHome",
  "travelFlightSearch",
  "travelGoogleFlights",
  "skillSuggestions",
  "pdfEnabled",
  "videoEnabled",
  "videoKeepDays",
  "redactToolResults",
  "parallelReads",
  "memory",
  "securityTaint",
  "securityInjectionDetector",
  "mcpServers",
  "mcpPeople",
  "sandboxDomains",
  "sandboxNetwork",
] as const;
export type WorkspaceSettingKey = (typeof WORKSPACE_SETTING_KEYS)[number];

/** Whether task summaries are on for `settings`: on unless turned off. */
export function activitySummariesOn(settings: WorkspaceSettings): boolean {
  return settings.activitySummaries !== false;
}

/** A monthly token budget as typed (digits, `_` or `,` between them), or `undefined` when it is not one in range. */
export function parseScheduledMonthlyTokenBudget(value: string): number | undefined {
  return parseTokenCount(value, ScheduledMonthlyTokenBudgetSchema);
}

/** How many of a task's newest model calls keep their whole request. */
export function keptModelRequests(settings: WorkspaceSettings): number {
  return settings.keptModelRequests ?? DEFAULT_KEPT_MODEL_REQUESTS;
}

/** The most a model call may write in a workspace, the default filling a gap. */
export function maxOutputTokensOf(settings: WorkspaceSettings): number {
  return settings.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
}

/** A call's output cap as typed (`MIN_MAX_OUTPUT_TOKENS`–`MAX_MAX_OUTPUT_TOKENS`), or `undefined` when it is not one. */
export function parseMaxOutputTokens(value: string): number | undefined {
  return parseWholeNumberIn(value, MIN_MAX_OUTPUT_TOKENS, MAX_MAX_OUTPUT_TOKENS);
}

/** The prompt layout in force for `settings`. */
export function promptLayoutOf(settings: WorkspaceSettings): PromptLayout {
  return settings.promptLayout ?? DEFAULT_PROMPT_LAYOUT;
}

/** Whether attended chats defer rarely used built-ins (`models.toolDeferral`), the default filling a gap. */
export function toolDeferralOf(settings: WorkspaceSettings): ToolDeferral {
  return settings.toolDeferral ?? DEFAULT_TOOL_DEFERRAL;
}

/** Where the person keeps their tasks (`tasks.home`), the default filling a gap. */
export function tasksHomeOf(settings: WorkspaceSettings): TasksHome {
  return settings.tasksHome ?? DEFAULT_TASKS_HOME;
}

/** A count of kept requests as typed (`0`–`MAX_KEPT_MODEL_REQUESTS`), or `undefined` when it is not one. */
export function parseKeptModelRequests(value: string): number | undefined {
  return parseWholeNumberIn(value, 0, MAX_KEPT_MODEL_REQUESTS);
}

/** Whether the workspace has a Home chat: off unless turned on. */
/** Whether the flight search is on (default on). */
export function flightSearchOn(settings: WorkspaceSettings): boolean {
  return settings.travelFlightSearch !== false;
}

/** Whether the PDF tools are on (default on). */
export function pdfToolsOn(settings: WorkspaceSettings): boolean {
  return settings.pdfEnabled !== false;
}

/** Whether the video tools are on (default on). */
export function videoToolsOn(settings: WorkspaceSettings): boolean {
  return settings.videoEnabled !== false;
}

/** How many days a workspace keeps a video taken from outside. */
export function videoKeepDays(settings: WorkspaceSettings): number {
  return settings.videoKeepDays ?? DEFAULT_VIDEO_KEEP_DAYS;
}

/** How many minutes an inactive browser session of the workspace stays open (0: until closed). */
export function browserSessionIdleMinutes(settings: WorkspaceSettings): number {
  return settings.browserSessionIdleMinutes ?? DEFAULT_BROWSER_SESSION_IDLE_MINUTES;
}

/** What drives the workspace's acting by sight. */
export function browserVisionEngineOf(settings: WorkspaceSettings): BrowserVisionEngine {
  return settings.browserVisionEngine ?? "generic";
}

/** The largest browser download the workspace keeps, in MiB. */
export function browserDownloadMaxMiB(settings: WorkspaceSettings): number {
  return settings.browserDownloadMaxMiB ?? DEFAULT_BROWSER_DOWNLOAD_MAX_MIB;
}

/** How many independent read-only calls of one step the workspace runs at the same time (1: one at a time). */
export function parallelReadsOf(settings: WorkspaceSettings): number {
  return settings.parallelReads ?? DEFAULT_PARALLEL_READS;
}

/** A whole number as typed, from `min` to `max`, or `undefined` when it is not one. */
export function parseWholeNumberIn(value: string, min: number, max: number): number | undefined {
  if (!/^\d{1,6}$/.test(value.trim())) return undefined;
  const number = Number(value.trim());
  return number >= min && number <= max ? number : undefined;
}

/** A number of days as typed (`1`–`MAX_VIDEO_KEEP_DAYS`), or `undefined` when it is not one. */
export function parseVideoKeepDays(value: string): number | undefined {
  return parseWholeNumberIn(value, 1, MAX_VIDEO_KEEP_DAYS);
}

/** Whether the agent may offer skills unasked (default on). */
export function skillSuggestionsOn(settings: WorkspaceSettings): boolean {
  return settings.skillSuggestions !== false;
}

/** The stored credential holding the person's SerpApi key: flight searches then ask Google Flights through SerpApi. */
export const SERPAPI_CREDENTIAL_REF = "serpapi";

/** Whether the Google Flights back end is on (default on). */
export function googleFlightsOn(settings: WorkspaceSettings): boolean {
  return settings.travelGoogleFlights !== false;
}

/** Whether tool results are credential-scrubbed (default on). */
export function toolResultRedactionOn(settings: WorkspaceSettings): boolean {
  return settings.redactToolResults !== false;
}

/**
 * The taint mode in force for a workspace: the owner's `serve --taint-policy`
 * when it set one (owner-wide, for that owner's lifetime), else the
 * workspace's `security.taint`, else `DEFAULT_TAINT_MODE`.
 */
export function taintModeOf(settings: WorkspaceSettings, ownerPolicy?: TaintMode): TaintMode {
  return ownerPolicy ?? settings.securityTaint ?? DEFAULT_TAINT_MODE;
}

/** How strict each taint mode is: a page may only raise it (a page cannot widen what runs unasked). */
export function taintModeRank(mode: TaintMode): number {
  return mode === "off" ? 0 : mode === "observe" ? 1 : 2;
}

/** Whether the workspace has a Home chat: on unless set off. */
export function homeChatOn(settings: WorkspaceSettings): boolean {
  return settings.homeChat !== false;
}

/** The DM identities linked to Home in effect: the listed ones while Home is on, else none. */
export function homeDmLinkIdentities(settings: WorkspaceSettings): readonly HomeDmIdentity[] {
  return homeChatOn(settings) ? (settings.homeDmLink ?? []) : [];
}

/** Whether any DM is linked to Home in effect. */
export function homeDmLinkOn(settings: WorkspaceSettings): boolean {
  return homeDmLinkIdentities(settings).length > 0;
}

/** Whether a DM identity is linked to Home in effect. */
export function homeDmLinked(settings: WorkspaceSettings, connectionId: string, senderId: string): boolean {
  return homeDmLinkIdentities(settings).some((identity) => identity.connectionId === connectionId && identity.senderId === senderId);
}

/** An identity as the CLI writes it: `<connection>:<sender>`. */
export function formatHomeDmIdentity(identity: HomeDmIdentity): string {
  return `${identity.connectionId}:${identity.senderId}`;
}

/**
 * `<connection>:<sender>[,…]` as identities, `off` (or `none`) for none, or the
 * first entry that is not one. Whether a connection is a chat channel and the
 * sender a valid id there is its channel's to say, checked where the setting
 * is applied; a message links only from a chat channel's
 * one-to-one conversation either way.
 */
export function parseHomeDmLink(value: string): { readonly identities: readonly HomeDmIdentity[] } | { readonly invalid: string } {
  const trimmed = value.trim();
  if (["off", "none"].includes(trimmed.toLowerCase())) return { identities: [] };
  const identities: HomeDmIdentity[] = [];
  for (const entry of trimmed
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "")) {
    const colon = entry.indexOf(":");
    const parsed =
      colon <= 0 ? undefined : HomeDmIdentitySchema.safeParse({ connectionId: entry.slice(0, colon), senderId: entry.slice(colon + 1) });
    if (parsed === undefined || !parsed.success) return { invalid: entry };
    if (!identities.some((known) => known.connectionId === parsed.data.connectionId && known.senderId === parsed.data.senderId))
      identities.push(parsed.data);
  }
  if (identities.length === 0) return { invalid: value };
  if (identities.length > HOME_DM_LINK_MAX) return { invalid: `more than ${HOME_DM_LINK_MAX} identities` };
  return { identities };
}

/**
 * What linking DMs to Home changes, naming the identities
 * linked: shown whenever a change leaves the link in effect.
 */
export function homeDmLinkPrivacyNote(identities: readonly HomeDmIdentity[]): string {
  return (
    `Privacy: direct messages to the bot from ${identities.map(formatHomeDmIdentity).join(", ")} now become turns of your Home, ` +
    "as long as each identity's binding names you, this workspace's operator. " +
    "Home's whole context — everything you said in the canvas or tavi chat, its notes and notices — can shape the answers sent back to those DMs, " +
    "and their messages and replies are shown in Home. Only the identities listed are linked, and only in a chat channel's one-to-one conversation: group chats, forum topics, email and other identities never are. " +
    "/new in a linked DM ends nothing (Home never ends). Turn it off with `tavi config set chat.home-dm off`; a DM then returns to its own conversation from its next message."
  );
}

/** The no-thumbnail hosts in effect for `settings`: the workspace's list, else the default. */
export function effectiveNoThumbnailHosts(settings: WorkspaceSettings): readonly string[] {
  return settings.browserNoThumbnailHosts ?? DEFAULT_BROWSER_NO_THUMBNAIL_HOSTS;
}

/**
 * `desktop.grantedApps` as `tavi config set` takes it: comma-separated bundle
 * ids or app names, or `none`. Names match in any case, so one differing only
 * in case is kept once.
 */
export function parseDesktopGrantedApps(value: string): { readonly apps: readonly string[] } | { readonly invalid: string } {
  if (value.trim().toLowerCase() === "none") return { apps: [] };
  const apps: string[] = [];
  for (const entry of value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "")) {
    if (entry.length > 200) return { invalid: entry };
    if (!apps.some((app) => app.toLowerCase() === entry.toLowerCase())) apps.push(entry);
  }
  if (apps.length === 0) return { invalid: value };
  if (apps.length > DESKTOP_GRANTED_APPS_MAX) return { invalid: `more than ${DESKTOP_GRANTED_APPS_MAX} apps` };
  return { apps };
}

/**
 * A comma-separated host list (`a.com, *.bank`) in its stored form, `none` for
 * an empty list, or the first entry that is not a host.
 */
export function parseNoThumbnailHosts(value: string): { readonly hosts: readonly string[] } | { readonly invalid: string } {
  if (value.trim().toLowerCase() === "none") return { hosts: [] };
  const hosts: string[] = [];
  for (const entry of value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "")) {
    const normalized = normalizeNoThumbnailHost(entry);
    if (normalized === undefined) return { invalid: entry };
    if (!hosts.includes(normalized)) hosts.push(normalized);
  }
  if (hosts.length === 0) return { invalid: value };
  if (hosts.length > BROWSER_NO_THUMBNAIL_HOSTS_MAX) return { invalid: `more than ${BROWSER_NO_THUMBNAIL_HOSTS_MAX} hosts` };
  return { hosts };
}

/** `on`/`off` (and `true`/`false`, `yes`/`no`) as a boolean, or `undefined` for anything else. */
export function parseOnOff(value: string): boolean | undefined {
  const normalized = value.trim().toLowerCase();
  if (["on", "true", "yes", "1"].includes(normalized)) return true;
  if (["off", "false", "no", "0"].includes(normalized)) return false;
  return undefined;
}

/** `<connection>/<model>` as a target, or `undefined` when it is not one. */
export function parseSettingModelTarget(value: string): SettingModelTarget | undefined {
  const trimmed = value.trim();
  const slash = trimmed.indexOf("/");
  if (slash <= 0) return undefined;
  const parsed = SettingModelTargetSchema.safeParse({ connectionId: trimmed.slice(0, slash), model: trimmed.slice(slash + 1) });
  return parsed.success ? parsed.data : undefined;
}

/** A nonnegative revision; an absent row is revision zero, like the system prompt setting. */
export const WorkspaceSettingsRevisionSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

/** Actor metadata is a label from the trusted operator path, never a payload-supplied identity. */
export const WorkspaceSettingsActorSchema = z.string().min(1).max(128);

/**
 * The persisted document and its latest-change metadata.
 *
 * `updatedAt` and `actor` are `null` on the synthetic absent record
 * (`absentWorkspaceSettings`) — a workspace that has never saved a setting.
 */
export const WorkspaceSettingsRecordSchema = z.strictObject({
  workspaceId: IdSchema,
  settings: WorkspaceSettingsSchema,
  revision: WorkspaceSettingsRevisionSchema,
  updatedAt: TimestampSchema.nullable(),
  actor: WorkspaceSettingsActorSchema.nullable(),
});
export type WorkspaceSettingsRecord = z.infer<typeof WorkspaceSettingsRecordSchema>;

/** The revision-zero record returned for a workspace that has never saved a setting. */
export function absentWorkspaceSettings(workspaceId: string): WorkspaceSettingsRecord {
  return { workspaceId, settings: {}, revision: 0, updatedAt: null, actor: null };
}

export const SetWorkspaceSettingsInputSchema = z.strictObject({
  workspaceId: IdSchema,
  /** The whole document, replacing the stored one: a key left out is cleared. */
  settings: WorkspaceSettingsSchema,
  /** The revision the writer read; a mismatch is a `CONFLICT`, never a last-writer-wins overwrite. */
  expectedRevision: WorkspaceSettingsRevisionSchema,
  actor: WorkspaceSettingsActorSchema,
  now: TimestampSchema,
});
export type SetWorkspaceSettingsInput = z.infer<typeof SetWorkspaceSettingsInputSchema>;

/**
 * Storage for the settings document.
 *
 * `set` is a compare-and-set under `transactionImmediate` and reports a stale
 * revision as `CONFLICT`, exactly as `SystemPromptRepositoryPort.set` does. The
 * row is kept however few keys remain, so the revision never restarts.
 */
interface WorkspaceSettingsRepositoryPortDefinition {
  /** Never absent: a workspace that has never saved gets the revision-zero record. */
  get(workspaceId: string): WorkspaceSettingsRecord;
  set(input: SetWorkspaceSettingsInput): WorkspaceSettingsRecord;
  /**
   * Every workspace with a stored row, by id: what an offline reader that
   * knows no workspace list (`tavi reset` naming the memory providers each
   * selects) reads. A row whose document cannot be read is left out.
   */
  list(): readonly WorkspaceSettingsRecord[];
}

export type WorkspaceSettingsRepositoryPort = AsyncRepository<WorkspaceSettingsRepositoryPortDefinition>;

/**
 * The `workspace-settings` IPC command's actions.
 *
 * `set`/`unset` change one key. `expectedRevision` is optional, unlike
 * `system-prompt`'s: a one-key write from the CLI has nothing to lose by
 * applying to the current document, while the Settings view passes the
 * revision it read so a concurrent change is a `CONFLICT` rather than silently
 * replaced.
 */
export const WORKSPACE_SETTINGS_ACTIONS = ["get", "set", "unset"] as const;
export type WorkspaceSettingsAction = (typeof WORKSPACE_SETTINGS_ACTIONS)[number];

export const WorkspaceSettingsPayloadSchema = z
  .strictObject({
    action: z.enum(WORKSPACE_SETTINGS_ACTIONS),
    workspaceId: IdSchema.optional(),
    key: z.enum(WORKSPACE_SETTING_KEYS).optional(),
    /**
     * The new value for `set`. Bounded here, validated by the owner: a refusal
     * from this schema names only the path, and an invalid zone should be
     * reported with the value the person typed. Long enough for a host list.
     */
    value: z.string().min(1).max(8192).optional(),
    expectedRevision: WorkspaceSettingsRevisionSchema.optional(),
    /**
     * The person saw and accepted the disclosure this change needs
     * (invariant 14): turning `memory.retrieval` to `hybrid` on a remote
     * embedding connection is refused without it, naming what is sent where.
     */
    confirmed: z.literal(true).optional(),
    /**
     * The embedding connection the accepted disclosure named (the refusal's
     * `details.connectionId`): `confirmed` accepts hybrid recall, and
     * personal memory's opt-in, only while that connection is still the one
     * bound; another one bound since is refused with its own disclosure.
     */
    confirmedConnection: z.string().min(1).max(200).optional(),
    /**
     * The person's choice for embedding personal memory through a remote
     * embedding connection, with a `memory` write under hybrid recall: `true`
     * turns it on once its own
     * disclosure is accepted (`confirmed`), `false` turns it off. Absent:
     * unchanged. The owner stores it as `memory.retrievalPersonal`.
     */
    retrievalPersonal: z.boolean().optional(),
  })
  .refine((payload) => payload.retrievalPersonal === undefined || (payload.action === "set" && payload.key === "memory"), {
    message: "retrievalPersonal goes only with a memory write",
    path: ["retrievalPersonal"],
  })
  .refine((payload) => payload.confirmedConnection === undefined || payload.confirmed === true, {
    message: "confirmedConnection goes only with confirmed",
    path: ["confirmedConnection"],
  })
  .refine((payload) => payload.action === "get" || payload.key !== undefined, {
    message: "a workspace-settings write needs the key it changes",
    path: ["key"],
  })
  .refine((payload) => payload.action !== "set" || payload.value !== undefined, {
    message: "workspace-settings set needs a value",
    path: ["value"],
  })
  .refine((payload) => payload.action !== "unset" || payload.value === undefined, {
    message: "workspace-settings unset takes no value",
    path: ["value"],
  })
  .refine(
    (payload) =>
      payload.action !== "get" || (payload.key === undefined && payload.value === undefined && payload.expectedRevision === undefined),
    { message: "workspace-settings get takes only its workspace", path: ["action"] },
  );
export type WorkspaceSettingsPayload = z.infer<typeof WorkspaceSettingsPayloadSchema>;

/**
 * The `workspace-settings` answer, for both a read and a write.
 *
 * `settings` is what is stored; `effective` is what the runtime uses, with
 * every default filled in. `hostTimezone` is the owner host's zone, so a client
 * can say "the host default" without guessing it from the browser's zone.
 */
export const WorkspaceSettingsAnswerSchema = z.strictObject({
  workspaceId: IdSchema,
  revision: WorkspaceSettingsRevisionSchema,
  settings: WorkspaceSettingsSchema,
  effective: z.strictObject({
    timezone: z.string().min(1).max(64),
    /** Optional only so a page reads an owner from before task summaries; this build always sends it. */
    activitySummaries: z.boolean().optional(),
    /** Optional only so a page reads an owner from before browser history; this build always sends it. */
    browserNoThumbnailHosts: z.array(z.string().min(1).max(255)).max(BROWSER_NO_THUMBNAIL_HOSTS_MAX).optional(),
    /** Optional only so a page reads an owner from before the Home chat setting; this build always sends it. */
    homeChat: z.boolean().optional(),
    /** Optional only so a page reads an owner from before the DM link; this build always sends it. */
    homeDmLink: z.boolean().optional(),
    /** Optional only so a page reads an owner from before request retention; this build always sends it. */
    keptModelRequests: z.number().int().min(0).max(MAX_KEPT_MODEL_REQUESTS).optional(),
    /** Optional only so a page reads an owner from before the output cap; this build always sends it. */
    maxOutputTokens: z.number().int().min(MIN_MAX_OUTPUT_TOKENS).max(MAX_MAX_OUTPUT_TOKENS).optional(),
    /** Optional only so a page reads an owner from before the prompt layout setting; this build always sends it. */
    promptLayout: PromptLayoutSchema.optional(),
    /** Optional only so a page reads an owner from before the deferral setting; this build always sends it. */
    toolDeferral: ToolDeferralSchema.optional(),
    /** Optional only so a page reads an owner from before the task home; this build always sends it. */
    tasksHome: TasksHomeSchema.optional(),
    /** Optional only so a page reads an owner from before the flight settings; this build always sends them. */
    travelFlightSearch: z.boolean().optional(),
    travelGoogleFlights: z.boolean().optional(),
    /** Optional only so a page reads an owner from before the skill suggestions setting; this build always sends it. */
    skillSuggestions: z.boolean().optional(),
    /** Optional only so a page reads an owner from before the PDF tools; this build always sends it. */
    pdfEnabled: z.boolean().optional(),
    /** Optional only so a page reads an owner from before the video tools; this build always sends it. */
    videoEnabled: z.boolean().optional(),
    videoKeepDays: z.number().int().min(1).max(MAX_VIDEO_KEEP_DAYS).optional(),
    /** Optional only so a page reads an owner from before the browser's idle and download limits; this build always sends them. */
    browserSessionIdleMinutes: z.number().int().min(0).max(MAX_BROWSER_SESSION_IDLE_MINUTES).optional(),
    browserDownloadMaxMiB: z.number().int().min(1).max(MAX_BROWSER_DOWNLOAD_MAX_MIB).optional(),
    browserVisionEngine: BrowserVisionEngineSchema.optional(),
    /** Optional only so a page reads an owner from before tool-result redaction; this build always sends it. */
    redactToolResults: z.boolean().optional(),
    /** Optional only so a page reads an owner from before `tools.parallelReads`; this build always sends it. */
    parallelReads: z.number().int().min(1).max(MAX_PARALLEL_READS).optional(),
    /** Optional only so a page reads an owner from before the memory section; this build always sends it. */
    memory: EffectiveMemorySettingsSchema.optional(),
    /** Optional only so a page reads an owner from before `security.taint`; this build always sends it. The mode in force, an owner's `--taint-policy` included. */
    securityTaint: TaintModeSchema.optional(),
    /** Optional only so a page reads an owner from before `security.injectionDetector`; this build always sends it. */
    securityInjectionDetector: InjectionDetectorModeSchema.optional(),
  }),
  hostTimezone: z.string().min(1).max(64),
  /** The owner's `serve --taint-policy`, when it set one: it overrides `security.taint` in every workspace until the owner restarts without it. */
  taintPolicy: TaintModeSchema.optional(),
  /**
   * The built-in plugins turned off here (`tavi.browser`, `tavi.flights`, `tavi.video`, …): a setting only one of
   * them reads changes nothing while it is off, so a page leaves it out. Absent from an owner that does not say.
   */
  disabledPlugins: z.array(z.string().min(1).max(64)).max(64).optional(),
});
export type WorkspaceSettingsAnswer = z.infer<typeof WorkspaceSettingsAnswerSchema>;

/** The answer for `record`, with each default resolved against `host`. */
export function workspaceSettingsAnswerOf(
  record: WorkspaceSettingsRecord,
  host: string,
  taintPolicy?: TaintMode,
  disabledPlugins?: ReadonlySet<string>,
): WorkspaceSettingsAnswer {
  return {
    workspaceId: record.workspaceId,
    revision: record.revision,
    settings: record.settings,
    effective: {
      timezone: record.settings.timezone ?? host,
      activitySummaries: activitySummariesOn(record.settings),
      browserNoThumbnailHosts: [...effectiveNoThumbnailHosts(record.settings)],
      homeChat: homeChatOn(record.settings),
      homeDmLink: homeDmLinkOn(record.settings),
      keptModelRequests: keptModelRequests(record.settings),
      maxOutputTokens: maxOutputTokensOf(record.settings),
      promptLayout: promptLayoutOf(record.settings),
      toolDeferral: toolDeferralOf(record.settings),
      tasksHome: tasksHomeOf(record.settings),
      travelFlightSearch: flightSearchOn(record.settings),
      travelGoogleFlights: googleFlightsOn(record.settings),
      skillSuggestions: skillSuggestionsOn(record.settings),
      pdfEnabled: pdfToolsOn(record.settings),
      videoEnabled: videoToolsOn(record.settings),
      videoKeepDays: videoKeepDays(record.settings),
      browserSessionIdleMinutes: browserSessionIdleMinutes(record.settings),
      browserDownloadMaxMiB: browserDownloadMaxMiB(record.settings),
      browserVisionEngine: browserVisionEngineOf(record.settings),
      redactToolResults: toolResultRedactionOn(record.settings),
      parallelReads: parallelReadsOf(record.settings),
      memory: effectiveMemorySettings(record.settings.memory),
      securityTaint: taintModeOf(record.settings, taintPolicy),
      securityInjectionDetector: injectionDetectorModeOf(record.settings),
    },
    hostTimezone: host,
    ...(taintPolicy === undefined ? {} : { taintPolicy }),
    ...(disabledPlugins === undefined ? {} : { disabledPlugins: [...disabledPlugins].sort() }),
  };
}
