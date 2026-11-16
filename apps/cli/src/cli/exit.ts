/** The CLI's exit codes (`EXIT`) and the one way a command reports a failure or an owner's refusal and picks its exit code. */
import { TaviError } from "@tavi/contracts";
import { terminalText } from "../shared/terminal-text.js";
import { emitError, type ErrorSink } from "./output.js";

/** Exit codes are part of the CLI contract. */
export const EXIT = {
  ok: 0,
  taskFailed: 1,
  usage: 2,
  approvalRequired: 3,
  unavailable: 4,
  /** Another process owns the data directory; a designed refusal, not a crash. */
  alreadyOwned: 5,
  /** A turn produced one or more `pending`-review artifacts; use `tavi artifacts approve|reject`, never an implicit decision here. */
  reviewRequired: 6,
  /** The task is suspended on `agents.wait` — a correlated reply, a worker's completion, or its own deadline resolves it, never an operator decision made here. */
  taskWaiting: 7,
  /**
   * Nothing was there to resume or decide — distinct from `ok` so a caller can
   * tell "nothing to do" apart from "done". Consumers:
   *
   * - `tavi approvals approve|reject` when the task has no decidable approval —
   *   it is not waiting, is cancelled, is waiting on something else, the named
   *   `--call` is not the one, or its round was already decided by a resume that
   *   never committed. Nothing was written.
   * - `tavi artifacts approve|reject --resume` when the artifact has no
   *   associated task (`runId === null`), or its task has no decidable
   *   review. The **artifact decision was written**; only the resume was not.
   * - `tavi abort` when the task has no running turn (`NOT_RUNNING`), or no
   *   owner is serving the directory. Nothing was signalled.
   */
  resumeNotApplicable: 8,
  internal: 70,
  /**
   * An attached `tavi run` (or `--attach`) detached on Ctrl-C: the run belongs
   * to the owner and continues. 128 + SIGINT, as a shell reports an interrupt,
   * and distinct from every outcome code — nothing about the run is known.
   */
  detached: 130,
  /**
   * The same detach on SIGTERM — a supervisor or a CI timeout stopping the CLI,
   * not an operator — so a script can tell the two apart. 128 + SIGTERM.
   */
  terminated: 143,
} as const;

/**
 * Another process holds the data directory: the designed single-owner refusal.
 *
 * Recognised by its words, so an ownership refusal must say "already owns" or
 * "already owned by another process" to keep its exit code (5).
 *
 * Both the ownership layer's wording ("already owned by another process") and
 * the commands' own ("already owns") are recognised, since either can be the
 * one the operator sees.
 */
export function isOwnershipContention(error: { readonly message: string }): boolean {
  return /already own(s|ed by another process)/.test(error.message);
}

/**
 * The process-wide failure report: `<prefix>: <code>: <message>` (an ownership
 * refusal without its code), and the exit its code maps to.
 */
export function reportFailure(error: unknown, io: ErrorSink, prefix: string): number {
  const taviError = TaviError.from(error);
  // Another owner is a refusal the reader acts on, worded for them: its message alone, without the code.
  const owned = taviError.code === "CONFLICT" && isOwnershipContention(taviError);
  io.stderr(owned ? `${prefix}: ${taviError.message}\n` : `${prefix}: ${taviError.code}: ${taviError.message}\n`);
  if (taviError.code === "NOT_AUTHORIZED" || taviError.code === "UNAVAILABLE") {
    return EXIT.unavailable;
  }
  // Ownership contention is the designed single-owner refusal, so it gets its own
  // exit code rather than being indistinguishable from a crash.
  if (taviError.code === "CONFLICT" || isOwnershipContention(taviError)) {
    return EXIT.alreadyOwned;
  }
  return EXIT.internal;
}

/**
 * Failure mapping for the operator-typed registry commands (`agents`,
 * `projects`, `schedules`).
 *
 * `reportFailure` is the process-wide default and is right for a runtime
 * failure: it treats any `CONFLICT` as ownership contention and any
 * `INVALID_INPUT` as internal. Both are wrong for a command whose input is typed
 * by a human — "you already have a project called acme" is not "another process
 * owns the data directory", and a malformed `--ga4` is not a crash. Ownership
 * contention keeps its own code; everything else the caller can fix exits as a
 * usage error.
 */
export function reportCommandFailure(error: unknown, io: ErrorSink, prefix: string): number {
  const taviError = TaviError.from(error);
  if (taviError.code === "CONFLICT" && isOwnershipContention(taviError)) return reportFailure(error, io, prefix);
  if (taviError.code === "INVALID_INPUT" || taviError.code === "CONFLICT") {
    io.stderr(`${prefix}: ${taviError.code}: ${taviError.message}\n`);
    return EXIT.usage;
  }
  return reportFailure(error, io, prefix);
}

/**
 * Failure mapping for a configuration command that opens the directory itself
 * (`models`, `memory`, `skills`, `bindings`, `artifacts`).
 *
 * A refusal the operator can act on prints its message alone: the codes in
 * `usage` (and a `CONFLICT` with stored configuration, since exit 5 means
 * "another owner") exit as usage errors, those in `unavailable` as a missing
 * resource. Ownership contention keeps its own exit code, and anything else is
 * reported as `reportFailure` does.
 */
export function reportRefusal(
  error: unknown,
  io: ErrorSink,
  prefix: string,
  codes: { readonly usage: readonly string[]; readonly unavailable?: readonly string[] },
): number {
  const failure = TaviError.from(error);
  if (failure.code === "CONFLICT" && isOwnershipContention(failure)) return reportFailure(error, io, prefix);
  if (failure.code === "CONFLICT" || codes.usage.includes(failure.code)) {
    emitError(io, failure.message);
    return EXIT.usage;
  }
  if (codes.unavailable?.includes(failure.code) === true) {
    emitError(io, failure.message);
    return EXIT.unavailable;
  }
  return reportFailure(error, io, prefix);
}

/**
 * Print an owner's refusal (an answer's `error`, or a caught `TaviError`) as one line made safe for
 * a terminal, and exit as the same refusal offline does. `fallback` is the line when it carries no message.
 */
export function refusalExit(
  io: ErrorSink,
  refusal: { readonly message?: string; readonly code?: string } | undefined,
  fallback = "the owner refused",
): number {
  emitError(io, terminalText(refusal?.message ?? fallback));
  return configRefusalExit(refusal?.code);
}

/** The exit a configuration refusal maps to — the offline commands' for the same refusal. */
export function configRefusalExit(code: string | undefined): number {
  switch (code) {
    // A malformed request, a conflict with stored configuration, an action the
    // owner does not implement: usage-level refusals, as offline.
    case "INVALID_INPUT":
    case "CONFLICT":
    case "UNSUPPORTED":
      return EXIT.usage;
    case "INTERNAL":
      return EXIT.internal;
    default:
      // Not found, not configured, not authorized, unavailable.
      return EXIT.unavailable;
  }
}

/**
 * The exit an owner's refusal of an attached command maps to. Attached and
 * unattached runs must agree on the exit code for the same refusal, or a script
 * cannot treat the two paths alike.
 */
export function ownerRefusalExit(code: string | undefined): number {
  switch (code) {
    case "NOT_FOUND":
      return EXIT.unavailable;
    case "INVALID_INPUT":
      return EXIT.usage;
    default:
      return EXIT.taskFailed;
  }
}
