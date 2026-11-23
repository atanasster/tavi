import { z } from "zod";

import { TimestampSchema } from "./ids.js";
import { canvasCoreEnglish, type CanvasCoreT } from "./locales/core-canvas.js";
import { MemoryProvenanceSchema } from "./memory.js";
import type { AsyncRepository } from "./persistence-types.js";
import type { ModelUsage } from "./model.js";
import { SCHEDULE_TIME_PATTERN } from "./schedules.js";
import { defineProviderError } from "./util.js";
import { SettingModelTargetSchema } from "./workspace-settings.js";

/**
 * The heartbeat: a periodic check-in that stays quiet
 * until something needs the person. The host plugin `tavi.heartbeat` owns the
 * clock, gates, budget, egress, delivery and the ledger; a provider — the
 * built-in `tavi.heartbeatagent` or any approved plugin that `provides`
 * `heartbeat` — decides only what is worth saying; signal sources add
 * model-free things to watch.
 */

/** The heartbeat contract a provider or signal-source plugin is built for; another is refused before its code runs. */
export const HEARTBEAT_ABI = "tavi.heartbeat/1";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** The bounds the host holds every provider and source to. */
export const HEARTBEAT_LIMITS = {
  maxItems: 10,
  titleChars: 120,
  bodyChars: 1_000,
  instructionsBytes: 8 * 1024,
  memoBytes: 4 * 1024,
  memoryRecords: 10,
  memoryBytes: 4 * 1024,
  signalsPerSource: 50,
  sourceBytes: 32 * 1024,
  signalDataBytes: 2 * 1024,
  actionInputBytes: 4 * 1024,
  signalKeysPerItem: 16,
  sourceDeadlineMs: 5_000,
  itemKeyChars: 128,
  sourcesPerItem: 8,
  mutes: 100,
  disabledSources: 64,
  extraTools: 32,
  fetchHosts: 32,
  targets: 8,
  /** The built-in provider's tick deadline; an external provider declares its own `maxTickSeconds`. */
  builtinMaxTickSeconds: 60,
  /** The longest tick deadline a provider may declare (`maxTickSeconds`). */
  maxTickSeconds: 600,
  /** Heartbeat history older than this is swept by `tavi.retention`. */
  retentionDays: 30,
  /** Model turns one tick may run (`host.runTurn`), the steps each may take, and the output each step may write. */
  turnsPerTick: 3,
  turnSteps: 8,
  turnOutputTokens: 2_048,
  /** The least daily token limit a check can run under: one model turn's worst case is reserved before it runs (about 74k tokens and its prompt). */
  minTokensPerDay: 80_000,
  /** Pages one heartbeat check may fetch (`heartbeat.fetch`, across its turns), and the text each answers. */
  fetchesPerCheck: 5,
  fetchTextChars: 8_000,
  /** Pages one heartbeat may watch (`watch:` lines); lines past these are not read. */
  watchedPages: 20,
} as const;

/**
 * The interval choices a host offers: validated against, never a fixed
 * enum, so a test owner started with a lowered floor offers sub-minute
 * choices through the same select and the same validation.
 */
export const HeartbeatOptionsSchema = z.strictObject({
  every: z.array(z.number().int().positive()).min(1),
  deepCheckEvery: z.array(z.number().int().positive()).min(1),
  floorMs: z.number().int().positive(),
});
export type HeartbeatOptions = z.infer<typeof HeartbeatOptionsSchema>;

/** What a production owner offers: every 15 min–4 h, a deep look every 1–8 h. */
export const HEARTBEAT_PRODUCTION_OPTIONS: HeartbeatOptions = {
  every: [15 * MINUTE, 30 * MINUTE, HOUR, 2 * HOUR, 4 * HOUR],
  deepCheckEvery: [HOUR, 2 * HOUR, 4 * HOUR, 8 * HOUR],
  floorMs: 15 * MINUTE,
};

/**
 * The choices an owner offers for a floor: production's at 15 minutes and
 * above; a test owner started with a lower floor adds two intervals and one
 * deep look at multiples of it (2× and 4×, deep 4×), so the real select and the
 * same validation drive the UI tests. Never a flag or a setting.
 */
export function heartbeatOptionsFor(floorMs: number): HeartbeatOptions {
  if (floorMs >= HEARTBEAT_PRODUCTION_OPTIONS.floorMs) return HEARTBEAT_PRODUCTION_OPTIONS;
  return {
    every: [2 * floorMs, 4 * floorMs, ...HEARTBEAT_PRODUCTION_OPTIONS.every],
    deepCheckEvery: [4 * floorMs, ...HEARTBEAT_PRODUCTION_OPTIONS.deepCheckEvery],
    floorMs,
  };
}

export const HEARTBEAT_TELL_ME = ["urgent-now", "everything-now", "digest-only"] as const;
export type HeartbeatTellMe = (typeof HEARTBEAT_TELL_ME)[number];

/** Why a heartbeat is paused; only `budget` resumes by itself. */
export const HEARTBEAT_PAUSE_REASONS = ["user", "budget", "failures", "provider"] as const;
export type HeartbeatPauseReason = (typeof HEARTBEAT_PAUSE_REASONS)[number];

export const HEARTBEAT_WAKE_REASONS = ["interval", "signal", "event", "manual", "catch-up"] as const;
export type HeartbeatWakeReason = (typeof HEARTBEAT_WAKE_REASONS)[number];

/** A record row's kind: a tick of either kind, the digest, or a closed active window. */
export const HEARTBEAT_RECORD_KINDS = ["signal", "deep", "digest", "window"] as const;
export type HeartbeatRecordKind = (typeof HEARTBEAT_RECORD_KINDS)[number];

/** How a record row ended. A skip or a deferral is never a failure. */
export const HEARTBEAT_OUTCOMES = ["skipped", "deferred", "quiet", "quiet:withheld", "reported", "failed", "delivered"] as const;
export type HeartbeatOutcome = (typeof HEARTBEAT_OUTCOMES)[number];

/** Why a row was skipped or deferred: the gate that decided it. */
export const HEARTBEAT_SKIP_REASONS = [
  "off",
  "paused",
  "hours",
  "budget",
  "disk-full",
  "no-model",
  "provider-off",
  "provider-unavailable",
  "provider-reloading",
  "empty",
  "busy",
  "in-flight",
  "nothing-new",
  "provider",
] as const;
export type HeartbeatSkipReason = (typeof HEARTBEAT_SKIP_REASONS)[number];

/** What an external provider may be given, each behind a per-workspace egress switch. */
export const HEARTBEAT_RECEIVES = ["instructions", "signals", "ledger", "memory"] as const;
export type HeartbeatReceive = (typeof HEARTBEAT_RECEIVES)[number];

