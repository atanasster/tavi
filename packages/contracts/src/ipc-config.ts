import { RouterSettingsSubmissionSchema, RouterFeatureSchema, RouterModeSchema } from "./router.js";
import { ModelPriceSheetSchema } from "./model-accounting.js";
import { z } from "zod";

import { ArgMatcherSchema, ToolPatternSchema, ToolRuleDecisionSchema, type SessionGrant, type ToolRule } from "./tool-policy.js";
import {
  MODEL_ROLES,
  ModelConnectionSchema,
  ModelTargetInputSchema,
  ModelTargetSchema,
  PDF_ENGINES,
  PDF_INPUTS,
  PROVIDER_KINDS,
  StreamTimeoutSecondsSchema,
  WIRE_APIS,
} from "./models-config.js";
import { ProjectSchema } from "./projects.js";
import { SEARCH_PROVIDER_ID_PATTERN, WEB_SEARCH_KINDS } from "./web-search.js";
import {
  SCHEDULE_DELIVERY_TARGETS,
  SCHEDULE_HUMAN_CHECKPOINTS,
  SCHEDULE_MAX_EVERY_HOURS,
  SCHEDULE_MAX_TIMES_PER_DAY,
  ScheduleMaxRunMinutesSchema,
  ScheduleMaxTokensSchema,
  ScheduleNotifySchema,
  ScheduleEmailTriggerInputSchema,
  type ScheduleEmailTrigger,
  type ScheduleFireRecord,
  type ScheduleRecord,
  type ScheduledWorkUsage,
} from "./schedules.js";
import { AgendaWindowFieldsSchema } from "./agenda.js";
import { ReminderMonthlySchema, ReminderYearlySchema } from "./schedule-time.js";
import { IPC_MAX_PROMPT_CHARS } from "./ipc-limits.js";
export {
  APPROVAL_NOTE_MAX_CHARS,
  ARTIFACT_REVIEW_NOTE_MAX_CHARS,
  ApprovalRowIdSchema,
  IPC_MAX_CONNECTION_BACKLOG_BYTES,
  IPC_MAX_FRAME_BYTES,
  IPC_MAX_MESSAGE_CHARS,
  IPC_MAX_PROMPT_CHARS,
  IPC_MAX_SUBSCRIPTION_BACKLOG_BYTES,
  IPC_MAX_SUBSCRIPTIONS_PER_CONNECTION,
  IPC_RESERVED_OPERATION_KEY_PREFIX,
  MAX_REVIEW_EVENT_REQUESTS,
  type ApprovalRowId,
} from "./ipc-limits.js";
import { DisplayNameSchema, IdSchema } from "./ids.js";

/**
 * The payloads of the IPC commands that configure the owner: models,
 * credentials, search providers, projects, schedules, the router and tool
 * permissions — and the model target a client asserts it runs on.
 */

/**
 * The target a client was told to run or resume on (`--connection/--model`).
 * Not a choice but an assertion of the owner's default as it resolves now:
 * an owner running another target refuses the request, naming its
 * own, rather than quietly running a different model than the operator asked
 * for. A chat's own model is chosen with `run`'s `model` or `models set-chat`.
 */
export const ExpectTargetSchema = z.object({
  connectionId: z.string().min(1).max(64).optional(),
  model: z.string().min(1).max(256).optional(),
});
export type ExpectTarget = z.infer<typeof ExpectTargetSchema>;

export const MODELS_ACTIONS = [
  "list",
  "show",
  "roles",
  "add",
  "remove",
  "rebind",
  "set-role",
  "clear-role",
  "set-default",
  "clear-default",
  "test",
  "probe",
  "discover",
  "chat",
  "set-chat",
  "video",
  // Read-only: what `doctor` says of video (FFmpeg, confinement, the analyser chains) for Settings → Models,
  // since a page may not read `doctor` itself.
  "video-status",
  // What Rhumb says of the models in use: stores their lifecycle, never changes a model.
  "sync",
  // Read-only: what the last sync stored of the models in use, for today (doctor's `modelConfiguration.lifecycle`).
  "lifecycle",
] as const;

