import type { AgentMailboxRepositoryPort } from "../internal-contracts.js";
import {
  AgentMailboxEnvelopeRecordSchema,
  type AgentDeliveryState,
  type AgentMailboxEnvelopeRecord,
  type AgentRetentionState,
} from "@tavi/contracts";
import type { StoreContext } from "./context.js";
import { parseStoredRow, storedLabelOf } from "./stored-values.js";

export class SqliteAgentMailboxRepository implements AgentMailboxRepositoryPort {
  readonly #store: StoreContext;

  constructor(store: StoreContext) {
    this.#store = store;
  }

  insertEnvelope(envelope: AgentMailboxEnvelopeRecord): void {
    this.#store.handle
      .prepare(
        `INSERT INTO tavi_agent_mailbox
           (message_id, protocol_version, workspace_id, sender_agent_id, sender_task_id,
            recipient_agent_id, recipient_task_id, kind, correlation_id, causation_id,
            created_at, expires_at, content, artifact_id, delivery_state, retention_state,
            lease_id, lease_expires_at, label_json)
         VALUES (@messageId, @protocolVersion, @workspaceId, @senderAgentId, @senderTaskId,
                 @recipientAgentId, @recipientTaskId, @kind, @correlationId, @causationId,
                 @createdAt, @expiresAt, @content, @artifactId, @deliveryState, @retentionState,
                 @leaseId, @leaseExpiresAt, @labelJson)`,
      )
      .run({
        messageId: envelope.messageId,
        protocolVersion: envelope.protocolVersion,
        workspaceId: envelope.workspaceId,
        senderAgentId: envelope.senderAgentId,
        senderTaskId: envelope.senderTaskId,
        recipientAgentId: envelope.recipientAgentId,
        recipientTaskId: envelope.recipientTaskId,
        kind: envelope.kind,
        correlationId: envelope.correlationId ?? null,
        causationId: envelope.causationId ?? null,
        createdAt: envelope.createdAt,
        expiresAt: envelope.expiresAt ?? null,
        content: envelope.content ?? null,
        artifactId: envelope.artifactId ?? null,
        deliveryState: envelope.deliveryState,
        retentionState: envelope.retentionState,
        leaseId: envelope.leaseId ?? null,
        leaseExpiresAt: envelope.leaseExpiresAt ?? null,
        // The sender's label at send time; none from before labels, read untrusted.
        labelJson: envelope.label === undefined ? null : JSON.stringify(envelope.label),
      });
  }

  getEnvelope(messageId: string): AgentMailboxEnvelopeRecord | undefined {
    const row = this.#store.handle.prepare("SELECT * FROM tavi_agent_mailbox WHERE message_id = ?").get(messageId) as
      | AgentMailboxRow
      | undefined;
    return row === undefined ? undefined : toAgentMailboxEnvelopeRecord(row);
  }

  listPending(taskId: string, limit: number): readonly AgentMailboxEnvelopeRecord[] {
    const rows = this.#store.handle
      .prepare(
        `SELECT * FROM tavi_agent_mailbox
          WHERE recipient_task_id = ? AND delivery_state = 'pending'
          ORDER BY created_at ASC, rowid ASC LIMIT ?`,
      )
      .all(taskId, limit) as AgentMailboxRow[];
    return rows.map(toAgentMailboxEnvelopeRecord);
  }

  listByCorrelation(correlationId: string): readonly AgentMailboxEnvelopeRecord[] {
    const rows = this.#store.handle
      .prepare("SELECT * FROM tavi_agent_mailbox WHERE correlation_id = ? ORDER BY created_at ASC")
      .all(correlationId) as AgentMailboxRow[];
    return rows.map(toAgentMailboxEnvelopeRecord);
  }

