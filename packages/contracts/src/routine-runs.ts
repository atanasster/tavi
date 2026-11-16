import { ProviderOperationSchema } from "./provider-operation.js";
import { z } from "zod";
import { ROUTINE_GRANT_DENIALS } from "./routine-grants.js";
import type { RoutineScope, RoutineSnapshot } from "./routines.js";

export const ROUTINE_RUN_STATUSES = [
  "queued",
  "running",
  "succeeded",
  "degraded",
  "suppressed",
  "failed",
  "cancelled",
  "skipped",
  "interrupted",
] as const;
export type RoutineRunStatus = (typeof ROUTINE_RUN_STATUSES)[number];
export type RoutineStep = "research" | "synthesis" | "render" | "delivery";
export const RoutineEnvelopeSchema = z.strictObject({
  operation: ProviderOperationSchema.optional(),
  version: z.literal(1),
  step: z.enum(["research", "synthesis", "render", "delivery"]).optional(),
  code: z.enum([
    "model-retired",
    "transient",
    "setup-needed",
    "auto-paused",
    "claimed",
    "started",
    "recovered",
    "completed",
    "failed",
    "cancelled",
    "missed",
    "overlap",
    "daily-budget",
    "budget",
    "expired",
    "credentials",
    "revoked",
    "model",
    "tool",
    "heartbeat",
    "published",
    "delivery",
    "pruned",
    "grant",
    "unsupported",
    "asked",
    "answered",
  ]),
  retryable: z.boolean().optional(),
  generation: z.number().int().nonnegative().optional(),
  model: z.string().max(256).optional(),
  connectionId: z.string().max(128).optional(),
  tool: z
    .string()
    .regex(/^[a-zA-Z0-9_.-]+$/)
    .max(128)
    .optional(),
  sourceOrigin: z
    .string()
    .max(300)
    .regex(/^https:\/\/[a-z0-9.-]+(?::[0-9]+)?$/)
    .optional(),
  modelCalls: z.number().int().nonnegative().optional(),
  toolCalls: z.number().int().nonnegative().optional(),
  tokens: z.number().int().nonnegative().nullable().optional(),
  /** Durable grant identity a research/synthesis effect resolved against. */
  grantId: z.string().min(1).max(128).optional(),
  /** `permissions.revision` of the pinned snapshot the grant resolved to. */
  policyRevision: z.number().int().positive().optional(),
  /** Allow is recorded on every reserved effect; deny on every typed refusal. */
  decision: z.enum(["allow", "deny"]).optional(),
  /** Why a grant decision refused; the typed code, not free text. */
  denial: z.enum(ROUTINE_GRANT_DENIALS).optional(),
  /** A human checkpoint: the question when `asked`, how it was settled when `answered`. */
  checkpoint: z
    .strictObject({
      question: z.string().max(300).optional(),
      outcome: z.enum(["answered", "defaulted", "undelivered", "withdrawn"]).optional(),
      answers: z.array(z.string().max(60)).max(4).optional(),
      via: z.string().max(128).optional(),
    })
    .optional(),
});
export type RoutineEnvelope = z.infer<typeof RoutineEnvelopeSchema>;
export interface RoutineFence {
  readonly runId: string;
  readonly generation: number;
  readonly ownerEpoch: string;
  readonly attemptId: string;
}
export interface RoutineRun extends RoutineScope {
  readonly runId: string;
  readonly routineId: string;
  readonly occurrenceKey: string;
  readonly triggerId: string | null;
  readonly revision: number;
  readonly snapshot: RoutineSnapshot;
  readonly mode: "production" | "preview";
  readonly status: RoutineRunStatus;
  readonly generation: number;
  readonly taskId: string | null;
  /** The durable grant pinned at admission; every research/synthesis effect re-resolves it. */
  readonly grantId: string | null;
  readonly scheduledFor: string | null;
  readonly claimedAt: string;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly data: RoutineRunData;
}
/** What a run took: wall time from start to end, the calls it made and the tokens providers reported. */
export interface RoutineRunEffort {
  /** Null until the run has both started and ended. */
  readonly durationMs: number | null;
  readonly modelCalls: number;
  readonly toolCalls: number;
  readonly tokensKnown: number;
}
/** A run as history lists it: without its snapshot and accounting, with what it took and its report's headline. */
export interface RoutineRunSummary extends Omit<RoutineRun, "snapshot" | "data">, RoutineRunEffort {
  /** The published report's first story title, or its title when it has none; null before a report (and on a run published before headlines were kept). */
  readonly headline: string | null;
}
/** A routine's runs claimed since `since`, summed: how many, and what they took together. */
export interface RoutineRunEffortTotals extends RoutineRunEffort {
  readonly since: string;
  readonly runs: number;
  readonly durationMs: number;
}
/**
 * Why a routine, or one of its delivery targets, paused on its own: real
 * failures in a row, or a credential still missing past its grace.
 */
