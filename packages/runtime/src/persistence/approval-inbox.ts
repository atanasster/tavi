import type { ApprovalInboxRepositoryPort } from "./internal-contracts.js";
import { z } from "zod";
import {
  decodeRoundRisk,
  APPROVAL_EXPIRED_DECIDER,
  APPROVAL_HISTORY_KINDS,
  APPROVAL_HISTORY_STATES_BY_KIND,
  APPROVAL_HISTORY_TEXT_MAX_CHARS,
  ApprovalCallScopesSchema,
  ApprovalHistoryInputSchema,
  ApprovalSettlementInputSchema,
  ApprovalSettlementSchema,
  ApprovalsHistoryResultSchema,
  ASK_USER_CONTEXT_MAX_CHARS,
  AskUserChoicesSchema,
  BrowserHandoffSchema,
  PendingApprovalsAnswerSchema,
  PendingApprovalsInputSchema,
  PendingWaitsAnswerSchema,
  PendingWaitsInputSchema,
  TaskOriginSchema,
  TOOL_HEADLINE_INPUT_FIELDS,
  TaviError,
  scopesForRisk,
  toolCallHeadline,
  redactToolText,
  type ApprovalHistoryInput,
  type ApprovalHistoryItem,
  type ApprovalHistoryKind,
  type ApprovalHistoryState,
  type ApprovalScope,
  type ApprovalSettlement,
  type ApprovalSettlementInput,
  type ApprovalsHistoryResult,
  type PendingApprovalsAnswer,
  type PendingApprovalsInput,
  type PendingWaitsAnswer,
  type PendingWaitsInput,
  type RiskLevel,
  toolPrefixEnd,
  ConnectRequestSchema,
  parseOrThrow,
} from "@tavi/contracts";
import { clip } from "@tavi/contracts/util";
import { sha256Hex } from "@tavi/node-kit";

import type { Database } from "./sqlite-loader.js";
import { TASK_PROMPT_SQL, displayTitleOf } from "./task-list.js";

/**
 * The scopes a pending call's decision may carry: what the gate's verdict
 * offered it, as its round recorded. A round with no recorded scopes has only
 * its risk, whose scopes are an upper bound (taint, a once-only tool
 * or unrepresentable subjects narrow them further); a call with no round, or
 * one its round does not list, offers `once` alone.
 */
function allowedScopesOf(callId: string, risk: RiskLevel | null, callScopesJson: string | null): ApprovalScope[] {
  if (callScopesJson !== null) {
    const recorded = ApprovalCallScopesSchema.safeParse(JSON.parse(callScopesJson));
    const entry = recorded.success ? recorded.data.find((call) => call.callId === callId) : undefined;
    return entry === undefined ? ["once"] : [...entry.allowedScopes];
  }
  return risk === null ? ["once"] : [...scopesForRisk(risk, false)];
}

/**
 * The headline fields of a stored call input, as a small JSON object: only
 * the fields `toolCallHeadline` reads, each a scalar clipped to 256
 * characters. The whole input never leaves the database.
 */
const HEADLINE_FIELD_CHARS = 256;
const HEADLINE_INPUT_SQL = (column: string): string =>
  `CASE WHEN json_valid(${column}) THEN json_object(${TOOL_HEADLINE_INPUT_FIELDS.map((field) => {
    if (!/^[A-Za-z]+$/.test(field)) throw new TaviError("INTERNAL", `headline field ${JSON.stringify(field)} is not a plain name`);
    return `'${field}', CASE WHEN json_type(${column}, '$.${field}') IN ('text', 'integer', 'real') THEN substr(json_extract(${column}, '$.${field}'), 1, ${HEADLINE_FIELD_CHARS}) END`;
  }).join(", ")}) END`;

/**
 * The headline fields without a word the SQL's clip cut in two: a secret cut
 * at the clip would no longer match the mask, so a clipped field ends at its
 * last whole word, with an ellipsis.
 */
function unclipped(fields: unknown): unknown {
  if (typeof fields !== "object" || fields === null) return fields;
  return Object.fromEntries(
    Object.entries(fields).map(([key, value]) => {
      if (typeof value !== "string" || value.length < HEADLINE_FIELD_CHARS) return [key, value];
      const end = value.search(/\s\S*$/);
      return [key, `${end <= 0 ? "" : value.slice(0, end)}…`];
    }),
  );
}

/**
 * A waiting call's one-line summary, from its stored input — masked whatever
 * the workspace's `tools.redactResults` says: a list of what
 * waits shows a headline, and the whole input is one `approvals show` away,
 * which follows the setting.
 */
function headlineOf(toolId: string, headline: string | null): string | undefined {
  if (headline === null) return undefined;
  try {
    const shown = toolCallHeadline(toolId, unclipped(JSON.parse(headline) as unknown));
    return shown === undefined || shown === "" ? undefined : redactToolText(shown).text;
  } catch {
    return undefined;
  }
}

/**
 * A question's text: kept on wait `w`'s row, else read from
 * the admission that suspended on it; NULL when that wait asked none.
 */
export const QUESTION_SQL = (w: string) =>
  `COALESCE(${w}.question, (SELECT json_extract(q.result, '$.waitInterrupt.question') FROM tavi_admissions q
     WHERE q.task_id = ${w}.task_id AND json_extract(q.result, '$.waitInterrupt.wait.waitId') = ${w}.wait_id
       AND json_type(q.result, '$.waitInterrupt.question') = 'text' LIMIT 1))`;

