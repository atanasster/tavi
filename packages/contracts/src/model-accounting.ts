import { type ProviderOperationsPort, ProviderOperationSchema } from "./provider-operation.js";
import { z } from "zod";
import { IdSchema, TimestampSchema } from "./ids.js";
import { ModelCallSiteSchema, ModelRequestSchema, ModelUsageSchema, type ModelUsage } from "./model.js";

const rate = z.number().finite().nonnegative();

/** Immutable, dated USD rates per million tokens. Cache writes are an input subset. */
export const ModelPriceSheetSchema = z.strictObject({
  revision: IdSchema,
  connectionId: IdSchema,
  model: z.string().min(1).max(256),
  effectiveAt: TimestampSchema.transform((value) => new Date(value).toISOString()),
  currency: z.literal("USD"),
  input: rate,
  cacheRead: rate,
  cacheWrite: rate,
  output: rate,
  reasoning: rate.optional(),
});
export type ModelPriceSheet = z.infer<typeof ModelPriceSheetSchema>;

export const ProviderAttemptSchema = z.strictObject({
  callId: IdSchema,
  runId: IdSchema,
  attemptId: IdSchema,
  ownerSession: IdSchema,
  connectionId: IdSchema,
  model: z.string().min(1).max(256),
  purpose: z.enum(["generation", "summary", "evaluation", "router", "extraction", "vision", "embedding"]),
  operation: ProviderOperationSchema.optional(),
  /**
   * Validated plain application history, stored beside the operation envelope.
   * Kept only on a run's newest attempts (`DEFAULT_KEPT_MODEL_REQUESTS`, the
   * workspace's `keptModelRequests`) and on one still `started`; older settled
   * attempts keep everything else, `requestSha256` included when it was set.
   */
  request: ModelRequestSchema.optional(),
  /** SHA-256 of the stored request's JSON, set by the ledger when the attempt began with one; it outlives the request. */
  requestSha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
  /**
   * The first 16 hex digits of the SHA-256 of the request's system text (its
   * system messages, trimmed and joined as the model adapters join them), set
   * by the ledger at `begin` when the attempt carries a request. Two turns
   * whose first calls share it sent the same instructions, so a provider's
   * prefix cache could reuse them. Absent on older attempts.
   */
  systemHash: z
    .string()
    .regex(/^[0-9a-f]{16}$/)
    .optional(),
  /** The request's `step`: which model call of its turn this was. Set by the ledger at `begin`; absent on older attempts and on calls outside a turn's loop. */
  step: z.number().int().positive().optional(),
  /**
   * The first 16 hex digits of the SHA-256 of the request's tool descriptors,
   * set by the ledger at `begin` beside `systemHash`: tools lead a provider's
   * cached prefix, so two calls with different hashes could share none of it.
   */
  toolsHash: z
    .string()
    .regex(/^[0-9a-f]{16}$/)
    .optional(),
  /** Which caller made the call (`MODEL_CALL_SITES`); absent on older attempts and unlabelled callers. */
  site: ModelCallSiteSchema.optional(),
  startedAt: TimestampSchema,
  finishedAt: TimestampSchema.optional(),
  state: z.enum(["started", "completed", "failed", "aborted", "uncertain"]),
  usage: ModelUsageSchema,
  priceRevision: IdSchema.optional(),
  estimatedUsd: rate.optional(),
});
export type ProviderAttempt = z.infer<typeof ProviderAttemptSchema>;

/** Unknown usage or unsupported billing dimensions produce no dollar estimate. */
export function estimateModelCost(usage: ModelUsage, price: ModelPriceSheet): number | undefined {
  if (!ModelUsageSchema.safeParse(usage).success) return undefined;
  const input = usage.inputTokens;
  const output = usage.outputTokens;
  if (input === undefined || output === undefined) return undefined;
  const read = usage.inputCacheReadTokens;
  const write = usage.inputCacheWriteTokens;
  const plain = usage.inputNoCacheTokens;
  if ((read ?? 0) + (write ?? 0) + (plain ?? 0) > input) return undefined;
  let inputCost: number;
  if (price.cacheRead === price.input && price.cacheWrite === price.input) {
    inputCost = input * price.input;
  } else {
    if (read === undefined || write === undefined || plain === undefined || read + write + plain !== input) return undefined;
    inputCost = plain * price.input + read * price.cacheRead + write * price.cacheWrite;
  }
  const reasoning = usage.outputReasoningTokens;
  if (reasoning !== undefined && reasoning > output) return undefined;
  let outputCost = output * price.output;
  if (price.reasoning !== undefined && price.reasoning !== price.output) {
    if (reasoning === undefined) return undefined;
    outputCost = (output - reasoning) * price.output + reasoning * price.reasoning;
  }
  const usd = (inputCost + outputCost) / 1_000_000;
  return Number.isFinite(usd) ? usd : undefined;
}

