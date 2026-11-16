import type {
  ApprovalRoundDeliveryRepositoryPort,
  ChannelPurgeRepositoryPort,
  ChannelRoomRepositoryPort,
  MessagingGrantRepositoryPort,
} from "./internal-contracts.js";
import {
  ApprovalRoundDeliveryRecordSchema,
  MessagingGrantRecordSchema,
  TaviError,
  grantRefusal,
  type MessagingGrantRecord,
  ChannelPurgeCountsSchema,
  ChannelPurgeRecordSchema,
  ChannelRoomRecordSchema,
  type ApprovalRoundDeliveryRecord,
  type ChannelPurgeCounts,
  type ChannelPurgeInventory,
  type ChannelSenderForgetting,
  type ChannelPurgeRecord,
  type ChannelRoomRecord,
} from "@tavi/contracts";

import type { Database } from "./sqlite-loader.js";

// The host's records for group chats: listed rooms, where each approval round was delivered,
// and connections waiting to be purged.

interface RoomRow {
  readonly connection_id: string;
  readonly conversation_id: string;
  readonly workspace_id: string;
  readonly label: string;
  readonly trigger_json: string;
  readonly members: string;
  readonly context: string;
  readonly intro_state: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly disabled_at: string | null;
  readonly auto_thread: number;
}

const toRoom = (row: RoomRow): ChannelRoomRecord =>
  ChannelRoomRecordSchema.parse({
    connectionId: row.connection_id,
    conversationId: row.conversation_id,
    workspaceId: row.workspace_id,
    label: row.label,
    trigger: JSON.parse(row.trigger_json) as unknown,
    members: row.members,
    context: row.context,
    introState: row.intro_state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.disabled_at === null ? {} : { disabledAt: row.disabled_at }),
    ...(row.auto_thread === 1 ? { autoThread: true } : {}),
  });

export class SqliteChannelRoomRepository implements ChannelRoomRepositoryPort {
  readonly #db: () => Database;

  constructor(db: () => Database) {
    this.#db = db;
  }

  get(connectionId: string, conversationId: string): ChannelRoomRecord | undefined {
    const row = this.#db()
      .prepare("SELECT * FROM tavi_channel_rooms WHERE connection_id = ? AND conversation_id = ?")
      .get(connectionId, conversationId) as RoomRow | undefined;
    return row === undefined ? undefined : toRoom(row);
  }

  listForConnection(connectionId: string): readonly ChannelRoomRecord[] {
    const rows = this.#db()
      .prepare("SELECT * FROM tavi_channel_rooms WHERE connection_id = ? ORDER BY created_at, conversation_id")
      .all(connectionId) as RoomRow[];
    return rows.map(toRoom);
  }

  upsert(room: ChannelRoomRecord): void {
    const checked = ChannelRoomRecordSchema.parse(room);
    this.#db()
      .prepare(`
INSERT INTO tavi_channel_rooms (connection_id, conversation_id, workspace_id, label, trigger_json, members, context, intro_state, created_at, updated_at, disabled_at, auto_thread)
VALUES (@connectionId, @conversationId, @workspaceId, @label, @trigger, @members, @context, @introState, @createdAt, @updatedAt, @disabledAt, @autoThread)
ON CONFLICT (connection_id, conversation_id) DO UPDATE SET
  workspace_id = excluded.workspace_id, label = excluded.label, trigger_json = excluded.trigger_json, members = excluded.members,
  context = excluded.context, intro_state = excluded.intro_state, updated_at = excluded.updated_at, disabled_at = excluded.disabled_at,
  auto_thread = excluded.auto_thread`)
      .run({
        connectionId: checked.connectionId,
        conversationId: checked.conversationId,
        workspaceId: checked.workspaceId,
        label: checked.label,
        trigger: JSON.stringify(checked.trigger),
        members: checked.members,
        context: checked.context,
        introState: checked.introState,
        createdAt: checked.createdAt,
        updatedAt: checked.updatedAt,
        disabledAt: checked.disabledAt ?? null,
        autoThread: checked.autoThread === true ? 1 : 0,
      });
  }