const HHMM = z.string().regex(SCHEDULE_TIME_PATTERN, "expected a 24-hour HH:MM time");
const ITEM_KEY = /^[A-Za-z0-9][A-Za-z0-9_.:@/-]*$/;
/** A mute: an item key, or a key prefix ending in `*` (`stripe:invoice:*`). */
const MUTE = /^[A-Za-z0-9][A-Za-z0-9_.:@/-]*\*?$/;
/** A signal source's id: a built-in's (`needs`) or a plugin's (`acme.queue.queue`). */
const SOURCE_ID = /^[a-z][a-z0-9_-]*(\.[a-z0-9_-]+)*$/;
const HOST = /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;
const TOOL_ID = /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)+$/;

/** One channel target: a connection and the chat on it, chosen from the operator's authorized targets. */
export const HeartbeatTargetSchema = z.strictObject({
  connectionId: z.string().min(1).max(64),
  to: z.string().min(1).max(256),
});
export type HeartbeatTarget = z.infer<typeof HeartbeatTargetSchema>;

export const HeartbeatEgressSchema = z.strictObject({
  instructions: z.boolean(),
  signals: z.boolean(),
  ledger: z.boolean(),
  memory: z.boolean(),
});
export type HeartbeatEgress = z.infer<typeof HeartbeatEgressSchema>;

export const HeartbeatBudgetSchema = z.strictObject({
  modelTicksPerDay: z.number().int().min(1).max(1_000),
  tokensPerDay: z.number().int().min(1_000).max(100_000_000),
  usdPerDay: z.number().positive().max(10_000).optional(),
});
export type HeartbeatBudget = z.infer<typeof HeartbeatBudgetSchema>;

export const HeartbeatPauseSchema = z.strictObject({
  reason: z.enum(HEARTBEAT_PAUSE_REASONS),
  until: z.string().datetime({ offset: true }).optional(),
});
export type HeartbeatPause = z.infer<typeof HeartbeatPauseSchema>;

/** Where the built-in provider id is the default; `off` selects no provider. */
export const BUILTIN_HEARTBEAT_PROVIDER_ID = "tavi.heartbeatagent";

/**
 * A heartbeat's configuration: one per (workspace, principal), enabled
 * only for the workspace's operator in v1. `enabled`, `paused` and `revision`
 * are stored in their own columns, the rest as JSON; the repository assembles
 * this object. Interval membership in the host's options is checked by
 * `heartbeatIntervalProblem`, since the options depend on the owner.
 */
/** The config's fields, before the cross-field rule: what a settings change is a part of. */
const HeartbeatConfigFieldsSchema = z.strictObject({
  enabled: z.boolean(),
  everyMs: z.number().int().positive(),
  activeHours: z
    .strictObject({ start: HHMM, end: HHMM })
    .refine((hours) => hours.start !== hours.end, "active hours start and end must differ"),
  daysOfWeek: z
    .array(z.number().int().min(0).max(6))
    .min(1)
    .max(7)
    .refine((days) => new Set(days).size === days.length, "each day once")
    .optional(),
  tellMe: z.enum(HEARTBEAT_TELL_ME),
  targets: z.array(HeartbeatTargetSchema).max(HEARTBEAT_LIMITS.targets),
  instructions: z
    .string()
    .refine(
      (text) => utf8Bytes(text) <= HEARTBEAT_LIMITS.instructionsBytes,
      `instructions are at most ${HEARTBEAT_LIMITS.instructionsBytes} bytes`,
    ),
  providerId: z.string().min(1).max(64),
  providerEgress: HeartbeatEgressSchema,
  extraTools: z.array(z.string().regex(TOOL_ID, "expected a plugin tool id")).max(HEARTBEAT_LIMITS.extraTools),
  fetchHosts: z.array(z.string().max(253).regex(HOST, "expected a lower-case host or *.domain")).max(HEARTBEAT_LIMITS.fetchHosts),
  mutes: z
    .array(z.string().min(1).max(HEARTBEAT_LIMITS.itemKeyChars).regex(MUTE, "expected an item key or a prefix ending in *"))
    .max(HEARTBEAT_LIMITS.mutes),
  /** Signal sources this heartbeat does not collect, by id; a heartbeat saved before this setting has none. */
  disabledSources: z
    .array(z.string().min(1).max(128).regex(SOURCE_ID, "expected a signal source id"))
    .max(HEARTBEAT_LIMITS.disabledSources)
    .default([]),
  agentId: z.string().min(1).max(128).optional(),
  model: SettingModelTargetSchema.optional(),
  deepCheckEveryMs: z.number().int().positive(),
  budget: HeartbeatBudgetSchema,
  maxNowPerHour: z.number().int().min(1).max(60),
  paused: HeartbeatPauseSchema.optional(),
  revision: z.number().int().positive(),
  /**
   * Where its instructions may have come from: set when a chat proposed
   * them under taint (`heartbeat.propose`), joined with each such proposal,
   * cleared when the person rewrites the instructions. A check starts with it,
   * and `heartbeat.status` answers with it.
   */
  provenance: MemoryProvenanceSchema.optional(),
});

export const HeartbeatConfigSchema = HeartbeatConfigFieldsSchema.superRefine((config, context) => {
  if (config.deepCheckEveryMs < config.everyMs)
    context.addIssue({ code: "custom", path: ["deepCheckEveryMs"], message: "the deep-look interval is at least the check interval" });
});
export type HeartbeatConfig = z.infer<typeof HeartbeatConfigSchema>;

/**
 * A settings change (`heartbeat set`): any of the settings, merged onto
 * the current config and then held to the whole config's rules. The pause,
 * the revision, the instructions and the provider have their own actions.
 */
export const HeartbeatSettingsChangeSchema = HeartbeatConfigFieldsSchema.omit({
  paused: true,
  revision: true,
  instructions: true,
  providerId: true,
  provenance: true,
})
  .partial()
  // `null` clears a setting that may be unset: back to the workspace's fast model, or to no persona.
  .extend({
    model: HeartbeatConfigFieldsSchema.shape.model.unwrap().nullable().optional(),
    agentId: HeartbeatConfigFieldsSchema.shape.agentId.unwrap().nullable().optional(),
  })
  .refine((change) => Object.keys(change).length > 0, "name at least one setting to change");
export type HeartbeatSettingsChange = z.infer<typeof HeartbeatSettingsChangeSchema>;

/** The defaults a new heartbeat starts with: off, every 30 min from 08:00 to 22:00. */
export function defaultHeartbeatConfig(): HeartbeatConfig {
  return {
    enabled: false,
    everyMs: 30 * MINUTE,
    activeHours: { start: "08:00", end: "22:00" },
    tellMe: "urgent-now",
    targets: [],
    instructions: "",
    providerId: BUILTIN_HEARTBEAT_PROVIDER_ID,
    providerEgress: { instructions: false, signals: false, ledger: false, memory: false },
    extraTools: [],
    fetchHosts: [],
    mutes: [],
    disabledSources: [],
    deepCheckEveryMs: 4 * HOUR,
    budget: { modelTicksPerDay: 24, tokensPerDay: 300_000 },
    maxNowPerHour: 3,
    revision: 1,
  };
}

