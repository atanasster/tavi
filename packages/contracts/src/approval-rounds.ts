import type { AsyncRepository } from "./persistence-types.js";
import { z } from "zod";

import { IdSchema } from "./ids.js";
import { ApprovalScopeSchema, RiskLevelSchema, type RiskLevel } from "./tool-policy.js";
import { CONTENT_LABEL_LIMITS, LabelSummarySchema, utf8Bytes, type LabelSummary } from "./content-label.js";

/**
 * Approval rounds as the channels see them.
 *
 * The workflow already keys a round by `(taskId, steps)` and decides it through
 * the round's resume key. What a channel adds is a short token a person can
 * type or a button can carry, the conversation the round was announced in (so
 * a decision made anywhere can be reported there), an expiry after which the
 * round is denied, and an append-only record of what happened to it.
 */

/** Lowercase base32 without `0`, `1`, `l`, `o`: easy to read aloud and to type on a phone. */
const TOKEN_ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";
export const ROUND_TOKEN_LENGTH = 8;
export const RoundTokenSchema = z.string().regex(new RegExp(`^[${TOKEN_ALPHABET}]{${ROUND_TOKEN_LENGTH}}$`));

/**
 * A fresh round token: 8 characters from a 32-letter alphabet, 40 random bits.
 * The caller supplies the random source, since this package has no platform
 * APIs (Node's `randomFillSync`, a browser's `crypto.getRandomValues`).
 */
export function newRoundToken(fillRandom: (bytes: Uint8Array) => void): string {
  const bytes = new Uint8Array(ROUND_TOKEN_LENGTH);
  fillRandom(bytes);
  let token = "";
  for (const byte of bytes) token += TOKEN_ALPHABET[byte % TOKEN_ALPHABET.length];
  return token;
}

/** Each call of a round with the scopes the gate's verdict offered it. */
export const ApprovalCallScopesSchema = z
  .array(z.strictObject({ callId: IdSchema, allowedScopes: z.array(ApprovalScopeSchema).min(1).max(3) }))
  .max(64);
export type ApprovalCallScopes = z.infer<typeof ApprovalCallScopesSchema>;

export const ApprovalRoundRecordSchema = z.strictObject({
  taskId: IdSchema,
  steps: z.number().int().nonnegative(),
  token: RoundTokenSchema,
  workspaceId: IdSchema,
  /** Where the round was announced; absent when it was not sent to a chat. */
  connectionId: z.string().min(1).max(128).optional(),
  conversationId: z.string().min(1).max(256).optional(),
  /** Provider message ids of the announcement, for threading and later edits. */
  messageIds: z.array(z.string().min(1).max(256)).max(16),
  /** After this instant the round is denied (`policy:expired`). */
  expiresAt: z.string().min(1).max(64).optional(),
  /** The round's highest call risk, which decides what a channel may accept for it. */
  risk: z.enum(["low", "medium", "high", "critical"]).optional(),
  /**
   * The context label the round's calls were emitted under: its summary,
   * stored with `risk` in the same column
   * (`encodeRoundRisk`), bounded to 4 KiB. Absent on older rounds.
   */
  riskLabel: LabelSummarySchema.optional(),
  /**
   * The scopes the gate's verdict offered each call of the round:
   * narrower than the round's risk allows for a tainted conversation, a
   * once-only tool or subjects no rule can hold. Absent on older rounds.
   */
  callScopes: ApprovalCallScopesSchema.optional(),
  settledAt: z.string().min(1).max(64).optional(),
  createdAt: z.string().min(1).max(64),
});
export type ApprovalRoundRecord = z.infer<typeof ApprovalRoundRecordSchema>;

export const APPROVAL_EVENT_KINDS = [
  "announced",
  "announce_failed",
  "decision_refused",
  "settled",
  "grant_created",
  "rule_created",
  "expired",
  /** The settlement was shown in the conversation the round was announced in (an edit or a follow-up). */
  "notified",
  /** The settlement could not be shown there; the sweep tries again. */
  "notify_failed",
  /** What became of a decided call: ran (`ok`), failed (`error`) or `denied`. */
  "tool_result",
] as const;
export const ApprovalEventKindSchema = z.enum(APPROVAL_EVENT_KINDS);
export type ApprovalEventKind = z.infer<typeof ApprovalEventKindSchema>;

export const ApprovalEventRecordSchema = z.strictObject({
  eventId: z.number().int().positive(),
  taskId: IdSchema,
  steps: z.number().int().nonnegative(),
  kind: ApprovalEventKindSchema,
  /** The front end or channel it came through: `telegram-main`, `ipc`, `cli`, `policy`. */
  via: z.string().max(128).optional(),
  /** The principal who acted, when one did. */
  actor: z.string().max(128).optional(),
  /** Bounded free-form facts: the scope, a refusal's reason, a rule id. */
  detail: z.record(z.string().max(64), z.unknown()).optional(),
  at: z.string().min(1).max(64),
});
export type ApprovalEventRecord = z.infer<typeof ApprovalEventRecordSchema>;

/**
 * A single-use link that decides a round or answers a question from an
 * email. Only the token's SHA-256 is stored; the token itself is in the one
 * email it was sent in. Using any link of a round or question spends them all.
 */
