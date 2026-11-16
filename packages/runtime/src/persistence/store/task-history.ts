import { PLUMBING_ORIGINS_SQL, type MemoryReach, type PastChatHit, TOPIC_CONVERSATION_SEPARATOR } from "@tavi/contracts";
import { TASK_PROMPT_SQL, listedTitleOf } from "../task-list.js";
import type { StoreContext } from "./context.js";

/** Rows `searchTaskHistory` reads a page at a time, and at most in all. */
const SEARCH_PAGE_ROWS = 200;

const SEARCH_SCAN_ROWS = 5_000;

/** The most terms `searchTaskHistory` matches: `retrievalKeywordsFrom`'s own default bound. */
const SEARCH_MAX_TERMS = 24;

const COMBINING_MARK = /\p{M}/u;

/**
 * Cased Greek and Cyrillic letters whose case the trigram tokenizer folds as `toLocaleLowerCase` does:
 * every character that lowercases to one of them is folded to the same trigram (the final and medial
 * sigma included). Left out are the few newer letters it does not fold (`Ϳ` → `ϳ`, U+0528 and later).
 */
const FTS_FOLDED = /[\u0370-\u03f2\u03f4-\u0527]/u;

/**
 * Past conversations that mention any of `terms`, best first: a turn's prompt (its admission's intent) or its final answer
 * (its result), for one principal in one workspace. Each term is a
 * lexical, case-insensitive substring match — the admission record is what
 * is durable about a turn, and it is small. One hit per chat, ranked by how
 * many of the terms its turns hold, then by its newest matching turn. The
 * excerpt is 300 characters around the first match in the turn that held
 * the most terms, and `at` is that turn's admission time. The caller builds
 * the terms (`retrievalKeywordsFrom` with CJK bigrams, in
 * `assistant-tools.ts`); at most `SEARCH_MAX_TERMS` are read.
 *
 * Left out: a heartbeat tick, a `run` task, and a chat begun in a
 * messaging conversation — whose words may be anyone's — unless the caller
 * (`excludeTaskId`) is a chat of that same conversation, an earlier epoch's
 * included. With `reach: "chat-only"` (a group conversation)
 * only chats of the caller's own conversation are searched — its epochs and
 * its forum topics' side chats — never the person's Home or other chats.
 * A delegated worker is judged by its delegation root's origin and
 * conversation, so a messaging chat's worker is reached only as its root is.
 * Nor a chat whose memory is off or private, a side chat of one at any
 * depth, or a worker of one, nor what a chat said before its memory — or
 * any parent's, or its root's — was last turned back on (invariant
 * 25). A worker of a `run` or a heartbeat tick is left out as its
 * root is.
 */
