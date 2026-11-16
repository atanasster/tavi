import type { CenterSummaryAnswer, TaskChannelKind, TaskListRow, TaskOrigin } from "@tavi/contracts";
import { plural } from "@tavi/contracts/util";

/**
 * The Command Center's pure reads: what a task's row says about where it
 * came from and where it stands, and what the rail counts (its days and times
 * are `lib/time.ts`'s). Kept free of React so each is asserted on its own.
 */

// ---- Rows ------------------------------------------------------------------

/**
 * Where a task came from, as a reader names it:
 * the row's `channel`, which the owner reads from the task's chat connection,
 * routine run, reminder or schedule. An older owner sends no channel, so its
 * origin stands in for it; a task with neither is Other.
 */
export type SourceKind = TaskChannelKind | "other";

/**
 * Every source's chip name, in the order the filter chips are shown. A
 * messaging task's source is its channel's provider id,
 * named by the channel's descriptor (`sourceLabel`), never here.
 */
export const SOURCE_LABELS: Readonly<Record<string, string>> = {
  web: "Web",
  terminal: "Terminal",
  messaging: "Messaging",
  routine: "Routine",
  reminder: "Reminder",
  schedule: "Schedule",
  agent: "Agent",
  other: "Other",
};

const ORIGIN_SOURCES: Readonly<Record<TaskOrigin, SourceKind>> = {
  cli: "terminal",
  ipc: "terminal",
  web: "web",
  messaging: "messaging",
  schedule: "schedule",
  agent: "agent",
  reminder: "reminder",
  // Never listed (principle 9); named for a row that reaches here anyway.
  heartbeat: "other",
  ideas: "other",
};

/** A source's chip name: its own, its channel's (by `channelLabel`), or else its id, capitalized. */
export function sourceLabel(kind: SourceKind, channelLabel?: (providerId: string) => string | undefined): string {
  return SOURCE_LABELS[kind] ?? channelLabel?.(kind) ?? `${kind.charAt(0).toUpperCase()}${kind.slice(1)}`;
}

/** The source a row's chip and filter use. */
export function sourceOf(row: Pick<TaskListRow, "origin" | "channel">): SourceKind {
  if (row.channel !== undefined) return row.channel.kind;
  return row.origin === null ? "other" : (ORIGIN_SOURCES[row.origin] ?? "other");
}

/**
 * A row's source chip: "Routine: Morning news" and "Schedule: Backup" name
 * what ran them; the other kinds are named alone, with their label (the
 * connection, the reminder's text) left for the chip's tooltip.
 */
export function sourceChip(
  row: Pick<TaskListRow, "origin" | "channel">,
  channelLabel?: (providerId: string) => string | undefined,
): { readonly kind: SourceKind; readonly text: string; readonly title?: string } {
  const kind = sourceOf(row);
  const label = row.channel?.label;
  const text = sourceLabel(kind, channelLabel);
  if (label === undefined) return { kind, text };
  if (kind === "routine" || kind === "schedule") return { kind, text: `${text}: ${label}`, title: label };
  return { kind, text, title: label };
}

/** "2 follow-ups": how many prompts a task was sent after its first, or nothing for none. */
export function followUpsLabel(count: number | undefined): string | undefined {
  if (count === undefined || count <= 0) return undefined;
  return plural(count, "follow-up");
}

/** Where a task stands, as its row marks it. */
export type RowMark = "done" | "working" | "needs" | "failed" | "stopped" | "cancelled" | "unknown";

export const ROW_MARK_LABELS: Readonly<Record<RowMark, string>> = {
  done: "Done",
  working: "Working",
  needs: "Needs you",
  failed: "Failed",
  stopped: "Stopped",
  cancelled: "Cancelled",
  unknown: "Unknown",
};

/**
 * A row's mark. Waiting on the reader wins over everything else, including a
 * need hoisted from a delegated worker: that is what the reader acts on.
 */