/** A settled connect wait's history state: connected, *Not now* (`declined`), or its deadline passed. */
const CONNECT_STATE_SQL = (w: string) =>
  `CASE json_extract(${w}.settled_outcome_json, '$.kind') WHEN 'answered' THEN CASE json_extract(${w}.settled_outcome_json, '$.connect.outcome') WHEN 'connected' THEN 'connected' WHEN 'declined' THEN 'declined' END WHEN 'wait-timeout' THEN 'expired' WHEN 'cancelled' THEN 'cancelled' END`;

/** A settled wait's outcome as a history state; NULL for a wait no person was asked to answer. */
const QUESTION_STATE_SQL = (w: string) =>
  `CASE json_extract(${w}.settled_outcome_json, '$.kind') WHEN 'answered' THEN 'answered' WHEN 'wait-timeout' THEN 'expired' WHEN 'cancelled' THEN 'cancelled' END`;

/** The latest settlement (`settled` or `expired`) event of approval `a`'s round. */
const SETTLED_EVENT_SQL = (a: string, column: string) =>
  `(SELECT e.${column} FROM tavi_approval_events e WHERE e.task_id = ${a}.task_id AND e.steps = ${a}.steps AND e.kind IN ('settled', 'expired') ORDER BY e.event_id DESC LIMIT 1)`;

/** A row's `taskTitle`: the generated title, else the prompt's first line (`displayTitleOf`); absent when neither says anything. */
function optionalTitle(generated: string | null, prompt: string | null): { taskTitle?: string } {
  const title = displayTitleOf(generated, prompt);
  return title === undefined ? {} : { taskTitle: title };
}

/**
 * Keyset cursors, bound to the filters they were issued for by a hash: a
 * cursor sent with other filters would page a different list.
 */
const PendingCursorSchema = z.strictObject({
  v: z.literal(1),
  scope: z.string(),
  at: z.string().min(1).max(64),
  id: z.string().min(1).max(128),
});
const HistoryCursorSchema = z.strictObject({
  v: z.literal(1),
  scope: z.string(),
  at: z.string().min(1).max(64),
  kind: z.enum(APPROVAL_HISTORY_KINDS),
  id: z.string().min(1).max(128),
});

const scopeOf = (value: unknown): string => sha256Hex(JSON.stringify(value)).slice(0, 32);
const encodeCursor = (value: object): string => Buffer.from(JSON.stringify({ v: 1, ...value })).toString("base64url");
function decodeCursor<T extends { readonly scope: string }>(schema: z.ZodType<T>, cursor: string, scope: string, what: string): T {
  let decoded: T;
  try {
    decoded = schema.parse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));
  } catch {
    throw new TaviError("INVALID_INPUT", `Invalid ${what} cursor; restart the list`);
  }
  if (decoded.scope !== scope) throw new TaviError("INVALID_INPUT", `The ${what} cursor was issued for other filters; restart the list`);
  return decoded;
}

/** One history row before it is shaped, in the order every source sorts by. */
interface Keyed {
  readonly at: string;
  readonly kind: ApprovalHistoryKind;
  readonly id: string;
  readonly item: ApprovalHistoryItem;
}

/** `(decided_at DESC, kind ASC, id DESC)`: the history's order, which the keyset follows. */
function compareKeyed(left: Keyed, right: Keyed): number {
  if (left.at !== right.at) return left.at < right.at ? 1 : -1;
  if (left.kind !== right.kind) return left.kind < right.kind ? -1 : 1;
  if (left.id !== right.id) return left.id < right.id ? 1 : -1;
  return 0;
}

/**
 * The rows of source `kind` after the cursor, in the history's order: the
 * cursor's own kind resumes after its id; a later kind starts at the cursor's
 * time, an earlier one after it.
 */
function afterCursor(
  kind: ApprovalHistoryKind,
  at: string,
  id: string,
  cursor: z.infer<typeof HistoryCursorSchema> | undefined,
): { sql: string; params: string[] } | undefined {
  if (cursor === undefined) return undefined;
  if (kind === cursor.kind) return { sql: `(${at}, ${id}) < (?, ?)`, params: [cursor.at, cursor.id] };
  return kind > cursor.kind ? { sql: `${at} <= ?`, params: [cursor.at] } : { sql: `${at} < ?`, params: [cursor.at] };
}

type HistoryFilters = z.output<typeof ApprovalHistoryInputSchema>;

/**
 * The approvals inbox and the decision history.
 *
 * Every query is scoped to its workspace in SQL and pages by keyset over an
 * index; a page's rows are chosen first and only then enriched (title,
 * headline, round, events), so enrichment costs one page, not the workspace's
 * whole history. The three history sources are read as three indexed queries
 * of at most `limit + 1` rows each and merged here, which keeps each one on its
 * own index where one `UNION ALL` sorted as a whole would not.
 */
/** A needs row's task, from `tavi_tasks t` and the schedule that fired it (`tavi_schedules s`). */
const NEED_TASK_COLUMNS = `t.task_id AS need_task_id, t.workspace_id, t.principal_id, COALESCE(NULLIF(trim(t.title_override), ''), t.title) AS generated_title, ${TASK_PROMPT_SQL("t")} AS prompt, t.origin, s.name AS schedule_name,
  (SELECT COALESCE(NULLIF(trim(ad.name), ''), d.worker_agent_id) FROM tavi_agent_delegation_admissions d
     LEFT JOIN tavi_agent_definitions ad ON ad.workspace_id = d.workspace_id AND ad.agent_id = d.agent_definition_id
     WHERE d.worker_task_id = t.task_id LIMIT 1) AS worker_label`;
/**
 * `t` is a delegated worker under a root chat (bound as workspace, root,
 * workspace, root, workspace), at any depth: its delegation rows
 * walked down from the root by their parents, each step on
 * `tavi_delegation_parent_idx`. A row written before parents were recorded
 * names its root only. `UNION` drops repeats, so a cycle ends.
 */