  setIntroState(connectionId: string, conversationId: string, state: ChannelRoomRecord["introState"], at: string): boolean {
    return (
      this.#db()
        .prepare("UPDATE tavi_channel_rooms SET intro_state = ?, updated_at = ? WHERE connection_id = ? AND conversation_id = ?")
        .run(state, at, connectionId, conversationId).changes > 0
    );
  }

  remove(connectionId: string, conversationId: string): boolean {
    return (
      this.#db().prepare("DELETE FROM tavi_channel_rooms WHERE connection_id = ? AND conversation_id = ?").run(connectionId, conversationId)
        .changes > 0
    );
  }

  removeForConnection(connectionId: string): number {
    return this.#db().prepare("DELETE FROM tavi_channel_rooms WHERE connection_id = ?").run(connectionId).changes;
  }
}

interface RoundDeliveryRow {
  readonly task_id: string;
  readonly steps: number;
  readonly connection_id: string;
  readonly role: string;
  readonly destination_json: string;
  readonly message_ids_json: string;
  readonly text: string;
  readonly created_at: string;
}

const toRoundDelivery = (row: RoundDeliveryRow): ApprovalRoundDeliveryRecord =>
  ApprovalRoundDeliveryRecordSchema.parse({
    taskId: row.task_id,
    steps: row.steps,
    connectionId: row.connection_id,
    role: row.role,
    destination: JSON.parse(row.destination_json) as unknown,
    messageIds: JSON.parse(row.message_ids_json) as unknown,
    text: row.text,
    createdAt: row.created_at,
  });

export class SqliteApprovalRoundDeliveryRepository implements ApprovalRoundDeliveryRepositoryPort {
  readonly #db: () => Database;

  constructor(db: () => Database) {
    this.#db = db;
  }

  record(delivery: ApprovalRoundDeliveryRecord): void {
    const checked = ApprovalRoundDeliveryRecordSchema.parse(delivery);
    this.#db()
      .prepare(`
INSERT INTO tavi_approval_round_deliveries (task_id, steps, connection_id, role, destination_json, message_ids_json, text, created_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (task_id, steps, connection_id, role) DO UPDATE SET
  destination_json = excluded.destination_json, message_ids_json = excluded.message_ids_json, text = excluded.text`)
      .run(
        checked.taskId,
        checked.steps,
        checked.connectionId,
        checked.role,
        JSON.stringify(checked.destination ?? null),
        JSON.stringify(checked.messageIds),
        checked.text,
        checked.createdAt,
      );
  }

  listForRound(taskId: string, steps: number): readonly ApprovalRoundDeliveryRecord[] {
    const rows = this.#db()
      .prepare("SELECT * FROM tavi_approval_round_deliveries WHERE task_id = ? AND steps = ? ORDER BY created_at, role")
      .all(taskId, steps) as RoundDeliveryRow[];
    return rows.map(toRoundDelivery);
  }

  removeForConnection(connectionId: string): number {
    return this.#db().prepare("DELETE FROM tavi_approval_round_deliveries WHERE connection_id = ?").run(connectionId).changes;
  }
}

interface PurgeRow {
  readonly connection_id: string;
  readonly workspace_id: string;
  readonly provider_id: string;
  readonly account_ref: string;
  readonly requested_at: string;
  readonly purge_after: string;
  readonly state: string;
  readonly counts_json: string | null;
  readonly finished_at: string | null;
}

const toPurge = (row: PurgeRow): ChannelPurgeRecord =>
  ChannelPurgeRecordSchema.parse({
    connectionId: row.connection_id,
    workspaceId: row.workspace_id,
    providerId: row.provider_id,
    accountRef: row.account_ref,
    requestedAt: row.requested_at,
    purgeAfter: row.purge_after,
    state: row.state,
    ...(row.counts_json === null ? {} : { counts: JSON.parse(row.counts_json) as unknown }),
    ...(row.finished_at === null ? {} : { finishedAt: row.finished_at }),
  });