/** One attempt without its stored request or operation: what a listing of a run's calls shows. */
export interface ProviderAttemptSummary {
  readonly callId: string;
  readonly attemptId: string;
  readonly connectionId: string;
  readonly model: string;
  readonly state: ProviderAttempt["state"];
  readonly purpose: ProviderAttempt["purpose"];
  readonly usage: ModelUsage;
  readonly estimatedUsd?: number;
  readonly startedAt: string;
}

/** A run's attempt count, how many of them carry a dollar estimate, and those estimates' sum. */
export interface ProviderAttemptCostTotals {
  readonly attempts: number;
  readonly priced: number;
  readonly usd: number;
}

/**
 * How many of a run's newest attempts keep their whole request: the
 * rest keep usage, cost, ids, the operation and `requestSha256` (when set). Nothing reads
 * a settled attempt's request — the check before each call reads the
 * operation, reports read columns — so it is kept for debugging only.
 */
export const DEFAULT_KEPT_MODEL_REQUESTS = 10;
/** What a model call may write by default (`models.maxOutputTokens`): enough for a long answer, not a provider's whole maximum. */
export const DEFAULT_MAX_OUTPUT_TOKENS = 16_384;
/** The least `models.maxOutputTokens` may be: a short answer and a tool call fit. */
export const MIN_MAX_OUTPUT_TOKENS = 256;
/** The most `models.maxOutputTokens` may be. */
export const MAX_MAX_OUTPUT_TOKENS = 1_000_000;
/** The most a workspace may keep (`keptModelRequests`). */
export const MAX_KEPT_MODEL_REQUESTS = 1_000;

/** What `finish` keeps of the run's stored requests; absent, `DEFAULT_KEPT_MODEL_REQUESTS`. */
export interface ModelRequestRetention {
  /** A run's newest attempts that keep their request; `0` strips it from every settled attempt. */
  readonly keptRequests: number;
}

export interface ModelAccountingPort extends ProviderOperationsPort {
  putPrice(input: ModelPriceSheet): Promise<void>;
  price(connectionId: string, model: string, at: string): Promise<ModelPriceSheet | undefined>;
  begin(input: Omit<ProviderAttempt, "state" | "usage" | "finishedAt" | "estimatedUsd">): Promise<void>;
  /** `begin`, priced by the sheet in effect for its connection and model at `startedAt` (`price`), read in the same request. */
  beginPriced(input: Omit<ProviderAttempt, "state" | "usage" | "finishedAt" | "estimatedUsd" | "priceRevision">): Promise<void>;
  /**
   * Settles an attempt and, in the same transaction, strips the request from
   * the run's settled attempts older than its newest `retention.keptRequests`.
   * A `started` attempt always keeps its request.
   */
  finish(
    callId: string,
    state: Exclude<ProviderAttempt["state"], "started">,
    usage: ModelUsage,
    at: string,
    retention?: ModelRequestRetention,
  ): Promise<void>;
  get(callId: string): Promise<ProviderAttempt | undefined>;
  /**
   * A run's attempts, oldest first. `states` narrows the read to attempts in
   * those states — what a check before each call needs, so a long chat's
   * every attempt is not read per call. Only the newest attempts carry their
   * request.
   */
  list(runId: string, filter?: { readonly states?: readonly ProviderAttempt["state"][] }): Promise<readonly ProviderAttempt[]>;
  /**
   * A run's attempts as summaries, oldest first, reading no stored request.
   * `last` keeps only the newest that many (still returned oldest first).
   */
  summaries(runId: string, options?: { readonly last?: number }): Promise<readonly ProviderAttemptSummary[]>;
  /** The connections a run's generation calls went to, each once. */
  usedConnections(runId: string): Promise<readonly string[]>;
  /** `usedConnections` for many runs in one read: one entry per distinct run asked, `[]` for a run with none. */
  usedConnectionsOf(runIds: readonly string[]): Promise<readonly { readonly runId: string; readonly connections: readonly string[] }[]>;
  /** A run's attempt count and dollar estimates, summed in the database. */
  costTotals(runId: string): Promise<ProviderAttemptCostTotals>;
  recoverPreviousOwner(ownerSession: string, at: string): Promise<number>;
  deleteRun(runId: string): Promise<number>;
}