export const ModelsPayloadSchema = z.object({
  action: z.enum(MODELS_ACTIONS),
  connectionId: z.string().min(1).max(64).optional(),
  label: z.string().min(1).max(120).optional(),
  kind: z.enum(PROVIDER_KINDS).optional(),
  baseUrl: z.string().min(1).max(500).optional(),
  credentialRef: z.string().min(1).max(128).optional(),
  model: z.string().min(1).max(256).optional(),
  /** `add`: as `tavi models add --local-only` and `--header`, and bounded as the stored connection is. */
  localOnly: z.boolean().optional(),
  /** `add`: as `--pdf-input`; `openai-file` only where the endpoint's preset takes PDFs. */
  pdfInput: z.enum(PDF_INPUTS).optional(),
  /** `add`: as `--pdf-engine`; `default` clears it. */
  pdfEngine: z.enum([...PDF_ENGINES, "default"]).optional(),
  /** `add`: `responses` for a ChatGPT sign-in's connection. */
  wireApi: z.enum(WIRE_APIS).optional(),
  /** `add`: as `--first-byte-timeout` and `--idle-timeout`, in seconds; `default` clears one. */
  streamFirstByteSeconds: z.union([StreamTimeoutSecondsSchema, z.literal("default")]).optional(),
  streamIdleSeconds: z.union([StreamTimeoutSecondsSchema, z.literal("default")]).optional(),
  headers: ModelConnectionSchema.shape.headers,
  role: z.enum(MODEL_ROLES).optional(),
  /** `set-role`: the ordered fallback targets, as `tavi models set-role --fallback`. */
  fallback: z.array(ModelTargetInputSchema).max(3).optional(),
  workspaceId: IdSchema.optional(),
  /** `chat`, `set-chat`: the chat whose model is read, or set to `connectionId`/`model` from its next turn. */
  taskId: IdSchema.optional(),
  /** `video`: the model native video goes on or off for, and whether its disclosure was confirmed. */
  videoEnable: z.string().min(1).max(256).optional(),
  videoDisable: z.string().min(1).max(256).optional(),
  disclosureConfirmed: z.boolean().optional(),
  /** `probe`: what is probed (absent: `pdf`, as before there was a choice). */
  probe: z.enum(["pdf", "video"]).optional(),
});
export type ModelsPayload = z.infer<typeof ModelsPayloadSchema>;

/**
 * What a `models` write answers beside its result. `restartRequired`
 * is always false since the owner reads its configuration at each turn;
 * it stays for clients written when a write could need a restart.
 */
export interface ModelsWriteResult {
  readonly result: unknown;
  readonly restartRequired: boolean;
}

/**
 * What `models chat` answers: the model the chat runs from its next turn —
 * `chosen`, the one saved as its own (a person's choice, or the router's); else
 * `default`, the default as configured now. `target` is null for a chosen
 * model no configured connection offers any more (its next turn is refused
 * until another is chosen), and for an owner running no configured model.
 */
export const ChatModelSchema = z.object({
  taskId: IdSchema,
  target: ModelTargetSchema.nullable(),
  source: z.enum(["chosen", "default"]),
});
export type ChatModel = z.infer<typeof ChatModelSchema>;

export const CREDENTIALS_ACTIONS = ["list", "set", "delete", "encrypt", "key"] as const;

/**
 * Where `key` moves the at-rest key on the owner: to the systemd credential the
 * owner's unit loads, or from it back into `credentials.key`. Only the owner
 * systemd started reads that credential; a page is refused either way.
 */
export const CREDENTIAL_KEY_OWNER_HOMES = ["file", "systemd"] as const;

export const CredentialsPayloadSchema = z.object({
  action: z.enum(CREDENTIALS_ACTIONS),
  reference: z.string().min(1).max(128).optional(),
  /**
   * The secret value, present only for `set`.
   *
   * It crosses the local socket once, to a daemon that writes it `0600` through
   * the same store the CLI uses, and is never echoed back. Bounded so a stray
   * paste cannot become a frame-sized allocation.
   */
  value: z
    .string()
    .min(1)
    .max(16 * 1024)
    .optional(),
  /** `key`: where to move the key; absent, where it is kept. */
  to: z.enum(CREDENTIAL_KEY_OWNER_HOMES).optional(),
});
export type CredentialsPayload = z.infer<typeof CredentialsPayloadSchema>;

export const SEARCH_ACTIONS = ["list", "add", "remove", "enable", "disable", "test"] as const;

/**
 * `search`: the web search providers `web_search` tries, as `tavi
 * search` configures them — so a page can, too. `add`
 * carries the provider's fields, checked by the repository against
 * `SearchProviderConfigSchema` (a keyed kind needs its `credentialRef`, SearXNG
 * its `baseUrl`); the others name it by `providerId`. `test` runs one search
 * through the adapter `web_search` uses, with the owner's credential chain.
 */