/** A sender's inbox rows on a connection (bound as `connection_id`, `externalSenderId`). */
const SENDERS_ROWS = "connection_id = ? AND json_valid(payload_json) AND json_extract(payload_json, '$.externalSenderId') = ?";
/** Another person's inbox rows on a connection quoting the sender's words: a reply's parent or a picked message (`referenced`, its author's), bound the same way. */
const QUOTING_ROWS =
  "connection_id = ? AND json_valid(payload_json) AND json_extract(payload_json, '$.referenced.externalSenderId') = ? AND json_type(payload_json, '$.referenced.content') IS NOT NULL";

export class SqliteChannelPurgeRepository implements ChannelPurgeRepositoryPort {
  readonly #db: () => Database;

  constructor(db: () => Database) {
    this.#db = db;
  }

  schedule(purge: Omit<ChannelPurgeRecord, "state" | "counts" | "finishedAt">): void {
    const checked = ChannelPurgeRecordSchema.omit({ state: true, counts: true, finishedAt: true }).parse(purge);
    this.#db()
      .prepare(`
INSERT INTO tavi_channel_purges (connection_id, workspace_id, provider_id, account_ref, requested_at, purge_after, state, counts_json, finished_at)
VALUES (?, ?, ?, ?, ?, ?, 'scheduled', NULL, NULL)
ON CONFLICT (connection_id) DO UPDATE SET
  workspace_id = excluded.workspace_id, provider_id = excluded.provider_id, account_ref = excluded.account_ref,
  requested_at = excluded.requested_at, purge_after = excluded.purge_after, state = 'scheduled', counts_json = NULL, finished_at = NULL
WHERE tavi_channel_purges.state IN ('cancelled', 'done')`)
      .run(checked.connectionId, checked.workspaceId, checked.providerId, checked.accountRef, checked.requestedAt, checked.purgeAfter);
  }

  get(connectionId: string): ChannelPurgeRecord | undefined {
    const row = this.#db().prepare("SELECT * FROM tavi_channel_purges WHERE connection_id = ?").get(connectionId) as PurgeRow | undefined;
    return row === undefined ? undefined : toPurge(row);
  }

  cancelForAccount(
    providerId: string,
    accountRef: string,
    at: string,
    opener?: { readonly connectionId: string; readonly createdAt?: string | undefined },
  ): readonly string[] {
    // Within the grace only: an overdue purge the sweep has not reached yet still runs.
    const byOpener = opener === undefined ? "" : " AND (connection_id = ? OR requested_at <= ?)";
    const rows = this.#db()
      .prepare(
        `UPDATE tavi_channel_purges SET state = 'cancelled', finished_at = ? WHERE provider_id = ? AND account_ref = ? AND state = 'scheduled' AND purge_after > ?${byOpener} RETURNING connection_id`,
      )
      .all(at, providerId, accountRef, at, ...(opener === undefined ? [] : [opener.connectionId, opener.createdAt ?? ""])) as {
      readonly connection_id: string;
    }[];
    return rows.map((row) => row.connection_id);
  }

  listDue(now: string): readonly ChannelPurgeRecord[] {
    const rows = this.#db()
      .prepare(
        "SELECT * FROM tavi_channel_purges WHERE (state = 'scheduled' AND purge_after <= ?) OR state = 'running' ORDER BY purge_after, connection_id",
      )
      .all(now) as PurgeRow[];
    return rows.map(toPurge);
  }

  markRunning(connectionId: string): boolean {
    return (
      this.#db()
        .prepare("UPDATE tavi_channel_purges SET state = 'running' WHERE connection_id = ? AND state IN ('scheduled', 'running')")
        .run(connectionId).changes > 0
    );
  }

