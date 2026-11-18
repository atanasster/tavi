import { TASK_NEEDS_CTE } from "./task-needs.js";
import { z } from "zod";
import {
  PLUMBING_ORIGINS_SQL,
  TOPIC_CONVERSATION_SEPARATOR,
  REMINDER_TASK_KEY_ISO_LENGTH,
  REMINDER_TASK_KEY_PREFIX,
  TASK_CHANNEL_LABEL_MAX,
  TASK_LIST_DEFAULT_LIMIT,
  TASK_LIST_ORDERS,
  TASK_NEEDS,
  TASK_NEEDS_LIMIT,
  TASK_PROMPT_TEXT_MAX,
  TASK_TITLE_MAX,
  TASK_PROMPTS_LIMIT,
  TaskListFiltersSchema,
  TaskListResultSchema,
  TaskPromptsFiltersSchema,
  TaskPromptsResultSchema,
  TaviError,
  type TaskChannel,
  type TaskListFilters,
  type TaskListResult,
  type TaskPromptsFilters,
  type TaskPromptsResult,
} from "@tavi/contracts";
import { clip } from "@tavi/contracts/util";
import { sha256Hex } from "@tavi/node-kit";
import type { Database } from "./sqlite-loader.js";

// The order is in the scope hash too; carrying it names which column `at` is.
// `home`: the last row shown was a Home listed first; absent otherwise.
const Cursor = z
  .object({
    v: z.literal(1),
    at: z.string().datetime(),
    id: z.string().min(1).max(128),
    scope: z.string(),
    order: z.enum(TASK_LIST_ORDERS),
    home: z.literal(true).optional(),
  })
  .strict();
/**
 * Task `t` is plumbing, not a chat (`PLUMBING_ORIGINS`): a heartbeat tick
 * or an idea's prepared step
 * — never listed, counted or shown as a day's work.
 */
export const IS_PLUMBING_TASK = `COALESCE(t.origin, '') IN (${PLUMBING_ORIGINS_SQL})`;
/** Whether task `t` is a delegation worker: nested under its root unless `includeDelegated` asks for its own row. */
export const IS_DELEGATION_WORKER = "EXISTS(SELECT 1 FROM tavi_agent_delegation_admissions d WHERE d.worker_task_id=t.task_id)";
/** The first 256 characters of task `t`'s starting prompt, or NULL: what a task's title and preview are read from. */
export const TASK_PROMPT_SQL = (t: string) =>
  `(SELECT substr(json_extract(adm.intent, '$.prompt'), 1, 256) FROM tavi_admissions adm WHERE adm.task_id=${t}.task_id AND adm.kind='start' ORDER BY adm.created_at, adm.admission_id LIMIT 1)`;
/**
 * Whether admission `a` is a follow-up prompt: a reply that carries text. A
 * system wake is a reply with an empty prompt; a refused reply never ran.
 */
export const FOLLOW_UP_SQL = (a: string) =>
  `(${a}.kind='reply' AND ${a}.state<>'refused' AND json_type(${a}.intent, '$.prompt')='text' AND trim(json_extract(${a}.intent, '$.prompt'), ' '||char(9,10,13))<>'')`;
/** The reminder id in a reminder task's operation key `k` (`reminderTaskOperationKey`): `reminder:<id>:<ISO instant>`. */
const REMINDER_ID_SQL = (k: string) =>
  `CASE WHEN substr(${k}, 1, ${REMINDER_TASK_KEY_PREFIX.length})='${REMINDER_TASK_KEY_PREFIX}' AND length(${k}) > ${REMINDER_TASK_KEY_PREFIX.length + REMINDER_TASK_KEY_ISO_LENGTH + 1}
    THEN substr(${k}, ${REMINDER_TASK_KEY_PREFIX.length + 1}, length(${k}) - ${REMINDER_TASK_KEY_PREFIX.length + REMINDER_TASK_KEY_ISO_LENGTH + 1}) END`;
/** A task's title: the first line of its prompt, clipped with an ellipsis to TASK_TITLE_MAX. */
const taskTitleOf = (prompt: string): string => clip(prompt.split(/\r?\n/)[0]!.trim(), TASK_TITLE_MAX);
/**
 * The title a task is shown under: its generated title when it has one, else
 * the first line of its prompt; undefined when neither says anything.
 */