export const SearchPayloadSchema = z.object({
  action: z.enum(SEARCH_ACTIONS),
  providerId: z.string().min(1).max(64).regex(SEARCH_PROVIDER_ID_PATTERN, "expected a lower-case slug").optional(),
  kind: z.enum(WEB_SEARCH_KINDS).optional(),
  credentialRef: z.string().min(1).max(128).optional(),
  baseUrl: z.string().min(1).max(500).optional(),
  /** `test`: what to search for; `tavi` otherwise. */
  query: z.string().min(1).max(500).optional(),
});
export type SearchPayload = z.infer<typeof SearchPayloadSchema>;

/**
 * What a `search` write answers beside the provider. `restartRequired` is
 * always false since the owner activates a provider added or enabled over IPC
 * on demand and offers `web_search` from the next turn; it stays for
 * clients written when the tool was registered only as
 * the runtime composed.
 */
export interface SearchWriteResult {
  readonly result: unknown;
  readonly restartRequired: boolean;
}

export const PROJECTS_ACTIONS = ["list", "add", "remove", "show", "enable", "disable"] as const;

/**
 * `projects`: the project registry the collectors read.
 *
 * `add` carries the project itself, validated by the same `ProjectSchema` the
 * registry and the collectors use — its sources (GA4, Search Console, billing,
 * Stripe, keywords) are what a project *is*, so a name alone would create one
 * nothing can collect for. `show`/`remove`/`enable`/`disable` name it by id.
 */
export const ProjectsPayloadSchema = z.object({
  action: z.enum(PROJECTS_ACTIONS),
  workspaceId: IdSchema.optional(),
  projectId: IdSchema.optional(),
  project: ProjectSchema.optional(),
});
export type ProjectsPayload = z.infer<typeof ProjectsPayloadSchema>;

export const SCHEDULES_ACTIONS = [
  "list",
  "show",
  "history",
  "add",
  "update",
  "enable",
  "disable",
  "remove",
  "run",
  "agenda",
  "preview",
  "tools",
  "webhook",
  "email-trigger",
] as const;

/** How many runs `schedules preview` answers when no `limit` is given, and the most it answers. */
export const SCHEDULE_PREVIEW_RUNS = 3;
export const SCHEDULE_PREVIEW_MAX_RUNS = 10;

/** What `schedules webhook` does to a schedule's webhook. */
export const SCHEDULE_WEBHOOK_MODES = ["on", "off", "rotate"] as const;
export type ScheduleWebhookMode = (typeof SCHEDULE_WEBHOOK_MODES)[number];

/**
 * What `schedules webhook` answers. `secret` and `signingKey` come only from `on` (when it made a secret) and `rotate`,
 * and are never shown again: the secret is the bearer token a call sends, stored only as its SHA-256; the signing key
 * the HMAC key a signed call uses, stored only encrypted with the credential key, and made only while the credential
 * store is encrypted. `url` is the address under the ingress's public address, when one is set, else the listener's
 * own loopback address once the ingress is configured.
 */
export interface ScheduleWebhookAnswer {
  readonly scheduleId: string;
  readonly name: string;
  readonly webhook: "on" | "off";
  readonly path: string;
  readonly url?: string;
  /** When its current secret was made, while it is on. */
  readonly since?: string;
  readonly secret?: string;
  readonly signingKey?: string;
  /** `on` for a webhook already on: nothing changed, and no secret is shown. */
  readonly unchanged?: true;
}

/**
 * What `schedules email-trigger` answers: whether the schedule's email trigger is on, and what it listens for while it
 * is. `unchanged` for `off` on a schedule that had none.
 */
export interface ScheduleEmailTriggerAnswer {
  readonly scheduleId: string;
  readonly name: string;
  readonly emailTrigger: "on" | "off";
  readonly trigger?: ScheduleEmailTrigger;
  readonly unchanged?: true;
}