export type RoutinePauseCause = "failures" | "credential-grace";
/** What a routine run's notice is about: its routine pausing, or the run expiring before it could finish. */
export type RoutineRunNoticeCause = RoutinePauseCause | "expired";
export interface RoutineRunData {
  operationKey: string;
  deadline: string;
  queueExpiresAt: string;
  localDay: string;
  /** Every model call the run made, an excused attempt's too: what its effort shows. */
  modelCalls: number;
  /** Every tool call the run made, an excused attempt's too: what its effort shows. */
  toolCalls: number;
  /** Of `modelCalls`, those attempts a transient failure cut short made: the budget does not count them. */
  excusedModelCalls?: number;
  /** Of `toolCalls`, those attempts a transient failure cut short made: the budget does not count them. */
  excusedToolCalls?: number;
  tokensReserved: number;
  tokensKnown: number;
  usageComplete: boolean;
  reservations: Record<string, number>;
  stepStarted: Partial<Record<RoutineStep, string>>;
  reason?: RoutineEnvelope["code"];
  report?: unknown;
  /** The routine's name when its report was selected: the report is titled, and its delivered file named, by it. */
  reportName?: string;
  /**
   * The research worker's operation key, once it differs from `${operationKey}:research`: a synthesis
   * attempt that failed transiently starts again under a new key and reuses the research it already has.
   */
  researchOperationKey?: string;
  /** How many attempts a transient provider failure has cut short; bounded by `ROUTINE_MAX_TRANSIENT_RETRIES`. */
  transientRetries?: number;
  /** A resumed attempt waits until then before it starts: the backoff after a transient failure. */
  retryAfter?: string;
  /** The usage each step had begun from (every call, excused or not), so an attempt a transient failure cut short can be excused. */
  stepBase?: Partial<Record<RoutineStep, { modelCalls: number; toolCalls: number; tokensReserved: number }>>;
  /** Since when the run has waited for an execution slot: its windows move on by the wait once it starts. */
  slotWaitSince?: string;
  /** The owner that recorded `slotWaitSince`: a wait under an earlier owner is not credited. */
  slotWaitEpoch?: string;
  /** The attempt generation that ran out of its model or tool budget. */
  budgetExhausted?: number;
  /** Why a failed run failed, in the words of the error it ended on (at most 500 characters): what its page says. */
  failureDetail?: string;
}
/** A transient provider failure is retried at most this many times per run before it counts as a failure. */
export const ROUTINE_MAX_TRANSIENT_RETRIES = 3;
/** The research worker's operation key for a run. */
export function routineResearchOperationKey(data: Pick<RoutineRunData, "operationKey" | "researchOperationKey">): string {
  return data.researchOperationKey ?? `${data.operationKey}:research`;
}
/** A run's start to end in milliseconds, once it has both; never negative. */
export function routineRunDuration(startedAt: string | null, endedAt: string | null): number | null {
  if (startedAt === null || endedAt === null) return null;
  const ms = Date.parse(endedAt) - Date.parse(startedAt);
  return Number.isFinite(ms) ? Math.max(0, ms) : null;
}
/**
 * What a readiness probe found.
 *
 * Read-only by construction: it performs no model call, sends nothing and admits
 * no run. Research health and delivery health are separate statements because they
 * fail separately — a revoked destination blocks delivery while research is fine —
 * and a stale owner heartbeat means *unknown*, not "offline", because nothing here
 * can prove the owner is gone.
 */
