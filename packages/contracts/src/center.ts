import type { AsyncRepository } from "./persistence-types.js";
import { z } from "zod";

import { AppRepairSchema } from "./connected-apps.js";
import { IdSchema, TimestampSchema } from "./ids.js";
import { MCP_NOTICE_KINDS } from "./mcp-store.js";
import { LocaleSchema } from "./workspace-settings.js";
import type { AgendaInput, AgendaResult } from "./agenda.js";
import type { MemoryScope } from "./memory.js";

/**
 * The Command Center's owner command: one call for
 * the first paint (`summary`) and a long-poll change feed (`watch`) that tells
 * a page which sections to fetch again.
 *
 * Both read workspace-wide aggregates only — counts, dates, ids and names —
 * never a prompt, a tool payload or a memory body.
 */

/**
 * What `watch` reports as changed. Coarse on purpose: a kind names a section
 * to refetch, not the rows that changed. A kind is added here with counter
 * triggers on its tables in the runtime (`browser`: browser history; `plugin`:
 * plugin settings and versions, owner-wide, and a workspace's
 * `uiRoles`/`uiPlacements`, so every open page re-reads its UI plugins;
 * `settings`: every write of a workspace's settings, so an open page re-reads
 * the summary and with it the workspace's language).
 */
export const CENTER_CHANGE_KINDS = [
  "task",
  "approval",
  "review",
  "question",
  "routine",
  "schedule",
  "memory",
  "skill",
  "reminder",
  "browser",
  "plugin",
  "settings",
] as const;

/** The counter scope of an owner-wide change (plugins are installed and enabled for the whole owner). */
export const CENTER_GLOBAL_SCOPE = "*";
export const CenterChangeKindSchema = z.enum(CENTER_CHANGE_KINDS);
export type CenterChangeKind = (typeof CENTER_CHANGE_KINDS)[number];

export const CENTER_SUMMARY_DEFAULT_DAYS = 14;
export const CENTER_SUMMARY_MAX_DAYS = 31;
/** Items in the "Coming up" rail. */
export const CENTER_NEXT_LIMIT = 3;
/** The most connections a summary asks to be reconnected. */
export const CENTER_RECONNECT_LIMIT = 20;
/** The most MCP server notices a summary lists. */
export const CENTER_SERVERS_LIMIT = 20;
/** The most app repairs a summary lists. */
export const CENTER_APPS_LIMIT = 20;
/** People named in one summary; a workspace with more shows the rest by id. */
export const CENTER_PEOPLE_LIMIT = 200;

/**
 * A watch waits at most this long before answering "nothing changed". Below
 * the canvas's 30-second request timeout, so a quiet poll is an answer, not a
 * `TIMEOUT` the page would report.
 */
export const CENTER_WATCH_DEFAULT_TIMEOUT_MS = 20_000;
export const CENTER_WATCH_MIN_TIMEOUT_MS = 1_000;
export const CENTER_WATCH_MAX_TIMEOUT_MS = 25_000;
/**
 * The least time between two fingerprint reads of a waiting watch. The owner
 * reads again when its store reports a write, so a change shows at once; with
 * no write signal, this is how often it reads.
 */
export const CENTER_WATCH_INTERVAL_MS = 1_000;

/** Opaque: only the owner interprets it. Base64url, like the task list's cursor. */
export const CenterCursorSchema = z
  .string()
  .min(1)
  .max(2048)
  .regex(/^[A-Za-z0-9_-]+$/);

const CenterDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const CenterPayloadSchema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("summary"),
    workspaceId: IdSchema.optional(),
    /** Days in `perDay`, ending today. Absent: `CENTER_SUMMARY_DEFAULT_DAYS`. */
    days: z.number().int().min(1).max(CENTER_SUMMARY_MAX_DAYS).optional(),
  }),
  z.strictObject({
    action: z.literal("watch"),
    workspaceId: IdSchema.optional(),
    /** Absent: answer at once with the current cursor, which a page takes from `summary` anyway. */
    cursor: CenterCursorSchema.optional(),
    /** Absent: `CENTER_WATCH_DEFAULT_TIMEOUT_MS`. */
    timeoutMs: z.number().int().min(CENTER_WATCH_MIN_TIMEOUT_MS).max(CENTER_WATCH_MAX_TIMEOUT_MS).optional(),
  }),
]);
export type CenterPayload = z.infer<typeof CenterPayloadSchema>;

