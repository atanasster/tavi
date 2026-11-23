import type { ToolCard, TranscriptEntry } from "@tavi/client/browser";
import type { Idea, TaskListRow } from "@tavi/contracts";

/** The rows the canvas's view tests show, each built from the few fields a test sets. */

/** The ideas' clock: when every idea `idea` builds was made. */
export const IDEA_AT = "2026-10-19T10:00:00.000Z";

/** An active idea for `key` (its category the key's first part), with `overrides`. */
export const idea = (key: string, overrides: Partial<Idea> = {}): Idea => ({
  id: `id-${key}`,
  workspaceId: "default",
  runId: "run-1",
  providerId: "tavi.ideasagent",
  key,
  category: key.split(".")[0] as Idea["category"],
  icon: "💡",
  title: `I can help with ${key}`,
  pitch: `A pitch for ${key}.`,
  label: key,
  prompt: `Help me with ${key}.`,
  basis: [{ kind: "general", ref: "general" }],
  uses: [{ capability: "web", approval: false }],
  score: 0.5,
  status: "active",
  pinned: false,
  shownRuns: 0,
  createdAt: IDEA_AT,
  updatedAt: IDEA_AT,
  expiresAt: "2026-11-19T10:00:00.000Z",
  ...overrides,
});

/** A settled web chat in the sidebar's list, titled `title`, with `extra`. */
export const taskRow = (taskId: string, title: string, extra: Partial<TaskListRow> = {}): TaskListRow => ({
  taskId,
  workspaceId: "default",
  status: "completed",
  origin: "web",
  title,
  createdAt: "2026-10-04T08:00:00Z",
  updatedAt: "2026-10-04T09:00:00Z",
  needs: [],
  counts: { admissions: 1, tools: null },
  ...extra,
});

/** A completed `sandbox.run` card in a transcript, on call `callId`, with `over`. */
export const toolCard = (callId: string, over: Partial<ToolCard> = {}): ToolCard => ({
  kind: "tool",
  key: callId,
  attemptId: "a",
  callId,
  toolName: "sandbox.run",
  status: "completed",
  ...over,
});

/** A transcript's text block `key`, saying `body`. */
export const textEntry = (key: string, body: string): TranscriptEntry => ({ kind: "text", key, attemptId: "a", blockId: key, text: body });