export const UNDER_ROOT_SQL = `t.task_id IN (WITH RECURSIVE tree(task_id) AS (
    SELECT d.worker_task_id FROM tavi_agent_delegation_admissions d WHERE d.workspace_id = ? AND d.parent_task_id = ?
    UNION SELECT d.worker_task_id FROM tavi_agent_delegation_admissions d WHERE d.workspace_id = ? AND d.parent_task_id IS NULL AND d.root_task_id = ?
    UNION SELECT d.worker_task_id FROM tree CROSS JOIN tavi_agent_delegation_admissions d ON d.workspace_id = ? AND d.parent_task_id = tree.task_id
  ) SELECT task_id FROM tree)`;
interface NeedTaskRow {
  readonly need_task_id: string;
  readonly workspace_id: string;
  readonly principal_id: string;
  readonly generated_title: string | null;
  readonly prompt: string | null;
  readonly origin: string | null;
  readonly schedule_name: string | null;
  readonly worker_label: string | null;
}

/** A stored JSON column, or `undefined` when it does not parse: one bad row must not fail a listing. */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

export class SqliteApprovalInboxRepository implements ApprovalInboxRepositoryPort {
  readonly #db: () => Database;

  constructor(db: () => Database) {
    this.#db = db;
  }

  pending(input: PendingApprovalsInput): PendingApprovalsAnswer {
    const { workspaceId, taskId, rootTaskId, limit, cursor } = parseOrThrow(
      PendingApprovalsInputSchema,
      input,
      "The approvals list request is not valid",
    );
    const scope = scopeOf(["pending", workspaceId, taskId ?? null, rootTaskId ?? null]);
    const where = ["a.state = 'pending'", "t.workspace_id = ?"];
    const params: (string | number)[] = [workspaceId];
    if (taskId !== undefined) {
      where.push("a.task_id = ?");
      params.push(taskId);
    }
    if (rootTaskId !== undefined) {
      where.push(UNDER_ROOT_SQL, "t.task_id <> ?");
      params.push(workspaceId, rootTaskId, workspaceId, rootTaskId, workspaceId, rootTaskId);
    }
    if (cursor !== undefined) {
      const after = decodeCursor(PendingCursorSchema, cursor, scope, "approvals list");
      where.push("(a.created_at > ? OR (a.created_at = ? AND a.approval_id > ?))");
      params.push(after.at, after.at, after.id);
    }
    const rows = this.#db()
      .prepare(`WITH page AS (
          SELECT a.approval_id FROM tavi_approvals a JOIN tavi_tasks t ON t.task_id = a.task_id
          WHERE ${where.join(" AND ")} ORDER BY a.created_at, a.approval_id LIMIT ?
        )
        SELECT a.approval_id, a.task_id, a.tool_id, a.call_id, a.steps, a.created_at,
          t.workspace_id, t.principal_id, t.status, t.origin, COALESCE(NULLIF(trim(t.title_override), ''), t.title) AS generated_title, ${TASK_PROMPT_SQL("t")} AS prompt,
          r.risk, r.call_scopes_json, r.expires_at, r.connection_id, r.conversation_id,
          EXISTS (SELECT 1 FROM tavi_approval_events e WHERE e.task_id = r.task_id AND e.steps = r.steps AND e.kind = 'announced') AS announced,
          (SELECT COALESCE(d.root_task_id, d.parent_task_id) FROM tavi_agent_delegation_admissions d WHERE d.worker_task_id = a.task_id) AS root_task_id,
          ${HEADLINE_INPUT_SQL("a.inputs")} AS headline
        FROM page JOIN tavi_approvals a ON a.approval_id = page.approval_id JOIN tavi_tasks t ON t.task_id = a.task_id
        LEFT JOIN tavi_approval_rounds r ON r.task_id = a.task_id AND r.steps = a.steps
        ORDER BY a.created_at, a.approval_id`)
      .all(...params, limit + 1) as {
      approval_id: string;
      task_id: string;
      tool_id: string;
      call_id: string;
      steps: number;
      created_at: string;
      workspace_id: string;
      principal_id: string;
      status: string;
      origin: string | null;
      generated_title: string | null;
      prompt: string | null;
      risk: string | null;
      call_scopes_json: string | null;
      expires_at: string | null;
      connection_id: string | null;
      conversation_id: string | null;
      announced: number;
      root_task_id: string | null;
      headline: string | null;
    }[];
    const shown = rows.slice(0, limit);
    const last = shown.at(-1);
    const truncated = rows.length > limit;
    return PendingApprovalsAnswerSchema.parse({
      rows: shown.map((row) => {
        const summary = headlineOf(row.tool_id, row.headline);
        const label = decodeRoundRisk(row.risk).label;
        return {
          approvalId: row.approval_id,
          taskId: row.task_id,
          toolId: row.tool_id,
          callId: row.call_id,
          steps: row.steps,
          createdAt: row.created_at,
          workspaceId: row.workspace_id,
          principalId: row.principal_id,
          taskStatus: row.status,
          ...(TaskOriginSchema.safeParse(row.origin).success ? { taskOrigin: TaskOriginSchema.parse(row.origin) } : {}),
          ...(row.root_task_id === null ? {} : { rootTaskId: row.root_task_id }),
          ...optionalTitle(row.generated_title, row.prompt),
          ...(summary === undefined ? {} : { summary }),
          ...(decodeRoundRisk(row.risk).level === undefined ? {} : { risk: decodeRoundRisk(row.risk).level }),
          ...(row.expires_at === null ? {} : { expiresAt: row.expires_at }),
          allowedScopes: allowedScopesOf(row.call_id, decodeRoundRisk(row.risk).level ?? null, row.call_scopes_json),
          ...(row.announced === 1 && row.connection_id !== null && row.conversation_id !== null
            ? { announcedIn: { connectionId: row.connection_id, conversationId: row.conversation_id } }
            : {}),
          // Where its chat read untrusted content, as the round recorded it.
          ...(label === undefined || label.integrity !== "untrusted" ? {} : { label }),
        };
      }),
      truncated,
      ...(truncated && last !== undefined ? { nextCursor: encodeCursor({ scope, at: last.created_at, id: last.approval_id }) } : {}),
    });
  }