export function displayTitleOf(generated: string | null, prompt: string | null): string | undefined {
  if (typeof generated === "string" && generated.trim() !== "") return clip(generated, TASK_TITLE_MAX);
  if (typeof prompt === "string" && taskTitleOf(prompt).trim() !== "") return taskTitleOf(prompt);
  return undefined;
}
/**
 * The title the chat list shows a task under (`queryTaskList`), and where it
 * came from: the reader's rename, then Home, then its generated title, then
 * the first line of its prompt; undefined when it has none of them.
 */
export function listedTitleOf(row: {
  readonly title_override: string | null;
  readonly chat_kind: string | null;
  readonly title: string | null;
  readonly prompt: string | null;
}): { readonly title: string; readonly titleSource: "reader" | "home" | "generated" | "prompt" } | undefined {
  if (typeof row.title_override === "string" && row.title_override.length > 0)
    return { title: clip(row.title_override, TASK_TITLE_MAX), titleSource: "reader" };
  // A Home is called Home, whatever was asked in it.
  if (row.chat_kind === "home") return { title: "Home", titleSource: "home" };
  if (typeof row.title === "string" && row.title.length > 0) return { title: clip(row.title, TASK_TITLE_MAX), titleSource: "generated" };
  if (typeof row.prompt === "string") return { title: taskTitleOf(row.prompt), titleSource: "prompt" };
  return undefined;
}
/**
 * Task `t`'s channel kind, as `channelOf` names it from the page's columns: a
 * routine's run first, then the origin; a messaging task's kind is its first
 * conversation's provider, or `messaging` when none was recorded. NULL for
 * a task with no origin that no routine ran.
 */
const CHANNEL_KIND_SQL = (t: string) => `CASE
    WHEN EXISTS(SELECT 1 FROM tavi_routine_runs rr JOIN tavi_routines r ON r.routine_id=rr.routine_id WHERE rr.task_id=${t}.task_id AND rr.workspace_id=${t}.workspace_id) THEN 'routine'
    WHEN ${t}.origin='messaging' THEN COALESCE((SELECT c.provider_id
      FROM tavi_messaging_conversation_tasks c WHERE c.task_id=${t}.task_id ORDER BY c.created_at, c.connection_id LIMIT 1), 'messaging')
    WHEN ${t}.origin IN ('reminder', 'schedule', 'agent', 'web') THEN ${t}.origin
    WHEN ${t}.origin IN ('cli', 'ipc') THEN 'terminal'
  END`;
/**
 * Indexed, bounded session projection. Inbox filters deliberately bypass pagination.
 *
 * A row's `chatNotes` is not read here: memory is read through its service
 * only, so the owner adds each shown chat's count from
 * `MemoryServicePort.counts` after the page query.
 */
