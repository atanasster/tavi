import type { CenterRepositoryPort } from "./internal-contracts.js";
import { z } from "zod";
import {
  AGENDA_MAX_DAYS,
  AgendaInputSchema,
  CENTER_CHANGE_KINDS,
  CENTER_GLOBAL_SCOPE,
  CENTER_NEXT_LIMIT,
  CENTER_PEOPLE_LIMIT,
  CenterChangesInputSchema,
  CenterSummaryAnswerSchema,
  CENTER_RECONNECT_LIMIT,
  CENTER_SERVERS_LIMIT,
  CenterSummaryInputSchema,
  TaviError,
  isValidTimeZone,
  MemoryScopeSchema,
  type AgendaInput,
  type AgendaResult,
  type AgentRoutinePin,
  type CenterChangeKind,
  type CenterChangesInput,
  type CenterScope,
  type CenterSummaryAnswer,
  type CenterSummaryInput,
  type CenterWatchAnswer,
  type MemoryScope,
  parseOrThrow,
} from "@tavi/contracts";

import type { Database } from "./sqlite-loader.js";
import { stmt } from "./statement-cache.js";
import { agendaItems, laterFires } from "./agenda.js";
import { FOLLOW_UP_SQL, IS_DELEGATION_WORKER, IS_PLUMBING_TASK } from "./task-list.js";
import { TASK_NEEDS_CTE } from "./task-needs.js";

/**
 * The counter rows a scope's page watches: the workspace's, and the
 * operator's own personal-memory row (the `*_center_*` triggers in `baseline-schema.ts`). A kind's
 * fingerprint is the sum of its versions there, so any write behind the kind
 * moves it.
 */
const VERSIONS_SQL = "SELECT kind, sum(version) AS version FROM tavi_center_versions WHERE scope IN (?, ?, ?) GROUP BY kind";

/**
 * The cursor: the workspace it belongs to and one short hash per kind. Kinds
 * are keyed by name rather than position, so a build that adds a kind reads
 * an older cursor as "that kind changed" and ignores a kind it does not know.
 */
const CursorSchema = z.strictObject({
  v: z.literal(1),
  workspaceId: z.string().min(1).max(128),
  kinds: z.record(z.string().max(32), z.string().max(64)),
});

function encodeCursor(workspaceId: string, kinds: Readonly<Record<CenterChangeKind, string>>): string {
  return Buffer.from(JSON.stringify({ v: 1, workspaceId, kinds })).toString("base64url");
}

function decodeCursor(cursor: string, workspaceId: string): Readonly<Record<string, string>> {
  let decoded: z.infer<typeof CursorSchema>;
  try {
    decoded = CursorSchema.parse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));
  } catch {
    throw new TaviError("INVALID_INPUT", "Invalid center cursor; take a new one from summary or an uncursored watch");
  }
  if (decoded.workspaceId !== workspaceId) {
    throw new TaviError("INVALID_INPUT", "The center cursor belongs to another workspace", { details: { workspaceId } });
  }
  return decoded.kinds;
}

/** `YYYY-MM-DD` for an instant, in `formatter`'s zone. */
function calendarDate(formatter: Intl.DateTimeFormat, instant: Date): string {
  const parts = Object.fromEntries(formatter.formatToParts(instant).map((part) => [part.type, part.value]));
  return `${parts["year"]}-${parts["month"]}-${parts["day"]}`;
}

/** The `days` calendar dates ending `today`, oldest first; calendar arithmetic, so a DST change cannot skip or repeat a day. */
function datesEnding(today: string, days: number): string[] {
  const [year, month, day] = today.split("-").map(Number) as [number, number, number];
  return Array.from({ length: days }, (_, index) =>
    new Date(Date.UTC(year, month - 1, day - (days - 1 - index))).toISOString().slice(0, 10),
  );
}

/**
 * The Command Center's reads.
 *
 * Everything is an aggregate over indexed workspace columns; nothing here
 * returns a prompt, a tool payload or a memory body. `changes` compares once
 * and returns, so the owner's long poll waits between calls rather than
 * holding the persistence worker.
 */
export class SqliteCenterRepository implements CenterRepositoryPort {
  readonly #db: () => Database;

  constructor(db: () => Database) {
    this.#db = db;
  }

