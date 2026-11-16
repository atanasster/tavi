import {
  AgendaAnswerSchema,
  CENTER_WATCH_DEFAULT_TIMEOUT_MS,
  CenterSummaryAnswerSchema,
  CenterWatchAnswerSchema,
  TaskListResultSchema,
  TaskPromptsResultSchema,
  type AgendaAnswer,
  type CenterSummaryAnswer,
  type CenterWatchAnswer,
  type TaskChannelKind,
  type TaskListResult,
  type TaskPromptsResult,
} from "@tavi/contracts";

import { read, type Outcome, type SettingsClient } from "../../lib/ipc.js";

/**
 * The canvas's side of the owner's `center` command and the Activity list.
 * An answer the page cannot read is a
 * failed outcome here, never a value a view renders and trips over.
 */

/** Tasks per page of Activity: the list's default, one screen or two. */
const ACTIVITY_PAGE_SIZE = 50;

/**
 * A watch's own deadline is the owner's to keep: the request's is above it by
 * a margin, so a quiet poll answers "nothing changed" rather than timing out.
 */
const WATCH_REQUEST_TIMEOUT_MS = CENTER_WATCH_DEFAULT_TIMEOUT_MS + 10_000;

/** The first paint: counts, the day strip, the rail and the feed's cursor. */
export function loadSummary(client: SettingsClient, workspaceId: string): Promise<Outcome<CenterSummaryAnswer>> {
  return read(client, "center", { action: "summary", workspaceId }, CenterSummaryAnswerSchema);
}

/** One long poll: what changed since `cursor`, or nothing once the owner's wait runs out. */
export function watchCenter(client: SettingsClient, workspaceId: string, cursor: string): Promise<Outcome<CenterWatchAnswer>> {
  return read(
    client,
    "center",
    { action: "watch", workspaceId, cursor, timeoutMs: CENTER_WATCH_DEFAULT_TIMEOUT_MS },
    CenterWatchAnswerSchema,
    { timeoutMs: WATCH_REQUEST_TIMEOUT_MS },
  );
}

/** What Activity asks the owner for beyond a page: the search, one person, one source, and a day to list back from. */
export interface ActivityFilters {
  readonly query?: string | undefined;
  /** Tasks this person started only. */
  readonly principalId?: string | undefined;
  /** Tasks whose channel is one of these kinds. */
  readonly channelKinds?: readonly TaskChannelKind[] | undefined;
  /** Tasks asked at or before this instant: a day strip's day and older. */
  readonly until?: string | undefined;
}

/** One page of Activity: top-level tasks by the day they were asked, newest first. */
export function listActivity(
  client: SettingsClient,
  workspaceId: string,
  options: ActivityFilters & { readonly cursor?: string | undefined },
): Promise<Outcome<TaskListResult>> {
  const query = options.query?.trim();
  return read(
    client,
    "tasks",
    {
      action: "list",
      workspaceId,
      order: "created",
      limit: ACTIVITY_PAGE_SIZE,
      ...(query ? { query } : {}),
      ...(options.principalId === undefined ? {} : { principalId: options.principalId }),
      ...(options.channelKinds === undefined || options.channelKinds.length === 0 ? {} : { channelKinds: [...options.channelKinds] }),
      ...(options.until === undefined ? {} : { until: options.until }),
      ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
    },
    TaskListResultSchema,
  );
}

/** A task's follow-up prompts, oldest first: what a row's "2 follow-ups" line expands to (`tasks prompts`). */
export function loadTaskPrompts(client: SettingsClient, workspaceId: string, taskId: string): Promise<Outcome<TaskPromptsResult>> {
  return read(client, "tasks", { action: "prompts", workspaceId, taskId }, TaskPromptsResultSchema);
}

/** Schedule's Coming up: every occurrence in the next seven days, in the workspace zone (`schedules agenda`). */
export function loadAgenda(client: SettingsClient, workspaceId: string): Promise<Outcome<AgendaAnswer>> {
  return read(client, "schedules", { action: "agenda", workspaceId }, AgendaAnswerSchema);
}
