import { z } from "zod";
import { errorMessage } from "./util.js";
import { coreEnglish, type CoreKey, type CoreT } from "./locales/core.js";
import { englishOf, renderTextRef, textRef, TextRefSchema, type TextRef, type TextRefParams } from "./text-ref.js";

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
  /**
   * The words of `message` by key, when they are Tavi's and a person reads them: a reader (the canvas) says them in
   * the workspace's language, and one that does not know the key shows `message`. Invalid, it is dropped rather
   * than failing the error it rides on.
   */
  i18n: TextRefSchema.optional().catch(undefined),
});
export type TaviErrorData = z.infer<typeof TaviErrorSchema>;

export interface TaviErrorOptions {
  readonly details?: Record<string, unknown>;
  readonly cause?: unknown;
  /** `message` by key: see `TaviErrorSchema.i18n`. `keyedError` sets it, with `message` as its English. */
  readonly i18n?: TextRef;
}

export class TaviError extends Error {
  readonly code: TaviErrorCode;
  readonly details?: Record<string, unknown>;
  readonly i18n?: TextRef;

  constructor(code: TaviErrorCode, message: string, options: TaviErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "TaviError";
    this.code = code;
    if (options.details !== undefined) this.details = options.details;
    if (options.i18n !== undefined) this.i18n = options.i18n;
  }

  toData(): TaviErrorData {
    return {
      code: this.code,
      message: this.message,
      ...(this.details === undefined ? {} : { details: this.details }),
      ...(this.i18n === undefined ? {} : { i18n: this.i18n }),
    };
  }

  static from(error: unknown, fallbackCode: TaviErrorCode = "INTERNAL"): TaviError {
    if (error instanceof TaviError) return error;
    const message = errorMessage(error);
    return new TaviError(fallbackCode, message, { cause: error });
  }
}

/**
 * An error a person reads, by key: its `message` is the key's English (`englishOf`), so the terminal, logs, JSON
 * output and the model read what they always did, and `i18n` lets the canvas say it in the workspace's language.
 * Data (a name, a path, a count) goes in `params`; a count inside a sentence is passed as text so English never
 * groups it.
 */
export function keyedError(
  code: TaviErrorCode,
  key: CoreKey,
  params?: TextRefParams,
  options: Omit<TaviErrorOptions, "i18n"> = {},
): TaviError {
  const ref = textRef(key, params);
  return new TaviError(code, englishOf(ref), { ...options, i18n: ref });
}

/**
 * An error as `t`'s reader is told it: a keyed error (a `TaviError`, or its data off the wire) in their language, its
 * English message when this build does not know its key, and any other error framed (`error.generic`, which adds
 * nothing in English) around its English message. For a person's surfaces (the canvas, `tavi chat`, a chat app's
 * reply); the CLI's stderr, logs and what the model reads keep `message`.
 */
export function errorTextIn(error: unknown, t: CoreT = coreEnglish): string {
  const said =
    error instanceof Error
      ? error
      : typeof error === "object" && error !== null
        ? (error as { message?: unknown; i18n?: unknown })
        : undefined;
  const message = typeof said?.message === "string" ? said.message : errorMessage(error);
  const i18n = said === undefined ? undefined : TextRefSchema.safeParse((said as { i18n?: unknown }).i18n);
  if (i18n?.success === true && i18n.data !== undefined) return renderTextRef(i18n.data, t) ?? message;
  return t("error.generic", { message });
}

/** A refusal's data (an IPC answer's `error`) thrown again as a `TaviError`, its key kept so a reader still says it in their language. */
export function taviErrorOf(error: { readonly code: string; readonly message: string; readonly i18n?: TextRef | undefined }): TaviError {
  return new TaviError(error.code as TaviErrorCode, error.message, error.i18n === undefined ? {} : { i18n: error.i18n });
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
