import type { NeedDeliveryRepositoryPort } from "./internal-contracts.js";
import { NeedDeliveryRecordSchema, PendingReasonRecordSchema, type NeedDeliveryRecord, type PendingReasonRecord } from "@tavi/contracts";

import type { Database } from "./sqlite-loader.js";

interface DeliveryRow {
  readonly wait_id: string;
  readonly task_id: string;
  readonly connection_id: string;
  readonly destination_json: string;
  readonly provider_message_id: string | null;
  /** The chat the question was delivered to: a typed reply is matched by chat and message id. */
  readonly chat_id: string | null;
  /** The forum topic or reply thread it was asked in; NULL for the chat itself. */
  readonly thread_id: string | null;
  readonly text: string;
  readonly token: string;
  readonly selected_json: string;
  readonly created_at: string;
}

interface ReasonRow {
  readonly reason_key: string;
  readonly token: string;
  readonly workspace_id: string;
  readonly principal_id: string;
  readonly caller: string;
  readonly reply_target_json: string;
  readonly expires_at: string;
}

const toDelivery = (row: DeliveryRow): NeedDeliveryRecord =>
  NeedDeliveryRecordSchema.parse({
    waitId: row.wait_id,
    taskId: row.task_id,
    connectionId: row.connection_id,
    destination: JSON.parse(row.destination_json) as unknown,
    ...(row.provider_message_id === null ? {} : { providerMessageId: row.provider_message_id }),
    ...(row.chat_id === null ? {} : { chatId: row.chat_id }),
    ...(row.thread_id === null ? {} : { threadId: row.thread_id }),
    text: row.text,
    token: row.token,
    selected: JSON.parse(row.selected_json) as unknown,
    createdAt: row.created_at,
  });

const toReason = (row: ReasonRow): PendingReasonRecord =>
  PendingReasonRecordSchema.parse({
    key: row.reason_key,
    token: row.token,
    workspaceId: row.workspace_id,
    principalId: row.principal_id,
    caller: row.caller,
    replyTarget: JSON.parse(row.reply_target_json) as unknown,
    expiresAt: row.expires_at,
  });

/** Where each question went, and ❌ presses waiting for their reason. */
export class SqliteNeedDeliveryRepository implements NeedDeliveryRepositoryPort {
  readonly #db: () => Database;

  constructor(db: () => Database) {
    this.#db = db;
  }

  record(delivery: Omit<NeedDeliveryRecord, "selected">): void {
    const value = NeedDeliveryRecordSchema.omit({ selected: true }).parse(delivery);
    this.#db()
      .prepare(
        `INSERT INTO tavi_need_deliveries (wait_id, task_id, connection_id, destination_json, provider_message_id, chat_id, thread_id, text, token, selected_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?)
         ON CONFLICT (wait_id, connection_id) DO UPDATE SET provider_message_id = COALESCE(provider_message_id, excluded.provider_message_id), chat_id = COALESCE(chat_id, excluded.chat_id),
           thread_id = COALESCE(thread_id, excluded.thread_id)`,
      )
      .run(
        value.waitId,
        value.taskId,
        value.connectionId,
        JSON.stringify(value.destination ?? null),
        value.providerMessageId ?? null,
        value.chatId ?? null,
        value.threadId ?? null,
        value.text,
        value.token,
        value.createdAt,
      );
  }

  listForWait(waitId: string): readonly NeedDeliveryRecord[] {
    const rows = this.#db()
      .prepare("SELECT * FROM tavi_need_deliveries WHERE wait_id = ? ORDER BY created_at, connection_id")
      .all(waitId) as DeliveryRow[];
    return rows.map(toDelivery);
  }

  getByToken(token: string): NeedDeliveryRecord | undefined {
    const row = this.#db().prepare("SELECT * FROM tavi_need_deliveries WHERE token = ? ORDER BY created_at LIMIT 1").get(token) as
      | DeliveryRow
      | undefined;
    return row === undefined ? undefined : toDelivery(row);
  }

  getByMessage(connectionId: string, chatId: string, providerMessageId: string): NeedDeliveryRecord | undefined {
    const row = this.#db()
      .prepare(
        "SELECT * FROM tavi_need_deliveries WHERE connection_id = ? AND chat_id = ? AND provider_message_id = ? ORDER BY created_at DESC LIMIT 1",
      )
      .get(connectionId, chatId, providerMessageId) as DeliveryRow | undefined;
    return row === undefined ? undefined : toDelivery(row);
  }

  listOpenInChat(connectionId: string, chatId: string, threadId: string | undefined, limit: number): readonly NeedDeliveryRecord[] {
    // A thread named matches only deliveries into it; none named, any of the chat's.
    const rows = this.#db()
      .prepare(
        `SELECT d.* FROM tavi_need_deliveries d JOIN tavi_agent_wait_intents w ON w.wait_id = d.wait_id
          WHERE d.connection_id = ? AND d.chat_id = ? AND (? IS NULL OR d.thread_id = ?) AND w.state = 'active' ORDER BY d.created_at DESC LIMIT ?`,
      )
      .all(connectionId, chatId, threadId ?? null, threadId ?? null, Math.max(1, Math.min(limit, 100))) as DeliveryRow[];
    return rows.map(toDelivery);
  }

  setSelected(waitId: string, connectionId: string, selected: readonly number[]): void {
    this.#db()
      .prepare("UPDATE tavi_need_deliveries SET selected_json = ? WHERE wait_id = ? AND connection_id = ?")
      .run(JSON.stringify(selected), waitId, connectionId);
  }

  putReason(reason: PendingReasonRecord): void {
    const value = PendingReasonRecordSchema.parse(reason);
    this.#db()
      .prepare(
        `INSERT INTO tavi_pending_reject_reasons (reason_key, token, workspace_id, principal_id, caller, reply_target_json, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (reason_key) DO UPDATE SET token = excluded.token, workspace_id = excluded.workspace_id, principal_id = excluded.principal_id,
           caller = excluded.caller, reply_target_json = excluded.reply_target_json, expires_at = excluded.expires_at`,
      )
      .run(value.key, value.token, value.workspaceId, value.principalId, value.caller, JSON.stringify(value.replyTarget), value.expiresAt);
  }

  getReason(key: string): PendingReasonRecord | undefined {
    const row = this.#db().prepare("SELECT * FROM tavi_pending_reject_reasons WHERE reason_key = ?").get(key) as ReasonRow | undefined;
    return row === undefined ? undefined : toReason(row);
  }

  takeReason(key: string, token?: string): PendingReasonRecord | undefined {
    const row = (
      token === undefined
        ? this.#db().prepare("DELETE FROM tavi_pending_reject_reasons WHERE reason_key = ? RETURNING *").get(key)
        : this.#db().prepare("DELETE FROM tavi_pending_reject_reasons WHERE reason_key = ? AND token = ? RETURNING *").get(key, token)
    ) as ReasonRow | undefined;
    return row === undefined ? undefined : toReason(row);
  }

  takeExpiredReasons(now: string): readonly PendingReasonRecord[] {
    const rows = this.#db().prepare("DELETE FROM tavi_pending_reject_reasons WHERE expires_at <= ? RETURNING *").all(now) as ReasonRow[];
    return rows.map(toReason);
  }
}