/** Why a config's intervals are not among a host's options, or undefined when they are. */
export function heartbeatIntervalProblem(
  config: Pick<HeartbeatConfig, "everyMs" | "deepCheckEveryMs">,
  options: HeartbeatOptions,
): string | undefined {
  if (!options.every.includes(config.everyMs))
    return `the check interval must be one of ${options.every.map(formatHeartbeatInterval).join(", ")}`;
  if (!options.deepCheckEvery.includes(config.deepCheckEveryMs))
    return `the deep-look interval must be one of ${options.deepCheckEvery.map(formatHeartbeatInterval).join(", ")}`;
  if (config.deepCheckEveryMs < config.everyMs) return "the deep-look interval is at least the check interval";
  return undefined;
}

/** `1800000` → `30m`; `7200000` → `2h`; `2000` → `2s`. */
export function formatHeartbeatInterval(ms: number): string {
  if (ms % HOUR === 0) return `${ms / HOUR}h`;
  if (ms % MINUTE === 0) return `${ms / MINUTE}m`;
  return `${Math.round(ms / 1000)}s`;
}

/** Whether an item key is muted by a key or a `prefix*` mute. */
export function heartbeatKeyMuted(key: string, mutes: readonly string[]): boolean {
  return mutes.some((mute) => (mute.endsWith("*") ? key.startsWith(mute.slice(0, -1)) : key === mute));
}

/** A model-free observation a signal source returns; untrusted text. */
export const HeartbeatSignalSchema = z.strictObject({
  key: z.string().min(1).max(HEARTBEAT_LIMITS.itemKeyChars).regex(ITEM_KEY),
  hash: z.string().min(1).max(128),
  title: z.string().min(1).max(HEARTBEAT_LIMITS.titleChars),
  at: z.string().datetime({ offset: true }),
  source: z.string().min(1).max(80),
  data: z
    .unknown()
    .optional()
    .refine(
      (data) => data === undefined || jsonFits(data, HEARTBEAT_LIMITS.signalDataBytes),
      `signal data is at most ${HEARTBEAT_LIMITS.signalDataBytes} bytes of JSON`,
    ),
});
export type HeartbeatSignal = z.infer<typeof HeartbeatSignalSchema>;

export const HeartbeatSourceRefSchema = z.strictObject({
  label: z.string().min(1).max(80),
  ref: z.string().min(1).max(512).optional(),
});

/** An action the provider suggests; never run by the host — *Do it* starts an attended turn. */
export const HeartbeatProposedActionSchema = z.strictObject({
  toolId: z.string().min(1).max(64).regex(TOOL_ID),
  input: z
    .unknown()
    .refine(
      (input) => jsonFits(input, HEARTBEAT_LIMITS.actionInputBytes),
      `a proposed action's input is at most ${HEARTBEAT_LIMITS.actionInputBytes} bytes of JSON`,
    ),
  summary: z.string().min(1).max(200),
});

/** One thing worth telling the person, as the host validates it. */
export const HeartbeatItemSchema = z.strictObject({
  key: z
    .string()
    .min(1)
    .max(HEARTBEAT_LIMITS.itemKeyChars)
    .regex(ITEM_KEY, "item keys are letters, digits and _.:@/- such as stripe:invoice:in_123"),
  signalKeys: z
    .array(z.string().min(1).max(HEARTBEAT_LIMITS.itemKeyChars).regex(ITEM_KEY))
    .max(HEARTBEAT_LIMITS.signalKeysPerItem)
    .optional(),
  urgency: z.enum(["now", "later"]),
  title: z.string().trim().min(1).max(HEARTBEAT_LIMITS.titleChars),
  body: z.string().max(HEARTBEAT_LIMITS.bodyChars).optional(),
  sources: z.array(HeartbeatSourceRefSchema).min(1).max(HEARTBEAT_LIMITS.sourcesPerItem),
  instructionLine: z.number().int().min(1).max(10_000).optional(),
  proposedAction: HeartbeatProposedActionSchema.optional(),
});
export type HeartbeatItem = z.infer<typeof HeartbeatItemSchema>;

/**
 * The host's structured answer for a heartbeat turn: the only way a
 * turn reports items. Answered by the host, never put to a plugin's hooks,
 * and offered only to a task whose policy allowlists it.
 */
export const HEARTBEAT_REPORT_TOOL_ID = "heartbeat.report";

/**
 * A heartbeat turn's own fetch: a page one of the instructions' `watch:`
 * lines names, or a link found on a page the turn already fetched, on a host
 * the heartbeat may read — never a URL the model composes, which is how a
 * page's instructions would carry what the turn read elsewhere. Offered only
 * to a heartbeat turn, and to an external provider's only with `signals`.
 */
export const HEARTBEAT_FETCH_TOOL_ID = "heartbeat.fetch";

/**
 * An item as the model reports it: the item's own shape, except that a
 * proposed action's input size is left to the host's validation of every
 * reported item — a model-facing schema cannot carry a refinement.
 */
const ReportedHeartbeatItemSchema = HeartbeatItemSchema.extend({
  proposedAction: HeartbeatProposedActionSchema.extend({ input: z.unknown() }).optional(),
});

export const HeartbeatReportInputSchema = z.strictObject({
  items: z.array(ReportedHeartbeatItemSchema).max(HEARTBEAT_LIMITS.maxItems),
});
export type HeartbeatReportInput = z.infer<typeof HeartbeatReportInputSchema>;

export const HEARTBEAT_LEDGER_STATES = ["told", "resolved", "muted", "snoozed", "filtered"] as const;
export type HeartbeatLedgerState = (typeof HEARTBEAT_LEDGER_STATES)[number];

/** One row of the item ledger: what was told, under its key, and what became of it. */
export interface HeartbeatLedgerRow {
  /** What notices reference as `heartbeatItemId`. */
  readonly itemId: string;
  readonly workspaceId: string;
  readonly principalId: string;
  readonly key: string;
  readonly hash: string;
  readonly signalKeys: readonly string[];
  /** The tier it was told in: a `now` item past the hourly limit is told `later`, `heldBack`. */
  readonly urgency: "now" | "later";
  readonly heldBack: boolean;
  readonly title: string;
  readonly body?: string;
  readonly sources: HeartbeatItem["sources"];
  readonly instructionLine?: number;
  readonly proposedAction?: NonNullable<HeartbeatItem["proposedAction"]>;
  readonly state: HeartbeatLedgerState;
  readonly snoozedUntil?: string;
  readonly feedback?: "up" | "down";
  readonly buttonToken?: string;
  readonly firstToldAt: string;
  readonly lastToldAt: string;
  /** When a digest listed it; a `later` item is listed once. */
  readonly digestedAt?: string;
  readonly updatedAt: string;
}

