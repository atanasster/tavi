import { createInterface } from "node:readline/promises";
import { TaviError, displaySafe, type ApprovalScope } from "@tavi/contracts";

/**
 * A call's input as a terminal shows it: JSON (so a control character is an
 * escape, not an action), with what its strings would hide — a bidi override,
 * an invisible character — marked (`displaySafe`).
 */
export function shownInput(input: unknown, indent?: number): string {
  return displaySafe(
    JSON.stringify(input ?? null, (_key, value: unknown) => (typeof value === "string" ? displaySafe(value) : value), indent) ?? "null",
  );
}

/**
 * The foreground prompt's line: what the call is, its input, and the keys —
 * or, for a call the stream above just printed (`shown`), only its title.
 */
export function approvalQuery(summary: string, input: unknown, keys: string, shown = false): string {
  return shown ? `Approve ${displaySafe(summary)}? [${keys}] ` : `${displaySafe(summary)} ${shownInput(input)} [${keys}] `;
}

/**
 * Ask for approval on a terminal.
 *
 * A non-interactive caller never receives an implicit yes: nothing hangs on a
 * hidden prompt, and a missing TTY is never treated as approval.
 *
 * The call's offered scopes are keys too: `y` approves once, `s` for
 * the rest of this chat and `a` always where offered, anything else is no.
 */
export async function promptForApprovalScope(
  summary: string,
  input: unknown,
  scopes: readonly ApprovalScope[],
  io: {
    readonly isTty: boolean;
    readonly write: (chunk: string) => void;
    readonly signal?: AbortSignal;
    /** The call's `[approval]` line, with its input or diff, is already on the terminal: the question names it only. */
    readonly shown?: boolean;
  },
): Promise<{ readonly approved: boolean; readonly scope?: ApprovalScope }> {
  if (!io.isTty) {
    throw new TaviError(
      "APPROVAL_REQUIRED",
      "Approval is required but this invocation is not interactive; re-run with --approval approve or --approval deny",
      { details: { summary, input } },
    );
  }
  const keys = ["y", ...(scopes.includes("session") ? ["s"] : []), ...(scopes.includes("always") ? ["a"] : []), "N"].join("/");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const query = approvalQuery(summary, input, keys, io.shown === true);
    const answer = (await (io.signal === undefined ? rl.question(query) : rl.question(query, { signal: io.signal }))).trim().toLowerCase();
    if (answer === "s" && scopes.includes("session")) return { approved: true, scope: "session" };
    if (answer === "a" && scopes.includes("always")) return { approved: true, scope: "always" };
    return { approved: /^y(es)?$/.test(answer) };
  } finally {
    rl.close();
  }
}