export function queryTaskList(db: Database, input: TaskListFilters): TaskListResult {
  const filters = TaskListFiltersSchema.parse(input);
  const needs = filters.needs ?? [];
  const inbox = needs.length > 0;
  const limit = inbox ? TASK_NEEDS_LIMIT : (filters.limit ?? TASK_LIST_DEFAULT_LIMIT);
  const order = filters.order ?? "updated";
  // The column the order, the keyset and since/until all read.
  const column = order === "created" ? "created_at" : "updated_at";
  const nested = !inbox && filters.includeDelegated !== true;
  // A Home is listed first: on the first page of a list by
  // last touch, whatever touched since, and on no later page. A list by
  // creation day (the Center's) or the needs inbox keeps its own order.
  const homeFirst = !inbox && order === "updated";
  // The newer filters join the hash only when set, so a cursor issued without them stays valid.
  const narrowed =
    filters.principalId === undefined && filters.channelKinds === undefined
      ? []
      : [filters.principalId ?? null, filters.channelKinds ?? null];
  // As the filters before them: in the hash only when set.
  const kinds =
    filters.chatKinds === undefined && filters.parentChatId === undefined ? [] : [filters.chatKinds ?? null, filters.parentChatId ?? null];
  const scope = sha256Hex(
    JSON.stringify([
      filters.workspaceId,
      filters.status,
      filters.origin,
      filters.since,
      filters.until,
      filters.query,
      order,
      nested,
      ...narrowed,
      ...kinds,
    ]),
  );
  const params: (string | number)[] = [];
  const where: string[] = [];
  const add = (sql: string, ...values: (string | number)[]) => {
    where.push(sql);
    params.push(...values);
  };
  if (filters.workspaceId !== undefined) add("workspace_id = ?", filters.workspaceId);
  if (filters.since !== undefined) add(`${column} >= ?`, filters.since);
  if (filters.until !== undefined) add(`${column} <= ?`, filters.until);
  if (nested) where.push("worker = 0");
  // Plumbing — a heartbeat tick, an idea's prepared step — is never a row of the list, whatever the filters (principle 9).
  where.push(`COALESCE(origin, '') NOT IN (${PLUMBING_ORIGINS_SQL})`);
  if (filters.status?.length) add(`session_status IN (${filters.status.map(() => "?").join(",")})`, ...filters.status);
  if (filters.origin?.length) {
    // A filter for `ipc` also matches the canvas runs recorded as `web`.
    const origins = [...new Set(filters.origin.flatMap((origin) => (origin === "ipc" ? ["ipc", "web"] : [origin])))];
    add(`origin IN (${origins.map(() => "?").join(",")})`, ...origins);
  }
  if (filters.principalId !== undefined) add("principal_id = ?", filters.principalId);
  if (filters.channelKinds?.length) add(`channel_kind IN (${filters.channelKinds.map(() => "?").join(",")})`, ...filters.channelKinds);
  // `chat` is a task recorded with no kind: an ordinary chat.
  if (filters.chatKinds?.length) {
    const named = filters.chatKinds.filter((kind) => kind !== "chat");
    const clauses = [
      ...(named.length ? [`chat_kind IN (${named.map(() => "?").join(",")})`] : []),
      ...(filters.chatKinds.includes("chat") ? ["chat_kind IS NULL"] : []),
    ];
    add(`(${clauses.join(" OR ")})`, ...named);
  }
  if (filters.parentChatId !== undefined) add("parent_chat_id = ?", filters.parentChatId);
  const query = filters.query;
  if (query) {
    const searched = ["prompt", "final_text", "title", "title_override", "summary"];
    add(`(${searched.map((column) => `instr(lower(COALESCE(${column}, '')), lower(?)) > 0`).join(" OR ")})`, ...searched.map(() => query));
  }
  if (inbox) {
    const columns = { approval: "approval", review: "review", question: "question", handoff: "handoff", connect: "connect_need" } as const;
    where.push(`(${needs.map((need) => `${columns[need]} = 1`).join(" OR ")})`);
  } else if (filters.cursor !== undefined) {
    try {
      const cursor = Cursor.parse(JSON.parse(Buffer.from(filters.cursor, "base64url").toString("utf8")));
      if (cursor.scope !== scope || cursor.order !== order) throw new Error("scope changed");
      // Paged over the whole sort key: Homes first, then the rest. After a Home, the
      // Homes after it and every other row follow; after any other row, no Home does.
      if (homeFirst && cursor.home === true) {
        add(
          `((chat_kind IS 'home' AND (${column} < ? OR (${column} = ? AND task_id < ?))) OR chat_kind IS NOT 'home')`,
          cursor.at,
          cursor.at,
          cursor.id,
        );
      } else {
        add(`(${column} < ? OR (${column} = ? AND task_id < ?))`, cursor.at, cursor.at, cursor.id);
        if (homeFirst) where.push("chat_kind IS NOT 'home'");
      }
    } catch {
      throw new TaviError("INVALID_INPUT", "Invalid session cursor; restart the list query");
    }
  }
  const rows = db
    .prepare(`WITH RECURSIVE ${TASK_NEEDS_CTE}, facts AS (
    SELECT t.task_id, t.workspace_id, t.principal_id, t.origin, t.origin_schedule_id, t.operation_key, t.created_at, t.updated_at, t.final_text, t.tool_count,
      t.title, t.title_override, t.summary, t.summary_state, t.chat_kind, t.parent_chat_id, t.memory_mode,
      ${IS_DELEGATION_WORKER} AS worker,
      (SELECT COALESCE(d.root_task_id, d.parent_task_id) FROM tavi_agent_delegation_admissions d WHERE d.worker_task_id=t.task_id) AS root_task_id,
      -- A worker with neither id is counted nowhere rather than guessed at.
      (SELECT count(*) FROM tavi_agent_delegation_admissions d WHERE d.workspace_id=t.workspace_id AND d.worker_task_id<>t.task_id
        AND (d.root_task_id=t.task_id OR (d.root_task_id IS NULL AND d.parent_task_id=t.task_id))) AS delegated,
      ${TASK_PROMPT_SQL("t")} AS prompt,
      (SELECT count(*) FROM tavi_admissions a WHERE a.task_id=t.task_id) AS admissions,
      EXISTS(SELECT 1 FROM needs n WHERE n.task_id=t.task_id AND n.workspace_id=t.workspace_id AND n.need='approval') AS approval,
      EXISTS(SELECT 1 FROM needs n WHERE n.task_id=t.task_id AND n.workspace_id=t.workspace_id AND n.need='review') AS review,
      EXISTS(SELECT 1 FROM needs n WHERE n.task_id=t.task_id AND n.workspace_id=t.workspace_id AND n.need='question') AS question,
      EXISTS(SELECT 1 FROM needs n WHERE n.task_id=t.task_id AND n.workspace_id=t.workspace_id AND n.need='handoff') AS handoff,
      EXISTS(SELECT 1 FROM needs n WHERE n.task_id=t.task_id AND n.workspace_id=t.workspace_id AND n.need='connect') AS connect_need,
      (SELECT group_concat(DISTINCT n.need) FROM needs n WHERE n.task_id=t.task_id AND n.workspace_id=t.workspace_id AND n.via_child=0) AS own_needs,
      (SELECT group_concat(DISTINCT n.need) FROM needs n WHERE n.task_id=t.task_id AND n.workspace_id=t.workspace_id AND n.via_child=1) AS descendant_needs,
      ${CHANNEL_KIND_SQL("t")} AS channel_kind,
      -- A Home never ends: between turns it is idle, never completed or failed.
      CASE WHEN t.chat_kind = 'home' AND t.status IN ('completed', 'failed', 'stopped') THEN 'idle'
        ELSE CASE t.status WHEN 'admitted' THEN 'submitted' WHEN 'running' THEN 'working' WHEN 'waiting' THEN 'input-required'
        WHEN 'completed' THEN 'completed' WHEN 'cancelled' THEN 'canceled' WHEN 'failed' THEN 'failed' WHEN 'stopped' THEN 'stopped'
        ELSE 'unknown' END END AS session_status
    FROM tavi_tasks t
  ), page AS (
    SELECT task_id, workspace_id, principal_id, origin, origin_schedule_id, operation_key, created_at, updated_at, substr(final_text,1,256) AS final_text,
      tool_count, title, title_override, summary, summary_state, chat_kind, parent_chat_id, memory_mode, prompt, admissions, approval, review, question, handoff, connect_need, own_needs, descendant_needs, session_status, root_task_id, delegated FROM facts ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY ${homeFirst ? "(chat_kind IS 'home') DESC, " : ""}${column} DESC, task_id DESC LIMIT ?
  )
  -- Read for the page only: where each shown task came from, and its follow-ups.
  SELECT page.*,
    (SELECT r.name FROM tavi_routine_runs rr JOIN tavi_routines r ON r.routine_id=rr.routine_id
      WHERE rr.task_id=page.task_id AND rr.workspace_id=page.workspace_id ORDER BY rr.claimed_at, rr.run_id LIMIT 1) AS routine_name,
    CASE WHEN page.origin='messaging' THEN (SELECT c.connection_id FROM tavi_messaging_conversation_tasks c WHERE c.task_id=page.task_id ORDER BY c.created_at, c.connection_id LIMIT 1) END AS connection_id,
    CASE WHEN page.origin='messaging' THEN (SELECT c.provider_id FROM tavi_messaging_conversation_tasks c WHERE c.task_id=page.task_id ORDER BY c.created_at, c.connection_id LIMIT 1) END AS provider_id,
    -- A conversation's Home: the active epoch of a channel's DM or group, never the local connection's or a topic's.
    CASE WHEN page.origin='messaging' AND page.chat_kind IS NULL THEN (SELECT json_object('kind', c.conversation_kind, 'epoch', c.epoch)
      FROM tavi_messaging_conversation_tasks c WHERE c.task_id=page.task_id AND c.active=1 AND substr(c.connection_id, 1, 6)<>'local-'
        AND instr(c.external_conversation_id, '${TOPIC_CONVERSATION_SEPARATOR}')=0 ORDER BY c.created_at LIMIT 1) END AS conversation_home,
    CASE WHEN page.origin='reminder' THEN (SELECT m.text FROM tavi_reminders m WHERE m.workspace_id=page.workspace_id AND m.reminder_id=${REMINDER_ID_SQL("page.operation_key")}) END AS reminder_text,
    CASE WHEN page.origin='schedule' THEN (SELECT s.name FROM tavi_schedules s WHERE s.schedule_id=page.origin_schedule_id AND s.workspace_id=page.workspace_id) END AS schedule_name,
    (SELECT count(*) FROM tavi_admissions a WHERE a.task_id=page.task_id AND ${FOLLOW_UP_SQL("a")}) AS follow_ups,
    -- The chat's own instructions in force (its latest revision, not blank).
    -- Blank as the runtime reads it: whitespace of any kind, not spaces alone.
    EXISTS(SELECT 1 FROM tavi_chat_instructions c WHERE c.task_id=page.task_id AND trim(c.text, ' '||char(9)||char(10)||char(11)||char(12)||char(13))<>''
      AND c.revision=(SELECT max(c2.revision) FROM tavi_chat_instructions c2 WHERE c2.task_id=page.task_id)) AS chat_instructions
  FROM page ORDER BY ${homeFirst ? "(chat_kind IS 'home') DESC, " : ""}${column} DESC, task_id DESC`)
    .all(...params, limit + 1) as {
    routine_name: string | null;
    connection_id: string | null;
    provider_id: string | null;
    conversation_home: string | null;
    reminder_text: string | null;
    schedule_name: string | null;
    follow_ups: number;
    chat_instructions: number;

    task_id: string;
    workspace_id: string;
    principal_id: string;
    origin: string | null;
    created_at: string;
    updated_at: string;
    root_task_id: string | null;
    delegated: number;
    final_text: string | null;
    tool_count: number | null;
    prompt: string | null;
    title: string | null;
    title_override: string | null;
    summary: string | null;
    summary_state: string | null;
    chat_kind: string | null;
    parent_chat_id: string | null;
    memory_mode: string | null;
    own_needs: string | null;
    descendant_needs: string | null;
    admissions: number;
    approval: number;
    review: number;
    question: number;
    handoff: number;
    connect_need: number;
    session_status: string;
  }[];
  const truncated = rows.length > limit;
  const shown = rows.slice(0, limit);
  const last = shown.at(-1);
  return TaskListResultSchema.parse({
    action: "list",
    truncated,
    ...(!inbox && truncated && last
      ? {
          nextCursor: Buffer.from(
            JSON.stringify({
              v: 1,
              at: order === "created" ? last.created_at : last.updated_at,
              id: last.task_id,
              scope,
              order,
              ...(homeFirst && last.chat_kind === "home" ? { home: true } : {}),
            }),
          ).toString("base64url"),
        }
      : {}),
    rows: shown.map((row) => ({
      taskId: row.task_id,
      workspaceId: row.workspace_id,
      principalId: row.principal_id,
      status: row.session_status,
      origin: row.origin,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      delegated: row.delegated,
      ...(row.root_task_id === null ? {} : { rootTaskId: row.root_task_id }),
      ...(typeof row.prompt === "string" ? { promptPreview: row.prompt.slice(0, 256) } : {}),
      ...listedTitleOf(row),
      summary: typeof row.summary === "string" && row.summary.length > 0 ? row.summary : null,
      summaryState: row.summary_state,
      ...(row.final_text === null ? {} : { lastText: clip(row.final_text, 256) }),
      needs: [
        row.approval ? "approval" : null,
        row.review ? "review" : null,
        row.question ? "question" : null,
        row.handoff ? "handoff" : null,
        row.connect_need ? "connect" : null,
      ].filter(Boolean),
      ownNeeds: TASK_NEEDS.filter((need) => row.own_needs?.split(",").includes(need) === true),
      ...(row.descendant_needs ? { descendantNeeds: row.descendant_needs.split(",") } : {}),
      counts: { admissions: row.admissions, tools: row.tool_count },
      ...optional("channel", channelOf(row)),
      followUps: row.follow_ups,
      ...(row.chat_instructions === 1 ? { chatInstructions: true } : {}),
      ...(row.chat_kind === null ? {} : { chatKind: row.chat_kind }),
      ...(row.parent_chat_id === null ? {} : { parentChatId: row.parent_chat_id }),
      ...(row.memory_mode === null ? {} : { memoryMode: row.memory_mode }),
      ...optional("conversationHome", conversationHomeOf(row.conversation_home)),
    })),
  });
}