  summary(input: CenterSummaryInput): CenterSummaryAnswer {
    const { workspaceId, principalId, timezone, days, now, memoryProposals } = parseOrThrow(
      CenterSummaryInputSchema,
      input,
      "The center summary request is not valid",
    );
    if (!isValidTimeZone(timezone)) {
      throw new TaviError("INVALID_INPUT", `${JSON.stringify(timezone)} is not an IANA time zone`);
    }
    const db = this.#db();
    const scope = { workspaceId, principalId };
    const formatter = new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" });
    const today = calendarDate(formatter, new Date(now));
    const dates = datesEnding(today, days);

    const needs = stmt(
      db,
      `WITH RECURSIVE ${TASK_NEEDS_CTE} SELECT need, count(DISTINCT task_id) AS n FROM needs WHERE workspace_id = ? AND via_child = 0 GROUP BY need`,
    ).all(workspaceId) as { need: "approval" | "review" | "question"; n: number }[];
    const need = (kind: string) => needs.find((row) => row.need === kind)?.n ?? 0;
    const scalar = (sql: string, ...params: readonly string[]) => (stmt(db, sql).get(...params) as { n: number }).n;

    // Read a day more than the window: the oldest local midnight is at most
    // `days` days and a DST hour before now, whatever the zone's offset.
    const since = new Date(new Date(now).getTime() - (days + 1) * 86_400_000).toISOString();
    // A day's work is its turns: a task started, or a chat taken up
    // again — a Home is one task however many days it is used.
    const created = stmt(
      db,
      `SELECT a.created_at, t.principal_id FROM tavi_admissions a JOIN tavi_tasks t ON t.task_id = a.task_id
        WHERE t.workspace_id = ? AND a.created_at >= ? AND (a.kind = 'start' OR ${FOLLOW_UP_SQL("a")}) AND NOT ${IS_DELEGATION_WORKER} AND NOT ${IS_PLUMBING_TASK}`,
    ).all(workspaceId, since) as { created_at: string; principal_id: string }[];
    const perDay = new Map(dates.map((date) => [date, 0]));
    // The people are those whose tasks a day counts, so the extra day read for
    // the zone offset names no one the window leaves out.
    const principals = new Set<string>();
    for (const row of created) {
      const date = calendarDate(formatter, new Date(row.created_at));
      const tasks = perDay.get(date);
      if (tasks === undefined) continue;
      perDay.set(date, tasks + 1);
      principals.add(row.principal_id);
    }

    // "Coming up" is the agenda's head, from the same sources.
    const horizon = new Date(new Date(now).getTime() + AGENDA_MAX_DAYS * 86_400_000).toISOString();
    const head = agendaItems(db, { workspaceId, now, from: now, until: horizon, limit: CENTER_NEXT_LIMIT }).items.map((item) => ({
      kind: item.kind,
      id: item.id,
      title: item.title,
      at: item.at,
    }));
    // A window with room left shows the next stored fires beyond it: a
    // far-off one-off is still "coming up".
    const next =
      head.length < CENTER_NEXT_LIMIT ? [...head, ...laterFires(db, workspaceId, horizon, CENTER_NEXT_LIMIT - head.length)] : head;

    // A person is named as the operator named them when allowing a sender
    // (`channels allow`'s name, the newest binding's), else by the
    // principal id.
    const people = [...principals].sort().slice(0, CENTER_PEOPLE_LIMIT);
    const names = new Map<string, string>();
    if (people.length > 0) {
      const rows = db
        .prepare(`SELECT b.principal_id, b.display_name FROM tavi_messaging_identity_bindings b
          WHERE b.workspace_id = ? AND b.display_name IS NOT NULL AND b.display_name <> '' AND b.principal_id IN (${people.map(() => "?").join(", ")})
          ORDER BY b.created_at, b.connection_id, b.external_sender_id`)
        .all(workspaceId, ...people) as { principal_id: string; display_name: string }[];
      for (const row of rows) names.set(row.principal_id, row.display_name);
    }

    return CenterSummaryAnswerSchema.parse({
      workspaceId,
      timezone,
      today,
      counts: {
        approvals: need("approval"),
        reviews: need("review"),
        questions: need("question"),
        handoffs: need("handoff"),
        connects: need("connect"),
        runningTasks: scalar(
          `SELECT count(*) AS n FROM tavi_tasks t WHERE t.workspace_id = ? AND t.status IN ('admitted', 'running') AND NOT ${IS_DELEGATION_WORKER} AND NOT ${IS_PLUMBING_TASK}`,
          workspaceId,
        ),
        // Counted by the memory service: no memory table is read here.
        memoryProposals: memoryProposals ?? 0,
        activeRoutines: scalar("SELECT count(*) AS n FROM tavi_routines WHERE workspace_id = ? AND status = 'active'", workspaceId),
        schedules: scalar(
          `SELECT count(*) AS n FROM tavi_schedules s WHERE s.workspace_id = ? AND s.enabled = 1
          AND NOT EXISTS (SELECT 1 FROM tavi_routine_triggers rt WHERE rt.schedule_id = s.schedule_id)`,
          workspaceId,
        ),
        reminders: scalar("SELECT count(*) AS n FROM tavi_reminders WHERE workspace_id = ? AND status = 'active'", workspaceId),
        unseenReminders: scalar(
          `SELECT count(*) AS n FROM tavi_reminder_fires f JOIN tavi_reminders r ON r.reminder_id = f.reminder_id
          WHERE r.workspace_id = ? AND f.outcome = 'delivered-in-app' AND f.acknowledged_at IS NULL`,
          workspaceId,
        ),
        // Only sessions in use: an inactive one (its task over, kept for the chat's next turn) is not live.
        liveBrowserSessions: scalar(
          "SELECT count(*) AS n FROM tavi_browser_sessions WHERE workspace_id = ? AND closed_at IS NULL AND inactive_since IS NULL",
          workspaceId,
        ),
      },
      perDay: [...perDay].map(([date, tasks]) => ({ date, tasks })),
      next,
      reconnect: (
        stmt(
          this.#db(),
          `SELECT connection_id, provider_id, label, auth_state FROM tavi_messaging_connections
          WHERE workspace_id = ? AND deleted_at IS NULL AND enabled = 1 AND auth_state IN ('expired', 'needs-consent')
          ORDER BY updated_at DESC LIMIT ?`,
        ).all(workspaceId, CENTER_RECONNECT_LIMIT) as {
          connection_id: string;
          provider_id: string;
          label: string | null;
          auth_state: "expired" | "needs-consent";
        }[]
      ).map((row) => ({
        connectionId: row.connection_id,
        providerId: row.provider_id,
        ...(row.label === null ? {} : { label: row.label }),
        authState: row.auth_state,
      })),
      servers: (
        stmt(
          this.#db(),
          "SELECT plugin_id, kind, updated_at FROM tavi_mcp_notices WHERE decided_at IS NULL ORDER BY updated_at DESC LIMIT ?",
        ).all(CENTER_SERVERS_LIMIT) as { plugin_id: string; kind: "drift" | "login" | "scope" | "failed" | "budget"; updated_at: string }[]
      ).map((row) => ({ pluginId: row.plugin_id, kind: row.kind, updatedAt: row.updated_at })),
      people: Object.fromEntries(people.map((principal) => [principal, names.get(principal) ?? principal])),
      cursor: encodeCursor(workspaceId, this.#fingerprints(scope)),
    });
  }

  agenda(input: AgendaInput): AgendaResult {
    return agendaItems(this.#db(), parseOrThrow(AgendaInputSchema, input, "The schedules agenda request is not valid"));
  }

  changes(input: CenterChangesInput): CenterWatchAnswer {
    const { workspaceId, principalId, cursor } = parseOrThrow(CenterChangesInputSchema, input, "The center watch request is not valid");
    const previous = cursor === undefined ? undefined : decodeCursor(cursor, workspaceId);
    const current = this.#fingerprints({ workspaceId, principalId });
    return {
      cursor: encodeCursor(workspaceId, current),
      changed: previous === undefined ? [] : CENTER_CHANGE_KINDS.filter((kind) => previous[kind] !== current[kind]),
    };
  }

  agentPins(input: { readonly workspaceId: string }): readonly AgentRoutinePin[] {
    // A completed or archived routine runs no more; any other one runs, or may
    // once activated, the agent its revision pinned.
    const rows = stmt(
      this.#db(),
      `SELECT json_extract(v.snapshot_json, '$.agent.agentId') AS agent_id, r.routine_id, r.name FROM tavi_routines r
        JOIN tavi_routine_revisions v ON v.routine_id = r.routine_id AND v.revision = COALESCE(r.active_revision, r.latest_revision)
        WHERE r.workspace_id = ? AND r.status NOT IN ('completed', 'archived') AND json_type(v.snapshot_json, '$.agent.agentId') = 'text'
        ORDER BY r.name, r.routine_id`,
    ).all(input.workspaceId) as { agent_id: string; routine_id: string; name: string }[];
    return rows.map((row) => ({ agentId: row.agent_id, routineId: row.routine_id, name: row.name }));
  }

  memoryChanged(input: { readonly scope: MemoryScope }): void {
    const scope = parseOrThrow(MemoryScopeSchema, input.scope, "The center memory changed request is not valid");
    // The rows the memory triggers bump (the `*_center_*` triggers in `baseline-schema.ts`): a chat's own memory bumps nothing.
    const row = scope.kind === "run_local" ? undefined : scope.kind === "shared_workspace" ? scope.workspaceId : `p:${scope.principalId}`;
    if (row === undefined) return;
    stmt(
      this.#db(),
      "INSERT INTO tavi_center_versions (scope, kind, version) VALUES (?, 'memory', 1) ON CONFLICT (scope, kind) DO UPDATE SET version = version + 1",
    ).run(row);
  }

  #fingerprints(scope: CenterScope): Record<CenterChangeKind, string> {
    const rows = stmt(this.#db(), VERSIONS_SQL).all(scope.workspaceId, `p:${scope.principalId}`, CENTER_GLOBAL_SCOPE) as {
      kind: string;
      version: number;
    }[];
    const versions = new Map(rows.map((row) => [row.kind, row.version]));
    return Object.fromEntries(CENTER_CHANGE_KINDS.map((kind) => [kind, String(versions.get(kind) ?? 0)])) as Record<
      CenterChangeKind,
      string
    >;
  }
}
