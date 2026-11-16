import { z } from "zod";

import {
  HEARTBEAT_LEDGER_STATES,
  HEARTBEAT_RECEIVES,
  HeartbeatConfigSchema,
  HeartbeatHistoryRemovedSchema,
  HeartbeatInstructionsRevisionSchema,
  HeartbeatOptionsSchema,
  HeartbeatSettingsChangeSchema,
  HeartbeatTickRecordSchema,
  type HeartbeatLedgerRow,
  type HeartbeatState,
} from "./heartbeat.js";
import { IdSchema, TimestampSchema } from "./ids.js";

/**
 * `heartbeat`: one person's heartbeat —
 * in v1 only the workspace operator's (another principal is refused) — read,
 * changed by compare-and-set on its revision, paused, checked now, and its
 * log, items and history. `revision` is optional on every write: without it
 * the owner writes over the current revision.
 */

export const HEARTBEAT_LOG_DEFAULT = 50;
export const HEARTBEAT_LOG_MAX = 500;
export const HEARTBEAT_HISTORY_DEFAULT = 20;
/** The longest `pause --for`: a week. For longer, pause without one, until resumed. */
export const HEARTBEAT_PAUSE_MAX_MS = 7 * 24 * 60 * 60_000;
export const HEARTBEAT_SNOOZE_MAX_MINUTES = 7 * 24 * 60;
export const HEARTBEAT_RECENT_DEFAULT = 20;
export const HEARTBEAT_RECENT_MAX = 100;

const scope = {
  workspaceId: IdSchema.optional(),
  /** Whose heartbeat; absent, the operator's. Any other principal is refused in v1. */
  principalId: IdSchema.optional(),
} as const;
/** The revision a write is held to; 0 for a heartbeat never saved, so a first save made meanwhile is refused too. */
const revision = { revision: z.number().int().nonnegative().optional() } as const;

export const HeartbeatPayloadSchema = z.discriminatedUnion("action", [
  /** `offer: true` also works out the first-run offer (it runs the built-in sources); only the offer card asks. */
  z.strictObject({ action: z.literal("get"), ...scope, offer: z.boolean().optional() }),
  z.strictObject({ action: z.literal("options"), ...scope }),
  z.strictObject({ action: z.literal("set"), ...scope, ...revision, changes: HeartbeatSettingsChangeSchema }),
  z.strictObject({ action: z.literal("instructions"), ...scope }),
  z.strictObject({ action: z.literal("set-instructions"), ...scope, ...revision, text: z.string() }),
  z.strictObject({ action: z.literal("history"), ...scope, limit: z.number().int().min(1).max(100).optional() }),
  z.strictObject({ action: z.literal("run-now"), ...scope }),
  z.strictObject({ action: z.literal("pause"), ...scope, forMs: z.number().int().positive().max(HEARTBEAT_PAUSE_MAX_MS).optional() }),
  z.strictObject({ action: z.literal("resume"), ...scope }),
  z.strictObject({
    action: z.literal("log"),
    ...scope,
    since: TimestampSchema.optional(),
    limit: z.number().int().min(1).max(HEARTBEAT_LOG_MAX).optional(),
  }),
  z
    .strictObject({
      action: z.literal("items"),
      ...scope,
      itemId: IdSchema,
      op: z.enum(["feedback", "snooze", "unsnooze", "mute", "unmute"]),
      /** For `feedback`: 👍, 👎, or null to clear it. */
      feedback: z.enum(["up", "down"]).nullable().optional(),
      /** For `snooze`. */
      minutes: z.number().int().min(1).max(HEARTBEAT_SNOOZE_MAX_MINUTES).optional(),
    })
    .superRefine((payload, context) => {
      if (payload.op === "feedback" && payload.feedback === undefined)
        context.addIssue({ code: "custom", path: ["feedback"], message: "feedback needs up, down or null" });
      if (payload.op === "snooze" && payload.minutes === undefined)
        context.addIssue({ code: "custom", path: ["minutes"], message: "a snooze needs its minutes" });
    }),
  z.strictObject({ action: z.literal("mute"), ...scope, ...revision, prefix: z.string().min(1).max(128) }),
  z.strictObject({ action: z.literal("unmute"), ...scope, ...revision, prefix: z.string().min(1).max(128) }),
  z.strictObject({ action: z.literal("set-provider"), ...scope, ...revision, providerId: z.string().min(1).max(64) }),
  z.strictObject({ action: z.literal("egress"), ...scope, ...revision, field: z.enum(HEARTBEAT_RECEIVES), on: z.boolean() }),
  z.strictObject({ action: z.literal("item"), ...scope, itemId: IdSchema }),
  /** What it told lately, newest first: Center → Heartbeat's items, which show there with Home off too. */
  z.strictObject({ action: z.literal("recent"), ...scope, limit: z.number().int().min(1).max(HEARTBEAT_RECENT_MAX).optional() }),
  z.strictObject({ action: z.literal("forget"), ...scope }),
  /** Dismiss the first-run offer for good (*Not now*). */
  z.strictObject({ action: z.literal("offer"), ...scope }),
  /**
   * *Turn on* from the first-run offer: on, with these instructions, in one
   * save over the revision the offer was read at (0 for a heartbeat never
   * saved, which lands at revision 1) — a second press is refused.
   */
  z.strictObject({ action: z.literal("start"), ...scope, revision: z.number().int().nonnegative(), instructions: z.string() }),
]);
export type HeartbeatPayload = z.infer<typeof HeartbeatPayloadSchema>;