/** What retention or *Forget* removed. */
export const HeartbeatHistoryRemovedSchema = z
  .object({
    ticks: z.number().int().nonnegative(),
    items: z.number().int().nonnegative(),
    signals: z.number().int().nonnegative(),
    tasks: z.number().int().nonnegative(),
  })
  .readonly();
export type HeartbeatHistoryRemoved = z.infer<typeof HeartbeatHistoryRemovedSchema>;

/** An item the host decided to tell: written to the ledger before anything is sent. */
export interface TellHeartbeatItem {
  /** Used for a new key; a key told before keeps its own id. */
  readonly itemId: string;
  readonly item: HeartbeatItem;
  readonly hash: string;
  readonly heldBack: boolean;
  /** Regenerated each time the item is told (16 chars). */
  readonly buttonToken: string;
  /** Held back by a mod's `heartbeat.item` hook: recorded, and told nowhere. */
  readonly filtered?: boolean;
}

/** An inbound channel message as the heartbeat remembers it: where, from whom, and which chat answers it when known. */
export interface HeartbeatInboundNote {
  readonly connectionId: string;
  readonly conversationKey: string;
  readonly workspaceId: string;
  readonly senderPrincipalId: string;
  readonly providerEventId: string;
  readonly taskId?: string;
  readonly at: string;
}

export interface HeartbeatUnansweredMessage {
  readonly connectionId: string;
  readonly conversationKey: string;
  readonly providerEventId: string;
  readonly receivedAt: string;
  readonly taskId?: string;
}

export interface HeartbeatFailedSend {
  readonly connectionId: string;
  readonly providerMessageId: string;
  readonly status: "bounced" | "failed";
  readonly statusAt: string;
}

export interface HeartbeatFailedRoutineRun {
  readonly runId: string;
  readonly routineId: string;
  readonly name: string;
  readonly endedAt: string;
}

/** What a provider sees of what was said lately (egress `ledger`). */
export interface LedgerEntry {
  readonly key: string;
  readonly state: HeartbeatLedgerState;
  readonly urgency: "now" | "later";
  readonly title: string;
  readonly feedback?: "up" | "down";
  readonly lastToldAt: string;
}

/** One memory record a tick was given: redacted and fenced before any provider or prompt sees it. */
export interface MemoryExcerpt {
  readonly recordId: string;
  /** The revision it was read at: an edit is a new revision, which the record shows. */
  readonly revisionId: string;
  readonly kind: "preference" | "fact" | "lesson" | "summary";
  readonly text: string;
}

export interface HeartbeatUsage {
  readonly modelTicks: number;
  readonly tokens: number;
  /** What it cost, or null when any call had no price. */
  readonly usd: number | null;
  /** What the priced calls cost: the dollar limit holds against this even when some calls had no price. */
  readonly pricedUsd: number;
}

export interface BudgetLeft {
  readonly modelTicks: number;
  readonly tokens: number;
  readonly usd?: number;
}

export interface HeartbeatWake {
  readonly reason: HeartbeatWakeReason;
  readonly scheduledAt: string;
  readonly now: string;
  readonly timezone: string;
}

/** A frozen copy, like `RouterProviderRequest`; fields an external provider's egress withholds are absent. */
export interface HeartbeatTickRequest {
  readonly wake: HeartbeatWake;
  readonly kind: "signal" | "deep";
  readonly instructions?: string;
  readonly signals: readonly HeartbeatSignal[];
  readonly recent: readonly LedgerEntry[];
  readonly memory: readonly MemoryExcerpt[];
  readonly memo?: string;
  readonly limits: { readonly maxItems: number; readonly deadlineMs: number; readonly budgetLeft: BudgetLeft };
  readonly host: {
    /**
     * One metered, allowlisted, unattended turn. The items it reports go
     * straight to host validation and delivery as part of this tick; the
     * provider gets back only their keys and urgencies, never their text,
     * the transcript or tool output.
     */
    runTurn(input: {
      readonly prompt: string;
      readonly tools?: readonly string[];
      readonly model?: "fast" | "main";
    }): Promise<{ readonly reported: readonly { readonly key: string; readonly urgency: "now" | "later" }[]; readonly usage: ModelUsage }>;
    /**
     * A value for the provider's own panel in Center → Heartbeat (its
     * `center.heartbeat` contribution), for this person only: JSON of at
     * most 16 KiB under a 1–64 character key, masked as a tool's output is.
     * The newest per key is kept, at most 16 keys.
     */
    publish(key: string, value: unknown): void;
  };
  readonly signal: AbortSignal;
}

export interface HeartbeatTickResult {
  readonly items: readonly HeartbeatItem[];
  readonly memo?: string;
  /** Clamped by the host to [min(15 min, interval), interval]. */
  readonly nextWakeHint?: string;
}

/** Keys only, no content: a model-free precheck that may skip the tick. */
export interface HeartbeatPrecheckRequest {
  readonly wake: HeartbeatWake;
  readonly kind: "signal" | "deep";
  readonly signalKeys: readonly string[];
  readonly signal: AbortSignal;
}

export interface HeartbeatPrecheck {
  readonly wake: boolean;
  readonly reason?: string;
}

export interface HeartbeatProviderStatus {
  readonly ready: boolean;
  readonly detail?: string;
}

export interface HeartbeatProvider {
  precheck?(request: HeartbeatPrecheckRequest): Promise<HeartbeatPrecheck>;
  /** One tick. Never delivers anything itself; returns a report the host validates. */
  tick(request: HeartbeatTickRequest): Promise<HeartbeatTickResult>;
  status?(): HeartbeatProviderStatus;
}

/** A collection that saw only part of what it watches (a list cut at its page size): what it did not see is not taken for gone. */
export interface HeartbeatSignalBatch {
  readonly signals: readonly HeartbeatSignal[];
  readonly incomplete: true;
}

export interface HeartbeatSignalSource {
  readonly id: string;
  /**
   * `false` for a source whose signals leave by age (a failure in the last
   * day): one gone from it is forgotten, but its items are not marked
   * resolved, since nothing was fixed.
   */
  readonly retracts?: false;
  /**
   * The line the first-run offer suggests for it: what to watch, in the person's words ("Scheduled runs that
   * fail"). A plugin's source takes its approved manifest's (`heartbeatSignals.offers`), never its code's.
   */
  readonly offer?: string;
  /** One collection for one person's heartbeat: what is worth watching for them, model-free; a batch when it saw only part. */
  collect(input: {
    readonly workspaceId: string;
    readonly principalId: string;
    readonly now: string;
    readonly timezone: string;
    readonly signal: AbortSignal;
  }): Promise<readonly HeartbeatSignal[] | HeartbeatSignalBatch>;
}

/** A typed collection's signals, list or batch. */
export function heartbeatSignalsOf(answer: readonly HeartbeatSignal[] | HeartbeatSignalBatch): readonly HeartbeatSignal[] {
  return "signals" in answer ? answer.signals : answer;
}

