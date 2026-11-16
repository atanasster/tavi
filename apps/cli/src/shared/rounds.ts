import type { RoundDecidability } from "@tavi/contracts";

/**
 * How a front end words a round it may not decide.
 *
 * The offline `approvals approve|reject`, `artifacts approve|reject --resume`
 * and the chat approval all gate on `decidableRound`; the wording lives here so
 * the three cannot drift into describing one state three ways.
 */
export function undecidableRoundMessage(
  taskId: string,
  result: Exclude<RoundDecidability, { readonly decidable: true }>,
  wanted: "approval" | "review",
): string {
  switch (result.reason) {
    case "cancelled":
      return `task ${taskId} is cancelled; nothing to decide`;
    case "not-waiting":
      return `task ${taskId} is ${result.status}, not waiting on ${wanted === "approval" ? "an approval" : "a review"}; nothing to decide`;
    case "no-round":
      return `task ${taskId} has no pending ${wanted}; nothing to decide`;
    case "settled-uncommitted":
      return (
        `round ${result.round.steps} of task ${taskId} was already decided by a resume that never ` +
        "committed its outcome; it is not decided again here — see `tavi tasks`, and `tavi recover` if its execution died"
      );
  }
}

/**
 * Why naming one call cannot decide this round, or nothing.
 *
 * The workflow requires a decision for every call of a round, so `--call` (or a
 * row id) only asserts that the call named *is* the whole round. `multi-call` is
 * a usage error; `wrong-call` means there is nothing pending for that call.
 */
export function singleCallProblem(
  taskId: string,
  callIds: readonly string[],
  callId: string,
): { readonly kind: "multi-call" | "wrong-call"; readonly message: string } | undefined {
  if (callIds.length > 1) {
    return {
      kind: "multi-call",
      message:
        `task ${taskId} has ${callIds.length} pending approvals (${callIds.join(", ")}); decide them together — ` +
        "a partial decision would be rejected by the workflow and would fail the task",
    };
  }
  if (callIds[0] !== callId) return { kind: "wrong-call", message: `task ${taskId} has no pending approval for call ${callId}` };
  return undefined;
}

/** Why an operator may not decide a round a schedule's fire is still deciding. */
export function scheduleInFlightMessage(taskId: string, scheduleId: string): string {
  return `task ${taskId} is being decided by schedule ${scheduleId}'s fire, which is still in flight; its tool policy answers this round`;
}

/**
 * Why an artifact cannot be decided in this workspace, or nothing — the check
 * the offline `tavi artifacts approve|reject` and IPC `review` share. An
 * artifact id is globally unique, so without it `--workspace` would do nothing.
 */
export function artifactProblem(
  artifactId: string,
  artifact: { readonly workspaceId: string } | undefined,
  workspaceId: string,
): { readonly code: "NOT_FOUND" | "INVALID_INPUT"; readonly message: string } | undefined {
  if (artifact === undefined) return { code: "NOT_FOUND", message: `No artifact ${artifactId}` };
  if (artifact.workspaceId !== workspaceId) {
    return { code: "INVALID_INPUT", message: `Artifact ${artifactId} belongs to workspace ${artifact.workspaceId}, not ${workspaceId}` };
  }
  return undefined;
}

// The owner lists a round's calls; `@tavi/client` reads them (shared with the web canvas).
export { roundCallIds } from "@tavi/client";