  recordProgress(connectionId: string, counts: ChannelPurgeCounts): boolean {
    return (
      this.#db()
        .prepare("UPDATE tavi_channel_purges SET counts_json = ? WHERE connection_id = ? AND state = 'running'")
        .run(JSON.stringify(ChannelPurgeCountsSchema.parse(counts)), connectionId).changes > 0
    );
  }

  inventory(connectionId: string): ChannelPurgeInventory {
    const db = this.#db();
    const tasks = db
      .prepare("SELECT DISTINCT task_id FROM tavi_messaging_conversation_tasks WHERE connection_id = ? ORDER BY task_id")
      .all(connectionId) as { readonly task_id: string }[];
    const conversations = (
      db
        .prepare("SELECT COUNT(DISTINCT external_conversation_id) AS n FROM tavi_messaging_conversation_tasks WHERE connection_id = ?")
        .get(connectionId) as { readonly n: number }
    ).n;
    const messages = (
      db.prepare("SELECT COUNT(*) AS n FROM tavi_messaging_inbox WHERE connection_id = ?").get(connectionId) as { readonly n: number }
    ).n;
    // The artifacts the host stored for its messages' media (`payload.attachments`).
    const artifacts = db
      .prepare(`
SELECT DISTINCT json_extract(attachment.value, '$.artifactId') AS artifact_id
FROM tavi_messaging_inbox AS inbox, json_each(inbox.payload_json, '$.attachments') AS attachment
WHERE inbox.connection_id = ? AND json_valid(inbox.payload_json) AND json_extract(attachment.value, '$.artifactId') IS NOT NULL`)
      .all(connectionId) as { readonly artifact_id: string }[];
    // What the purge's erase would take from routines and heartbeats, read the same way.
    const routineTargets = (
      db
        .prepare(
          "SELECT target_id FROM tavi_routine_delivery_targets WHERE json_extract(target_json, '$.connectionId') = ? ORDER BY target_id",
        )
        .all(connectionId) as { readonly target_id: string }[]
    ).map((row) => row.target_id);
    const heartbeats = db
      .prepare(`
SELECT workspace_id, principal_id FROM tavi_heartbeats
WHERE json_valid(config_json) AND EXISTS (SELECT 1 FROM json_each(config_json, '$.targets') AS target WHERE json_extract(target.value, '$.connectionId') = ?)
ORDER BY workspace_id, principal_id`)
      .all(connectionId) as { readonly workspace_id: string; readonly principal_id: string }[];
    return {
      taskIds: tasks.map((row) => row.task_id),
      artifactIds: withDerived(
        db,
        artifacts.map((row) => row.artifact_id),
      ),
      conversations,
      messages,
      routineTargets,
      heartbeats: heartbeats.map((row) => ({ workspaceId: row.workspace_id, principalId: row.principal_id })),
    };
  }