export function rowMark(row: Pick<TaskListRow, "status" | "needs" | "descendantNeeds">): RowMark {
  if (row.needs.length > 0 || (row.descendantNeeds?.length ?? 0) > 0 || row.status === "input-required") return "needs";
  switch (row.status) {
    case "submitted":
    case "working":
      return "working";
    case "completed":
    case "idle":
      return "done";
    case "failed":
      return "failed";
    case "stopped":
      return "stopped";
    case "canceled":
      return "cancelled";
    default:
      return "unknown";
  }
}

/**
 * A row's one-line detail as plain text: an answer's start is Markdown, and a
 * line of `truncate` text shows its fences, marks and link targets as they are.
 * Fences go, a code block's body stays; headings, quotes and list markers
 * lose their marks; emphasis and inline code keep their words; a link keeps its
 * text; the rest folds onto one line.
 */
export function previewText(text: string): string {
  return (
    text
      // A fence and its language go wherever they sit (a summary may hold one mid-line).
      .replace(/(```|~~~)[\w+-]*/g, "")
      .split("\n")
      .map((line) => line.replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/, ""))
      .join(" ")
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
      // Odd parts are inline code: their words stay as written, `__init__` included.
      .split(/`([^`]+)`/)
      // Emphasis not inside a word, so `snake_case` and `2*3*4` keep theirs.
      .map((part, index) => (index % 2 === 1 ? part : part.replace(/(^|\W)(\*\*|__|\*|_|~~)(\S(?:.*?\S)?)\2(?=\W|$)/g, "$1$3")))
      .join("")
      .replace(/\s+/g, " ")
      .trim()
  );
}

/** What a row is called: its title, else the start of its prompt, else its id. */
export function rowTitle(row: Pick<TaskListRow, "title" | "promptPreview" | "taskId">): string {
  return row.title || row.promptPreview || UNTITLED_CHAT;
}

/** A chat with no title and no prompt to name it by: never its task id, which says nothing to a person. */
export const UNTITLED_CHAT = "Untitled chat";

// ---- People ----------------------------------------------------------------

/** Whether the summary names more than one person: only then is a row's person said. */
export function manyPeople(people: Readonly<Record<string, string>> | undefined): boolean {
  return people !== undefined && Object.keys(people).length > 1;
}

/** A person as a row names them: their name, else their id; nothing while only one person is named. */
export function personName(people: Readonly<Record<string, string>>, principalId: string | undefined): string | undefined {
  return manyPeople(people) && principalId !== undefined ? (people[principalId] ?? principalId) : undefined;
}

// ---- The summary -----------------------------------------------------------

/** Everything waiting on the reader, fired reminders not yet seen included: the Center tab's badge and the rail's first block. */
export function waitingCount(summary: CenterSummaryAnswer | undefined): number {
  if (summary === undefined) return 0;
  const { approvals, reviews, questions, handoffs, connects, memoryProposals, unseenReminders } = summary.counts;
  return approvals + reviews + questions + (handoffs ?? 0) + (connects ?? 0) + memoryProposals + (unseenReminders ?? 0);
}

/** Tasks asked on the summary's today. */
export function tasksToday(summary: CenterSummaryAnswer): number {
  return summary.perDay.find((day) => day.date === summary.today)?.tasks ?? 0;
}

/** Tasks asked across the summary's whole window. */
export function tasksInWindow(summary: CenterSummaryAnswer): number {
  return summary.perDay.reduce((sum, day) => sum + day.tasks, 0);
}

/** Decisions waiting in tasks: the Approvals section's count. */
export function decisionCount(summary: CenterSummaryAnswer | undefined): number {
  if (summary === undefined) return 0;
  // The Approvals section's own: a browser handoff is Browser's, and counted only as waiting.
  const { approvals, reviews, questions } = summary.counts;
  return approvals + reviews + questions;
}
