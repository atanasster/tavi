import type { TranscriptRepositoryPort } from "./internal-contracts.js";
import {
  CHAT_STEER_STATES,
  ChatNoticeSchema,
  DISPLAY_ONLY_NOTICE_KINDS,
  SOURCE_TASK_NOTICE_KINDS,
  type ChatSteer,
  NOTICE_SUMMARY_MAX,
  NOTICE_TITLE_MAX,
  NOTICES_PAGE_MAX,
  TASK_SUMMARY_TEXT_MAX,
  TRANSCRIPT_PAGE_MAX,
  TRANSCRIPT_TEXT_MAX,
  TranscriptEntrySchema,
  TranscriptTurnSchema,
  type ChatNotice,
  type PostNoticeInput,
  MEMORY_CARD_ITEMS_MAX,
  MEMORY_COMMAND_RECEIPT_KEY_PREFIX,
  MEMORY_LISTING_KEY_PREFIX,
  memoryCardNoticeText,
  memoryDigestNoticeText,
  type MemoryMarkKind,
  type MemoryReviewChat,
  memoryCommandReceiptSurfacePrefix,
  memoryListingKey,
  type MemoryPromptRow,
  type PostMemoryCardInput,
  type PostMemoryListingInput,
  type TranscriptEntry,
  type TranscriptForgetResult,
  type TranscriptRewindResult,
  type TranscriptPage,
  type TranscriptTurn,
  CHAT_FORGET_RELATED_MAX,
  TOPIC_CONVERSATION_SEPARATOR,
  TaviError,
} from "@tavi/contracts";
import { clip, isRecord } from "@tavi/contracts/util";

import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";

import type { Database } from "./sqlite-loader.js";
import { stmt } from "./statement-cache.js";
import { noteErasure } from "./erasure.js";
import { deleteIdeasCiting } from "./ideas-repository.js";

interface EntryRow {
  readonly task_id: string;
  readonly seq: number;
  readonly admission_id: string | null;
  readonly turn_json: string;
  readonly created_at: string;
}

const toEntry = (row: EntryRow): TranscriptEntry =>
  TranscriptEntrySchema.parse({
    taskId: row.task_id,
    seq: row.seq,
    ...(row.admission_id === null ? {} : { admissionId: row.admission_id }),
    turn: JSON.parse(row.turn_json) as unknown,
    createdAt: row.created_at,
  });

interface NoticeRow {
  readonly notice_id: string;
  readonly task_id: string;
  readonly kind: string;
  readonly source_task_id: string | null;
  readonly title: string;
  readonly summary: string;
  readonly after_seq: number;
  readonly created_at: string;
  readonly artifact_id: string | null;
  readonly heartbeat_item_id: string | null;
  /** The source task's generated summary, joined at read time: it is written after the notice. */
  readonly source_summary: string | null;
}

const toNotice = (row: NoticeRow): ChatNotice =>
  ChatNoticeSchema.parse({
    noticeId: row.notice_id,
    taskId: row.task_id,
    kind: row.kind,
    ...(row.source_task_id === null ? {} : { sourceTaskId: row.source_task_id }),
    title: row.title,
    // Kinds about one task take its generated summary — never a `conversation` notice, whose group's or DM's
    // summary reads what third parties wrote. The summarizer's reading of the task: a model's words over text that may quote a page, so untrusted —
    // it reaches the model only inside the fenced notices block, never a system message. A notice that already
    // quotes its run's result under its status line (a scheduled run's) is not joined: it would say it twice.
    summary:
      (SOURCE_TASK_NOTICE_KINDS as ReadonlySet<string>).has(row.kind) &&
      !row.summary.includes("\n") &&
      row.source_summary !== null &&
      row.source_summary.trim() !== ""
        ? `${row.summary} — ${clip(row.source_summary, TASK_SUMMARY_TEXT_MAX)}`.slice(0, NOTICE_SUMMARY_MAX)
        : row.summary,
    afterSeq: row.after_seq,
    ...(row.artifact_id === null ? {} : { artifactId: row.artifact_id }),
    ...(row.heartbeat_item_id === null ? {} : { heartbeatItemId: row.heartbeat_item_id }),
    createdAt: row.created_at,
  });

interface SteerRow {
  readonly steer_id: string;
  readonly task_id: string;
  readonly message_id: string;
  readonly conversation_id: string;
  readonly text: string;
  readonly state: string;
  readonly admission_id: string | null;
  readonly created_at: string;
}

const toSteer = (row: SteerRow): ChatSteer => {
  const state = CHAT_STEER_STATES.find((known) => known === row.state);
  if (state === undefined) throw new Error(`steer ${row.steer_id} has an unknown state ${row.state}`);
  return {
    steerId: row.steer_id,
    taskId: row.task_id,
    messageId: row.message_id,
    conversationId: row.conversation_id,
    text: row.text,
    state,
    ...(row.admission_id === null ? {} : { admissionId: row.admission_id }),
    createdAt: row.created_at,
  };
};

/**
 * What an `epoch` notice or a `folder` notice is posted read
 * by: it is for the person only, so no turn ever claims it — a claim takes
 * only notices read by nobody, and no operation key has this shape.
 */
const DISPLAY_ONLY = "(display-only)";
const readByOf = (kind: string, displayOnly?: true): string | null =>
  displayOnly === true || (DISPLAY_ONLY_NOTICE_KINDS as readonly string[]).includes(kind) ? DISPLAY_ONLY : null;
/** `DISPLAY_ONLY_NOTICE_KINDS` as a SQL list, for the statements that hand claims back. */
const DISPLAY_ONLY_SQL = DISPLAY_ONLY_NOTICE_KINDS.map((kind) => `'${kind}'`).join(", ");

const NOTICE_SELECT = `SELECT n.*, CASE WHEN s.summary_state = 'done' THEN s.summary END AS source_summary
  FROM tavi_chat_notices n LEFT JOIN tavi_tasks s ON s.task_id = n.source_task_id`;
/**
 * A command's listing is a `memory` notice only so its numbers have
 * rows to live in: it is never shown, so every read that shows a chat's
 * notices leaves it out.
 */
const SHOWN_NOTICE = `n.source_key NOT LIKE '${MEMORY_LISTING_KEY_PREFIX}%'`;

/** The text forget leaves in place of what it erased, where a field must stay a non-empty string. */
const ERASED = "(erased)";

/** `raw` with `redact` applied to its parsed JSON; `raw` itself when it does not parse or nothing changed. */
function redactJson(raw: string, redact: (value: Record<string, unknown>) => void): string {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return raw;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return raw;
  redact(value as Record<string, unknown>);
  const next = JSON.stringify(value);
  return next === raw ? raw : next;
}

const record = (value: unknown): Record<string, unknown> | undefined => (isRecord(value) ? value : undefined);

/**
 * An admission's intent without the person's words: its prompt, and a
 * resume's answer to a wait (`waitOutcome`) and decision notes. What its
 * `intent_hash` was computed from is gone with them; the hash stays.
 */
function redactIntent(intent: Record<string, unknown>): void {
  delete intent["prompt"];
  for (const holder of [intent, record(intent["resume"])]) {
    if (holder === undefined) continue;
    delete holder["waitOutcome"];
    delete holder["note"];
    const decisions = holder["decisions"];
    if (Array.isArray(decisions)) for (const decision of decisions) delete record(decision)?.["note"];
  }
}

/**
 * An admission's outcome without the turn's words: its answer and error
 * message, and — once a later admission settled, so the suspension is no
 * longer the round being answered — its question, the question's context and
 * the arguments of the calls it asked about.
 */
function redactResult(result: Record<string, unknown>, superseded: boolean): void {
  if (typeof result["finalText"] === "string") result["finalText"] = "";
  const error = record(result["error"]);
  if (error !== undefined && typeof error["message"] === "string" && error["message"] !== ERASED) error["message"] = ERASED;
  if (!superseded) return;
  const wait = record(result["waitInterrupt"]);
  if (wait !== undefined) {
    delete wait["question"];
    delete wait["context"];
    delete wait["choices"];
    const request = record(wait["wait"]);
    if (request !== undefined) {
      delete request["question"];
      delete request["choices"];
    }
  }
  const requests = record(result["interrupt"])?.["requests"];
  if (Array.isArray(requests)) {
    for (const request of requests) {
      const call = record(request);
      if (call === undefined) continue;
      if (call["input"] !== null) call["input"] = null;
      if (call["summary"] !== ERASED) call["summary"] = ERASED;
      delete call["display"];
      delete call["subjects"];
    }
  }
}

/** How many lost turns one `reconcile` saves; the rest are saved by the next call, still in order. */
const RECONCILE_MAX = 100;

/**
 * Settled `start` and `reply` admissions with a prompt, that ran (an execution
 * claimed them: one refused on a cancelled task never did), with no entry of
 * their own and none for a later admission of the chat — an entry saved after
 * a lost turn's would put the turn out of order, so it stays lost. A turn
 * forget erased has no prompt left and is never saved again.
 */