  claim(input: {
    readonly taskId: string;
    readonly limit: number;
    readonly leaseId: string;
    readonly leaseExpiresAt: string;
  }): readonly AgentMailboxEnvelopeRecord[] {
    // An immediate transaction: the write lock is taken before the pending
    // batch is read, so a concurrent claim cannot select the same rows this
    // one is about to lease (matches `SqliteSkillRepository.setActivation`'s
    // read-then-write-under-one-lock pattern).
    return this.#store.transactionImmediate(() => {
      const candidates = this.#store.handle
        .prepare(
          `SELECT message_id FROM tavi_agent_mailbox
            WHERE recipient_task_id = ? AND delivery_state = 'pending'
            ORDER BY created_at ASC LIMIT ?`,
        )
        .all(input.taskId, input.limit) as { readonly message_id: string }[];
      if (candidates.length === 0) return [];
      const messageIds = candidates.map((row) => row.message_id);
      const placeholders = messageIds.map(() => "?").join(", ");
      this.#store.handle
        .prepare(
          `UPDATE tavi_agent_mailbox
              SET delivery_state = 'delivered', lease_id = ?, lease_expires_at = ?
            WHERE message_id IN (${placeholders})`,
        )
        .run(input.leaseId, input.leaseExpiresAt, ...messageIds);
      const rows = this.#store.handle
        .prepare(`SELECT * FROM tavi_agent_mailbox WHERE message_id IN (${placeholders}) ORDER BY created_at ASC`)
        .all(...messageIds) as AgentMailboxRow[];
      return rows.map(toAgentMailboxEnvelopeRecord);
    });
  }

  acknowledge(input: { readonly taskId: string; readonly leaseId: string; readonly messageIds: readonly string[] }): void {
    if (input.messageIds.length === 0) return;
    const placeholders = input.messageIds.map(() => "?").join(", ");
    // Only rows still under this exact lease transition: a lease that has
    // already expired and been reclaimed by a later `claim` must not have
    // its new holder's delivery silently acknowledged by a stale caller.
    this.#store.handle
      .prepare(
        `UPDATE tavi_agent_mailbox
            SET delivery_state = 'acknowledged', lease_id = NULL, lease_expires_at = NULL
          WHERE recipient_task_id = ? AND lease_id = ? AND delivery_state = 'delivered'
            AND message_id IN (${placeholders})`,
      )
      .run(input.taskId, input.leaseId, ...input.messageIds);
  }

  setDeliveryState(messageId: string, state: AgentDeliveryState): void {
    this.#store.handle.prepare("UPDATE tavi_agent_mailbox SET delivery_state = ? WHERE message_id = ?").run(state, messageId);
  }

  setRetentionState(messageId: string, state: AgentRetentionState): void {
    this.#store.handle.prepare("UPDATE tavi_agent_mailbox SET retention_state = ? WHERE message_id = ?").run(state, messageId);
  }

  claimForTurn(input: {
    readonly taskId: string;
    readonly leaseId: string;
    readonly limit: number;
    readonly readLeases?: readonly string[];
  }): {
    readonly envelopes: readonly AgentMailboxEnvelopeRecord[];
    readonly more: number;
  } {
    // Under the write lock, as `claim`: a concurrent claim cannot take the same rows.
    return this.#store.transactionImmediate(() => {
      const countPending = (): number =>
        (
          this.#store.handle
            .prepare("SELECT COUNT(*) AS n FROM tavi_agent_mailbox WHERE recipient_task_id = ? AND delivery_state = 'pending'")
            .get(input.taskId) as { readonly n: number }
        ).n;
      const held = this.#store.handle
        .prepare(
          `SELECT * FROM tavi_agent_mailbox
            WHERE recipient_task_id = ? AND delivery_state = 'delivered' AND lease_id = ?
            ORDER BY created_at DESC, rowid DESC`,
        )
        .all(input.taskId, input.leaseId) as AgentMailboxRow[];
      // A re-run of this admission: exactly what it held, nothing newer.
      if (held.length > 0) return { envelopes: held.map(toAgentMailboxEnvelopeRecord), more: countPending() };
      // What a turn that died between its claim and its settle still holds.
      const read = new Set(input.readLeases ?? []);
      const stale = this.#store.handle
        .prepare(
          `SELECT message_id, lease_id FROM tavi_agent_mailbox
            WHERE recipient_task_id = ? AND delivery_state = 'delivered' AND lease_id LIKE 'mailbox-%' AND lease_id <> ?`,
        )
        .all(input.taskId, input.leaseId) as { readonly message_id: string; readonly lease_id: string }[];
      for (const row of stale) {
        this.#store.handle
          .prepare(`UPDATE tavi_agent_mailbox SET delivery_state = ?, lease_id = NULL, lease_expires_at = NULL WHERE message_id = ?`)
          .run(read.has(row.lease_id) ? "acknowledged" : "pending", row.message_id);
      }
      const fresh = this.#store.handle
        .prepare(
          `SELECT * FROM tavi_agent_mailbox
            WHERE recipient_task_id = ? AND delivery_state = 'pending'
            ORDER BY created_at DESC, rowid DESC LIMIT ?`,
        )
        .all(input.taskId, Math.max(0, input.limit)) as AgentMailboxRow[];
      const pending = countPending();
      if (fresh.length === 0) return { envelopes: [], more: pending };
      const messageIds = fresh.map((row) => row.message_id);
      this.#store.handle
        .prepare(
          `UPDATE tavi_agent_mailbox SET delivery_state = 'delivered', lease_id = ?, lease_expires_at = NULL WHERE message_id IN (${messageIds.map(() => "?").join(", ")})`,
        )
        .run(input.leaseId, ...messageIds);
      return {
        envelopes: fresh.map((row) =>
          toAgentMailboxEnvelopeRecord({ ...row, delivery_state: "delivered", lease_id: input.leaseId, lease_expires_at: null }),
        ),
        more: pending - fresh.length,
      };
    });
  }

  releaseClaim(input: { readonly taskId: string; readonly leaseId: string; readonly messageIds?: readonly string[] }): void {
    if (input.messageIds !== undefined && input.messageIds.length === 0) return;
    const only = input.messageIds === undefined ? "" : ` AND message_id IN (${input.messageIds.map(() => "?").join(", ")})`;
    this.#store.handle
      .prepare(
        `UPDATE tavi_agent_mailbox SET delivery_state = 'pending', lease_id = NULL, lease_expires_at = NULL
          WHERE recipient_task_id = ? AND lease_id = ? AND delivery_state = 'delivered'${only}`,
      )
      .run(input.taskId, input.leaseId, ...(input.messageIds ?? []));
  }

  acknowledgeBefore(taskId: string, before: string): number {
    return this.#store.handle
      .prepare(
        `UPDATE tavi_agent_mailbox SET delivery_state = 'acknowledged', lease_id = NULL, lease_expires_at = NULL
          WHERE recipient_task_id = ? AND delivery_state IN ('pending', 'delivered') AND created_at < ?`,
      )
      .run(taskId, before).changes;
  }

  listSent(input: {
    readonly senderTaskId: string;
    readonly recipientTaskId: string;
    readonly kind: AgentMailboxEnvelopeRecord["kind"];
    readonly since: string;
  }): readonly AgentMailboxEnvelopeRecord[] {
    const rows = this.#store.handle
      .prepare(
        `SELECT * FROM tavi_agent_mailbox
          WHERE sender_task_id = ? AND recipient_task_id = ? AND kind = ? AND created_at >= ?
          ORDER BY created_at ASC, rowid ASC`,
      )
      .all(input.senderTaskId, input.recipientTaskId, input.kind, input.since) as AgentMailboxRow[];
    return rows.map(toAgentMailboxEnvelopeRecord);
  }
}