export function searchTaskHistory(
  store: StoreContext,
  input: {
    readonly workspaceId: string;
    readonly principalId: string;
    readonly terms: readonly string[];
    readonly limit: number;
    readonly excludeTaskId?: string;
    readonly reach?: MemoryReach;
  },
): readonly PastChatHit[] {
  // The decoded text has its whitespace collapsed, so each term is too.
  const terms = [
    ...new Set(input.terms.map((term) => term.replace(/\s+/g, " ").trim().toLocaleLowerCase()).filter((term) => term !== "")),
  ].slice(0, SEARCH_MAX_TERMS);
  if (terms.length === 0) return [];
  const limit = Math.max(1, Math.min(input.limit, 50));
  // SQL narrows; the decoded text decides. Each term is narrowed by one run of it: its longest stretch
  // of printable characters that are ASCII, have no case (CJK) or are Greek or Cyrillic (`FTS_FOLDED`), so
  // SQLite's folding and `toLocaleLowerCase` agree on every one of them. Any term with no such run means
  // no narrowing at all: a row holding only that term would otherwise be hidden. A run of 3 or more
  // characters is looked up in `tavi_task_history_fts` (migration `0025_task_history_fts`), the trigrams
  // of the same decoded prompts and final texts, so any substring is found. A shorter one (a CJK bigram)
  // has no trigram: it is matched with `LIKE` on the raw JSON, where a quote or a backslash is escaped,
  // so it is escaped as `JSON.stringify` writes it. `LIKE` folds only ASCII, so a shorter run holding a
  // cased Greek or Cyrillic letter is no run. A combining mark, and the letter before it, end a run:
  // lowercased, one capital becomes a letter and a mark (`İ` → `i̇`) that neither folding maps back to it.
  const runs = terms.map((term) => {
    const pieces = [""];
    const chars = [...term];
    chars.forEach((char, index) => {
      const foldsAlike =
        char > " " &&
        (char < "\x80" || char.toLowerCase() === char.toUpperCase() || FTS_FOLDED.test(char)) &&
        !COMBINING_MARK.test(char) &&
        !COMBINING_MARK.test(chars[index + 1] ?? "");
      if (foldsAlike) pieces[pieces.length - 1] += char;
      else pieces.push("");
    });
    return pieces
      .filter(
        (piece) =>
          piece !== "" &&
          ([...piece].length >= 3 || [...piece].every((char) => char < "\x80" || char.toLowerCase() === char.toUpperCase())),
      )
      .sort((a, b) => [...b].length - [...a].length)[0];
  });
  const narrowed = runs.every((run): run is string => run !== undefined);
  const indexed = narrowed ? [...new Set(runs.filter((run) => [...run].length >= 3))] : [];
  const scanned = narrowed
    ? [
        ...new Set(
          runs
            .filter((run) => [...run].length < 3)
            .map(
              (run) =>
                `%${JSON.stringify(run)
                  .slice(1, -1)
                  .replace(/[\\%_]/g, (char) => `\\${char}`)}%`,
            ),
        ),
      ]
    : [];
  const narrowing = narrowed
    ? `AND (${[
        ...(indexed.length > 0
          ? [
              "a.admission_id IN (SELECT m.admission_id FROM tavi_task_history_fts f JOIN tavi_task_history_fts_map m ON m.row_id = f.rowid WHERE tavi_task_history_fts MATCH ?)",
            ]
          : []),
        ...scanned.map(() => "a.intent LIKE ? ESCAPE '\\' OR COALESCE(a.result, '') LIKE ? ESCAPE '\\'"),
      ].join(" OR ")})`
    : "";
  const patterns = [
    ...(indexed.length > 0 ? [indexed.map((run) => `"${run.replaceAll('"', '""')}"`).join(" OR ")] : []),
    ...scanned.flatMap((pattern) => [pattern, pattern]),
  ];
  // Which messaging chats are the caller's own conversation: the same key, or, for a group,
  // the same group — its Home's key or a topic's (`conversationOfKey`) — and then nothing else.
  const groupOf = (column: string) =>
    `CASE instr(${column}, '${TOPIC_CONVERSATION_SEPARATOR}') WHEN 0 THEN ${column} ELSE substr(${column}, 1, instr(${column}, '${TOPIC_CONVERSATION_SEPARATOR}') - 1) END`;
  const chatOnly = input.reach === "chat-only";
  const sameConversation = chatOnly
    ? `${groupOf("mine.external_conversation_id")} = ${groupOf("hit.external_conversation_id")}`
    : "mine.external_conversation_id = hit.external_conversation_id";
  // Newest first, a page at a time, to the scan cap: a chat holding fewer
  // terms may be outranked by an older one holding more, so the scan stops
  // early only once `limit` chats hold every term. A search never reads
  // more than `SEARCH_SCAN_ROWS` rows.
  // A delegated worker is admitted with origin "agent" (agent-communication.ts), so it is judged by its
  // delegation root `r` — joined once, at most one (`worker_task_id` is unique), none for a chat that
  // is not a worker: a worker of a messaging chat is that conversation's words, found only from that
  // conversation (invariant 25), as its root is; a routine's or heartbeat tick's research worker is that
  // run's words, left out as the run is; and a root whose memory is off, or was turned back on after
  // the turn, hides the turn.
  const page = store.handle.prepare(
    `SELECT a.rowid AS row_id, a.task_id, a.created_at, a.intent, a.result
       FROM tavi_admissions a JOIN tavi_tasks t ON t.task_id = a.task_id
       LEFT JOIN tavi_agent_delegation_admissions d ON d.worker_task_id = t.task_id
       LEFT JOIN tavi_tasks r ON r.task_id = COALESCE(d.root_task_id, d.parent_task_id)
      WHERE t.workspace_id = ? AND t.principal_id = ? AND a.task_id != ?
        AND COALESCE(r.origin, t.origin, '') NOT IN (${PLUMBING_ORIGINS_SQL})
        AND COALESCE(r.chat_kind, t.chat_kind) IS NOT 'run'
        AND t.memory_mode IS NULL AND (t.memory_on_at IS NULL OR a.created_at >= t.memory_on_at)
        AND NOT EXISTS (SELECT 1 FROM tavi_tasks p WHERE p.task_id = t.parent_chat_id AND p.memory_mode IS NOT NULL)
        AND (r.task_id IS NULL OR (r.memory_mode IS NULL AND (r.memory_on_at IS NULL OR a.created_at >= r.memory_on_at)))
        AND (${chatOnly ? "" : "COALESCE(r.origin, t.origin) IS NOT 'messaging' OR "}EXISTS (
              SELECT 1 FROM tavi_messaging_conversation_tasks hit
                JOIN tavi_messaging_conversation_tasks mine
                  ON mine.connection_id = hit.connection_id AND ${sameConversation}
               WHERE hit.task_id = COALESCE(r.task_id, a.task_id) AND mine.task_id = ?))
        ${narrowing}
        AND (? IS NULL OR a.created_at < ? OR (a.created_at = ? AND a.rowid < ?))
      ORDER BY a.created_at DESC, a.rowid DESC
      LIMIT ?`,
  );
  const decoded = (raw: string | null): string => {
    if (raw === null) return "";
    try {
      const value = JSON.parse(raw) as { prompt?: unknown; finalText?: unknown };
      return [value.prompt, value.finalText].filter((part): part is string => typeof part === "string").join(" — ");
    } catch {
      return "";
    }
  };
  // The SQL above narrows by the hit's own row, its parent's and its root's; the chat a hit belongs to is
  // judged whole here: the strictest mode and the latest `memory_on_at` along the hit's
  // side-chat chain and, for a worker, its delegation root's and that root's own chain, as `chatMemoryOf`
  // reads them for a turn. A chain longer than 32 parents is off, the narrower answer.
  const taskMemory = store.handle.prepare("SELECT memory_mode, memory_on_at, parent_chat_id FROM tavi_tasks WHERE task_id = ?");
  const rootOf = store.handle.prepare(
    "SELECT COALESCE(d.root_task_id, d.parent_task_id) AS root_id FROM tavi_agent_delegation_admissions d WHERE d.worker_task_id = ?",
  );
  const effective = new Map<string, { readonly off: boolean; readonly onAt?: string }>();
  const effectiveOf = (taskId: string): { readonly off: boolean; readonly onAt?: string } => {
    const known = effective.get(taskId);
    if (known !== undefined) return known;
    let off = false;
    let onAt: string | undefined;
    const root = (rootOf.get(taskId) as { root_id: string | null } | undefined)?.root_id ?? undefined;
    for (const start of root === undefined || root === taskId ? [taskId] : [taskId, root]) {
      let id: string | null = start;
      for (let hop = 0; id !== null && !off; hop += 1) {
        if (hop > 32) {
          off = true;
          break;
        }
        const row = taskMemory.get(id) as
          | { memory_mode: string | null; memory_on_at: string | null; parent_chat_id: string | null }
          | undefined;
        if (row === undefined) break;
        if (row.memory_mode !== null) off = true;
        if (row.memory_on_at !== null && (onAt === undefined || row.memory_on_at > onAt)) onAt = row.memory_on_at;
        id = row.parent_chat_id;
      }
    }
    const state = { off, ...(onAt === undefined ? {} : { onAt }) };
    effective.set(taskId, state);
    return state;
  };
  /** Each chat found, in the order its newest matching turn was read (newest first). */
  const chats = new Map<
    string,
    { readonly matched: Set<number>; best: { readonly count: number; readonly at: string; readonly excerpt: string } }
  >();
  let complete = 0;
  let after: { readonly createdAt: string; readonly rowId: number } | undefined;
  for (let scanned = 0; complete < limit && scanned < SEARCH_SCAN_ROWS; ) {
    const rows = page.all(
      input.workspaceId,
      input.principalId,
      input.excludeTaskId ?? "",
      input.excludeTaskId ?? "",
      ...patterns,
      after?.createdAt ?? null,
      after?.createdAt ?? null,
      after?.createdAt ?? null,
      after?.rowId ?? null,
      Math.min(SEARCH_PAGE_ROWS, SEARCH_SCAN_ROWS - scanned),
    ) as { row_id: number; task_id: string; created_at: string; intent: string; result: string | null }[];
    for (const row of rows) {
      const chatMemory = effectiveOf(row.task_id);
      if (chatMemory.off || (chatMemory.onAt !== undefined && row.created_at < chatMemory.onAt)) continue;
      const text = `${decoded(row.intent)} ${decoded(row.result)}`.replace(/\s+/g, " ").trim();
      const lower = text.toLocaleLowerCase();
      let first = -1;
      const matched: number[] = [];
      terms.forEach((term, index) => {
        const at = lower.indexOf(term);
        if (at < 0) return;
        matched.push(index);
        if (first < 0 || at < first) first = at;
      });
      if (matched.length === 0) continue;
      const from = Math.max(0, first - 120);
      const excerpt = (from > 0 ? "…" : "") + text.slice(from, from + 300);
      const chat = chats.get(row.task_id);
      if (chat === undefined) {
        chats.set(row.task_id, { matched: new Set(matched), best: { count: matched.length, at: row.created_at, excerpt } });
        if (matched.length === terms.length) complete += 1;
        continue;
      }
      const before = chat.matched.size;
      for (const index of matched) chat.matched.add(index);
      if (matched.length > chat.best.count) chat.best = { count: matched.length, at: row.created_at, excerpt };
      if (before < terms.length && chat.matched.size === terms.length) complete += 1;
    }
    const last = rows.at(-1);
    if (last === undefined || rows.length < SEARCH_PAGE_ROWS) break;
    scanned += rows.length;
    after = { createdAt: last.created_at, rowId: last.row_id };
  }
  // More terms first, then the newest; `chats` is already newest first, and the sort is stable.
  const ranked = [...chats].sort((a, b) => b[1].matched.size - a[1].matched.size).slice(0, limit);
  if (ranked.length === 0) return [];
  // A chat whose memory was turned back on — or one any parent of which, or a worker whose delegation
  // root or any of its parents, was — is never named by its generated title nor its prompt: both may
  // hold what was said before (invariant 25).
  const titles = new Map(
    (
      store.handle
        .prepare(`SELECT t.task_id, t.title, t.title_override, t.chat_kind, ${TASK_PROMPT_SQL("t")} AS prompt
        FROM tavi_tasks t WHERE t.task_id IN (${ranked.map(() => "?").join(", ")})`)
        .all(...ranked.map(([taskId]) => taskId)) as {
        task_id: string;
        title: string | null;
        title_override: string | null;
        chat_kind: string | null;
        prompt: string | null;
      }[]
    ).map((row) => [
      row.task_id,
      listedTitleOf(effectiveOf(row.task_id).onAt !== undefined ? { ...row, title: null, prompt: null } : row)?.title,
    ]),
  );
  return ranked.map(([taskId, chat]) => {
    const title = titles.get(taskId);
    return {
      taskId,
      title: title !== undefined && title.trim() !== "" ? title : "Untitled chat",
      at: chat.best.at,
      excerpt: chat.best.excerpt,
    };
  });
}