const count = z.number().int().nonnegative();

/**
 * The `summary` answer.
 *
 * `today` and every `perDay` date are calendar days in `timezone`, the
 * workspace zone (the owner host's while none is set), so Telegram and the web
 * agree on what today is. `perDay` holds exactly the requested number of days,
 * oldest first, zero-filled, and counts top-level tasks by the day they were
 * created; delegation workers are counted with nothing.
 */
export const CenterSummaryAnswerSchema = z.strictObject({
  workspaceId: IdSchema,
  timezone: z.string().min(1).max(64),
  /**
   * The workspace's language (`workspace.locale`), so the canvas speaks it from
   * its first screen. Set by the owner, not the repository; optional so a page
   * reads an owner from before languages.
   */
  locale: LocaleSchema.optional(),
  today: CenterDateSchema,
  counts: z.strictObject({
    /** Tasks waiting on each kind of decision themselves; a need hoisted from a worker is counted on the worker only. */
    approvals: count,
    reviews: count,
    questions: count,
    /** Tasks waiting for a person to act in their browser. Optional so a page reads an owner from before handoffs. */
    handoffs: count.optional(),
    /** Tasks waiting for an app to be connected. Optional so a page reads an owner from before them. */
    connects: count.optional(),
    /** Top-level tasks admitted or running. */
    runningTasks: count,
    /** Proposed memory the workspace's operator may review: their personal scopes and the workspace's shared one. */
    memoryProposals: count,
    activeRoutines: count,
    /** Enabled schedules that no routine owns. */
    schedules: count,
    /**
     * Active reminders, everyone's. Optional only so a page reads an owner
     * from before reminders; this build always sends it.
     */
    reminders: count.optional(),
    /** Reminder fires delivered in the app that nobody has acknowledged yet (the rail's "waiting on you"). */
    unseenReminders: count.optional(),
    /** Browser sessions open now (the Browser nav count). Optional so a page reads an owner from before browser history. */
    liveBrowserSessions: count.optional(),
  }),
  perDay: z
    .array(z.strictObject({ date: CenterDateSchema, tasks: count }))
    .min(1)
    .max(CENTER_SUMMARY_MAX_DAYS),
  /**
   * The head of `schedules agenda` from now (overdue fires the scheduler still
   * owes, then up to `AGENDA_MAX_DAYS` ahead), filled up with the earliest
   * stored fires beyond that; a routine's trigger is reported as its routine.
   */
  next: z
    .array(
      z.strictObject({
        kind: z.enum(["routine", "schedule", "reminder"]),
        /** The routine's id for `routine`, the schedule's for `schedule`, the reminder's for `reminder`. */
        id: IdSchema,
        title: z.string().min(1).max(256),
        at: TimestampSchema,
      }),
    )
    .max(CENTER_NEXT_LIMIT),
  /**
   * The workspace's OAuth connections whose sign-in lapsed or asks for more
   * than was granted: each a "Reconnect" the operator is
   * asked for. Optional so a page reads an owner from before them.
   */
  reconnect: z
    .array(
      z.strictObject({
        connectionId: IdSchema,
        providerId: z.string().min(1).max(48),
        label: z.string().min(1).max(80).optional(),
        authState: z.enum(["expired", "needs-consent"]),
      }),
    )
    .max(CENTER_RECONNECT_LIMIT)
    .optional(),
  /**
   * MCP servers that need the operator: each server's open
   * notices, owner-wide, newest first — the *Servers* group. Optional so a page reads an owner from before them.
   */
  servers: z
    .array(
      z.strictObject({
        pluginId: z.string().min(1).max(64),
        kind: z.enum(MCP_NOTICE_KINDS),
        updatedAt: TimestampSchema,
      }),
    )
    .max(CENTER_SERVERS_LIMIT)
    .optional(),
  /**
   * Connected apps that need the operator: each app's repairs,
   * channels and MCP servers alike, worst first. When present, a page shows these in place of
   * `reconnect` and `servers`, which stay for pages from before them.
   */
  apps: z
    .array(AppRepairSchema.extend({ appId: z.string().min(1).max(128), appName: z.string().min(1).max(80) }))
    .max(CENTER_APPS_LIMIT)
    .optional(),
  /**
   * The owner's own health: a warning for each of its resident memory, open
   * file descriptors and child processes that grew more than twofold over 6
   * hours and stayed there (a leak a restart clears). Absent while none did,
   * and from an owner from before the health watch.
   */
  health: z.array(z.string().min(1).max(400)).max(3).optional(),
  /** Display names of the people whose tasks fall in the window, by principal id. */
  people: z.record(IdSchema, z.string().min(1).max(256)),
  /** The watch cursor as of this summary, so the page's first `watch` misses nothing after it. */
  cursor: CenterCursorSchema,
});
export type CenterSummaryAnswer = z.infer<typeof CenterSummaryAnswerSchema>;