  pendingWaits(input: PendingWaitsInput): PendingWaitsAnswer {
    const { workspaceId, taskId, rootTaskId, limit } = parseOrThrow(PendingWaitsInputSchema, input, "The needs list request is not valid");
    const db = this.#db();
    const taskWhere =
      taskId !== undefined ? " AND t.task_id = ?" : rootTaskId !== undefined ? ` AND ${UNDER_ROOT_SQL} AND t.task_id <> ?` : "";
    const taskParams =
      taskId !== undefined
        ? [taskId]
        : rootTaskId !== undefined
          ? [workspaceId, rootTaskId, workspaceId, rootTaskId, workspaceId, rootTaskId]
          : [];
    // A question to a person is a bare-deadline wait whose suspension carried
    // its text (`apps/cli/src/runtime/conversations.ts`, `QUESTION_SQL`): no correlation and no worker.
    const questions = db
      .prepare(`SELECT w.wait_id, w.deadline_at, w.choices_json,
          ${NEED_TASK_COLUMNS},
          ${QUESTION_SQL("w")} AS question,
          (SELECT json_extract(q.result, '$.waitInterrupt.context') FROM tavi_admissions q WHERE q.task_id = w.task_id AND json_extract(q.result, '$.waitInterrupt.wait.waitId') = w.wait_id AND json_type(q.result, '$.waitInterrupt.context') = 'text' LIMIT 1) AS context,
          (SELECT q.updated_at FROM tavi_admissions q WHERE q.task_id = w.task_id AND json_extract(q.result, '$.waitInterrupt.wait.waitId') = w.wait_id LIMIT 1) AS asked_at
        FROM tavi_agent_wait_intents w JOIN tavi_tasks t ON t.task_id = w.task_id
        LEFT JOIN tavi_schedules s ON s.schedule_id = t.origin_schedule_id
        WHERE w.state = 'active' AND w.correlation_id IS NULL AND w.waiting_on_worker_task_id IS NULL AND w.handoff_json IS NULL AND w.connect_json IS NULL AND t.workspace_id = ?${taskWhere}
          AND ${QUESTION_SQL("w")} IS NOT NULL
        ORDER BY w.deadline_at, w.wait_id LIMIT ?`)
      .all(workspaceId, ...taskParams, limit + 1) as (NeedTaskRow & {
      wait_id: string;
      deadline_at: string;
      choices_json: string | null;
      question: string;
      context: string | null;
      asked_at: string | null;
    })[];
    const shownQuestions = questions.slice(0, limit);
    const deliveries = new Map<string, { connectionId: string }[]>();
    if (shownQuestions.length > 0) {
      const rows = db
        .prepare(
          `SELECT wait_id, connection_id FROM tavi_need_deliveries WHERE wait_id IN (${shownQuestions.map(() => "?").join(", ")}) ORDER BY created_at, connection_id`,
        )
        .all(...shownQuestions.map((row) => row.wait_id)) as { wait_id: string; connection_id: string }[];
      for (const row of rows) {
        const list = deliveries.get(row.wait_id) ?? [];
        if (list.length < 8) list.push({ connectionId: row.connection_id });
        deliveries.set(row.wait_id, list);
      }
    }
    const reviews = db
      .prepare(`SELECT count(*) AS artifact_count, min(r.created_at) AS asked_at,
          ${NEED_TASK_COLUMNS}
        FROM tavi_artifacts r JOIN tavi_tasks t ON t.task_id = r.run_id AND t.workspace_id = r.workspace_id
        LEFT JOIN tavi_schedules s ON s.schedule_id = t.origin_schedule_id
        WHERE r.review_state = 'pending' AND t.workspace_id = ?${taskWhere}
        GROUP BY r.run_id ORDER BY asked_at, r.run_id LIMIT ?`)
      .all(workspaceId, ...taskParams, limit + 1) as (NeedTaskRow & { artifact_count: number; asked_at: string })[];
    // A browser handoff is acted on in the live view, never answered: listed apart, and only for a root's workers.
    const handoffs =
      rootTaskId === undefined
        ? undefined
        : (db
            .prepare(`SELECT w.wait_id, w.deadline_at, w.handoff_json,
              ${NEED_TASK_COLUMNS},
              (SELECT q.updated_at FROM tavi_admissions q WHERE q.task_id = w.task_id AND json_extract(q.result, '$.waitInterrupt.wait.waitId') = w.wait_id LIMIT 1) AS asked_at
            FROM tavi_agent_wait_intents w JOIN tavi_tasks t ON t.task_id = w.task_id
            LEFT JOIN tavi_schedules s ON s.schedule_id = t.origin_schedule_id
            WHERE w.state = 'active' AND w.handoff_json IS NOT NULL AND t.workspace_id = ?${taskWhere}
            ORDER BY w.deadline_at, w.wait_id LIMIT ?`)
            .all(workspaceId, ...taskParams, limit + 1) as (NeedTaskRow & {
            wait_id: string;
            deadline_at: string;
            handoff_json: string;
            asked_at: string | null;
          })[]);
    // A connect wait is decided by connecting or *Not now*, never answered: listed apart.
    const connects = db
      .prepare(`SELECT w.wait_id, w.deadline_at, w.connect_json,
          ${NEED_TASK_COLUMNS},
          (SELECT q.updated_at FROM tavi_admissions q WHERE q.task_id = w.task_id AND json_extract(q.result, '$.waitInterrupt.wait.waitId') = w.wait_id LIMIT 1) AS asked_at
        FROM tavi_agent_wait_intents w JOIN tavi_tasks t ON t.task_id = w.task_id
        LEFT JOIN tavi_schedules s ON s.schedule_id = t.origin_schedule_id
        WHERE w.state = 'active' AND w.connect_json IS NOT NULL AND t.workspace_id = ?${taskWhere}
        ORDER BY w.deadline_at, w.wait_id LIMIT ?`)
      .all(workspaceId, ...taskParams, limit + 1) as (NeedTaskRow & {
      wait_id: string;
      deadline_at: string;
      connect_json: string;
      asked_at: string | null;
    })[];
    const taskOf = (row: NeedTaskRow) => {
      const origin = TaskOriginSchema.safeParse(row.origin);
      return {
        taskId: row.need_task_id,
        workspaceId: row.workspace_id,
        principalId: row.principal_id,
        ...optionalTitle(row.generated_title, row.prompt),
        ...(origin.success ? { origin: origin.data } : {}),
        ...(row.schedule_name === null || row.schedule_name.trim() === "" ? {} : { originLabel: clip(row.schedule_name.trim(), 120) }),
        ...(row.worker_label === null || row.worker_label.trim() === "" ? {} : { workerLabel: clip(row.worker_label.trim(), 120) }),
      };
    };
    return PendingWaitsAnswerSchema.parse({
      questions: shownQuestions.map((row) => {
        const choices = row.choices_json === null ? undefined : AskUserChoicesSchema.safeParse(parseJson(row.choices_json));
        return {
          ...taskOf(row),
          waitId: row.wait_id,
          question: clip(row.question, 2_000),
          ...(row.context === null || row.context.trim() === "" ? {} : { context: clip(row.context, ASK_USER_CONTEXT_MAX_CHARS) }),
          ...(choices?.success === true ? { choices: choices.data } : {}),
          deadlineAt: row.deadline_at,
          askedAt: row.asked_at ?? row.deadline_at,
          deliveries: deliveries.get(row.wait_id) ?? [],
        };
      }),
      reviews: reviews.slice(0, limit).map((row) => ({ ...taskOf(row), artifactCount: row.artifact_count, askedAt: row.asked_at })),
      ...(handoffs === undefined
        ? {}
        : {
            handoffs: handoffs.slice(0, limit).flatMap((row) => {
              const handoff = BrowserHandoffSchema.safeParse(parseJson(row.handoff_json));
              return handoff.success
                ? [
                    {
                      ...taskOf(row),
                      waitId: row.wait_id,
                      handoff: handoff.data,
                      deadlineAt: row.deadline_at,
                      askedAt: row.asked_at ?? row.deadline_at,
                    },
                  ]
                : [];
            }),
          }),
      connects: connects.slice(0, limit).flatMap((row) => {
        const connect = ConnectRequestSchema.safeParse(parseJson(row.connect_json));
        return connect.success
          ? [
              {
                ...taskOf(row),
                waitId: row.wait_id,
                ...connect.data,
                deadlineAt: row.deadline_at,
                askedAt: row.asked_at ?? row.deadline_at,
              },
            ]
          : [];
      }),
      truncated: questions.length > limit || reviews.length > limit || (handoffs?.length ?? 0) > limit || connects.length > limit,
    });
  }