  erase(
    connectionId: string,
    taskIds: readonly string[],
    finished?: ChannelPurgeCounts,
    at?: string,
  ): {
    readonly counts: ChannelPurgeCounts;
    readonly routineTargets: readonly string[];
    readonly heartbeats: readonly { readonly workspaceId: string; readonly principalId: string }[];
  } {
    const db = this.#db();
    return db.transaction(() => {
      const counts: Record<string, number> = {};
      const byConnection = (table: string, kind: string): void => {
        counts[kind] = db.prepare(`DELETE FROM ${table} WHERE connection_id = ?`).run(connectionId).changes;
      };
      byConnection("tavi_messaging_inbox", "inbox");
      byConnection("tavi_messaging_outbox", "outbox");
      byConnection("tavi_messaging_deliveries", "deliveries");
      byConnection("tavi_messaging_inbound_activity", "inboundActivity");
      byConnection("tavi_need_deliveries", "needDeliveries");
      byConnection("tavi_messaging_identity_bindings", "bindings");
      byConnection("tavi_messaging_conversation_tasks", "conversations");
      byConnection("tavi_channel_rooms", "rooms");
      byConnection("tavi_approval_round_deliveries", "roundDeliveries");
      byConnection("tavi_messaging_grants", "messagingGrants");
      counts["rounds"] = db
        .prepare("UPDATE tavi_approval_rounds SET connection_id = NULL, conversation_id = NULL WHERE connection_id = ?")
        .run(connectionId).changes;
      let prompts = 0;
      let grants = 0;
      let admissions = 0;
      for (const taskId of taskIds) {
        prompts += db.prepare("DELETE FROM tavi_memory_prompts WHERE task_id = ?").run(taskId).changes;
        grants += db.prepare("DELETE FROM tavi_session_grants WHERE task_id = ?").run(taskId).changes;
        // A forget keeps an admission's canonical intent (`intent_hash`), which holds its words, for a retry of its key
        // to be checked against; nothing retries a purged connection's messages, so the words go too.
        admissions += db
          .prepare(
            "UPDATE tavi_admissions SET intent = '{}', intent_hash = 'purged:' || admission_id WHERE task_id = ? AND intent_hash NOT LIKE 'purged:%'",
          )
          .run(taskId).changes;
      }
      counts["memoryPrompts"] = prompts;
      counts["sessionGrants"] = grants;
      counts["admissions"] = admissions;
      // Delivery targets that name it hold the platform's user and chat ids: removed, and named in the report.
      const routineTargets = (
        db
          .prepare("DELETE FROM tavi_routine_delivery_targets WHERE json_extract(target_json, '$.connectionId') = ? RETURNING target_id")
          .all(connectionId) as { readonly target_id: string }[]
      ).map((row) => row.target_id);
      counts["routineTargets"] = routineTargets.length;
      const heartbeats = db
        .prepare(`
UPDATE tavi_heartbeats
SET config_json = json_set(config_json, '$.targets', json((SELECT json_group_array(json(target.value)) FROM json_each(config_json, '$.targets') AS target WHERE json_extract(target.value, '$.connectionId') IS NOT ?))),
    revision = revision + 1
WHERE json_valid(config_json) AND EXISTS (SELECT 1 FROM json_each(config_json, '$.targets') AS target WHERE json_extract(target.value, '$.connectionId') = ?)
RETURNING workspace_id, principal_id`)
        .all(connectionId, connectionId) as { readonly workspace_id: string; readonly principal_id: string }[];
      counts["heartbeatTargets"] = heartbeats.length;
      const all = ChannelPurgeCountsSchema.parse({ ...counts, ...finished });
      if (finished !== undefined && at !== undefined) this.finish(connectionId, all, at);
      return {
        counts: all,
        routineTargets,
        heartbeats: heartbeats.map((row) => ({ workspaceId: row.workspace_id, principalId: row.principal_id })),
      };
    })();
  }

