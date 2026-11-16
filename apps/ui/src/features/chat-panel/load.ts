import type { Session } from "../shell/shell.js";

/**
 * What changes when the chat's records may have: a turn's status, or a tool
 * call finishing (an artifact archived, a browser session opened or closed, a
 * task delegated). Streamed text does not change it, so the panel's reads are
 * not repeated per token.
 */
export function chatVersion(session: Session): string {
  return session.runs
    .map(
      (run) =>
        `${run.id}:${run.run.status}:${run.run.transcript.filter((entry) => entry.kind === "tool" && entry.status !== "running").length}`,
    )
    .join("|");
}

/** What changes when a turn of the chat starts or ends: coarser than `chatVersion`, for reads too costly to repeat per tool call. */
export function turnVersion(session: Session): string {
  return session.runs.map((run) => `${run.id}:${run.run.status}`).join("|");
}