/** A collection's signals, whichever shape it answered, and whether it said it saw only part; undefined for neither shape. */
export function heartbeatCollected(answer: unknown): { readonly signals: readonly unknown[]; readonly incomplete: boolean } | undefined {
  if (Array.isArray(answer)) return { signals: answer, incomplete: false };
  if (answer !== null && typeof answer === "object" && Array.isArray((answer as { signals?: unknown }).signals)) {
    return { signals: (answer as { signals: unknown[] }).signals, incomplete: (answer as { incomplete?: unknown }).incomplete === true };
  }
  return undefined;
}

export const HEARTBEAT_PROVIDER_FAILURES = ["transport", "invalid", "budget"] as const;
export type HeartbeatProviderFailure = (typeof HEARTBEAT_PROVIDER_FAILURES)[number];

/** Thrown by a provider to report a failure; any other throw counts as `transport`. */
export class HeartbeatProviderError extends defineProviderError<HeartbeatProviderFailure>() {}

/** The failure a thrown value carries, whatever class it has; `transport` when it carries none. */
export function heartbeatProviderFailure(error: unknown): HeartbeatProviderFailure {
  // A plugin's thrown value may be a Proxy or carry a throwing getter: reading it must not throw.
  try {
    if (error === null || typeof error !== "object" || !("reason" in error)) return "transport";
    const reason = (error as { reason: unknown }).reason;
    return HEARTBEAT_PROVIDER_FAILURES.find((failure) => failure === reason) ?? "transport";
  } catch {
    return "transport";
  }
}

/** What a mod decided about one item of a check, on the check's record: the reason a hold-back gave is masked. */
export const HeartbeatHookDecisionSchema = z.object({
  key: z.string(),
  by: z.string(),
  action: z.enum(["held back", "made it wait for the summary"]),
  reason: z.string().max(200).optional(),
});
export type HeartbeatHookDecision = z.infer<typeof HeartbeatHookDecisionSchema>;

/** Why a check ran, in words, for the log; nothing for an ordinary interval check or a closed-hours row. */
function wakeWords(tick: Pick<HeartbeatTickRecord, "kind" | "wakeReason">, t: CanvasCoreT): string | undefined {
  if (tick.kind === "window") return undefined;
  switch (tick.wakeReason) {
    case "event":
      return t("heartbeat.tick.wake.event");
    case "manual":
      return t("heartbeat.tick.wake.manual");
    case "catch-up":
      return t("heartbeat.tick.wake.catchUp");
    case "signal":
      return t("heartbeat.tick.wake.signal");
    default:
      return undefined;
  }
}

/** What a log row adds about a check, read without trusting the row: why it ran, and how many memories it used. */
export function heartbeatTickContext(
  tick: Pick<HeartbeatTickRecord, "kind" | "wakeReason" | "inputs">,
  t: CanvasCoreT = canvasCoreEnglish,
): readonly string[] {
  const memory = tick.inputs !== null && typeof tick.inputs === "object" ? (tick.inputs as { memory?: unknown }).memory : undefined;
  const memories = Array.isArray(memory) ? memory.length : 0;
  const why = wakeWords(tick, t);
  return [
    ...(why === undefined ? [] : [why]),
    ...(memories === 0 ? [] : [t("heartbeat.tick.memories", { count: memories, n: String(memories) })]),
  ];
}

/** What a mod decided about one item, as a log row says it: "acme.quiet held back (a reason)". */
export function heartbeatHookDecisionText(decision: HeartbeatHookDecision, t: CanvasCoreT = canvasCoreEnglish): string {
  const heldBack = decision.action === "held back";
  if (decision.reason === undefined) return t(heldBack ? "heartbeat.hook.heldBack" : "heartbeat.hook.waited", { by: decision.by });
  return t(heldBack ? "heartbeat.hook.heldBackBecause" : "heartbeat.hook.waitedBecause", { by: decision.by, reason: decision.reason });
}

/** A record's mod decisions, read without trusting the row: anything else is none. */
export function heartbeatHookDecisions(value: unknown): readonly HeartbeatHookDecision[] {
  const parsed = z.array(HeartbeatHookDecisionSchema).max(HEARTBEAT_LIMITS.maxItems).safeParse(value);
  return parsed.success ? parsed.data : [];
}

/** One row of the record, as the log and IPC show it. */
export const HeartbeatTickRecordSchema = z.strictObject({
  tickId: z.string().min(1),
  workspaceId: z.string().min(1),
  principalId: z.string().min(1),
  kind: z.enum(HEARTBEAT_RECORD_KINDS).nullable(),
  wakeReason: z.enum(HEARTBEAT_WAKE_REASONS).nullable(),
  outcome: z.enum(HEARTBEAT_OUTCOMES),
  reason: z.string().max(200).nullable(),
  pauseReason: z.enum(HEARTBEAT_PAUSE_REASONS).nullable(),
  providerId: z.string().nullable(),
  taskId: z.string().nullable(),
  itemsNow: z.number().int().nonnegative(),
  itemsLater: z.number().int().nonnegative(),
  itemsRetracted: z.number().int().nonnegative(),
  inputs: z.unknown().nullable(),
  hookDecisions: z.unknown().nullable(),
  tokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative().nullable(),
  durationMs: z.number().int().nonnegative(),
  error: z.string().max(500).nullable(),
  providerDev: z.boolean(),
  createdAt: TimestampSchema,
});
export type HeartbeatTickRecord = z.infer<typeof HeartbeatTickRecordSchema>;

/** A page the instructions ask it to watch (`watch: https://…`): its URL, host and 1-based instruction line. */
export interface HeartbeatWatchedPage {
  readonly url: string;
  readonly host: string;
  readonly line: number;
}

// Contracts compile without the DOM or Node libraries; `URL` is a global wherever they run, so only its type is declared.
declare const URL: new (
  input: string,
) => {
  readonly protocol: string;
  readonly hostname: string;
  readonly username: string;
  readonly password: string;
  readonly port: string;
  readonly href: string;
  hash: string;
};

const WATCH_LINE = /^\s*(?:[-*•]\s*)?watch:\s*(https:\/\/\S+)/i;

/**
 * A page address as the guarded fetch would read it, or `undefined` when it
 * would not: https, a named host on the default port, no credentials, and no
 * fragment (the page is the same with any, so it is matched and fetched
 * without one). A heartbeat's `watch:` line and a schedule's pre-check name
 * pages by it.
 */
export function watchablePage(raw: string): { readonly url: string; readonly host: string } | undefined {
  let url: InstanceType<typeof URL>;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  const host = url.hostname.toLowerCase();
  const ipLiteral = /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith("[");
  url.hash = "";
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.port !== "" || ipLiteral || !HOST.test(host))
    return undefined;
  return { url: url.href, host };
}

/**
 * The pages an instruction list watches, in order: https URLs with a host a
 * fetch list can name, each once and without its fragment, at most
 * `watchedPages` of them.
 */