export const SchedulesPayloadSchema = z.object({
  action: z.enum(SCHEDULES_ACTIONS),
  workspaceId: IdSchema.optional(),
  principalId: IdSchema.optional(),
  name: DisplayNameSchema.optional(),
  prompt: z.string().min(1).max(IPC_MAX_PROMPT_CHARS).optional(),
  at: z.string().max(5).optional(),
  /** Several times a day (`tavi schedules --at 07:00,19:00`); replaces `at` or `everyHours`. */
  times: z.array(z.string().max(5)).min(1).max(SCHEDULE_MAX_TIMES_PER_DAY).optional(),
  /** Every this many hours, in `between` when given; replaces `at` or `times`. */
  everyHours: z.number().int().min(1).max(SCHEDULE_MAX_EVERY_HOURS).optional(),
  /** The window `everyHours` runs in; `null` clears it (the whole day). */
  between: z
    .strictObject({ from: z.string().max(5), to: z.string().max(5) })
    .nullable()
    .optional(),
  timezone: z.string().min(1).max(64).optional(),
  /** Days of the week; `null` clears every day pattern (`days`, `monthly`, `yearly`, `once`): every day again. */
  days: z.array(z.number().int().min(0).max(6)).min(1).max(7).nullable().optional(),
  /** A day each month, replacing the other day patterns. */
  monthly: ReminderMonthlySchema.optional(),
  /** A day each year, replacing the other day patterns. */
  yearly: ReminderYearlySchema.optional(),
  /** Only on this date, replacing the other day patterns and `untilDate`. */
  once: z.iso.date().optional(),
  /** The spec's `until`, the last date it runs on (`until` here is the agenda's window); `null` clears it. */
  untilDate: z.iso.date().nullable().optional(),
  missed: z.string().max(64).optional(),
  allow: z.array(z.string().max(4096)).max(128).optional(),
  agentId: z.string().min(1).max(128).nullable().optional(),
  alertConnection: z.string().min(1).max(128).nullable().optional(),
  alertDestination: z.string().min(1).max(256).nullable().optional(),
  /** Whether a fire may ask in the alert destination, with a default. */
  humanCheckpoints: z.enum(SCHEDULE_HUMAN_CHECKPOINTS).optional(),
  /** Where the run's result is posted besides what it sends itself: `home`, or `none` to stop. */
  deliverTo: z.enum([...SCHEDULE_DELIVERY_TARGETS, "none"]).optional(),
  /** How long a fire's run may work before it is stopped, in minutes. */
  maxRunMinutes: ScheduleMaxRunMinutesSchema.optional(),
  /** How many tokens a fire's run, its workers included, may use before it is stopped; `null` removes the ceiling. */
  maxTokens: ScheduleMaxTokensSchema.nullable().optional(),
  /** The host folder its fires work in, checked against the owner's `--fs-root` folders; `null` removes it. Never from a chat. */
  folder: z.string().min(1).max(4_096).nullable().optional(),
  /** When a run that went well tells its person: `always`, `when-sent` or `if-changed`. */
  notify: ScheduleNotifySchema.optional(),
  /** A read-only look before each fire, as typed (`page-changed:https://…`, `feed-has-new:https://…`, `file-changed:/path`); `none` or `null` removes it. */
  precheck: z.string().min(1).max(2100).nullable().optional(),
  /** Make it a watcher (`true`, which needs a pre-check), or stop it being one (`false`): see `scheduleWatchSentence`. */
  watch: z.boolean().optional(),
  /** A schedule's id, or its name within the workspace (as `tavi schedules` accepts either). */
  scheduleId: z.string().min(1).max(200).optional(),
  /** `list`: also answer what the workspace's scheduled work spent this month (`scheduledWork`), summed from model accounting. */
  withUsage: z.boolean().optional(),
  /** `webhook`: turn the schedule's webhook on (a new secret, shown once), off, or `rotate` its secret. */
  webhook: z.enum(SCHEDULE_WEBHOOK_MODES).optional(),
  /** `email-trigger`: turn the schedule's email trigger on, listening as given, or `off`. */
  emailTrigger: z.union([z.literal("off"), ScheduleEmailTriggerInputSchema]).optional(),
  /** `run`: the target the fire is expected to run on (`tavi schedules run-now --connection/--model`). */
  expectTarget: ExpectTargetSchema.optional(),
  /** `agenda`: the window and the most items (`AgendaWindowFieldsSchema`); `history`: the most fires; `preview`: the most runs. */
  ...AgendaWindowFieldsSchema.shape,
});
export type SchedulesPayload = z.infer<typeof SchedulesPayloadSchema>;

/** What `schedules show` answers: the schedule, its most recent fires and the zone to read them in. */
export type ScheduleShowResult = ScheduleRecord & {
  readonly timezone: string;
  readonly recentFires: readonly ScheduleFireRecord[];
  /**
   * Where a call reaches its webhook, while it has one: under the ingress's public address, else the listener's own
   * loopback address (`http://127.0.0.1:<port>/hooks/schedules/<id>`); absent before the ingress is configured.
   */
  readonly webhookUrl?: string;
};