/** The `watch` answer: `changed` is empty when the wait ran out, and the cursor is then the one sent. */
export const CenterWatchAnswerSchema = z.strictObject({
  cursor: CenterCursorSchema,
  changed: z.array(CenterChangeKindSchema).max(CENTER_CHANGE_KINDS.length),
});
export type CenterWatchAnswer = z.infer<typeof CenterWatchAnswerSchema>;

/**
 * Whose view the aggregates are: the workspace, and the operator principal
 * whose personal memory scopes count as reviewable.
 */
export const CenterScopeSchema = z.strictObject({ workspaceId: IdSchema, principalId: IdSchema });
export type CenterScope = z.infer<typeof CenterScopeSchema>;

export const CenterSummaryInputSchema = z.strictObject({
  workspaceId: IdSchema,
  principalId: IdSchema,
  /** The effective workspace zone, resolved by the caller. */
  timezone: z.string().min(1).max(64),
  days: z.number().int().min(1).max(CENTER_SUMMARY_MAX_DAYS),
  now: TimestampSchema,
  /**
   * The memory proposals the operator's page holds, counted by the memory
   * service (`MemoryServicePort.counts`): this repository reads no
   * memory table. Absent: 0.
   */
  memoryProposals: z.number().int().min(0).optional(),
});
export type CenterSummaryInput = z.infer<typeof CenterSummaryInputSchema>;

export const CenterChangesInputSchema = z.strictObject({
  workspaceId: IdSchema,
  principalId: IdSchema,
  cursor: CenterCursorSchema.optional(),
});
export type CenterChangesInput = z.infer<typeof CenterChangesInputSchema>;

/**
 * A routine that runs an agent under the instructions pinned in its revision
 * (`agents list`'s `pinnedBy`): editing the agent's persona does not change
 * what that routine runs.
 */
export interface AgentRoutinePin {
  readonly agentId: string;
  readonly routineId: string;
  readonly name: string;
}

/**
 * The Command Center's reads.
 *
 * `changes` is one comparison, not a wait: the owner repeats it when its
 * store reports a write (at most every `CENTER_WATCH_INTERVAL_MS`), so a long
 * poll never holds the persistence worker. A cursor from another workspace, or one that does not decode, is
 * `INVALID_INPUT`; a kind the cursor does not carry (an older build's) counts
 * as changed.
 */
interface CenterRepositoryPortDefinition {
  summary(input: CenterSummaryInput): CenterSummaryAnswer;
  changes(input: CenterChangesInput): CenterWatchAnswer;
  /**
   * Every occurrence of the workspace's enabled scheduled work in the window,
   * sorted by time and cut at `limit` (`schedules agenda`). `summary`'s `next`
   * is this list's head, so the two cannot disagree.
   */
  agenda(input: AgendaInput): AgendaResult;
  /**
   * The workspace's routines that may still run, each with the agent its
   * revision pins: the active revision, or the latest before one is active.
   */
  agentPins(input: { readonly workspaceId: string }): readonly AgentRoutinePin[];
  /**
   * Bump the memory kind for a scope's page: what an embedder's
   * `memoryOverride` calls after a write, since its records live outside the
   * tables whose triggers bump it for the built-in service. Personal scopes
   * bump the person's row, the shared scope its workspace's, and a chat's
   * own memory nothing, as the triggers do.
   */
  memoryChanged(input: { readonly scope: MemoryScope }): void;
}

export type CenterRepositoryPort = AsyncRepository<CenterRepositoryPortDefinition>;