/** A conversation Home's facts from the mapping row the list joined: its kind, as the conversation recorded it, and its epoch. */
function conversationHomeOf(json: string | null): { readonly kind: "direct" | "group"; readonly epoch: number } | undefined {
  if (json === null) return undefined;
  const mapping = JSON.parse(json) as { readonly kind: string | null; readonly epoch: number | null };
  return { kind: mapping.kind === "group" ? "group" : "direct", epoch: mapping.epoch ?? 0 };
}

const optional = <K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } =>
  (value === undefined ? {} : { [key]: value }) as { [P in K]?: V };
const labelled = (kind: TaskChannel["kind"], label: string | null): TaskChannel =>
  label === null || label.trim() === "" ? { kind } : { kind, label: clip(label, 256) };

/**
 * Where a task came from. A routine's run is
 * named first, whatever origin its task records; then the origin decides.
 * Undefined for a task with no origin that no routine ran.
 */
function channelOf(row: {
  origin: string | null;
  routine_name: string | null;
  connection_id: string | null;
  provider_id: string | null;
  reminder_text: string | null;
  schedule_name: string | null;
}): TaskChannel | undefined {
  if (row.routine_name !== null) return labelled("routine", row.routine_name);
  switch (row.origin) {
    // A messaging task's kind is its conversation's provider.
    case "messaging":
      return labelled(row.provider_id ?? "messaging", row.connection_id);
    case "reminder":
      return labelled("reminder", row.reminder_text === null ? null : clip(row.reminder_text, TASK_CHANNEL_LABEL_MAX));
    case "schedule":
      return labelled("schedule", row.schedule_name);
    case "agent":
      return { kind: "agent" };
    case "web":
      return { kind: "web" };
    case "cli":
    case "ipc":
      return { kind: "terminal" };
    default:
      return undefined;
  }
}