export function heartbeatWatchedPages(instructions: string): readonly HeartbeatWatchedPage[] {
  const pages: HeartbeatWatchedPage[] = [];
  const seen = new Set<string>();
  instructions.split("\n").forEach((text, index) => {
    const match = WATCH_LINE.exec(text);
    if (match?.[1] === undefined || pages.length >= HEARTBEAT_LIMITS.watchedPages) return;
    // Punctuation that ends the sentence is not part of the address.
    const page = watchablePage(match[1].replace(/[.,;:!?)]+$/, ""));
    if (page === undefined || seen.has(page.url)) return;
    seen.add(page.url);
    pages.push({ url: page.url, host: page.host, line: index + 1 });
  });
  return pages;
}

/** Whether `host` is one a fetch list names: itself, or under a `*.domain` entry. */
export function heartbeatHostAllowed(host: string, fetchHosts: readonly string[]): boolean {
  return fetchHosts.some((entry) => (entry.startsWith("*.") ? host.endsWith(entry.slice(1)) : host === entry));
}

/**
 * The config with the hosts of pages newly watched since `before` added to its
 * fetch list: approving instructions that watch a page is approving
 * that the heartbeat may read it, since an unattended check cannot ask. Hosts
 * already allowed are not added again; the list stays within its limit.
 */
export function withWatchedHosts(before: string, after: HeartbeatConfig): HeartbeatConfig {
  const known = new Set(heartbeatWatchedPages(before).map((page) => page.url));
  const fetchHosts = [...after.fetchHosts];
  for (const page of heartbeatWatchedPages(after.instructions)) {
    if (known.has(page.url) || heartbeatHostAllowed(page.host, fetchHosts) || fetchHosts.length >= HEARTBEAT_LIMITS.fetchHosts) continue;
    fetchHosts.push(page.host);
  }
  return fetchHosts.length === after.fetchHosts.length ? after : { ...after, fetchHosts };
}

/** A plugin's heartbeat provider (`provides: ["heartbeat"]`): what it asks to receive, reviewed before its code runs. */
export const PluginHeartbeatDeclarationSchema = z.strictObject({
  abi: z.literal(HEARTBEAT_ABI),
  receives: z
    .array(z.enum(HEARTBEAT_RECEIVES))
    .max(HEARTBEAT_RECEIVES.length)
    .refine((receives) => new Set(receives).size === receives.length, "each field is listed once")
    .default([]),
  usesTurns: z.boolean().default(false),
  maxTickSeconds: z.number().int().min(1).max(HEARTBEAT_LIMITS.maxTickSeconds).default(HEARTBEAT_LIMITS.builtinMaxTickSeconds),
});
export type PluginHeartbeatDeclaration = z.infer<typeof PluginHeartbeatDeclarationSchema>;

/** A plugin's heartbeat signal sources (`provides: ["heartbeat-signals"]`). */
export const PluginHeartbeatSignalsDeclarationSchema = z
  .strictObject({
    abi: z.literal(HEARTBEAT_ABI),
    sources: z
      .array(
        z
          .string()
          .regex(/^[a-z][a-z0-9_-]*$/, "source ids are lower-case, such as queue")
          .max(40),
      )
      .min(1)
      .max(8)
      .refine((sources) => new Set(sources).size === sources.length, "each source is listed once"),
    /**
     * Each source's line for the first-run heartbeat offer, as the person would write it (`HeartbeatSignalSource.offer`):
     * plain text on one line, shown at approval.
     */
    offers: z
      .record(
        z.string(),
        z
          .string()
          .min(1)
          .max(120)
          // One line of text: no control character (CR, LF, NEL, VT, FF, ESC, …) and no line or paragraph separator.
          .regex(/^[^\p{Cc}\p{Zl}\p{Zp}]+$/u, "an offer is one line of text"),
      )
      .optional(),
  })
  .refine((declaration) => Object.keys(declaration.offers ?? {}).every((source) => declaration.sources.includes(source)), {
    message: "an offer names one of the declared sources",
    path: ["offers"],
  });
export type PluginHeartbeatSignalsDeclaration = z.infer<typeof PluginHeartbeatSignalsDeclarationSchema>;

const RECEIVE_DISCLOSURES = {
  instructions: "heartbeat.plugin.receive.instructions",
  signals: "heartbeat.plugin.receive.signals",
  ledger: "heartbeat.plugin.receive.ledger",
  memory: "heartbeat.plugin.receive.memory",
} as const satisfies Record<HeartbeatReceive, string>;

/** What approving a heartbeat provider means, in the words the CLI and the canvas both show. */
export function describeHeartbeatDeclaration(heartbeat: PluginHeartbeatDeclaration, t: CanvasCoreT = canvasCoreEnglish): string {
  const receives = heartbeat.receives.map((field) => t(RECEIVE_DISCLOSURES[field]));
  const what = receives.length === 0 ? t("heartbeat.plugin.receive.none") : receives.join(", ");
  return t(heartbeat.usesTurns ? "heartbeat.plugin.describeTurns" : "heartbeat.plugin.describe", {
    what,
    seconds: String(heartbeat.maxTickSeconds),
  });
}

/** What a plugin version's heartbeat declarations mean, one line each: what its review and its details show. */
export function describePluginHeartbeat(
  version: {
    readonly heartbeat?: PluginHeartbeatDeclaration | undefined;
    readonly heartbeatSignals?: PluginHeartbeatSignalsDeclaration | undefined;
  },
  t: CanvasCoreT = canvasCoreEnglish,
): readonly string[] {
  return [
    ...(version.heartbeat === undefined ? [] : [describeHeartbeatDeclaration(version.heartbeat, t)]),
    ...(version.heartbeatSignals === undefined ? [] : [describeHeartbeatSignalsDeclaration(version.heartbeatSignals, t)]),
  ];
}

/** What approving heartbeat signal sources means. */
export function describeHeartbeatSignalsDeclaration(
  signals: PluginHeartbeatSignalsDeclaration,
  t: CanvasCoreT = canvasCoreEnglish,
): string {
  const offers = Object.entries(signals.offers ?? {});
  const sources = signals.sources.join(", ");
  if (offers.length === 0) return t("heartbeat.plugin.signals", { sources });
  return t("heartbeat.plugin.signalsOffers", {
    sources,
    offers: offers.map(([, line]) => t("heartbeat.plugin.offer", { line })).join(", "),
  });
}

/**
 * A plugin's signal source in words, for *Signal sources*: its declared offer line, else its id in sentence case
 * ("new_posts" is "New posts"), and the plugin's name, never the raw `<plugin>.<source>` id.
 */