  history(input: ApprovalHistoryInput): ApprovalsHistoryResult {
    const filters = parseOrThrow(ApprovalHistoryInputSchema, input, "The approvals history request is not valid");
    const { cursor: _cursor, limit, ...scoped } = filters;
    const scope = scopeOf(["history", scoped]);
    const cursor = filters.cursor === undefined ? undefined : decodeCursor(HistoryCursorSchema, filters.cursor, scope, "approvals history");
    const wanted = (kind: ApprovalHistoryKind): readonly ApprovalHistoryState[] => {
      if (filters.kinds !== undefined && !filters.kinds.includes(kind)) return [];
      // A tool names an approval's call; reviews and questions have none.
      if ((filters.toolId !== undefined || filters.toolPrefixes !== undefined) && kind !== "approval") return [];
      const states = APPROVAL_HISTORY_STATES_BY_KIND[kind];
      const only = filters.states;
      return only === undefined ? states : states.filter((state) => only.includes(state));
    };
    const merged = [
      ...this.#approvals(filters, wanted("approval"), cursor),
      ...this.#reviews(filters, wanted("review"), cursor),
      ...this.#questions(filters, wanted("question"), cursor),
      ...this.#connects(filters, wanted("connect"), cursor),
    ].sort(compareKeyed);
    const shown = merged.slice(0, limit);
    const last = shown.at(-1);
    return ApprovalsHistoryResultSchema.parse({
      items: shown.map((row) => row.item),
      ...(merged.length > limit && last !== undefined
        ? { nextCursor: encodeCursor({ scope, at: last.at, kind: last.kind, id: last.id }) }
        : {}),
    });
  }