/**
 * A task's follow-up prompts, oldest first (`tasks prompts`). Undefined when
 * the task does not exist, or is in another workspace than the one named.
 */
export function queryTaskPrompts(db: Database, input: TaskPromptsFilters): TaskPromptsResult | undefined {
  const { taskId, workspaceId } = TaskPromptsFiltersSchema.parse(input);
  const task = db.prepare("SELECT workspace_id FROM tavi_tasks WHERE task_id=?").get(taskId) as { workspace_id: string } | undefined;
  if (task === undefined || (workspaceId !== undefined && task.workspace_id !== workspaceId)) return undefined;
  const rows = db
    .prepare(`SELECT a.created_at AS at, substr(json_extract(a.intent, '$.prompt'), 1, ${TASK_PROMPT_TEXT_MAX}) AS text FROM tavi_admissions a
    WHERE a.task_id=? AND ${FOLLOW_UP_SQL("a")} ORDER BY a.created_at, a.admission_id LIMIT ?`)
    .all(taskId, TASK_PROMPTS_LIMIT + 1) as { at: string; text: string }[];
  return TaskPromptsResultSchema.parse({
    action: "prompts",
    truncated: rows.length > TASK_PROMPTS_LIMIT,
    // SQLite counts characters, JavaScript UTF-16 units: clipped again here so an astral character cannot overrun the bound.
    items: rows.slice(0, TASK_PROMPTS_LIMIT).map((row) => ({ at: row.at, text: row.text.slice(0, TASK_PROMPT_TEXT_MAX) })),
  });
}