export const ApprovalLinkRecordSchema = z.strictObject({
  tokenHash: z.string().regex(/^[0-9a-f]{64}$/),
  taskId: IdSchema,
  kind: z.enum(["round", "question"]),
  /** The round's steps (`kind: "round"`). */
  steps: z.number().int().nonnegative().optional(),
  /** The question's wait (`kind: "question"`). */
  waitId: IdSchema.optional(),
  /** `once`, `session`, `always` or `deny` for a round; the option's number for a question. */
  choice: z.string().min(1).max(16),
  expiresAt: z.string().min(1).max(64),
  usedAt: z.string().min(1).max(64).optional(),
  createdAt: z.string().min(1).max(64),
});
export type ApprovalLinkRecord = z.infer<typeof ApprovalLinkRecordSchema>;

/** Wrong PINs permitted for one round across every sibling link. */
export const MAX_APPROVAL_PIN_ATTEMPTS = 3;
export type ApprovalPinConsumption =
  | { readonly status: "consumed" | "unavailable" }
  | { readonly status: "wrong-pin"; readonly remaining: number };

interface ApprovalLinkRepositoryPortDefinition {
  create(link: Omit<ApprovalLinkRecord, "usedAt">): void;
  get(tokenHash: string): ApprovalLinkRecord | undefined;
  /**
   * Spend a link and every sibling (same round or question), atomically:
   * `true` only for the first caller, and only before the link expires.
   */
  consume(tokenHash: string, at: string): boolean;
  /** Atomically check the round's PIN attempt count, record a miss, or consume all links. */
  consumeWithPin(input: { readonly tokenHash: string; readonly pinMatches: boolean; readonly at: string }): ApprovalPinConsumption;
  /** Undo a `consume` made at `at` whose decision did not happen: the link and its siblings work again. */
  release(tokenHash: string, at: string): void;
}

export type ApprovalLinkRepositoryPort = AsyncRepository<ApprovalLinkRepositoryPortDefinition>;

/** Durable round metadata and the audit trail. */
interface ApprovalRoundRepositoryPortDefinition {
  /** Create the round's record; returns the existing one when it was already created. */
  create(round: Omit<ApprovalRoundRecord, "messageIds" | "settledAt"> & { readonly messageIds?: readonly string[] }): {
    readonly round: ApprovalRoundRecord;
    readonly created: boolean;
  };
  get(taskId: string, steps: number): ApprovalRoundRecord | undefined;
  getByToken(token: string): ApprovalRoundRecord | undefined;
  /** A task's recorded rounds, oldest first; one announced to a chat names its connection and conversation. */
  listForTask(taskId: string): readonly ApprovalRoundRecord[];
  addMessageIds(taskId: string, steps: number, messageIds: readonly string[]): void;
  /** Mark settled once; returns false when it already was. */
  settle(taskId: string, steps: number, at: string): boolean;
  /** Unsettled rounds that were announced and whose expiry has passed, oldest first. */
  listExpired(now: string, limit: number): readonly ApprovalRoundRecord[];
  /** Unsettled rounds whose announcement failed and has not since been sent, oldest first. */
  listUnannounced(limit: number): readonly ApprovalRoundRecord[];
  /** Rounds settled after `since` that were announced and whose settlement has not been shown there, oldest first. */
  listUnnotified(since: string, limit: number): readonly ApprovalRoundRecord[];
  /** Move an unsettled round's expiry: a round first seen late gets its full time to be decided. */
  setExpiry(taskId: string, steps: number, expiresAt: string): void;
  appendEvent(event: Omit<ApprovalEventRecord, "eventId">): ApprovalEventRecord;
  listEvents(taskId: string, steps?: number): readonly ApprovalEventRecord[];
}

export type ApprovalRoundRepositoryPort = AsyncRepository<ApprovalRoundRepositoryPortDefinition>;

/**
 * A round's `risk` column (TEXT) as stored: the level alone,
 * as every older round wrote it, or — with the context label's summary —
 * `{"level":…,"label":…}`, bounded to 4 KiB (display detail goes first:
 * refs, then principals; integrity, confidentiality and sources stay). No
 * SQL migration: the column was always text.
 */
export function encodeRoundRisk(level: RiskLevel, label?: LabelSummary): string {
  if (label === undefined) return level;
  let kept: LabelSummary = label;
  const encode = (): string => JSON.stringify({ level, label: kept });
  if (utf8Bytes(encode()) > CONTENT_LABEL_LIMITS.summaryMaxBytes) kept = { ...kept, refs: [], truncated: true };
  if (utf8Bytes(encode()) > CONTENT_LABEL_LIMITS.summaryMaxBytes) kept = { ...kept, principals: [], truncated: true };
  return encode();
}

/** A stored `risk` column read back (`encodeRoundRisk`): an unreadable value has no level, a label that does not parse is dropped. */
export function decodeRoundRisk(stored: string | null | undefined): { readonly level?: RiskLevel; readonly label?: LabelSummary } {
  if (stored === null || stored === undefined) return {};
  const bare = RiskLevelSchema.safeParse(stored);
  if (bare.success) return { level: bare.data };
  try {
    const parsed = JSON.parse(stored) as { readonly level?: unknown; readonly label?: unknown };
    const level = RiskLevelSchema.safeParse(parsed.level);
    const label = LabelSummarySchema.safeParse(parsed.label);
    return { ...(level.success ? { level: level.data } : {}), ...(label.success ? { label: label.data } : {}) };
  } catch {
    return {};
  }
}