/** A heartbeat's state as answers carry it. */
export const HeartbeatStateViewSchema = z.object({
  workspaceId: IdSchema,
  principalId: IdSchema,
  config: HeartbeatConfigSchema,
  nextTickAt: TimestampSchema.optional(),
  lastTickAt: TimestampSchema.optional(),
  lastDeepTickAt: TimestampSchema.optional(),
  memo: z.string().optional(),
  offerDismissedAt: TimestampSchema.optional(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});

/** A state as answers carry it; typed so the repository's `HeartbeatState` and this view cannot drift apart. */
export const heartbeatStateView = (state: HeartbeatState): z.infer<typeof HeartbeatStateViewSchema> => state;

/** A heartbeat as `get` (and every settings write) answers it: its state (none yet: the defaults, at revision 0), the choices, the zone, and whether the host runs. */
/** A read-only plugin tool a person may add to a heartbeat's checks. */
export const HeartbeatToolChoiceSchema = z.object({ id: z.string().min(1), description: z.string() });
export type HeartbeatToolChoice = z.infer<typeof HeartbeatToolChoiceSchema>;

export const HeartbeatGetAnswerSchema = z.object({
  workspaceId: IdSchema,
  principalId: IdSchema,
  /** Absent until it is first saved; `config` is then the defaults. */
  state: HeartbeatStateViewSchema.optional(),
  config: HeartbeatConfigSchema,
  revision: z.number().int().nonnegative(),
  options: HeartbeatOptionsSchema,
  timezone: z.string().min(1),
  /** Whether this owner runs the host (`tavi serve` with `tavi.heartbeat` enabled). */
  hostRunning: z.boolean(),
  /** The providers installed here, by plugin id. */
  providers: z.array(z.string()).readonly(),
  /** What each installed plugin provider may receive, and the disclosure its approval showed: what the provider choice shows. */
  providerDetails: z
    .array(
      z.object({
        id: z.string(),
        kind: z.enum(["builtin", "plugin"]),
        receives: z.array(z.enum(HEARTBEAT_RECEIVES)).readonly(),
        disclosure: z.string().max(1_000).optional(),
      }),
    )
    .readonly()
    .default([]),
  /**
   * The first-run offer, with the instructions it prefills: present
   * only while the heartbeat is off, the offer was never dismissed, and a
   * built-in signal source has something to watch.
   */
  offer: z.object({ instructions: z.string() }).optional(),
  /** The read-only plugin tools a person may add to its checks (`extraTools`): each loaded plugin's, by id. */
  toolChoices: z.array(HeartbeatToolChoiceSchema).readonly().default([]),
  /** The signal sources installed here, built in or a plugin's: what *Signal sources* may turn off, a plugin's with its name in words. */
  sources: z
    .array(z.object({ id: z.string().min(1), kind: z.enum(["builtin", "plugin"]), label: z.string().min(1).max(200).optional() }))
    .readonly()
    .default([]),
  /** What the selected provider published for its own panel, by key; absent when it published nothing. */
  providerState: z.record(z.string(), z.unknown()).optional(),
});
export type HeartbeatGetAnswer = z.infer<typeof HeartbeatGetAnswerSchema>;

export const HeartbeatInstructionsAnswerSchema = z.object({ text: z.string(), revision: z.number().int().nonnegative() });
export type HeartbeatInstructionsAnswer = z.infer<typeof HeartbeatInstructionsAnswerSchema>;

export const HeartbeatHistoryAnswerSchema = z.object({
  history: z.array(HeartbeatInstructionsRevisionSchema).readonly(),
});
export type HeartbeatHistoryAnswer = z.infer<typeof HeartbeatHistoryAnswerSchema>;

export const HeartbeatLogAnswerSchema = z.object({ ticks: z.array(HeartbeatTickRecordSchema).readonly() });
export type HeartbeatLogAnswer = z.infer<typeof HeartbeatLogAnswerSchema>;

export const HeartbeatRunNowAnswerSchema = z.object({ status: z.enum(["started", "queued"]) });
export type HeartbeatRunNowAnswer = z.infer<typeof HeartbeatRunNowAnswerSchema>;

/** One item as answers carry it. */
export const HeartbeatItemViewSchema = z.object({
  itemId: IdSchema,
  workspaceId: IdSchema,
  principalId: IdSchema,
  key: z.string(),
  hash: z.string(),
  signalKeys: z.array(z.string()).readonly(),
  urgency: z.enum(["now", "later"]),
  heldBack: z.boolean(),
  title: z.string(),
  body: z.string().optional(),
  sources: z.array(z.object({ label: z.string(), ref: z.string().optional() })).readonly(),
  instructionLine: z.number().int().optional(),
  proposedAction: z.object({ toolId: z.string(), input: z.unknown(), summary: z.string() }).optional(),
  state: z.enum(HEARTBEAT_LEDGER_STATES),
  snoozedUntil: TimestampSchema.optional(),
  feedback: z.enum(["up", "down"]).optional(),
  buttonToken: z.string().optional(),
  firstToldAt: TimestampSchema,
  lastToldAt: TimestampSchema,
  digestedAt: TimestampSchema.optional(),
  updatedAt: TimestampSchema,
});

/** An item as answers carry it; typed so the ledger's rows and this view cannot drift apart. */
export const heartbeatItemView = (row: HeartbeatLedgerRow): z.infer<typeof HeartbeatItemViewSchema> => row;

/**
 * `item`: one item, and the titles of the memories the check that told it was given
 * ("because you said …", at most 2), as the memory rows say now: a forgotten one is left out.
 */
export const HeartbeatItemAnswerSchema = z.object({
  item: HeartbeatItemViewSchema,
  because: z.array(z.string()).max(2).readonly().optional(),
});
export type HeartbeatItemAnswer = z.infer<typeof HeartbeatItemAnswerSchema>;

export const HeartbeatRecentAnswerSchema = z.object({ items: z.array(HeartbeatItemViewSchema).readonly() });
export type HeartbeatRecentAnswer = z.infer<typeof HeartbeatRecentAnswerSchema>;

export const HeartbeatForgetAnswerSchema = z.object({ removed: HeartbeatHistoryRemovedSchema });
export type HeartbeatForgetAnswer = z.infer<typeof HeartbeatForgetAnswerSchema>;
