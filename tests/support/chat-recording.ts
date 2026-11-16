/**
 * A recorded run as `tavi run --format json` writes it, for replaying through
 * `tavi chat --replay`: `run.started`, `deltas` text deltas with a
 * newline every `lineEvery`, then `task.completed`. Built as text, so the
 * gate needs nothing from the workspace's source; its `protocolVersion` is
 * `CLIENT_PROTOCOL_VERSION`'s, and a bump fails the replay by name. Its twin,
 * built from the schema, is `recordedEvents` in `apps/cli/test/tui/chat-command.test.ts`.
 */
export function chatRecording(deltas: number, lineEvery: number): string {
  const base = { protocolVersion: 8, epoch: "epoch-0", runId: "task-1", at: "2026-09-19T00:00:00.000Z" };
  const lines = [
    JSON.stringify({ ...base, sequence: 0, attemptId: "attempt-0", kind: "run.started", threadId: "thread-1", workspaceId: "default" }),
  ];
  for (let index = 1; index <= deltas; index += 1) {
    const text = index % lineEvery === 0 ? `w${index}\n` : `w${index} `;
    lines.push(JSON.stringify({ ...base, sequence: index, attemptId: "attempt-1", kind: "text.delta", blockId: "b", text }));
  }
  lines.push(JSON.stringify({ ...base, sequence: deltas + 1, attemptId: "attempt-1", kind: "task.completed", finalText: "…" }));
  return `${lines.join("\n")}\n`;
}