  senderFootprint(connectionId: string, externalSenderId: string): ChannelSenderForgetting {
    const db = this.#db();
    const artifacts = db
      .prepare(`
SELECT DISTINCT json_extract(attachment.value, '$.artifactId') AS artifact_id
FROM tavi_messaging_inbox AS inbox, json_each(inbox.payload_json, '$.attachments') AS attachment
WHERE inbox.connection_id = ? AND json_valid(inbox.payload_json) AND json_extract(inbox.payload_json, '$.externalSenderId') = ?
  AND json_extract(attachment.value, '$.artifactId') IS NOT NULL`)
      .all(connectionId, externalSenderId) as { readonly artifact_id: string }[];
    const messages = (
      db.prepare(`SELECT COUNT(*) AS n FROM tavi_messaging_inbox WHERE ${SENDERS_ROWS}`).get(connectionId, externalSenderId) as {
        readonly n: number;
      }
    ).n;
    // Where they spoke, and where another's message quoted them: both conversations' turns hold their words.
    const spoken = db
      .prepare(
        `SELECT DISTINCT json_extract(payload_json, '$.externalConversationId') AS conversation_id FROM tavi_messaging_inbox WHERE (${SENDERS_ROWS}) OR (${QUOTING_ROWS})`,
      )
      .all(connectionId, externalSenderId, connectionId, externalSenderId) as { readonly conversation_id: string | null }[];
    const tasksOf = db.prepare(
      "SELECT DISTINCT task_id FROM tavi_messaging_conversation_tasks WHERE connection_id = ? AND (external_conversation_id = ? OR external_conversation_id LIKE ? ESCAPE '\\') ORDER BY task_id",
    );
    const conversations = spoken.flatMap((row) => {
      if (row.conversation_id === null) return [];
      // A forum topic's conversation is keyed under its group (`<group>#topic:<thread>`).
      const escaped = row.conversation_id.replace(/[\\%_]/g, (match) => `\\${match}`);
      const taskIds = (tasksOf.all(connectionId, row.conversation_id, `${escaped}#topic:%`) as { readonly task_id: string }[]).map(
        (task) => task.task_id,
      );
      return [{ conversationId: row.conversation_id, taskIds }];
    });
    const binding = db
      .prepare("SELECT principal_id FROM tavi_messaging_identity_bindings WHERE connection_id = ? AND external_sender_id = ?")
      .get(connectionId, externalSenderId) as { readonly principal_id: string } | undefined;
    return {
      messages,
      artifactIds: withDerived(
        db,
        artifacts.map((row) => row.artifact_id),
      ),
      ...(binding === undefined ? {} : { principalId: binding.principal_id }),
      conversations,
    };
  }

  forgetSender(
    connectionId: string,
    externalSenderId: string,
  ): { readonly messages: number; readonly quoted: number; readonly bindingRemoved: boolean } {
    const db = this.#db();
    return db.transaction(() => {
      // Their contact grants go with their binding: a person allowed again starts with none, and their id is not kept here.
      db.prepare("DELETE FROM tavi_messaging_grants WHERE connection_id = ? AND scope_kind = 'contact' AND scope_id = ?").run(
        connectionId,
        externalSenderId,
      );
      const messages = db.prepare(`DELETE FROM tavi_messaging_inbox WHERE ${SENDERS_ROWS}`).run(connectionId, externalSenderId).changes;
      // Another's message quoting them keeps the quoter's own words: only the quoted ones go.
      const quoted = db
        .prepare(`UPDATE tavi_messaging_inbox SET payload_json = json_remove(payload_json, '$.referenced.content') WHERE ${QUOTING_ROWS}`)
        .run(connectionId, externalSenderId).changes;
      return {
        messages,
        quoted,
        bindingRemoved:
          db
            .prepare("DELETE FROM tavi_messaging_identity_bindings WHERE connection_id = ? AND external_sender_id = ?")
            .run(connectionId, externalSenderId).changes > 0,
      };
    })();
  }

  finish(connectionId: string, counts: ChannelPurgeCounts, at: string): boolean {
    return (
      this.#db()
        .prepare(
          "UPDATE tavi_channel_purges SET state = 'done', counts_json = ?, finished_at = ? WHERE connection_id = ? AND state = 'running'",
        )
        .run(JSON.stringify(ChannelPurgeCountsSchema.parse(counts)), at, connectionId).changes > 0
    );
  }
}

interface GrantRow {
  readonly grant_id: string;
  readonly workspace_id: string;
  readonly connection_id: string;
  readonly scope_kind: string;
  readonly scope_id: string;
  readonly tool_id: string;
  readonly mode: string;
  readonly created_by: string;
  readonly created_at: string;
  readonly expires_at: string | null;
  readonly revoked_at: string | null;
}

const toGrant = (row: GrantRow): MessagingGrantRecord =>
  MessagingGrantRecordSchema.parse({
    grantId: row.grant_id,
    workspaceId: row.workspace_id,
    connectionId: row.connection_id,
    scopeKind: row.scope_kind,
    scopeId: row.scope_id,
    toolId: row.tool_id,
    mode: row.mode,
    createdBy: row.created_by,
    createdAt: row.created_at,
    ...(row.expires_at === null ? {} : { expiresAt: row.expires_at }),
    ...(row.revoked_at === null ? {} : { revokedAt: row.revoked_at }),
  });

