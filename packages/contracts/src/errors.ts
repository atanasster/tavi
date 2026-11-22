import { z } from "zod";
import { errorMessage } from "./util.js";
import { coreEnglish, type CoreT } from "./locales/core.js";

/**
 * Typed errors.
 *
 * Errors cross service boundaries as data. A message never carries a secret and
 * authorization failures must not reveal whether an unauthorized object exists.
 */

export const TAVI_ERROR_CODES = [
  "NOT_AUTHORIZED",
  "INVALID_INPUT",
  "NOT_FOUND",
  "DUPLICATE",
  "CONFLICT",
  "REVISION_CONFLICT",
  // Two approved records claim the same preference key in one scope: the
  // conflict is reported rather than resolved by ranking.
  "MEMORY_CONFLICT",
  // Evidence a memory record cites is revoked, expired or unavailable.
  "SOURCE_UNAVAILABLE",
  "MISSING_DEPENDENCY",
  "DEPENDENCY_CYCLE",
  "DUPLICATE_PLUGIN",
  "DUPLICATE_SERVICE",
  "STARTUP_FAILED",
  "UNAVAILABLE",
  // No connection/role is configured for the requested work. Separated from
  // UNAVAILABLE so a caller can distinguish "you have not configured this yet"
  // from "the configured thing is down".
  "NOT_CONFIGURED",
  // The configured model, or an optional runtime component such as
  // Playwright, cannot do what the caller needs (for example the model does
  // not declare tool calling, or Playwright is not installed). Distinct from
  // NOT_CONFIGURED so an operator can tell "nothing is set up" from "what is
  // set up is unsuitable".
  "CAPABILITY_MISSING",
  "BUDGET_EXCEEDED",
  "TOOL_FAILED",
  "MODEL_FAILED",
  "APPROVAL_REQUIRED",
  "APPROVAL_DENIED",
  "CANCELLED",
  // An operator stopped the admission that was running (`tavi abort`).
  // Distinct from CANCELLED, which is the task's durable ledger
  // cancellation: an abort ends one turn and cancels nothing on the ledger.
  "ABORTED",
  // The person stopped the turn (Stop, Esc, `tavi abort`): ABORTED for anything else that
  // stops one, such as an owner shutting down. The reason the turn's signal carries, and the
  // error of an outcome whose status is `stopped`: unlike `cancelled`, a stopped chat goes on.
  "STOPPED",
  "UNSUPPORTED",
  "QUOTA_EXCEEDED",
  // A send/request past its deadline (agent-communication delivery rules).
  "DELIVERY_EXPIRED",
  // Delivery to a closed/cancelled task; reopening or a follow-up task is explicit.
  "MAILBOX_CLOSED",
  "INTERNAL",
] as const;

/** What a stopped turn says, in the transcript and the chats list's words. Its code stays in the trajectory. */
export function turnStoppedMessage(t: CoreT = coreEnglish): string {
  return t("turn.stopped.message");
}

/** `turnStoppedMessage` in English: what a stopped turn records (its final text and error), which the model reads too. */
export const TURN_STOPPED_MESSAGE = turnStoppedMessage();

export const TaviErrorCodeSchema = z.enum(TAVI_ERROR_CODES);
export type TaviErrorCode = z.infer<typeof TaviErrorCodeSchema>;

export const TaviErrorSchema = z.object({
  code: TaviErrorCodeSchema,
  message: z.string().max(2000),
  /** Safe structured detail. Must never contain credentials or secret values. */
  details: z.record(z.string(), z.unknown()).optional(),
});
export type TaviErrorData = z.infer<typeof TaviErrorSchema>;

export interface TaviErrorOptions {
  readonly details?: Record<string, unknown>;
  readonly cause?: unknown;
}

export class TaviError extends Error {
  readonly code: TaviErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: TaviErrorCode, message: string, options: TaviErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "TaviError";
    this.code = code;
    if (options.details !== undefined) this.details = options.details;
  }

  toData(): TaviErrorData {
    return this.details === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, details: this.details };
  }

  static from(error: unknown, fallbackCode: TaviErrorCode = "INTERNAL"): TaviError {
    if (error instanceof TaviError) return error;
    const message = errorMessage(error);
    return new TaviError(fallbackCode, message, { cause: error });
  }
}

/** The errors `refusedEarly` made: kept here, so no field a caller can set or copy marks an error as Tavi's own words. */
const OWN_WORDS = new WeakSet<TaviError>();

/**
 * A built-in tool's refusal whose message is Tavi's own words, raised before the tool reached anything outside (a
 * helper not built, a credential not set): a failed call it ends leaves the chat untainted (QA 1894). Never for an
 * error raised after a round-trip or a read, whose words may be what was read; it wraps no other error.
 */
export function refusedEarly(code: TaviErrorCode, message: string, details?: Record<string, unknown>): TaviError {
  const error = new TaviError(code, message, details === undefined ? {} : { details });
  OWN_WORDS.add(error);
  return error;
}

/** Whether `refusedEarly` made this error. */
export function isRefusedEarly(error: unknown): error is TaviError {
  return error instanceof TaviError && OWN_WORDS.has(error);
}