interface AgentMailboxRow {
  readonly message_id: string;
  readonly protocol_version: number;
  readonly workspace_id: string;
  readonly sender_agent_id: string;
  readonly sender_task_id: string;
  readonly recipient_agent_id: string;
  readonly recipient_task_id: string;
  readonly kind: string;
  readonly correlation_id: string | null;
  readonly causation_id: string | null;
  readonly created_at: string;
  readonly expires_at: string | null;
  readonly content: string | null;
  readonly artifact_id: string | null;
  readonly delivery_state: string;
  readonly retention_state: string;
  readonly lease_id: string | null;
  readonly lease_expires_at: string | null;
  /** Null on an unlabelled row. */
  readonly label_json: string | null;
}

function toAgentMailboxEnvelopeRecord(row: AgentMailboxRow): AgentMailboxEnvelopeRecord {
  return parseStoredRow<AgentMailboxEnvelopeRecord>(
    AgentMailboxEnvelopeRecordSchema,
    {
      messageId: row.message_id,
      protocolVersion: row.protocol_version,
      workspaceId: row.workspace_id,
      senderAgentId: row.sender_agent_id,
      senderTaskId: row.sender_task_id,
      recipientAgentId: row.recipient_agent_id,
      recipientTaskId: row.recipient_task_id,
      kind: row.kind,
      createdAt: row.created_at,
      deliveryState: row.delivery_state,
      retentionState: row.retention_state,
      ...(row.correlation_id === null ? {} : { correlationId: row.correlation_id }),
      ...(row.causation_id === null ? {} : { causationId: row.causation_id }),
      ...(row.expires_at === null ? {} : { expiresAt: row.expires_at }),
      ...(row.content === null ? {} : { content: row.content }),
      ...(row.artifact_id === null ? {} : { artifactId: row.artifact_id }),
      ...(row.lease_id === null ? {} : { leaseId: row.lease_id }),
      ...(row.lease_expires_at === null ? {} : { leaseExpiresAt: row.lease_expires_at }),
      // A label that no longer parses reads as untrusted, source unknown: it only ever narrows.
      ...(row.label_json === null ? {} : { label: storedLabelOf(row.label_json) }),
    },
    "agent mailbox envelope",
  );
}