export function pluginSignalSourceLabel(
  pluginName: string,
  sourceId: string,
  signals: PluginHeartbeatSignalsDeclaration,
  t: CanvasCoreT = canvasCoreEnglish,
): string {
  const offer = signals.offers?.[sourceId];
  if (offer !== undefined) return t("heartbeat.plugin.sourceOffer", { offer, plugin: pluginName });
  const words = sourceId.replace(/[-_]+/g, " ");
  return t("heartbeat.plugin.sourceNamed", { source: `${words.charAt(0).toUpperCase()}${words.slice(1)}`, plugin: pluginName });
}

// Local rather than `utf8ByteLength` from ipc-codec.ts, which imports ipc.ts: the IPC schemas import this module.
function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** Whether a value serializes to JSON within `maxBytes`; a value that cannot serialize does not fit. */
function jsonFits(value: unknown, maxBytes: number): boolean {
  try {
    return utf8Bytes(JSON.stringify(value) ?? "") <= maxBytes;
  } catch {
    return false;
  }
}

/**
 * A heartbeat as the host reads it: the config (assembled from its columns
 * and JSON) and the scheduling state only the host writes.
 */
export interface HeartbeatState {
  readonly workspaceId: string;
  readonly principalId: string;
  readonly config: HeartbeatConfig;
  readonly nextTickAt?: string;
  readonly lastTickAt?: string;
  readonly lastDeepTickAt?: string;
  /** The selected provider's latest memo, masked; read with `tavi heartbeat status --format json`. */
  readonly memo?: string;
  readonly offerDismissedAt?: string;
  /** When the selected provider last changed: `recent` starts no earlier. */
  readonly providerSince?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** One saved revision of a heartbeat's instructions (`tavi_heartbeat_instructions`). */
export const HeartbeatInstructionsRevisionSchema = z
  .object({
    revision: z.number().int().positive(),
    text: z.string(),
    author: z.string(),
    createdAt: TimestampSchema,
  })
  .readonly();
export type HeartbeatInstructionsRevision = z.infer<typeof HeartbeatInstructionsRevisionSchema>;

export interface SaveHeartbeatInput {
  readonly workspaceId: string;
  readonly principalId: string;
  /** The whole config; its `revision` is ignored — the saved row gets `expectedRevision + 1`. */
  readonly config: HeartbeatConfig;
  /** The revision the writer read; 0 creates the row. A stale one is `CONFLICT`. */
  readonly expectedRevision: number;
  /** When the next tick is due under the new config; omitted for a heartbeat that is off. */
  readonly nextTickAt?: string;
  /** Who saved it, for the instructions history (`operator`, `chat`, `cli`). */
  readonly author: string;
  readonly now: string;
}

export interface RecordHeartbeatTickInput extends Omit<HeartbeatTickRecord, "createdAt"> {
  readonly now: string;
  /** Any tick advances `last_tick_at`; a deep one that looked (`heartbeatTickLooked`) advances `last_deep_tick_at`. */
  readonly advancesLastTick: boolean;
  /** `false` for a deep tick that answered but did not look for this person (its provider was switched away). */
  readonly advancesDeepTick?: boolean;
}

/** Whether a log row is a check that ran (a quick or deep one, not a skip, a wait, closed hours or a summary): what "checks today" counts. */
export function heartbeatCheckRan(tick: Pick<HeartbeatTickRecord, "kind" | "outcome">): boolean {
  return (tick.kind === "signal" || tick.kind === "deep") && tick.outcome !== "skipped" && tick.outcome !== "deferred";
}

/** Whether a check looked: it answered, quiet or with items — not one that failed, timed out or was skipped. */
export function heartbeatTickLooked(outcome: HeartbeatTickRecord["outcome"]): boolean {
  return outcome === "quiet" || outcome === "quiet:withheld" || outcome === "reported";
}

interface HeartbeatRepositoryPortDefinition {
  get(workspaceId: string, principalId: string): HeartbeatState | undefined;
  /**
   * Save a heartbeat's config as the next revision, compare-and-set on
   * `expectedRevision`, recording the instructions in the history when they
   * changed. A row outside `HeartbeatConfigSchema` is `INVALID_INPUT`.
   */
  save(input: SaveHeartbeatInput): HeartbeatState;
  /**
   * Enabled heartbeats due at `now`, through the `(enabled, next_tick_at)`
   * index. A row whose config no longer parses is excluded and named, so one
   * hand-edited row cannot stop the sweep.
   */
  listDue(now: string, limit: number): { readonly due: readonly HeartbeatState[]; readonly unreadable: readonly string[] };
  /** Claim one tick: succeeds only if `next_tick_at` still equals `expectedNextTickAt`, then advances it to `nextTickAt`. */
  claimTick(input: {
    readonly workspaceId: string;
    readonly principalId: string;
    readonly expectedNextTickAt: string;
    readonly nextTickAt: string;
    readonly now: string;
  }): boolean;
  /** Move the next tick without a claim (the config changed, a catch-up or Check now was queued). */
  setNextTick(input: {
    readonly workspaceId: string;
    readonly principalId: string;
    readonly nextTickAt: string | null;
    readonly now: string;
  }): void;
  /**
   * Pause or resume, written by the host and the person alike. Column-backed
   * and not a config edit: it does not bump the revision, so a host pause never
   * turns a person's pending edit into a conflict.
   */
  setPaused(input: {
    readonly workspaceId: string;
    readonly principalId: string;
    readonly paused: HeartbeatPause | null;
    readonly now: string;
  }): void;
  /** End this pause, only while it is still the stored one; false when another was set meanwhile. */
  clearPause(input: {
    readonly workspaceId: string;
    readonly principalId: string;
    readonly paused: HeartbeatPause;
    readonly now: string;
  }): boolean;
  setMemo(input: { readonly workspaceId: string; readonly principalId: string; readonly memo: string | null; readonly now: string }): void;
  /** Dismiss the first-run offer for good, creating the row (with defaults, off) when there is none. */
  dismissOffer(input: { readonly workspaceId: string; readonly principalId: string; readonly now: string }): void;
  recordTick(input: RecordHeartbeatTickInput): HeartbeatTickRecord;
  /**
   * The newest record rows first, at most `limit`, optionally since an
   * instant; `ranOnly` keeps the ticks that asked a provider (signal or deep,
   * neither skipped nor deferred). `oldestFirst` turns the order: the first
   * rows since the instant (the check that told an item).
   */
  listTicks(input: {
    readonly workspaceId: string;
    readonly principalId: string;
    readonly since?: string;
    readonly ranOnly?: boolean;
    readonly oldestFirst?: boolean;
    readonly limit: number;
  }): readonly HeartbeatTickRecord[];
  /** The instructions history, newest first. */
  instructionsHistory(input: {
    readonly workspaceId: string;
    readonly principalId: string;
    readonly limit: number;
  }): readonly HeartbeatInstructionsRevision[];
  /**
   * What a heartbeat's ticks spent since an instant: model ticks (ticks
   * that ran a turn), and the tokens and dollars of their provider attempts.
   * `usd` is null when any attempt was unpriced: cost is then unknown.
   */
  usageSince(input: { readonly workspaceId: string; readonly principalId: string; readonly since: string }): HeartbeatUsage;
  /**
   * Compare one collection's signals with those seen before, in one
   * transaction: the first collection only seeds them (`seeded`, nothing new);
   * later, `fresh` names keys new or with a changed hash, and `gone` keys seen
   * before and absent now, which are forgotten so a return counts as new.
   * Keys under a `keep` prefix — a source that failed or was cut short this
   * time — are never gone: what it saw before stays seen. With `sources` (the
   * ids collected this time), each source is seeded on its own first
   * collection, and only their keys can be gone: a source not installed now
   * (a plugin restarting) keeps what it saw.
   */
  observeSignals(input: {
    readonly workspaceId: string;
    readonly principalId: string;
    readonly signals: readonly { readonly key: string; readonly hash: string; readonly source: string }[];
    readonly keep?: readonly string[];
    readonly sources?: readonly string[];
    readonly now: string;
  }): { readonly seeded: boolean; readonly fresh: readonly string[]; readonly gone: readonly string[] };
  /** Forget that keys were seen, so the next collection finds them new again: a check that failed never told what it was given. */
  unseeSignals(input: { readonly workspaceId: string; readonly principalId: string; readonly keys: readonly string[] }): void;
  /** The ledger rows of these keys. */
  ledgerRows(input: {
    readonly workspaceId: string;
    readonly principalId: string;
    readonly keys: readonly string[];
  }): readonly HeartbeatLedgerRow[];
  /** One ledger row by the token its channel buttons carry, whoever's it is: a press is checked against it after. */
  itemByToken(token: string): HeartbeatLedgerRow | undefined;
  /** The items told lately, newest first, at most `limit`, optionally since an instant. */
  /** The newest ledger rows first; with `told`, only items it told (not what a mod held back). */
  recentItems(input: {
    readonly workspaceId: string;
    readonly principalId: string;
    readonly since?: string;
    readonly limit: number;
    readonly told?: boolean;
  }): readonly HeartbeatLedgerRow[];
  /** A conversation's newest inbound message: one row per conversation, the newest kept. */
  noteInbound(input: HeartbeatInboundNote): void;
  /**
   * Conversations whose newest inbound message, from someone other than
   * `principalId`, arrived between `since` and `before` and has had no answer:
   * no turn saved in its chat since, no reply of the inbound path's own, and
   * no mod's deliberate drop of it. Newest first.
   */
  unansweredMessages(input: {
    readonly workspaceId: string;
    readonly principalId: string;
    readonly since: string;
    readonly before: string;
    readonly limit: number;
  }): readonly HeartbeatUnansweredMessage[];
  /** Sends in a workspace a channel reported bounced or failed since an instant, newest first. */
  failedSends(input: { readonly workspaceId: string; readonly since: string; readonly limit: number }): readonly HeartbeatFailedSend[];
  /** A person's routine runs that failed since an instant, newest first. */
  failedRoutineRuns(input: {
    readonly workspaceId: string;
    readonly principalId: string;
    readonly since: string;
    readonly limit: number;
  }): readonly HeartbeatFailedRoutineRun[];
  /** One ledger row by its id, for this heartbeat only. */
  ledgerRow(input: { readonly workspaceId: string; readonly principalId: string; readonly itemId: string }): HeartbeatLedgerRow | undefined;
  /**
   * Record items as told, in one transaction: a new key gets a row, a key told
   * before is updated in place (its id and first telling kept) and is `told`
   * again, unsnoozed and not yet in a digest. A key muted, or snoozed and not
   * yet out of it, is left as it is and not answered: nothing of it is told.
   */
  tellItems(input: {
    readonly workspaceId: string;
    readonly principalId: string;
    readonly items: readonly TellHeartbeatItem[];
    readonly now: string;
  }): readonly HeartbeatLedgerRow[];
  /** How many items were told `now` (not held back) since an instant: the hourly limit's count. */
  nowToldSince(input: { readonly workspaceId: string; readonly principalId: string; readonly since: string }): number;
  /**
   * Resolve every told or snoozed item that has signal keys, one of them among
   * `goneSignalKeys`, and none still seen (a retraction). Answers the rows
   * it resolved.
   */
  resolveItems(input: {
    readonly workspaceId: string;
    readonly principalId: string;
    readonly goneSignalKeys: readonly string[];
    readonly now: string;
  }): readonly HeartbeatLedgerRow[];
  /** The `later` items still told and in no digest, told since an instant, oldest first. */
  digestItems(input: {
    readonly workspaceId: string;
    readonly principalId: string;
    readonly since: string;
    readonly limit: number;
  }): readonly HeartbeatLedgerRow[];
  /** Mark the tellings a digest listed: an item told again since (a newer telling) is left for the next digest. */
  markDigested(input: {
    readonly workspaceId: string;
    readonly principalId: string;
    readonly items: readonly { readonly itemId: string; readonly lastToldAt: string }[];
    readonly now: string;
  }): void;
  /**
   * Retention, across every heartbeat: ticks older than `olderThan`;
   * ledger rows resolved, filtered, or `later` and still told, last told
   * before it (muted rows are kept); signals last seen before it; and settled
   * heartbeat tasks created before it, with their checkpoints, provider
   * attempts and hook rows; hook rows of ticks it removes that ran no turn;
   * and the notes of who messaged when, received before it.
   */
  sweep(input: { readonly olderThan: string }): HeartbeatHistoryRemoved;
  /**
   * *Forget heartbeat history*: one heartbeat's ledger, ticks (with the
   * hook rows filed under them), seen signals and memo, and its settled tasks
   * with their checkpoints, provider attempts and hook rows; the workspace's
   * notes of who messaged when, when no one else there has a heartbeat. Its
   * settings and instructions history are kept, and what the forgotten checks
   * spent since `keepUsageSince` (the start of the person's day) is kept as a
   * total, so the day's budget stands.
   */
  forget(input: {
    readonly workspaceId: string;
    readonly principalId: string;
    readonly now: string;
    readonly keepUsageSince?: string;
  }): HeartbeatHistoryRemoved;
  /** Set or clear the person's 👍/👎 on one item; undefined when it is not this heartbeat's. */
  setItemFeedback(input: {
    readonly workspaceId: string;
    readonly principalId: string;
    readonly itemId: string;
    readonly feedback: "up" | "down" | null;
    readonly now: string;
  }): HeartbeatLedgerRow | undefined;
  /** Mute, snooze (until an instant) or un-snooze one item; undefined when it is not this heartbeat's. */
  setItemState(input: {
    readonly workspaceId: string;
    readonly principalId: string;
    readonly itemId: string;
    readonly state: "told" | "muted" | "snoozed";
    readonly snoozedUntil?: string;
    readonly now: string;
  }): HeartbeatLedgerRow | undefined;
}

export type HeartbeatRepositoryPort = AsyncRepository<HeartbeatRepositoryPortDefinition>;