  settlement(input: ApprovalSettlementInput): ApprovalSettlement | undefined {
    const { taskId, steps } = parseOrThrow(ApprovalSettlementInputSchema, input, "The approval settlement request is not valid");
    const db = this.#db();
    // Without a round, the task's most recently decided one.
    const round =
      steps !== undefined
        ? { steps }
        : (db
            .prepare(
              "SELECT steps FROM tavi_approvals WHERE task_id = ? AND decided_at IS NOT NULL ORDER BY decided_at DESC, approval_id DESC LIMIT 1",
            )
            .get(taskId) as { steps: number } | undefined);
    if (round === undefined) return undefined;
    const rows = db
      .prepare(
        "SELECT task_id, steps, state, decided_by, decided_at FROM tavi_approvals WHERE task_id = ? AND steps = ? ORDER BY decided_at DESC, approval_id DESC",
      )
      .all(taskId, round.steps) as {
      task_id: string;
      steps: number;
      state: string;
      decided_by: string | null;
      decided_at: string | null;
    }[];
    const latest = rows[0];
    if (latest === undefined || latest.decided_at === null || rows.some((row) => row.state === "pending")) return undefined;
    const via =
      (
        db
          .prepare(
            `SELECT e.via FROM tavi_approval_events e WHERE e.task_id = ? AND e.steps = ? AND e.kind IN ('settled', 'expired') ORDER BY e.event_id DESC LIMIT 1`,
          )
          .get(taskId, round.steps) as { via: string | null } | undefined
      )?.via ?? undefined;
    const states = rows.map((row) => approvalState(row.state, row.decided_by));
    return ApprovalSettlementSchema.parse({
      taskId,
      steps: round.steps,
      state: new Set(states).size === 1 ? states[0] : "mixed",
      decidedBy: latest.decided_by,
      decidedAt: latest.decided_at,
      ...(via === undefined || via === null ? {} : { via }),
    });
  }