const UNRECONCILED_FROM = `FROM tavi_admissions a
  WHERE a.state IN ('committed', 'failed') AND a.kind IN ('start', 'reply') AND a.result IS NOT NULL
    AND a.created_at >= @since
    AND json_valid(a.intent) AND json_type(a.intent, '$.prompt') = 'text' AND json_extract(a.intent, '$.prompt') <> ''
    AND EXISTS (SELECT 1 FROM tavi_executions x WHERE x.task_id = a.task_id AND x.admission_id = a.admission_id)
    AND NOT EXISTS (SELECT 1 FROM tavi_transcript_entries e WHERE e.task_id = a.task_id AND e.admission_id = a.admission_id)
    AND NOT EXISTS (SELECT 1 FROM tavi_transcript_entries e JOIN tavi_admissions later ON later.admission_id = e.admission_id
                    WHERE e.task_id = a.task_id AND (later.created_at > a.created_at OR (later.created_at = a.created_at AND later.rowid > a.rowid)))`;

/**
 * A lost turn as its admission row has it: the prompt and the outcome, the
 * same status mapping the turn recorder uses, and no items — the tool cards
 * were never saved, which `truncated` says. Undefined when the row does not read.
 */
function recoveredTurn(kind: string, intentJson: string, resultJson: string): TranscriptTurn | undefined {
  try {
    const intent = record(JSON.parse(intentJson));
    const result = record(JSON.parse(resultJson));
    const prompt = intent?.["prompt"];
    if (result === undefined || typeof prompt !== "string" || prompt === "") return undefined;
    const finalText = typeof result["finalText"] === "string" ? result["finalText"] : "";
    const error = record(result["error"]);
    const status =
      result["status"] === "completed"
        ? "completed"
        : result["status"] === "failed" || result["status"] === "stopped"
          ? result["status"]
          : result["interrupt"] !== undefined
            ? "approval"
            : result["reviewInterrupt"] !== undefined
              ? "review"
              : "waiting";
    const parsed = TranscriptTurnSchema.safeParse({
      admissionKind: kind,
      prompt: prompt.slice(0, TRANSCRIPT_TEXT_MAX),
      items: [],
      truncated: true,
      outcome: {
        status,
        ...(finalText === "" ? {} : { finalText: finalText.slice(0, TRANSCRIPT_TEXT_MAX) }),
        ...(error === undefined || typeof error["code"] !== "string" || typeof error["message"] !== "string"
          ? {}
          : { errorCode: error["code"].slice(0, 64), message: error["message"].slice(0, 2_000) }),
      },
    });
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** The stored labels and provenances whose refs may name a chat (`chat:<task id>`), by table, column and the refs' JSON path. */
const LABELS_NAMING_CHATS = [
  ["tavi_memory_revisions", "provenance_json", "$.refs"],
  ["tavi_routine_revisions", "provenance_json", "$.refs"],
  ["tavi_reminders", "label_json", "$.refs"],
  ["tavi_agent_mailbox", "label_json", "$.refs"],
  ["tavi_artifacts", "label_json", "$.refs"],
  ["tavi_effects", "label_json", "$.refs"],
  ["tavi_heartbeats", "config_json", "$.provenance.refs"],
] as const;

/** A chat's saved history, one row per admission, and its notices. */
export class SqliteTranscriptRepository implements TranscriptRepositoryPort {
  readonly #db: () => Database;
  /** Where an artifact's body is, so an erased message's attachment goes with it; absent, its row goes and its body stays. */
  readonly #artifactFile: ((relativePath: string) => string) | undefined;

  constructor(db: () => Database, artifactFile?: (relativePath: string) => string) {
    this.#db = db;
    this.#artifactFile = artifactFile;
  }

  append(input: {
    readonly taskId: string;
    readonly admissionId?: string;
    readonly turn: TranscriptTurn;
    readonly createdAt: string;
  }): number {
    const turn = TranscriptTurnSchema.parse(input.turn);
    const db = this.#db();
    return db
      .transaction((): number => {
        if (input.admissionId !== undefined) {
          const existing = stmt(db, "SELECT seq FROM tavi_transcript_entries WHERE task_id = ? AND admission_id = ?").get(
            input.taskId,
            input.admissionId,
          ) as { readonly seq: number } | undefined;
          if (existing !== undefined) return existing.seq;
        }
        const next = this.#newestSeq(input.taskId) + 1;
        stmt(db, "INSERT INTO tavi_transcript_entries (task_id, seq, admission_id, turn_json, created_at) VALUES (?, ?, ?, ?, ?)").run(
          input.taskId,
          next,
          input.admissionId ?? null,
          JSON.stringify(turn),
          input.createdAt,
        );
        return next;
      })
      .immediate();
  }

  latestAt(taskId: string): string | undefined {
    const row = stmt(this.#db(), "SELECT created_at FROM tavi_transcript_entries WHERE task_id = ? ORDER BY seq DESC LIMIT 1").get(
      taskId,
    ) as { readonly created_at: string } | undefined;
    return row?.created_at;
  }

  activity(
    taskId: string,
    options: { readonly since?: string; readonly max: number },
  ): { readonly count: number; readonly lastAt?: string; readonly capped: boolean } {
    const max = Math.max(1, Math.floor(options.max));
    // Only the newest `max` turns with a prompt are looked at, by the primary key, newest first: no turn is parsed.
    const row = stmt(
      this.#db(),
      `SELECT count(*) AS count, max(created_at) AS last_at, sum(CASE WHEN created_at > ? THEN 1 ELSE 0 END) AS since FROM (
          SELECT created_at FROM tavi_transcript_entries WHERE task_id = ? AND json_type(turn_json, '$.prompt') = 'text' ORDER BY seq DESC LIMIT ?)`,
    ).get(options.since ?? "", taskId, max + 1) as {
      readonly count: number;
      readonly last_at: string | null;
      readonly since: number | null;
    };
    const recent = options.since === undefined ? row.count : (row.since ?? 0);
    const capped = recent > max;
    const lastAt = recent === 0 ? undefined : (row.last_at ?? undefined);
    return { count: Math.min(recent, max), capped, ...(lastAt === undefined ? {} : { lastAt }) };
  }

  /** The chat's newest turn number, saved or erased: what the next turn counts from. */
  #newestSeq(taskId: string): number {
    return (
      stmt(
        this.#db(),
        `SELECT max(coalesce((SELECT max(seq) FROM tavi_transcript_entries WHERE task_id = @taskId), 0),
        coalesce((SELECT transcript_seq_floor FROM tavi_tasks WHERE task_id = @taskId), 0)) AS seq`,
      ).get({ taskId }) as { readonly seq: number }
    ).seq;
  }

  forget(taskId: string, before: string): TranscriptForgetResult {
    const db = this.#db();
    const bodies: string[] = [];
    const result = db
      .transaction((): TranscriptForgetResult => {
        // The numbering is kept before any turn goes: a later turn never takes an erased one's number.
        stmt(db, "UPDATE tavi_tasks SET transcript_seq_floor = ? WHERE task_id = ?").run(this.#newestSeq(taskId), taskId);
        noteErasure(db);
        // Its fold archives, each tagged with the task that folded it.
        const archives = new Map<string, string>();
        const tagged = stmt(
          db,
          "SELECT artifact_id, relative_path FROM tavi_artifacts WHERE run_id = ? AND fold IS NOT NULL AND created_at <= ?",
        ).all(taskId, before) as { readonly artifact_id: string; readonly relative_path: string }[];
        for (const row of tagged) archives.set(row.artifact_id, row.relative_path);
        const dropArchive = stmt(db, "DELETE FROM tavi_artifacts WHERE artifact_id = ? AND run_id = ?");
        let dropped = 0;
        for (const [artifactId, relativePath] of archives) {
          if (dropArchive.run(artifactId, taskId).changes === 0) continue;
          dropped += 1;
          bodies.push(relativePath);
        }
        // Its rendered previews go too: the pages of a filled form.
        const previews = stmt(
          db,
          "SELECT artifact_id, relative_path FROM tavi_artifacts WHERE run_id = ? AND preview IS NOT NULL AND created_at <= ?",
        ).all(taskId, before) as { readonly artifact_id: string; readonly relative_path: string }[];
        for (const row of previews) if (dropArchive.run(row.artifact_id, taskId).changes > 0) bodies.push(row.relative_path);
        // What a video tool made from a source goes with the source,
        // whichever task made it and whatever its label: a frame of an erased upload or message never outlives it.
        // One another table still points at (an agent mailed it, say) stays, as `eraseArtifacts` keeps it: deleting it would fail
        // the foreign key and roll the whole erasure back.
        const derived = stmt(
          db,
          `SELECT artifact_id, relative_path FROM tavi_artifacts WHERE derived_from = ? AND preview IS NOT NULL
          AND artifact_id NOT IN (SELECT artifact_id FROM tavi_agent_mailbox WHERE artifact_id IS NOT NULL)
          AND artifact_id NOT IN (SELECT artifact_id FROM tavi_routine_blob_refs)
          AND artifact_id NOT IN (SELECT package_artifact_id FROM tavi_skill_versions)`,
        );
        const dropDerivedRow = stmt(db, "DELETE FROM tavi_artifacts WHERE artifact_id = ? AND preview IS NOT NULL");
        const dropDerived = (source: string): void => {
          for (const row of derived.all(source) as { readonly artifact_id: string; readonly relative_path: string }[])
            if (dropDerivedRow.run(row.artifact_id).changes > 0) bodies.push(row.relative_path);
        };
        // A file the person uploaded with a message goes with the chat its message began.
        const uploads = stmt(
          db,
          "SELECT artifact_id, relative_path FROM tavi_artifacts WHERE run_id = ? AND untrusted = 1 AND artifact_id LIKE 'art-up-%' AND created_at <= ?",
        ).all(taskId, before) as { readonly artifact_id: string; readonly relative_path: string }[];
        for (const row of uploads) {
          dropDerived(row.artifact_id);
          if (dropArchive.run(row.artifact_id, taskId).changes > 0) bodies.push(row.relative_path);
        }
        stmt(db, "DELETE FROM tavi_chat_notices WHERE task_id = ? AND created_at < ?").run(taskId, before);
        // The person's words sent into a turn go with the turns: those a turn holds or that were handed on.
        stmt(db, "DELETE FROM tavi_chat_steers WHERE task_id = ? AND created_at < ? AND state IN ('consumed', 'queued')").run(
          taskId,
          before,
        );
        const forgotten = stmt(db, "DELETE FROM tavi_transcript_entries WHERE task_id = ? AND created_at < ?").run(taskId, before).changes;
        // The model requests kept for its turns (`keptModelRequests`) hold their words too: those sent before
        // then go. The attempt rows stay, as the ledger the usage is counted from.
        stmt(db, "DELETE FROM tavi_provider_attempt_requests WHERE run_id = ? AND started_at < ?").run(taskId, before);
        // What the taint step asked of its calls names their tools and why: it goes with the turns that made them.
        stmt(db, "DELETE FROM tavi_gate_observations WHERE task_id = ? AND created_at < ?").run(taskId, before);
        // The admission record of each erased turn keeps its identity — kind, key and `intent_hash`, which is all a
        // retry of its key is checked against — and its outcome, but not its words: a settled admission from before
        // then whose turn is no longer saved loses every text it carries (`redactIntent`, `redactResult`). One still unsettled keeps
        // its prompt: its turn has yet to run (or to be recovered) from it. A suspension's question and its calls'
        // arguments stay while it is the task's open round (no later admission settled but a refused one) or its wait is still active.
        const admissions = stmt(
          db,
          `SELECT a.admission_id, a.intent, a.result,
          EXISTS (SELECT 1 FROM tavi_admissions later WHERE later.task_id = a.task_id AND later.result IS NOT NULL AND later.state <> 'refused'
            AND (later.created_at > a.created_at OR (later.created_at = a.created_at AND later.rowid > a.rowid)))
          AND NOT EXISTS (SELECT 1 FROM tavi_agent_wait_intents w WHERE w.task_id = a.task_id AND w.state = 'active'
            AND w.wait_id = CASE WHEN json_valid(a.result) THEN json_extract(a.result, '$.waitInterrupt.wait.waitId') END) AS superseded
        FROM tavi_admissions a
        WHERE a.task_id = ? AND a.created_at < ? AND a.result IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM tavi_transcript_entries e WHERE e.task_id = a.task_id AND e.admission_id = a.admission_id)`,
        ).all(taskId, before) as {
          readonly admission_id: string;
          readonly intent: string;
          readonly result: string;
          readonly superseded: number;
        }[];
        const rewrite = stmt(db, "UPDATE tavi_admissions SET intent = ?, result = ? WHERE admission_id = ?");
        let redacted = 0;
        for (const row of admissions) {
          const intent = redactJson(row.intent, redactIntent);
          const result = redactJson(row.result, (value) => redactResult(value, row.superseded === 1));
          if (intent === row.intent && result === row.result) continue;
          rewrite.run(intent, result, row.admission_id);
          redacted += 1;
        }
        // The chat's conversations' messages from then (the owner's local connection's, a conversation Home's, a forum
        // topic's) keep their rows — a provider event's or an effect's dedupe is by its row, so deleting one would let a
        // replay in again — but not their text. Each mapping is one epoch of its conversation: its messages are
        // those after the epoch before it ended (from the start, for the first — the message that opened an epoch was
        // received before its mapping was written) and before its own end. A topic's mapping key names its group and
        // thread; a group's own mapping leaves out a thread that is a topic's.
        const conversations = stmt(
          db,
          `SELECT m.connection_id, m.external_conversation_id, m.reset_at,
          (SELECT max(p.reset_at) FROM tavi_messaging_conversation_tasks p WHERE p.connection_id = m.connection_id
            AND p.external_conversation_id = m.external_conversation_id AND p.epoch < m.epoch) AS previous_reset_at
        FROM tavi_messaging_conversation_tasks m WHERE m.task_id = ?`,
        ).all(taskId) as {
          readonly connection_id: string;
          readonly external_conversation_id: string;
          readonly reset_at: string | null;
          readonly previous_reset_at: string | null;
        }[];
        const erasedMessages = `connection_id = @connection AND state = 'processed' AND received_at >= @from AND received_at < @until AND json_valid(payload_json)
          AND json_extract(payload_json, '$.externalConversationId') = @group
          AND (CASE WHEN @thread IS NULL
                 THEN json_type(payload_json, '$.externalThreadId') IS NULL OR NOT EXISTS (SELECT 1 FROM tavi_messaging_conversation_tasks t
                   WHERE t.connection_id = @connection AND t.external_conversation_id = @group || '${TOPIC_CONVERSATION_SEPARATOR}' || json_extract(payload_json, '$.externalThreadId'))
                 ELSE json_extract(payload_json, '$.externalThreadId') = @thread END)
          AND (json_type(payload_json, '$.content') IS NOT NULL OR json_type(payload_json, '$.attachments') IS NOT NULL)`;
        const inbox = stmt(
          db,
          `UPDATE tavi_messaging_inbox SET payload_json = json_remove(payload_json, '$.content', '$.attachments') WHERE ${erasedMessages}`,
        );
        // An erased message's attachments go with it: they are the sender's, kept for that message alone.
        const attached = stmt(
          db,
          `SELECT json_extract(a.value, '$.artifactId') AS artifact_id FROM tavi_messaging_inbox, json_each(payload_json, '$.attachments') a WHERE ${erasedMessages} AND json_type(payload_json, '$.attachments') = 'array'`,
        );
        const artifact = stmt(db, "SELECT relative_path FROM tavi_artifacts WHERE artifact_id = ? AND untrusted = 1");
        const dropArtifact = stmt(db, "DELETE FROM tavi_artifacts WHERE artifact_id = ? AND untrusted = 1");
        const outbox = stmt(
          db,
          `UPDATE tavi_messaging_outbox SET message_json = json_remove(json_set(message_json, '$.parts', json('[]')), '$.subject', '$.buttons')
        WHERE connection_id = @connection AND state = 'resolved' AND created_at >= @from AND created_at < @until AND json_valid(message_json)
          AND coalesce(json_extract(message_json, '$.destination.conversationId'), json_extract(message_json, '$.destination.chatId')) = @group
          AND (CASE WHEN @thread IS NULL
                 THEN json_type(message_json, '$.destination.threadId') IS NULL OR NOT EXISTS (SELECT 1 FROM tavi_messaging_conversation_tasks t
                   WHERE t.connection_id = @connection AND t.external_conversation_id = @group || '${TOPIC_CONVERSATION_SEPARATOR}' || json_extract(message_json, '$.destination.threadId'))
                 ELSE json_extract(message_json, '$.destination.threadId') = @thread END)`,
        );
        for (const conversation of conversations) {
          const until = conversation.reset_at !== null && conversation.reset_at < before ? conversation.reset_at : before;
          const at = conversation.external_conversation_id.indexOf(TOPIC_CONVERSATION_SEPARATOR);
          const scope = {
            connection: conversation.connection_id,
            from: conversation.previous_reset_at ?? "",
            until,
            group: at < 0 ? conversation.external_conversation_id : conversation.external_conversation_id.slice(0, at),
            thread: at < 0 ? null : conversation.external_conversation_id.slice(at + TOPIC_CONVERSATION_SEPARATOR.length),
          };
          for (const row of attached.all(scope) as { readonly artifact_id: unknown }[]) {
            const artifactId = row.artifact_id;
            if (typeof artifactId !== "string") continue;
            // Its derived previews go even when the raw video was already pruned past its retention (video.keepDays).
            dropDerived(artifactId);
            const stored = artifact.get(artifactId) as { readonly relative_path: string } | undefined;
            if (stored === undefined) continue;
            dropArtifact.run(artifactId);
            bodies.push(stored.relative_path);
          }
          inbox.run(scope);
          outbox.run(scope);
        }
        // The whole history: no turn left, and none admitted since then (a task that never saved a turn is not emptied by a time before it).
        const whole =
          (
            stmt(
              db,
              `SELECT NOT EXISTS (SELECT 1 FROM tavi_transcript_entries WHERE task_id = @taskId)
          AND NOT EXISTS (SELECT 1 FROM tavi_admissions WHERE task_id = @taskId AND created_at >= @before) AS whole`,
            ).get({ taskId, before }) as { readonly whole: number }
          ).whole === 1;
        if (whole) {
          // Nothing of the chat is left to say what it was about: its last answer, generated title and summary go. A
          // name the reader gave it stays; the summary is not written again until a later turn asks for one.
          stmt(
            db,
            "UPDATE tavi_tasks SET final_text = NULL, title = NULL, summary = NULL, summary_input_hash = NULL, summary_state = CASE WHEN summary_state IS NULL THEN NULL ELSE 'skipped' END WHERE task_id = ?",
          ).run(taskId);
          // Labels kept elsewhere stop naming it: a `chat:` ref goes, and the label stays as untrusted as it was.
          const ref = `chat:${taskId}`;
          for (const [table, column, refs] of LABELS_NAMING_CHATS) {
            stmt(
              db,
              `UPDATE ${table} SET ${column} = json_set(${column}, '${refs}', json((SELECT json_group_array(json(r.value)) FROM json_each(${column}, '${refs}') r WHERE json_extract(r.value, '$.ref') IS NOT @ref)))
            WHERE json_valid(${column}) AND EXISTS (SELECT 1 FROM json_each(${column}, '${refs}') r WHERE json_extract(r.value, '$.ref') = @ref)`,
            ).run({ ref });
          }
          stmt(db, "UPDATE tavi_tainted_host_writes SET task_id = NULL WHERE task_id = ?").run(taskId);
        } else if (forgotten > 0) {
          // Its title and summary may tell of an erased turn: written again, from what is left, once the chat is idle.
          // The kept first title goes too (a pass keeps one once written), and the digest of the words it came from.
          stmt(
            db,
            "UPDATE tavi_tasks SET summary_state = 'pending', title = NULL, summary_input_hash = NULL WHERE task_id = ? AND summary_state IS NOT NULL AND chat_kind IS NOT 'home'",
          ).run(taskId);
        }
        // Ideas that quoted the chat's title go, whether the whole chat or some of its turns were forgotten:
        // its title may have told of what was erased.
        if (whole || forgotten > 0) deleteIdeasCiting(db, taskId);
        // Copies elsewhere: a side chat begun from this one holds its seed, a worker its brief. Named, not erased.
        const related = stmt(
          db,
          `SELECT task_id, kind FROM (
          SELECT t.task_id, 'side' AS kind, t.created_at FROM tavi_tasks t WHERE t.parent_chat_id = @taskId AND t.created_at < @before
          UNION
          SELECT d.worker_task_id AS task_id, 'worker' AS kind, d.created_at FROM tavi_agent_delegation_admissions d
            WHERE (d.root_task_id = @taskId OR (d.root_task_id IS NULL AND d.parent_task_id = @taskId)) AND d.created_at < @before AND d.worker_task_id <> @taskId
        ) ORDER BY created_at, task_id LIMIT @limit`,
        ).all({ taskId, before, limit: CHAT_FORGET_RELATED_MAX }) as { readonly task_id: string; readonly kind: "side" | "worker" }[];
        return { forgotten, redacted, whole, related: related.map((row) => ({ taskId: row.task_id, kind: row.kind })), archives: dropped };
      })
      .immediate();
    // Bodies after the rows are gone, as `pruneArtifacts` does: one that cannot be removed is no row's.
    for (const relativePath of bodies) {
      try {
        if (this.#artifactFile !== undefined) rmSync(this.#artifactFile(relativePath), { force: true });
      } catch {
        // The row is gone; an unreadable or already-absent body must not fail the erasure.
      }
    }
    return result;
  }

  rewind(taskId: string, seq: number, prompt: string): TranscriptRewindResult {
    const db = this.#db();
    return db
      .transaction((): TranscriptRewindResult => {
        noteErasure(db);
        const entry = stmt(
          db,
          `SELECT e.turn_json, a.admission_id, a.created_at, a.rowid AS row FROM tavi_transcript_entries e
          JOIN tavi_admissions a ON a.admission_id = e.admission_id WHERE e.task_id = ? AND e.seq = ?`,
        ).get(taskId, seq) as
          | { readonly turn_json: string; readonly admission_id: string; readonly created_at: string; readonly row: number }
          | undefined;
        const turn = entry === undefined ? undefined : TranscriptTurnSchema.safeParse(JSON.parse(entry.turn_json));
        const saved = turn?.success === true ? turn.data.prompt : undefined;
        if (entry === undefined || saved === undefined || saved === "")
          throw new TaviError("NOT_FOUND", `Chat ${taskId} has no turn ${seq} with a prompt to rewind to`);
        if (saved !== prompt.slice(0, TRANSCRIPT_TEXT_MAX))
          throw new TaviError("CONFLICT", `Turn ${seq} of chat ${taskId} is not the message shown: reload the chat and rewind again`);
        // The turn and every later admission of the chat: they all go, so none may still be running.
        const from = "FROM tavi_admissions WHERE task_id = @taskId AND (created_at > @at OR (created_at = @at AND rowid >= @row))";
        const scope = { taskId, at: entry.created_at, row: entry.row };
        const unsettled = (
          stmt(db, `SELECT count(*) AS n ${from} AND state IN ('pending', 'claimed')`).get(scope) as { readonly n: number }
        ).n;
        if (unsettled > 0) throw new TaviError("CONFLICT", `Chat ${taskId} has a turn that has not ended: stop it, then rewind`);
        // The numbering is kept before any turn goes: a later turn never takes a rewound one's number.
        stmt(db, "UPDATE tavi_tasks SET transcript_seq_floor = ? WHERE task_id = ?").run(this.#newestSeq(taskId), taskId);
        const rewound = stmt(db, "DELETE FROM tavi_transcript_entries WHERE task_id = ? AND seq >= ?").run(taskId, seq).changes;
        const admissions = stmt(db, `SELECT admission_id, operation_key, intent, result ${from} ORDER BY created_at, rowid`).all(scope) as {
          readonly admission_id: string;
          readonly operation_key: string;
          readonly intent: string;
          readonly result: string | null;
        }[];
        // Their words go as forget's do: `reconcile` saves no turn without a prompt, so none comes back.
        const rewrite = stmt(db, "UPDATE tavi_admissions SET intent = ?, result = ? WHERE admission_id = ?");
        const steers = stmt(db, "DELETE FROM tavi_chat_steers WHERE task_id = ? AND admission_id = ?");
        const unread = stmt(
          db,
          `UPDATE tavi_chat_notices SET read_by = NULL WHERE task_id = ? AND read_by = ? AND kind NOT IN (${DISPLAY_ONLY_SQL})`,
        );
        for (const row of admissions) {
          const intent = redactJson(row.intent, redactIntent);
          const result = row.result === null ? null : redactJson(row.result, (value) => redactResult(value, true));
          if (intent !== row.intent || result !== row.result) rewrite.run(intent, result, row.admission_id);
          steers.run(taskId, row.admission_id);
          // What the rewound turns read, the chat's next turn reads again.
          unread.run(taskId, row.operation_key);
        }
        // A notice posted after a rewound turn (a side chat that finished) still happened: shown after the new last turn.
        stmt(db, "UPDATE tavi_chat_notices SET after_seq = ? WHERE task_id = ? AND after_seq >= ?").run(Math.max(0, seq - 1), taskId, seq);
        // Every admission taken back is held, with any an earlier rewind still holds: a turn whose own messages are
        // gone (folded into an epoch, or never written) must not leave a later one in the model's conversation.
        const held = this.rewindMarker(taskId) ?? [];
        const ids = [...held, ...admissions.map((row) => row.admission_id).filter((id) => !held.includes(id))];
        stmt(db, "UPDATE tavi_tasks SET rewind_admission_ids = ? WHERE task_id = ?").run(JSON.stringify(ids), taskId);
        const left = stmt(db, "SELECT turn_json FROM tavi_transcript_entries WHERE task_id = ? ORDER BY seq DESC LIMIT 1").get(taskId) as
          | { readonly turn_json: string }
          | undefined;
        if (left === undefined) {
          // Nothing of the chat is left to say what it was about, as after a whole forget: a reader's name stays.
          stmt(
            db,
            "UPDATE tavi_tasks SET final_text = NULL, title = NULL, summary = NULL, summary_input_hash = NULL, summary_state = CASE WHEN summary_state IS NULL THEN NULL ELSE 'skipped' END WHERE task_id = ?",
          ).run(taskId);
        } else {
          // The chat's last answer is its new last turn's; its title and summary are written again from what is left.
          const last = TranscriptTurnSchema.safeParse(JSON.parse(left.turn_json));
          const finalText = last.success ? (last.data.outcome.finalText ?? null) : null;
          stmt(
            db,
            "UPDATE tavi_tasks SET final_text = ?, title = CASE WHEN summary_state IS NULL OR chat_kind IS 'home' THEN title ELSE NULL END, summary_input_hash = NULL, summary_state = CASE WHEN summary_state IS NULL OR chat_kind IS 'home' THEN summary_state ELSE 'pending' END WHERE task_id = ?",
          ).run(finalText, taskId);
        }
        // As a forget of some turns does: ideas that quoted the chat's title, and what the person typed into it from
        // one, may tell of what was taken back.
        if (rewound > 0 || admissions.length > 0) deleteIdeasCiting(db, taskId);
        return { prompt: saved, rewound };
      })
      .immediate();
  }

  privateChatsDue(input: { readonly idleBefore: string; readonly limit: number }): readonly string[] {
    // A private chat, a side chat made private with it, or a worker whose chat is private;
    // its newest saved turn older than `idleBefore`, and no turn of it running.
    const rows = stmt(
      this.#db(),
      `SELECT e.task_id, max(e.created_at) AS last_at
        FROM tavi_transcript_entries e JOIN tavi_tasks t ON t.task_id = e.task_id
       WHERE (t.memory_mode = 'private' OR EXISTS (SELECT 1 FROM tavi_agent_delegation_admissions d JOIN tavi_tasks r ON r.task_id = COALESCE(d.root_task_id, d.parent_task_id)
                WHERE d.worker_task_id = t.task_id AND r.memory_mode = 'private'))
         AND NOT EXISTS (SELECT 1 FROM tavi_admissions a WHERE a.task_id = e.task_id AND a.state = 'claimed' AND a.result IS NULL)
       GROUP BY e.task_id
      HAVING max(e.created_at) < ?
       ORDER BY last_at ASC
       LIMIT ?`,
    ).all(input.idleBefore, Math.max(1, Math.min(input.limit, 1_000))) as { readonly task_id: string }[];
    return rows.map((row) => row.task_id);
  }

  rewindMarker(taskId: string): readonly string[] | undefined {
    const row = stmt(this.#db(), "SELECT rewind_admission_ids FROM tavi_tasks WHERE task_id = ?").get(taskId) as
      | { readonly rewind_admission_ids: string | null }
      | undefined;
    if (row?.rewind_admission_ids == null) return undefined;
    const ids: unknown = JSON.parse(row.rewind_admission_ids);
    return Array.isArray(ids) && ids.length > 0 ? ids.filter((id): id is string => typeof id === "string") : undefined;
  }

  clearRewind(taskId: string, admissionIds: readonly string[]): void {
    stmt(this.#db(), "UPDATE tavi_tasks SET rewind_admission_ids = NULL WHERE task_id = ? AND rewind_admission_ids = ?").run(
      taskId,
      JSON.stringify(admissionIds),
    );
  }

  noticesAfter(
    taskId: string,
    options: { readonly fromSeq: number; readonly beforeSeq?: number; readonly skip: number; readonly limit: number },
  ): readonly ChatNotice[] {
    const limit = Math.max(1, Math.min(options.limit, NOTICES_PAGE_MAX));
    const rows = stmt(
      this.#db(),
      `${NOTICE_SELECT} WHERE n.task_id = @taskId AND ${SHOWN_NOTICE} AND n.after_seq >= @fromSeq AND (@beforeSeq IS NULL OR n.after_seq < @beforeSeq)
        ORDER BY n.after_seq, n.created_at, n.rowid LIMIT @limit OFFSET @skip`,
    ).all({
      taskId,
      fromSeq: options.fromSeq,
      beforeSeq: options.beforeSeq ?? null,
      limit,
      skip: Math.max(0, options.skip),
    }) as NoticeRow[];
    return rows.map(toNotice);
  }

  epochStartedAt(taskId: string, epoch: number): string | undefined {
    const row = stmt(this.#db(), "SELECT created_at FROM tavi_chat_notices WHERE task_id = ? AND kind = 'epoch' AND source_key = ?").get(
      taskId,
      `epoch:${epoch}`,
    ) as { readonly created_at: string } | undefined;
    return row?.created_at;
  }

  postNotice(input: PostNoticeInput): { readonly notice: ChatNotice; readonly posted: boolean } {
    const db = this.#db();
    return db.transaction(() => this.#postNotice(db, input)).immediate();
  }

  /** `postNotice`'s write, inside the caller's transaction. */
  #postNotice(db: Database, input: PostNoticeInput): { readonly notice: ChatNotice; readonly posted: boolean } {
    const title = clip(input.title.replace(/\s+/g, " ").trim() || "Notice", NOTICE_TITLE_MAX);
    const summary = clip(input.summary.trim(), NOTICE_SUMMARY_MAX);
    const existing = stmt(db, "SELECT notice_id, title, summary FROM tavi_chat_notices WHERE task_id = ? AND source_key = ?").get(
      input.taskId,
      input.sourceKey,
    ) as { readonly notice_id: string; readonly title: string; readonly summary: string } | undefined;
    if (
      existing !== undefined &&
      (input.once === true || (existing.title === title && existing.summary === summary && input.bump !== true))
    ) {
      return { notice: this.#notice(existing.notice_id), posted: false };
    }
    const afterSeq = this.#newestSeq(input.taskId);
    if (existing !== undefined) {
      // A later settle of the same source: its newest words, after the newest turn, unread again. The
      // source task follows the post: a conversation's notice names its current epoch's task.
      // The archive is the post's own: a lossy retry of an epoch's rollover names none.
      stmt(
        db,
        "UPDATE tavi_chat_notices SET title = ?, summary = ?, after_seq = ?, read_by = ?, created_at = ?, source_task_id = coalesce(?, source_task_id), artifact_id = ?, heartbeat_item_id = ? WHERE notice_id = ?",
      ).run(
        title,
        summary,
        afterSeq,
        readByOf(input.kind, input.displayOnly),
        input.createdAt,
        input.sourceTaskId ?? null,
        input.artifactId ?? null,
        input.heartbeatItemId ?? null,
        existing.notice_id,
      );
      return { notice: this.#notice(existing.notice_id), posted: true };
    }
    stmt(
      db,
      "INSERT INTO tavi_chat_notices (notice_id, task_id, source_key, kind, source_task_id, title, summary, after_seq, read_by, created_at, artifact_id, heartbeat_item_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      input.noticeId,
      input.taskId,
      input.sourceKey,
      input.kind,
      input.sourceTaskId ?? null,
      title,
      summary,
      afterSeq,
      readByOf(input.kind, input.displayOnly),
      input.createdAt,
      input.artifactId ?? null,
      input.heartbeatItemId ?? null,
    );
    return { notice: this.#notice(input.noticeId), posted: true };
  }

  postMemoryCard(input: PostMemoryCardInput): { readonly notice: ChatNotice; readonly prompts: readonly MemoryPromptRow[] } {
    const db = this.#db();
    return db
      .transaction(() => {
        const existing = stmt(db, "SELECT notice_id FROM tavi_chat_notices WHERE task_id = ? AND source_key = ? AND kind = 'memory'").get(
          input.taskId,
          input.sourceKey,
        ) as { readonly notice_id: string } | undefined;
        const noticeId = existing?.notice_id ?? input.noticeId;
        const held = existing === undefined ? [] : this.#memoryPrompts(db, noticeId);
        const onCard = new Set(held.map((row) => row.recordId));
        const fresh = [
          ...new Map(input.records.filter((record) => !onCard.has(record.recordId)).map((record) => [record.recordId, record])).values(),
        ].slice(0, Math.max(0, MEMORY_CARD_ITEMS_MAX - held.length));
        if (fresh.length === 0) {
          if (existing !== undefined) return { notice: this.#notice(noticeId), prompts: held };
          throw new TaviError("INVALID_INPUT", "A memory card needs at least one record");
        }
        // Counts only: a card's words are never its records' (invariant 22).
        const words =
          input.digest === undefined
            ? memoryCardNoticeText({ count: held.length + fresh.length, flush: input.sourceKey.startsWith("memory:flush:") })
            : // A digest's: how many it lists of how many wait, and when the oldest expires.
              memoryDigestNoticeText({
                listed: held.length + fresh.length,
                waiting: input.digest.waiting,
                oldestExpires: input.digest.oldestExpires,
              });
        // After the chat's newest turn: the turn that proposed them, when it was saved first.
        const { notice } = this.#postNotice(db, {
          noticeId,
          taskId: input.taskId,
          kind: "memory",
          sourceKey: input.sourceKey,
          title: words.title,
          summary: words.summary,
          createdAt: input.createdAt,
          bump: true,
        });
        const insert = stmt(
          db,
          "INSERT INTO tavi_memory_prompts (token, notice_id, workspace_id, principal_id, record_id, task_id, number, created_at, settled_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)",
        );
        let number = held.reduce((max, row) => Math.max(max, row.number), 0);
        for (const record of fresh) {
          number += 1;
          insert.run(
            randomBytes(12).toString("base64url"),
            notice.noticeId,
            record.workspaceId,
            record.principalId,
            record.recordId,
            input.taskId,
            number,
            input.createdAt,
          );
        }
        return { notice, prompts: this.#memoryPrompts(db, notice.noticeId) };
      })
      .immediate();
  }

  memoryPrompts(noticeId: string): readonly MemoryPromptRow[] {
    return this.#memoryPrompts(this.#db(), noticeId);
  }

  postMemoryListing(input: PostMemoryListingInput): readonly MemoryPromptRow[] {
    const db = this.#db();
    return db
      .transaction(() => {
        const records = [...new Map(input.records.map((record) => [record.recordId, record])).values()].slice(0, MEMORY_CARD_ITEMS_MAX);
        // Counts only, as a card's; nobody reads them, the notice is never shown.
        const words = memoryCardNoticeText({ count: records.length, flush: false });
        const { notice } = this.#postNotice(db, {
          noticeId: input.noticeId,
          taskId: input.taskId,
          kind: "memory",
          sourceKey: memoryListingKey(input.surface),
          title: words.title,
          summary: words.summary,
          createdAt: input.createdAt,
          bump: true,
        });
        // A new listing replaces the last one's numbers on this surface.
        stmt(db, "DELETE FROM tavi_memory_prompts WHERE notice_id = ?").run(notice.noticeId);
        const insert = stmt(
          db,
          "INSERT INTO tavi_memory_prompts (token, notice_id, workspace_id, principal_id, record_id, task_id, number, created_at, settled_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)",
        );
        records.forEach((record, index) => {
          insert.run(
            randomBytes(12).toString("base64url"),
            notice.noticeId,
            record.workspaceId,
            record.principalId,
            record.recordId,
            input.taskId,
            index + 1,
            input.createdAt,
          );
        });
        return this.#memoryPrompts(db, notice.noticeId);
      })
      .immediate();
  }

  memoryNumbers(input: { readonly taskId: string; readonly surface: string }): readonly MemoryPromptRow[] {
    const db = this.#db();
    // The newest of the chat's cards and this surface's own listing and command receipts;
    // other surfaces' listings and receipts are not in the race.
    const receipts = memoryCommandReceiptSurfacePrefix(input.surface);
    const row = stmt(
      db,
      `SELECT notice_id FROM tavi_chat_notices
      WHERE task_id = ? AND kind = 'memory'
        AND ((source_key NOT LIKE '${MEMORY_LISTING_KEY_PREFIX}%' AND source_key NOT LIKE '${MEMORY_COMMAND_RECEIPT_KEY_PREFIX}%')
          OR source_key = ? OR substr(source_key, 1, ?) = ?)
      ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    ).get(input.taskId, memoryListingKey(input.surface), receipts.length, receipts) as { readonly notice_id: string } | undefined;
    return row === undefined ? [] : this.#memoryPrompts(db, row.notice_id);
  }

  memoryPromptByToken(token: string): MemoryPromptRow | undefined {
    const [row] = toMemoryPromptRows(
      stmt(this.#db(), "SELECT * FROM tavi_memory_prompts WHERE token = ?").all(token) as MemoryPromptDbRow[],
    );
    return row;
  }

  unsettledMemoryPrompts(): readonly MemoryPromptRow[] {
    return toMemoryPromptRows(
      stmt(
        this.#db(),
        "SELECT * FROM tavi_memory_prompts WHERE settled_at IS NULL ORDER BY created_at, notice_id, number",
      ).all() as MemoryPromptDbRow[],
    );
  }

  memoryPromptsOfRecord(recordId: string): readonly MemoryPromptRow[] {
    // The record, and every waiting tidy-up merging it (a `contains` edge into a proposal's revision), as
    // `forget` cascades: their rows go with it, so a card or digest listing a tidy-up is edited too.
    return toMemoryPromptRows(
      stmt(
        this.#db(),
        `WITH RECURSIVE erased(record_id) AS (
        SELECT ?
        UNION
        SELECT r.record_id FROM erased x
          JOIN tavi_memory_revisions f ON f.record_id = x.record_id
          JOIN tavi_lineage_edges e ON e.from_revision_id = f.revision_id AND e.dependency_kind = 'contains'
          JOIN tavi_memory_revisions v ON v.revision_id = e.to_revision_id
          JOIN tavi_memory_records r ON r.record_id = v.record_id AND r.status = 'proposed'
      )
      SELECT p.* FROM tavi_memory_prompts p JOIN erased x ON x.record_id = p.record_id
      ORDER BY p.created_at, p.notice_id, p.number`,
      ).all(recordId) as MemoryPromptDbRow[],
    );
  }

  memoryCardMessages(
    effectId: string,
  ): readonly { readonly connectionId: string; readonly destination: unknown; readonly messageId: string }[] {
    // The send itself, and a digest's per-target sends `<effectId>:<connection>:<chat>`: a
    // key range the primary key serves, as `;` sorts right after `:`.
    const rows = stmt(
      this.#db(),
      `SELECT connection_id, json_extract(message_json, '$.destination') AS destination, json_extract(outcome_json, '$.parts[0].providerMessageId') AS message_id
      FROM tavi_messaging_outbox WHERE (effect_id = ? OR (effect_id > ? AND effect_id < ?)) AND state = 'resolved' AND json_valid(message_json) AND json_valid(outcome_json) AND json_extract(outcome_json, '$.status') = 'accepted'
      ORDER BY effect_id`,
    ).all(effectId, `${effectId}:`, `${effectId};`) as {
      readonly connection_id: string;
      readonly destination: string | null;
      readonly message_id: string | null;
    }[];
    return rows.flatMap((row) => {
      if (row.message_id === null || row.destination === null) return [];
      // `json_extract` answers an object as its JSON text, and a scalar as itself.
      let destination: unknown = row.destination;
      try {
        destination = JSON.parse(row.destination);
      } catch {
        // A destination that is a plain string is kept as it is.
      }
      return [{ connectionId: row.connection_id, destination, messageId: String(row.message_id) }];
    });
  }

  eraseMemoryCardMessage(effectId: string): boolean {
    return (
      stmt(
        this.#db(),
        `UPDATE tavi_messaging_outbox SET message_json = json_remove(json_set(message_json, '$.parts', json('[]')), '$.subject', '$.buttons')
      WHERE effect_id = ? AND json_valid(message_json)`,
      ).run(effectId).changes > 0
    );
  }

  claimMemoryMark(input: { readonly taskId: string; readonly kind: MemoryMarkKind; readonly mark: string; readonly at: string }): boolean {
    return (
      stmt(
        this.#db(),
        "INSERT INTO tavi_memory_marks (task_id, kind, mark, at) VALUES (?, ?, ?, ?) ON CONFLICT (task_id, kind, mark) DO NOTHING",
      ).run(input.taskId, input.kind, input.mark, input.at).changes > 0
    );
  }

  takeMemoryMark(input: { readonly taskId: string; readonly kind: MemoryMarkKind; readonly mark: string }): boolean {
    return (
      stmt(this.#db(), "DELETE FROM tavi_memory_marks WHERE task_id = ? AND kind = ? AND mark = ?").run(
        input.taskId,
        input.kind,
        input.mark,
      ).changes > 0
    );
  }

  lastMemoryMark(input: {
    readonly taskId: string;
    readonly kind: MemoryMarkKind;
  }): { readonly mark: string; readonly at: string } | undefined {
    return stmt(
      this.#db(),
      "SELECT mark, at FROM tavi_memory_marks WHERE task_id = ? AND kind = ? ORDER BY at DESC, mark DESC LIMIT 1",
    ).get(input.taskId, input.kind) as { readonly mark: string; readonly at: string } | undefined;
  }

  memoryMarksOf(input: {
    readonly workspaceId: string;
    readonly kind: MemoryMarkKind;
  }): readonly { readonly taskId: string; readonly principalId: string; readonly mark: string; readonly at: string }[] {
    const rows = stmt(
      this.#db(),
      `SELECT m.task_id, t.principal_id, m.mark, m.at FROM tavi_memory_marks m JOIN tavi_tasks t ON t.task_id = m.task_id
      WHERE t.workspace_id = ? AND m.kind = ?
        AND NOT EXISTS (SELECT 1 FROM tavi_memory_marks n WHERE n.task_id = m.task_id AND n.kind = m.kind AND (n.at > m.at OR (n.at = m.at AND n.mark > m.mark)))
      ORDER BY m.at DESC, m.task_id`,
    ).all(input.workspaceId, input.kind) as {
      readonly task_id: string;
      readonly principal_id: string;
      readonly mark: string;
      readonly at: string;
    }[];
    return rows.map((row) => ({ taskId: row.task_id, principalId: row.principal_id, mark: row.mark, at: row.at }));
  }

  memoryMarksSince(input: {
    readonly workspaceId: string;
    readonly kind: MemoryMarkKind;
    readonly since: string;
  }): readonly { readonly taskId: string; readonly principalId: string; readonly mark: string; readonly at: string }[] {
    const rows = stmt(
      this.#db(),
      `SELECT m.task_id, t.principal_id, m.mark, m.at FROM tavi_memory_marks m JOIN tavi_tasks t ON t.task_id = m.task_id
      WHERE t.workspace_id = ? AND m.kind = ? AND m.at >= ?
      ORDER BY m.at DESC, m.task_id, m.mark`,
    ).all(input.workspaceId, input.kind, input.since) as {
      readonly task_id: string;
      readonly principal_id: string;
      readonly mark: string;
      readonly at: string;
    }[];
    return rows.map((row) => ({ taskId: row.task_id, principalId: row.principal_id, mark: row.mark, at: row.at }));
  }

  memoryReviewChats(input: { readonly workspaceId: string; readonly savedBefore: string }): readonly MemoryReviewChat[] {
    // Attended chats only: a Home, a side chat or an ordinary one begun at a terminal or in the
    // canvas, with memory on. Never a worker, a `run`, a messaging conversation (a group's included), a
    // routine, a reminder or a heartbeat tick. The review mark is the newest by the turn it reads
    // through (`r<seq>` sorts by seq); failures count only those on the span after it.
    // `seed_seq` is read only for a chat with no review mark yet (once per chat), newest first so it stops early.
    // A side chat follows its parents live, as `chatMemoryOf` reads them: one any parent of
    // which is off or private is passed by, and its span starts at the latest `memory_on_at` along the chain, so
    // what it said while a parent was off is never read. A chain longer than 32 parents is off, the narrower answer.
    const rows = stmt(
      this.#db(),
      `WITH RECURSIVE ancestry(task_id, ancestor_id, hops) AS (
        SELECT t.task_id, t.parent_chat_id, 1 FROM tavi_tasks t
         WHERE t.workspace_id = @workspaceId AND t.parent_chat_id IS NOT NULL AND t.origin IN ('cli', 'ipc', 'web') AND (t.chat_kind IS NULL OR t.chat_kind IN ('home', 'side')) AND t.memory_mode IS NULL
        UNION ALL
        SELECT a.task_id, p.parent_chat_id, a.hops + 1 FROM ancestry a JOIN tavi_tasks p ON p.task_id = a.ancestor_id
         WHERE p.parent_chat_id IS NOT NULL AND a.hops <= 32
      ), lineage AS (
        SELECT a.task_id, max(a.hops) AS hops, max(p.memory_mode IS NOT NULL) AS off, max(p.memory_on_at) AS on_at
          FROM ancestry a LEFT JOIN tavi_tasks p ON p.task_id = a.ancestor_id GROUP BY a.task_id
      ), marked AS (
        SELECT t.task_id, t.principal_id,
          CASE WHEN l.on_at IS NOT NULL AND (t.memory_on_at IS NULL OR l.on_at > t.memory_on_at) THEN l.on_at ELSE t.memory_on_at END AS memory_on_at,
          (SELECT max(e.seq) FROM tavi_transcript_entries e WHERE e.task_id = t.task_id) AS newest_seq,
          (SELECT m.mark FROM tavi_memory_marks m WHERE m.task_id = t.task_id AND m.kind = 'review' AND substr(m.mark, 1, 1) = 'r' ORDER BY m.mark DESC LIMIT 1) AS review_mark
        FROM tavi_tasks t LEFT JOIN lineage l ON l.task_id = t.task_id
        WHERE t.workspace_id = @workspaceId AND t.origin IN ('cli', 'ipc', 'web') AND (t.chat_kind IS NULL OR t.chat_kind IN ('home', 'side')) AND t.memory_mode IS NULL
          AND COALESCE(l.off, 0) = 0 AND COALESCE(l.hops, 0) <= 32
      ), chats AS (
        SELECT k.*,
          CASE WHEN k.review_mark IS NULL THEN
            (SELECT e.seq FROM tavi_transcript_entries e WHERE e.task_id = k.task_id AND e.created_at < @savedBefore ORDER BY e.seq DESC LIMIT 1)
          END AS seed_seq
        FROM marked k
      )
      SELECT c.task_id, c.principal_id, c.memory_on_at, c.newest_seq, c.seed_seq, c.review_mark, e.created_at AS newest_at,
        (SELECT m.at FROM tavi_memory_marks m WHERE m.task_id = c.task_id AND m.kind = 'review' AND m.mark = c.review_mark) AS review_at,
        (SELECT count(*) FROM tavi_memory_marks x WHERE x.task_id = c.task_id AND x.kind = 'review' AND substr(x.mark, 1, 12) = 'x' || substr(c.review_mark, 2, 10) || ';') AS failures,
        (SELECT max(x.at) FROM tavi_memory_marks x WHERE x.task_id = c.task_id AND x.kind = 'review' AND substr(x.mark, 1, 12) = 'x' || substr(c.review_mark, 2, 10) || ';') AS last_failure_at
      FROM chats c JOIN tavi_transcript_entries e ON e.task_id = c.task_id AND e.seq = c.newest_seq
      ORDER BY e.created_at, c.task_id`,
    ).all({ workspaceId: input.workspaceId, savedBefore: input.savedBefore }) as {
      readonly task_id: string;
      readonly principal_id: string;
      readonly memory_on_at: string | null;
      readonly newest_seq: number;
      readonly seed_seq: number | null;
      readonly review_mark: string | null;
      readonly review_at: string | null;
      readonly newest_at: string;
      readonly failures: number;
      readonly last_failure_at: string | null;
    }[];
    return rows.map((row) => ({
      taskId: row.task_id,
      principalId: row.principal_id,
      ...(row.memory_on_at === null ? {} : { memoryOnAt: row.memory_on_at }),
      newestSeq: row.newest_seq,
      newestAt: row.newest_at,
      seedSeq: row.seed_seq ?? 0,
      ...(row.review_mark === null || row.review_at === null ? {} : { review: { mark: row.review_mark, at: row.review_at } }),
      failures: row.review_mark === null ? 0 : row.failures,
      ...(row.review_mark === null || row.last_failure_at === null ? {} : { lastFailureAt: row.last_failure_at }),
    }));
  }

  #memoryPrompts(db: Database, noticeId: string): readonly MemoryPromptRow[] {
    return toMemoryPromptRows(
      stmt(db, "SELECT * FROM tavi_memory_prompts WHERE notice_id = ? ORDER BY number").all(noticeId) as MemoryPromptDbRow[],
    );
  }

  pruneMemoryPrompts(input: { readonly now: string; readonly settledBefore: string; readonly settle?: readonly string[] }): {
    readonly settled: number;
    readonly deleted: number;
  } {
    const db = this.#db();
    return db
      .transaction(() => {
        // A row settles when its record no longer waits: decided, expired, or gone.
        const settled =
          input.settle === undefined
            ? stmt(
                db,
                `UPDATE tavi_memory_prompts SET settled_at = ?
           WHERE settled_at IS NULL
             AND NOT EXISTS (SELECT 1 FROM tavi_memory_records r WHERE r.record_id = tavi_memory_prompts.record_id AND r.status = 'proposed')`,
              ).run(input.now).changes
            : stmt(
                db,
                `UPDATE tavi_memory_prompts SET settled_at = ?
           WHERE settled_at IS NULL
             AND record_id IN (SELECT value FROM json_each(?))`,
              ).run(input.now, JSON.stringify(input.settle)).changes;
        // A card's rows go together, a week after its last one settled (the press-age limit).
        const deleted = stmt(
          db,
          `DELETE FROM tavi_memory_prompts WHERE notice_id IN (
           SELECT notice_id FROM tavi_memory_prompts GROUP BY notice_id
           HAVING count(*) = count(settled_at) AND max(settled_at) < ?)`,
        ).run(input.settledBefore).changes;
        return { settled, deleted };
      })
      .immediate();
  }

  getNotice(noticeId: string): ChatNotice | undefined {
    const row = stmt(this.#db(), `${NOTICE_SELECT} WHERE n.notice_id = ?`).get(noticeId) as NoticeRow | undefined;
    return row === undefined ? undefined : toNotice(row);
  }

  notices(taskId: string, options: { readonly limit: number }): readonly ChatNotice[] {
    const limit = Math.max(1, Math.min(options.limit, NOTICES_PAGE_MAX));
    const rows = stmt(
      this.#db(),
      `${NOTICE_SELECT} WHERE n.task_id = ? AND ${SHOWN_NOTICE} ORDER BY n.created_at DESC, n.rowid DESC LIMIT ?`,
    ).all(taskId, limit) as NoticeRow[];
    return rows.reverse().map(toNotice);
  }

  claimNotices(
    taskId: string,
    key: string,
    limit: number,
  ): { readonly notices: readonly ChatNotice[]; readonly claimed: readonly string[]; readonly more: number } {
    const db = this.#db();
    return db
      .transaction(() => {
        const unread = (
          stmt(db, "SELECT notice_id FROM tavi_chat_notices WHERE task_id = ? AND read_by IS NULL").all(taskId) as {
            readonly notice_id: string;
          }[]
        ).map((row) => row.notice_id);
        if (unread.length > 0) stmt(db, "UPDATE tavi_chat_notices SET read_by = ? WHERE task_id = ? AND read_by IS NULL").run(key, taskId);
        const rows = stmt(db, `${NOTICE_SELECT} WHERE n.task_id = ? AND n.read_by = ? ORDER BY n.created_at DESC, n.rowid DESC`).all(
          taskId,
          key,
        ) as NoticeRow[];
        const shown = rows.slice(0, Math.max(0, limit)).reverse().map(toNotice);
        return { notices: shown, claimed: unread, more: Math.max(0, rows.length - shown.length) };
      })
      .immediate();
  }

  releaseOrphanedNotices(): number {
    // A claim whose turn never committed (the owner stopped between claim and run): handed back,
    // so the chat's next turn reads it. A committed or failed turn's claim stands.
    return stmt(
      this.#db(),
      `UPDATE tavi_chat_notices SET read_by = NULL
       WHERE read_by IS NOT NULL
         AND read_by <> '${DISPLAY_ONLY}'
         AND kind NOT IN (${DISPLAY_ONLY_SQL})
         AND NOT EXISTS (SELECT 1 FROM tavi_admissions a
                          WHERE a.task_id = tavi_chat_notices.task_id
                            AND a.operation_key = tavi_chat_notices.read_by
                            AND a.result IS NOT NULL AND a.state <> 'refused')`,
    ).run().changes;
  }

  releaseNotices(key: string, noticeIds: readonly string[]): number {
    if (noticeIds.length === 0) return 0;
    const db = this.#db();
    const release = stmt(db, "UPDATE tavi_chat_notices SET read_by = NULL WHERE notice_id = ? AND read_by = ?");
    return db.transaction(() => noticeIds.reduce((count, noticeId) => count + release.run(noticeId, key).changes, 0)).immediate();
  }

  recordSteer(input: {
    readonly steerId: string;
    readonly taskId: string;
    readonly messageId: string;
    readonly conversationId: string;
    readonly text: string;
    readonly createdAt: string;
  }): ChatSteer {
    const db = this.#db();
    return db
      .transaction((): ChatSteer => {
        stmt(
          db,
          "INSERT INTO tavi_chat_steers (steer_id, task_id, message_id, conversation_id, text, state, admission_id, created_at) VALUES (?, ?, ?, ?, ?, 'pending', NULL, ?) ON CONFLICT (task_id, message_id) DO NOTHING",
        ).run(input.steerId, input.taskId, input.messageId, input.conversationId, input.text, input.createdAt);
        const row = stmt(db, "SELECT * FROM tavi_chat_steers WHERE task_id = ? AND message_id = ?").get(input.taskId, input.messageId) as
          | SteerRow
          | undefined;
        if (row === undefined) throw new Error(`steer ${input.steerId} vanished inside its own transaction`);
        return toSteer(row);
      })
      .immediate();
  }

  steerOf(taskId: string, messageId: string): ChatSteer | undefined {
    const row = stmt(this.#db(), "SELECT * FROM tavi_chat_steers WHERE task_id = ? AND message_id = ?").get(taskId, messageId) as
      | SteerRow
      | undefined;
    return row === undefined ? undefined : toSteer(row);
  }

  openSteers(taskId: string): readonly ChatSteer[] {
    const rows = stmt(
      this.#db(),
      "SELECT * FROM tavi_chat_steers WHERE task_id = ? AND state IN ('pending', 'claimed') ORDER BY created_at, rowid",
    ).all(taskId) as SteerRow[];
    return rows.map(toSteer);
  }

  claimSteers(taskId: string, admissionId: string, steerIds: readonly string[]): readonly string[] {
    if (steerIds.length === 0) return [];
    const db = this.#db();
    const claim = stmt(
      db,
      "UPDATE tavi_chat_steers SET state = 'claimed', admission_id = ? WHERE steer_id = ? AND task_id = ? AND state IN ('pending', 'claimed')",
    );
    return db.transaction(() => steerIds.filter((steerId) => claim.run(admissionId, steerId, taskId).changes > 0)).immediate();
  }

  settleSteers(taskId: string, heldIds: readonly string[]): void {
    const db = this.#db();
    const held = new Set(heldIds);
    db.transaction(() => {
      const claimed = stmt(db, "SELECT steer_id FROM tavi_chat_steers WHERE task_id = ? AND state = 'claimed'").all(taskId) as {
        readonly steer_id: string;
      }[];
      const consume = stmt(db, "UPDATE tavi_chat_steers SET state = 'consumed' WHERE steer_id = ? AND state = 'claimed'");
      const release = stmt(
        db,
        "UPDATE tavi_chat_steers SET state = 'pending', admission_id = NULL WHERE steer_id = ? AND state = 'claimed'",
      );
      for (const row of claimed) (held.has(row.steer_id) ? consume : release).run(row.steer_id);
    }).immediate();
  }

  releaseOrphanedSteers(): number {
    // A claim whose admission ended without settling it, or is gone (the owner stopped between
    // the claim and the settle): pending again, for the chat's next turn or its hand-off. A claim
    // of an admission still unended is kept: that turn, recovered, takes it.
    return stmt(
      this.#db(),
      `UPDATE tavi_chat_steers SET state = 'pending', admission_id = NULL
       WHERE state = 'claimed'
         AND NOT EXISTS (SELECT 1 FROM tavi_admissions a
                          WHERE a.admission_id = tavi_chat_steers.admission_id
                            AND a.state = 'claimed' AND a.result IS NULL)`,
    ).run().changes;
  }

  reconcile(taskId: string, options?: { readonly beforeAdmissionId?: string }): number {
    const db = this.#db();
    return db
      .transaction((): number => {
        const before =
          options?.beforeAdmissionId === undefined
            ? undefined
            : (stmt(db, "SELECT created_at, rowid AS row_id FROM tavi_admissions WHERE admission_id = ? AND task_id = ?").get(
                options.beforeAdmissionId,
                taskId,
              ) as { readonly created_at: string; readonly row_id: number } | undefined);
        if (options?.beforeAdmissionId !== undefined && before === undefined) return 0;
        const rows = stmt(
          db,
          `SELECT a.admission_id, a.kind, a.intent, a.result, a.updated_at ${UNRECONCILED_FROM}
          AND a.task_id = @taskId
          AND (@beforeAt IS NULL OR a.created_at < @beforeAt OR (a.created_at = @beforeAt AND a.rowid < @beforeRow))
        ORDER BY a.created_at, a.rowid LIMIT ${RECONCILE_MAX}`,
        ).all({ taskId, since: "", beforeAt: before?.created_at ?? null, beforeRow: before?.row_id ?? null }) as {
          readonly admission_id: string;
          readonly kind: string;
          readonly intent: string;
          readonly result: string;
          readonly updated_at: string;
        }[];
        const insert = stmt(
          db,
          "INSERT INTO tavi_transcript_entries (task_id, seq, admission_id, turn_json, created_at) VALUES (?, ?, ?, ?, ?)",
        );
        let saved = 0;
        for (const row of rows) {
          const turn = recoveredTurn(row.kind, row.intent, row.result);
          if (turn === undefined) continue;
          insert.run(taskId, this.#newestSeq(taskId) + 1, row.admission_id, JSON.stringify(turn), row.updated_at);
          saved += 1;
        }
        return saved;
      })
      .immediate();
  }

  listUnreconciled(options: { readonly since: string; readonly limit: number }): readonly string[] {
    const limit = Math.max(1, Math.min(Math.floor(options.limit), 1_000));
    return (
      stmt(this.#db(), `SELECT DISTINCT a.task_id ${UNRECONCILED_FROM} LIMIT @limit`).all({ since: options.since, limit }) as {
        readonly task_id: string;
      }[]
    ).map((row) => row.task_id);
  }

  queueSteer(taskId: string, steerId: string): boolean {
    return (
      stmt(this.#db(), "UPDATE tavi_chat_steers SET state = 'queued' WHERE steer_id = ? AND task_id = ? AND state = 'pending'").run(
        steerId,
        taskId,
      ).changes > 0
    );
  }

  #notice(noticeId: string): ChatNotice {
    const notice = this.getNotice(noticeId);
    if (notice === undefined) throw new Error(`notice ${noticeId} vanished inside its own transaction`);
    return notice;
  }

  page(taskId: string, options: { readonly before?: number; readonly after?: number; readonly limit: number }): TranscriptPage {
    const limit = Math.max(1, Math.min(options.limit, TRANSCRIPT_PAGE_MAX));
    if (options.after !== undefined) return this.#pageAfter(taskId, options.after, limit);
    const rows = stmt(
      this.#db(),
      `SELECT * FROM tavi_transcript_entries WHERE task_id = ? ${options.before === undefined ? "" : "AND seq < ?"} ORDER BY seq DESC LIMIT ?`,
    ).all(...(options.before === undefined ? [taskId, limit + 1] : [taskId, options.before, limit + 1])) as EntryRow[];
    const more = rows.length > limit;
    const entries = rows.slice(0, limit).reverse().map(toEntry);
    // The notices among these turns: from the page's first turn (from the
    // chat's start on its oldest page) up to the turn before the next page's.
    const from = more && entries[0] !== undefined ? entries[0].seq : 0;
    const noticeRows = stmt(
      this.#db(),
      `${NOTICE_SELECT} WHERE n.task_id = ? AND ${SHOWN_NOTICE} AND n.after_seq >= ? ${options.before === undefined ? "" : "AND n.after_seq < ?"} ORDER BY n.after_seq DESC, n.created_at DESC, n.rowid DESC LIMIT ?`,
    ).all(
      ...(options.before === undefined ? [taskId, from, NOTICES_PAGE_MAX] : [taskId, from, options.before, NOTICES_PAGE_MAX]),
    ) as NoticeRow[];
    const notices = noticeRows.reverse().map(toNotice);
    return {
      entries,
      ...(more && entries[0] !== undefined ? { nextBefore: entries[0].seq } : {}),
      ...(notices.length === 0 ? {} : { notices }),
    };
  }

  /**
   * The oldest `limit` turns after `after`, and the notices among them: from
   * the one after turn `after` up to the one before the page's last turn —
   * every notice after it too, on the newest page — so consecutive pages
   * share none.
   */
  #pageAfter(taskId: string, after: number, limit: number): TranscriptPage {
    const rows = stmt(this.#db(), "SELECT * FROM tavi_transcript_entries WHERE task_id = ? AND seq > ? ORDER BY seq LIMIT ?").all(
      taskId,
      after,
      limit + 1,
    ) as EntryRow[];
    const more = rows.length > limit;
    const entries = rows.slice(0, limit).map(toEntry);
    const last = entries.at(-1);
    const noticeRows = stmt(
      this.#db(),
      `${NOTICE_SELECT} WHERE n.task_id = ? AND ${SHOWN_NOTICE} AND n.after_seq >= ? ${more ? "AND n.after_seq < ?" : ""} ORDER BY n.after_seq, n.created_at, n.rowid LIMIT ?`,
    ).all(...(more && last !== undefined ? [taskId, after, last.seq, NOTICES_PAGE_MAX] : [taskId, after, NOTICES_PAGE_MAX])) as NoticeRow[];
    const notices = noticeRows.map(toNotice);
    return { entries, ...(more && last !== undefined ? { nextAfter: last.seq } : {}), ...(notices.length === 0 ? {} : { notices }) };
  }
}

/** A `tavi_memory_prompts` row as stored. */
interface MemoryPromptDbRow {
  readonly token: string;
  readonly notice_id: string;
  readonly workspace_id: string;
  readonly principal_id: string;
  readonly record_id: string;
  readonly task_id: string;
  readonly number: number;
  readonly created_at: string;
  readonly settled_at: string | null;
}

function toMemoryPromptRows(rows: readonly MemoryPromptDbRow[]): readonly MemoryPromptRow[] {
  return rows.map((row) => ({
    token: row.token,
    noticeId: row.notice_id,
    workspaceId: row.workspace_id,
    principalId: row.principal_id,
    recordId: row.record_id,
    taskId: row.task_id,
    number: row.number,
    createdAt: row.created_at,
    ...(row.settled_at === null ? {} : { settledAt: row.settled_at }),
  }));
}