/**
 * What `schedules preview` answers for a cadence that is not saved: the zone it
 * runs in, the cadence in words, and its next runs (ISO-8601 UTC, earliest
 * first), fewer when it ends sooner.
 */
export interface SchedulePreviewResult {
  readonly timezone: string;
  readonly text: string;
  readonly runs: readonly string[];
}

/**
 * What `schedules tools` answers: the registered tool ids a schedule may list
 * by name (an MCP tool only once approved read-only), the `prefix.*`
 * families among them, and the listed ids that are read-only, each sorted.
 * Nothing a schedule's list is refused for is offered.
 */
export interface ScheduleToolsResult {
  readonly tools: readonly string[];
  readonly families: readonly string[];
  readonly readOnly: readonly string[];
}

/** What `schedules history` answers: the schedule's fires, newest first, and the zone to read them in. */
export interface ScheduleHistoryResult {
  readonly scheduleId: string;
  readonly name: string;
  readonly timezone: string;
  readonly fires: readonly ScheduleFireRecord[];
}

/** What `schedules list` answers: each schedule without its prompt, which `show` gives, and, when asked `withUsage`, what the workspace's scheduled work spent this month. */
export interface SchedulesListResult {
  readonly schedules: readonly Omit<ScheduleRecord, "prompt">[];
  readonly truncated: boolean;
  /** Absent unless asked `withUsage`, and from an owner from before the monthly total. */
  readonly scheduledWork?: ScheduledWorkUsage;
}

const routerScopeFields = { workspaceId: IdSchema.default("default"), principalId: IdSchema.default("operator") };
export const RouterPayloadSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("status"), ...routerScopeFields }),
  z.strictObject({ action: z.literal("explain"), ...routerScopeFields, taskId: IdSchema }),
  z.strictObject({
    action: z.literal("configure"),
    ...routerScopeFields,
    expectedRevision: z.number().int().nonnegative(),
    settings: RouterSettingsSubmissionSchema,
    priceSheets: z.array(ModelPriceSheetSchema).max(32).default([]),
  }),
  z.strictObject({
    action: z.literal("set-mode"),
    ...routerScopeFields,
    expectedRevision: z.number().int().nonnegative(),
    feature: RouterFeatureSchema,
    mode: RouterModeSchema,
  }),
  z.strictObject({
    action: z.literal("set-provider"),
    ...routerScopeFields,
    expectedRevision: z.number().int().nonnegative(),
    providerId: IdSchema,
  }),
]);
export type RouterPayload = z.infer<typeof RouterPayloadSchema>;

/**
 * `permissions`: a workspace's tool rules and its tasks' session
 * grants. `add` stores an operator rule; `remove` deletes one (shipped and
 * `serve --allow` rules live in code and the command line, not here);
 * `revoke` drops a session grant.
 */
const permissionsScope = { workspaceId: IdSchema.default("default") };
export const PermissionsPayloadSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("rules"), ...permissionsScope }),
  z.strictObject({
    action: z.literal("add"),
    ...permissionsScope,
    toolPattern: ToolPatternSchema,
    argMatcher: ArgMatcherSchema.optional(),
    decision: ToolRuleDecisionSchema,
    note: z.string().max(500).optional(),
    matchUnparsed: z.literal(true).optional(),
    createdBy: IdSchema.default("operator"),
  }),
  z.strictObject({ action: z.literal("remove"), ...permissionsScope, ruleId: IdSchema }),
  z.strictObject({ action: z.literal("grants"), ...permissionsScope, taskId: IdSchema.optional() }),
  z.strictObject({ action: z.literal("revoke"), ...permissionsScope, grantId: IdSchema }),
]);
export type PermissionsPayload = z.infer<typeof PermissionsPayloadSchema>;

/** `permissions rules`: every rule in force, shipped and flag rules included, marked by source. */
export interface PermissionsRulesResult {
  readonly rules: readonly ToolRule[];
}
/** A session grant as `permissions grants` lists it: with its chat's title, when the chat has one. */
export type ListedSessionGrant = SessionGrant & { readonly taskTitle?: string };
/** `permissions grants`: the workspace's (or one task's) session grants. */
export interface PermissionsGrantsResult {
  readonly grants: readonly ListedSessionGrant[];
}