  #approvals(
    filters: HistoryFilters,
    states: readonly ApprovalHistoryState[],
    cursor: z.infer<typeof HistoryCursorSchema> | undefined,
  ): Keyed[] {
    if (states.length === 0) return [];
    // `denied` and `expired` share the stored state; the decider tells them apart.
    const stored = [...new Set(states.map((state) => (state === "expired" ? "denied" : state)))];
    // `+a.state`: the state is a residual filter, never the index to read by
    // (see the `CROSS JOIN` below).
    const where = [`+a.state IN (${stored.map(() => "?").join(", ")})`, "a.decided_at IS NOT NULL", "t.workspace_id = ?"];
    const params: (string | number)[] = [...stored, filters.workspaceId];
    const denied = states.includes("denied");
    const expired = states.includes("expired");
    if (denied !== expired) {
      where.push(expired ? "(a.state <> 'denied' OR a.decided_by = ?)" : "(a.state <> 'denied' OR a.decided_by IS NOT ?)");
      params.push(APPROVAL_EXPIRED_DECIDER);
    }
    this.#common(where, params, filters, "a.decided_at", "a.task_id");
    if (filters.toolId !== undefined) {
      where.push("a.tool_id = ?");
      params.push(filters.toolId);
    }
    if (filters.toolPrefixes !== undefined) {
      where.push(`(${filters.toolPrefixes.map(() => "(a.tool_id >= ? AND a.tool_id < ?)").join(" OR ")})`);
      params.push(...filters.toolPrefixes.flatMap((prefix) => [prefix, toolPrefixEnd(prefix)]));
    }
    const after = afterCursor("approval", "a.decided_at", "a.approval_id", cursor);
    if (after !== undefined) {
      where.push(after.sql);
      params.push(...after.params);
    }
    // `CROSS JOIN` keeps the approvals as the outer loop, so the page is read
    // in order from `tavi_approvals_decided_idx` and stops at `limit + 1`;
    // driven from the workspace's tasks instead, every decided row of the
    // workspace would be gathered and sorted on each page.
    const rows = this.#db()
      .prepare(`WITH page AS (
          SELECT a.approval_id FROM tavi_approvals a CROSS JOIN tavi_tasks t ON t.task_id = a.task_id
          WHERE ${where.join(" AND ")} ORDER BY a.decided_at DESC, a.approval_id DESC LIMIT ?
        )
        SELECT a.approval_id, a.task_id, a.tool_id, a.call_id, a.steps, a.state, a.decided_by, a.decided_at, a.note,
          t.principal_id, COALESCE(NULLIF(trim(t.title_override), ''), t.title) AS generated_title, ${TASK_PROMPT_SQL("t")} AS prompt, r.risk,
          ${HEADLINE_INPUT_SQL("a.inputs")} AS headline,
          ${SETTLED_EVENT_SQL("a", "via")} AS via,
          (SELECT json_extract(d.value, '$.scope') FROM tavi_approval_events e, json_each(e.detail_json, '$.decisions') d
            WHERE e.task_id = a.task_id AND e.steps = a.steps AND e.kind = 'settled' AND json_extract(d.value, '$.callId') = a.call_id
            ORDER BY e.event_id DESC LIMIT 1) AS scope,
          (SELECT json_extract(e.detail_json, '$.created[0]') FROM tavi_approval_events e
            WHERE e.task_id = a.task_id AND e.steps = a.steps AND e.kind = 'rule_created' AND json_extract(e.detail_json, '$.callId') = a.call_id
            ORDER BY e.event_id DESC LIMIT 1) AS rule_id
        FROM page JOIN tavi_approvals a ON a.approval_id = page.approval_id JOIN tavi_tasks t ON t.task_id = a.task_id
        LEFT JOIN tavi_approval_rounds r ON r.task_id = a.task_id AND r.steps = a.steps`)
      .all(...params, filters.limit + 1) as {
      approval_id: string;
      task_id: string;
      tool_id: string;
      call_id: string;
      steps: number;
      state: string;
      decided_by: string | null;
      decided_at: string;
      note: string | null;
      principal_id: string;
      generated_title: string | null;
      prompt: string | null;
      risk: string | null;
      headline: string | null;
      via: string | null;
      scope: unknown;
      rule_id: unknown;
    }[];
    return rows.map((row) => {
      const state = approvalState(row.state, row.decided_by);
      const summary = headlineOf(row.tool_id, row.headline);
      const granted = state === "granted";
      return {
        at: row.decided_at,
        kind: "approval",
        id: row.approval_id,
        item: {
          kind: "approval",
          approvalId: row.approval_id,
          taskId: row.task_id,
          ...optionalTitle(row.generated_title, row.prompt),
          principalId: row.principal_id,
          toolId: row.tool_id,
          callId: row.call_id,
          steps: row.steps,
          ...(summary === undefined ? {} : { summary }),
          state,
          decidedBy: row.decided_by,
          decidedAt: row.decided_at,
          ...(row.via === null ? {} : { via: row.via }),
          // A scope says how long a grant stands; a denial has none.
          ...(granted && (row.scope === "once" || row.scope === "session" || row.scope === "always") ? { scope: row.scope } : {}),
          ...(decodeRoundRisk(row.risk).level === undefined ? {} : { risk: decodeRoundRisk(row.risk).level }),
          note: row.note === null ? null : clip(row.note, 2000),
          ...(granted && row.scope === "always" && typeof row.rule_id === "string" && row.rule_id !== "" ? { ruleId: row.rule_id } : {}),
        },
      };
    });
  }

  #reviews(
    filters: HistoryFilters,
    states: readonly ApprovalHistoryState[],
    cursor: z.infer<typeof HistoryCursorSchema> | undefined,
  ): Keyed[] {
    if (states.length === 0) return [];
    const where = ["ar.workspace_id = ?", "ar.reviewed_at IS NOT NULL", `ar.review_state IN (${states.map(() => "?").join(", ")})`];
    const params: (string | number)[] = [filters.workspaceId, ...states];
    this.#common(where, params, filters, "ar.reviewed_at", "ar.run_id");
    const after = afterCursor("review", "ar.reviewed_at", "ar.artifact_id", cursor);
    if (after !== undefined) {
      where.push(after.sql);
      params.push(...after.params);
    }
    const rows = this.#db()
      .prepare(`WITH page AS (
          SELECT ar.artifact_id FROM tavi_artifacts ar LEFT JOIN tavi_tasks t ON t.task_id = ar.run_id
          WHERE ${where.join(" AND ")} ORDER BY ar.reviewed_at DESC, ar.artifact_id DESC LIMIT ?
        )
        SELECT ar.artifact_id, ar.review_state, ar.reviewed_by, ar.reviewed_at, ar.review_note, ar.content_type,
          t.task_id, t.principal_id, COALESCE(NULLIF(trim(t.title_override), ''), t.title) AS generated_title, CASE WHEN t.task_id IS NULL THEN NULL ELSE ${TASK_PROMPT_SQL("t")} END AS prompt
        FROM page JOIN tavi_artifacts ar ON ar.artifact_id = page.artifact_id LEFT JOIN tavi_tasks t ON t.task_id = ar.run_id`)
      .all(...params, filters.limit + 1) as {
      artifact_id: string;
      review_state: "approved" | "rejected";
      reviewed_by: string | null;
      reviewed_at: string;
      review_note: string | null;
      content_type: string;
      task_id: string | null;
      principal_id: string | null;
      generated_title: string | null;
      prompt: string | null;
    }[];
    return rows.map((row) => ({
      at: row.reviewed_at,
      kind: "review",
      id: row.artifact_id,
      item: {
        kind: "review",
        artifactId: row.artifact_id,
        ...(row.task_id === null ? {} : { taskId: row.task_id }),
        ...optionalTitle(row.generated_title, row.prompt),
        ...(row.principal_id === null ? {} : { principalId: row.principal_id }),
        state: row.review_state,
        decidedBy: row.reviewed_by,
        decidedAt: row.reviewed_at,
        note: row.review_note === null ? null : clip(row.review_note, 2000),
        contentType: row.content_type,
      },
    }));
  }

  #connects(
    filters: HistoryFilters,
    states: readonly ApprovalHistoryState[],
    cursor: z.infer<typeof HistoryCursorSchema> | undefined,
  ): Keyed[] {
    if (states.length === 0) return [];
    const where = [
      "w.state = 'settled'",
      "w.settled_at IS NOT NULL",
      "w.connect_json IS NOT NULL",
      "t.workspace_id = ?",
      `${CONNECT_STATE_SQL("w")} IN (${states.map(() => "?").join(", ")})`,
    ];
    const params: (string | number)[] = [filters.workspaceId, ...states];
    this.#common(where, params, filters, "w.settled_at", "w.task_id");
    const after = afterCursor("connect", "w.settled_at", "w.wait_id", cursor);
    if (after !== undefined) {
      where.push(after.sql);
      params.push(...after.params);
    }
    const rows = this.#db()
      .prepare(`SELECT w.wait_id, w.task_id, w.settled_at, ${CONNECT_STATE_SQL("w")} AS state, json_extract(w.connect_json, '$.appName') AS app_name, w.settled_by,
          t.principal_id, COALESCE(NULLIF(trim(t.title_override), ''), t.title) AS generated_title, ${TASK_PROMPT_SQL("t")} AS prompt
        FROM tavi_agent_wait_intents w JOIN tavi_tasks t ON t.task_id = w.task_id
        WHERE ${where.join(" AND ")} ORDER BY w.settled_at DESC, w.wait_id DESC LIMIT ?`)
      .all(...params, filters.limit + 1) as {
      wait_id: string;
      task_id: string;
      settled_at: string;
      state: "connected" | "declined" | "expired" | "cancelled";
      app_name: string | null;
      settled_by: string | null;
      principal_id: string;
      generated_title: string | null;
      prompt: string | null;
    }[];
    return rows.map((row) => ({
      at: row.settled_at,
      kind: "connect",
      id: row.wait_id,
      item: {
        kind: "connect",
        waitId: row.wait_id,
        taskId: row.task_id,
        ...optionalTitle(row.generated_title, row.prompt),
        principalId: row.principal_id,
        state: row.state,
        appName: clip(row.app_name ?? "an app", 80),
        decidedAt: row.settled_at,
        ...(row.settled_by === null ? {} : { decidedBy: row.settled_by }),
      },
    }));
  }

  #questions(
    filters: HistoryFilters,
    states: readonly ApprovalHistoryState[],
    cursor: z.infer<typeof HistoryCursorSchema> | undefined,
  ): Keyed[] {
    if (states.length === 0) return [];
    // A question to a person is a bare-deadline wait (`apps/cli/src/runtime/asking.ts`): no
    // correlation and no worker. Only such a wait is read for a question.
    const where = [
      "w.state = 'settled'",
      "w.settled_at IS NOT NULL",
      "w.correlation_id IS NULL",
      "w.waiting_on_worker_task_id IS NULL",
      // A connect wait carries words for its suspension, but is no question.
      "w.connect_json IS NULL",
      "t.workspace_id = ?",
      `${QUESTION_STATE_SQL("w")} IN (${states.map(() => "?").join(", ")})`,
      `${QUESTION_SQL("w")} IS NOT NULL`,
    ];
    const params: (string | number)[] = [filters.workspaceId, ...states];
    this.#common(where, params, filters, "w.settled_at", "w.task_id");
    const after = afterCursor("question", "w.settled_at", "w.wait_id", cursor);
    if (after !== undefined) {
      where.push(after.sql);
      params.push(...after.params);
    }
    const rows = this.#db()
      .prepare(`WITH page AS (
          SELECT w.wait_id FROM tavi_agent_wait_intents w JOIN tavi_tasks t ON t.task_id = w.task_id
          WHERE ${where.join(" AND ")} ORDER BY w.settled_at DESC, w.wait_id DESC LIMIT ?
        )
        SELECT w.wait_id, w.task_id, w.settled_at, ${QUESTION_STATE_SQL("w")} AS state,
          substr(${QUESTION_SQL("w")}, 1, ${APPROVAL_HISTORY_TEXT_MAX_CHARS + 1}) AS question,
          substr(json_extract(w.settled_outcome_json, '$.replyText'), 1, ${APPROVAL_HISTORY_TEXT_MAX_CHARS + 1}) AS reply,
          json_extract(w.settled_outcome_json, '$.answers') AS answers, w.settled_by, w.settled_via,
          t.principal_id, COALESCE(NULLIF(trim(t.title_override), ''), t.title) AS generated_title, ${TASK_PROMPT_SQL("t")} AS prompt
        FROM page JOIN tavi_agent_wait_intents w ON w.wait_id = page.wait_id JOIN tavi_tasks t ON t.task_id = w.task_id`)
      .all(...params, filters.limit + 1) as {
      wait_id: string;
      task_id: string;
      settled_at: string;
      state: "answered" | "expired" | "cancelled";
      question: string;
      reply: string | null;
      answers: string | null;
      settled_by: string | null;
      settled_via: string | null;
      principal_id: string;
      generated_title: string | null;
      prompt: string | null;
    }[];
    return rows.map((row) => {
      const answer = row.state !== "answered" ? null : (row.reply ?? answersText(row.answers));
      return {
        at: row.settled_at,
        kind: "question",
        id: row.wait_id,
        item: {
          kind: "question",
          waitId: row.wait_id,
          taskId: row.task_id,
          ...optionalTitle(row.generated_title, row.prompt),
          principalId: row.principal_id,
          state: row.state,
          question: clip(row.question, APPROVAL_HISTORY_TEXT_MAX_CHARS),
          answer: answer === null ? null : clip(answer, APPROVAL_HISTORY_TEXT_MAX_CHARS),
          decidedAt: row.settled_at,
          ...(row.settled_by === null ? {} : { decidedBy: row.settled_by }),
          ...(row.settled_via === null ? {} : { via: row.settled_via }),
        },
      };
    });
  }

  /** The filters every source shares: the decision's time window, its task (`taskColumn`), and the task's person (`t`). */
  #common(where: string[], params: (string | number)[], filters: HistoryFilters, decidedAt: string, taskColumn: string): void {
    if (filters.taskId !== undefined) {
      where.push(`${taskColumn} = ?`);
      params.push(filters.taskId);
    }
    if (filters.since !== undefined) {
      where.push(`${decidedAt} >= ?`);
      params.push(filters.since);
    }
    if (filters.until !== undefined) {
      where.push(`${decidedAt} <= ?`);
      params.push(filters.until);
    }
    if (filters.principalId !== undefined) {
      where.push("t.principal_id = ?");
      params.push(filters.principalId);
    }
  }
}

/** A stored approval state as the history names it: a denial by the expiry policy is `expired`. */
function approvalState(state: string, decidedBy: string | null): "granted" | "denied" | "expired" | "cancelled" {
  if (state === "denied" && decidedBy === APPROVAL_EXPIRED_DECIDER) return "expired";
  if (state === "granted" || state === "denied" || state === "cancelled") return state;
  throw new TaviError("INTERNAL", `approval state ${JSON.stringify(state)} is not a decision`);
}

/** The options chosen, when a question's answer was kept only as its labels. */
function answersText(answers: string | null): string | null {
  if (answers === null) return null;
  try {
    const labels = JSON.parse(answers) as unknown;
    return Array.isArray(labels) && labels.every((label) => typeof label === "string") && labels.length > 0 ? labels.join(", ") : null;
  } catch {
    return null;
  }
}