export interface RoutineReadiness {
  readonly routineId: string;
  readonly revision: {
    readonly active: number | null;
    readonly latest: number;
    readonly candidate: {
      readonly revision: number;
      readonly evaluation: "pending" | "running" | "passed" | "failed";
      readonly detail: string;
    } | null;
  };
  readonly research: {
    readonly ready: boolean;
    /** `credentials`, `model-retired`, `transient`, `setup-needed`, or null when ready. */
    readonly blockedBy: string | null;
    readonly retryable: boolean | null;
    readonly tools: readonly string[];
    readonly hosts: readonly string[];
    readonly networkMode: string;
    readonly grant: { readonly grantId: string; readonly revokedAt: string | null; readonly policyRevision: number } | null;
  };
  readonly delivery: {
    readonly authorized: boolean;
    readonly blockedBy: string | null;
    readonly targets: readonly {
      readonly targetId: string;
      readonly revision: number;
      readonly enabled: boolean;
      readonly authorized: boolean;
      readonly problem: string | null;
    }[];
  };
  readonly owner: {
    readonly heartbeatAt: string | null;
    /** `live`, `stale` (older than the threshold) or `never`. */
    readonly state: "live" | "stale" | "never";
    readonly heartbeatAgeMs: number | null;
  };
  readonly storage: { readonly freeBytes: number | null; readonly belowFloor: boolean | null };
  readonly schedule: {
    readonly nextRunAt: string | null;
    readonly timezone: string;
    readonly triggerId: string | null;
    readonly enabled: boolean;
  } | null;
  readonly renderer: { readonly available: boolean; readonly provider: string } | null;
}

/**
 * What a ledger verification actually establishes.
 *
 * The verdict is deliberately partial: a local hash chain proves that no event was
 * changed *between* the events it contains, and nothing more. A rewrite of the
 * whole table, or a truncated tail, produces a chain that verifies. The
 * `limitation` string is part of the contract, not decoration, and `anchored` is
 * `false` until an operator-controlled anchor exists — no caller may render this
 * as a blanket "untampered".
 */
export interface RoutineLedgerVerdict {
  readonly valid: boolean;
  readonly scope: { readonly workspaceId: string; readonly principalId: string; readonly routineId: string };
  /** Events the chain covers. */
  readonly events: number;
  /** The last event's hash, or the all-zero genesis hash for an empty ledger. */
  readonly headHash: string;
  readonly prunedDetails: number;
  readonly chain: "local";
  readonly anchored: false;
  readonly limitation: string;
}
export interface RoutineLedgerEvent {
  readonly sequence: number;
  readonly eventId: string;
  readonly runId: string | null;
  readonly attemptId: string | null;
  readonly at: string;
  readonly envelope: RoutineEnvelope;
  readonly previousHash: string;
  readonly eventHash: string;
  readonly detailId: string | null;
  readonly detailHash: string | null;
}
export interface RoutineExecutionPort {
  get(scope: RoutineScope, runId: string): RoutineRun;
  history(scope: RoutineScope, routineId: string, limit?: number, beforeRunId?: string): readonly RoutineRunSummary[];
  cancel(scope: RoutineScope, runId: string): void;
  ledger(scope: RoutineScope, routineId: string, afterSequence?: number, limit?: number): readonly RoutineLedgerEvent[];
}