/** An operator's room and contact grants: one per connection, scope and tool. */
export class SqliteMessagingGrantRepository implements MessagingGrantRepositoryPort {
  readonly #db: () => Database;

  constructor(db: () => Database) {
    this.#db = db;
  }

  put(grant: MessagingGrantRecord): void {
    const checked = MessagingGrantRecordSchema.parse(grant);
    const refused = grantRefusal(checked);
    if (refused !== undefined) throw new TaviError("INVALID_INPUT", refused);
    this.#db()
      .prepare(`
INSERT INTO tavi_messaging_grants (grant_id, workspace_id, connection_id, scope_kind, scope_id, tool_id, mode, created_by, created_at, expires_at, revoked_at)
VALUES (@grantId, @workspaceId, @connectionId, @scopeKind, @scopeId, @toolId, @mode, @createdBy, @createdAt, @expiresAt, NULL)
ON CONFLICT (connection_id, scope_kind, scope_id, tool_id) DO UPDATE SET
  grant_id = excluded.grant_id, workspace_id = excluded.workspace_id, mode = excluded.mode, created_by = excluded.created_by,
  created_at = excluded.created_at, expires_at = excluded.expires_at, revoked_at = NULL`)
      .run({
        grantId: checked.grantId,
        workspaceId: checked.workspaceId,
        connectionId: checked.connectionId,
        scopeKind: checked.scopeKind,
        scopeId: checked.scopeId,
        toolId: checked.toolId,
        mode: checked.mode,
        createdBy: checked.createdBy,
        createdAt: checked.createdAt,
        expiresAt: checked.expiresAt ?? null,
      });
  }

  get(grantId: string): MessagingGrantRecord | undefined {
    const row = this.#db().prepare("SELECT * FROM tavi_messaging_grants WHERE grant_id = ?").get(grantId) as GrantRow | undefined;
    return row === undefined ? undefined : toGrant(row);
  }

  revoke(grantId: string, at: string): boolean {
    return (
      this.#db().prepare("UPDATE tavi_messaging_grants SET revoked_at = ? WHERE grant_id = ? AND revoked_at IS NULL").run(at, grantId)
        .changes > 0
    );
  }

  listForConnection(connectionId: string): readonly MessagingGrantRecord[] {
    return (
      this.#db()
        .prepare("SELECT * FROM tavi_messaging_grants WHERE connection_id = ? ORDER BY created_at, grant_id")
        .all(connectionId) as GrantRow[]
    ).map(toGrant);
  }

  listForScope(connectionId: string, scopeKind: MessagingGrantRecord["scopeKind"], scopeId: string): readonly MessagingGrantRecord[] {
    return (
      this.#db()
        .prepare(
          "SELECT * FROM tavi_messaging_grants WHERE connection_id = ? AND scope_kind = ? AND scope_id = ? ORDER BY created_at, grant_id",
        )
        .all(connectionId, scopeKind, scopeId) as GrantRow[]
    ).map(toGrant);
  }

  removeForConnection(connectionId: string): number {
    return this.#db().prepare("DELETE FROM tavi_messaging_grants WHERE connection_id = ?").run(connectionId).changes;
  }
}

/**
 * `artifactIds` and the previews a video tool made from them: a
 * purge or a forgotten sender erases a video's frames, sheets and overlays with it, whichever task made them.
 */
function withDerived(db: Database, artifactIds: readonly string[]): string[] {
  if (artifactIds.length === 0) return [];
  const derived = db
    .prepare(
      "SELECT a.artifact_id FROM tavi_artifacts a, json_each(?) source WHERE a.derived_from = source.value AND a.preview IS NOT NULL ORDER BY a.artifact_id",
    )
    .all(JSON.stringify(artifactIds)) as { readonly artifact_id: string }[];
  return [...new Set([...artifactIds, ...derived.map((row) => row.artifact_id)])];
}
