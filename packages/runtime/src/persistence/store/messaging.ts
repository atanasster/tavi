import { assertPositiveLimit } from "../values.js";
import type {
  MessagingInboxRepositoryPort,
  MessagingOutboxRepositoryPort,
  MessagingIdentityBindingRepositoryPort,
  MessagingConversationRepositoryPort,
} from "../internal-contracts.js";
import {
  TaviError,
  type InboundEvent,
  type MessagingConversationTask,
  type MessagingIdentityBinding,
  type MessagingTrustUnverified,
  type OutboundMessage,
  type SendOutcome,
  type DeliveryEventStatus,
  type MessagingDelivery,
} from "@tavi/contracts";
import { zodIssues } from "@tavi/contracts/zod-util";
import { z } from "zod";
import { senderActorFromBinding } from "../../messaging/identity.js";
import {
  parseJsonColumn,
  StoredHeldPayloadSchema,
  StoredInboundEventSchema,
  StoredOutboundMessageSchema,
  StoredSendOutcomeSchema,
} from "../json-column.js";
import type { StoreContext } from "./context.js";

/** Held messages kept for one unbound sender on one connection: anyone can message a bot, and each one is a row. */
export const HELD_STRANGER_PER_SENDER = 20;

/** Held messages from unbound senders kept across every connection, however many senders there are. */
export const HELD_STRANGER_TOTAL = 5000;

const UNBOUND_SENDER = `NOT EXISTS (SELECT 1 FROM tavi_messaging_identity_bindings b
    WHERE b.connection_id = tavi_messaging_inbox.connection_id
      AND b.external_sender_id = json_extract(tavi_messaging_inbox.payload_json, '$.externalSenderId'))`;

/**
 * Which inbox rows a cap may take: still held (`received`), not claimed by a turn being admitted right now, and from
 * a sender with no binding. A bound sender's held row is still deduplicating — an unverified message, an admission
 * that failed and waits for a redelivery or a replay — and a claimed row is a turn in flight, so neither is ever taken.
 */
const HELD_STRANGER_ROW = `state = 'received' AND replay_claimed_at IS NULL AND ${UNBOUND_SENDER}`;

/**
 * Which held stranger rows the retention sweep (`pruneTransport`) expires: received before `@olderThan`, and
 * unclaimed or claimed before it too. A claim goes stale after ten minutes, so one older than the cutoff is a crashed
 * turn's, never one in flight, and nothing else would ever release a stranger's row from it.
 */
export const EXPIRED_HELD_STRANGER_ROW = `state = 'received' AND (replay_claimed_at IS NULL OR replay_claimed_at < @olderThan)
  AND ${UNBOUND_SENDER} AND received_at < @olderThan`;

// Both caps keep the row just recorded, which `ingest` goes on to read, ranked first even if a clock stepped back,
// then the newest by arrival and insertion.
export const PRUNE_HELD_STRANGER_SENDER = `DELETE FROM tavi_messaging_inbox WHERE rowid IN (
  SELECT rowid FROM tavi_messaging_inbox
   WHERE connection_id = @connectionId AND ${HELD_STRANGER_ROW}
     AND json_extract(payload_json, '$.externalSenderId') = @externalSenderId
   ORDER BY (connection_id = @connectionId AND provider_event_id = @providerEventId) DESC, received_at DESC, rowid DESC
   LIMIT -1 OFFSET @limit
)`;

// Walked one connection at a time through `tavi_messaging_inbox_state_idx`, so the cost is the held rows, never the
// processed ones the table keeps for a month. Every inbox row's connection is in `tavi_messaging_connections`
// (connections are soft-deleted, never removed); a row that somehow is not still expires in the retention sweep.
export const PRUNE_HELD_STRANGERS = `DELETE FROM tavi_messaging_inbox WHERE rowid IN (
  SELECT rowid FROM tavi_messaging_inbox
   WHERE connection_id IN (SELECT connection_id FROM tavi_messaging_connections) AND ${HELD_STRANGER_ROW}
   ORDER BY (connection_id = @connectionId AND provider_event_id = @providerEventId) DESC, received_at DESC, rowid DESC
   LIMIT -1 OFFSET @limit
)`;

export class SqliteMessagingInboxRepository implements MessagingInboxRepositoryPort {
  readonly #store: StoreContext;

  constructor(store: StoreContext) {
    this.#store = store;
  }

  record(input: {
    readonly connectionId: string;
    readonly providerEventId: string;
    readonly kind: string;
    readonly payload: InboundEvent;
    readonly now: () => string;
  }): { readonly created: boolean } {
    return this.#store.transaction(() => {
      const result = this.#store.handle
        .prepare(
          `INSERT INTO tavi_messaging_inbox (connection_id, provider_event_id, kind, payload_json, state, received_at)
           VALUES (@connectionId, @providerEventId, @kind, @payloadJson, 'received', @receivedAt)
           ON CONFLICT (connection_id, provider_event_id) DO NOTHING`,
        )
        .run({
          connectionId: input.connectionId,
          providerEventId: input.providerEventId,
          kind: input.kind,
          payloadJson: JSON.stringify(input.payload),
          receivedAt: input.now(),
        });
      const created = result.changes > 0;
      // Only a new row from a sender nobody allowed can push the held strangers past a cap; a bound sender's row is
      // never a stranger's, so its insert has nothing to trim.
      if (created && !this.#bound(input.connectionId, input.payload.externalSenderId)) {
        const keep = { connectionId: input.connectionId, providerEventId: input.providerEventId };
        this.#store.handle
          .prepare(PRUNE_HELD_STRANGER_SENDER)
          .run({ ...keep, externalSenderId: input.payload.externalSenderId, limit: HELD_STRANGER_PER_SENDER });
        this.#store.handle.prepare(PRUNE_HELD_STRANGERS).run({ ...keep, limit: HELD_STRANGER_TOTAL });
      }
      return { created };
    });
  }

  #bound(connectionId: string, externalSenderId: string): boolean {
    return (
      this.#store.handle
        .prepare("SELECT 1 FROM tavi_messaging_identity_bindings WHERE connection_id = ? AND external_sender_id = ?")
        .get(connectionId, externalSenderId) !== undefined
    );
  }

  listHeld(input: { readonly limit: number; readonly connectionIds?: readonly string[] }): {
    readonly held: readonly {
      readonly connectionId: string;
      readonly providerEventId: string;
      readonly receivedAt: string;
      readonly externalSenderId: string;
      readonly content: string;
      readonly resolvedPrincipalId: string | null;
    }[];
    readonly total: number;
  } {
    // A negative or fractional limit is a caller bug, and the failure mode is
    // silent: SQLite treats a negative LIMIT as *unbounded* and a float as a
    // datatype error, so the guard is what makes it a typed refusal.
    assertPositiveLimit(input.limit, "listHeld");
    const scoped = input.connectionIds === undefined ? null : JSON.stringify(input.connectionIds);
    const total = (
      this.#store.handle
        .prepare(
          "SELECT COUNT(*) AS n FROM tavi_messaging_inbox WHERE state = 'received' AND (? IS NULL OR connection_id IN (SELECT value FROM json_each(?)))",
        )
        .get(scoped, scoped) as {
        n: number;
      }
    ).n;
    const rows = this.#store.handle
      .prepare(
        // Oldest first: the message held longest is the one an operator most
        // wants to see, and the one a replay should clear first.
        "SELECT connection_id, provider_event_id, payload_json, received_at FROM tavi_messaging_inbox WHERE state = 'received' AND (? IS NULL OR connection_id IN (SELECT value FROM json_each(?))) ORDER BY received_at, provider_event_id LIMIT ?",
      )
      .all(scoped, scoped, input.limit) as {
      readonly connection_id: string;
      readonly provider_event_id: string;
      readonly payload_json: string;
      readonly received_at: string;
    }[];
    return {
      total,
      held: rows.map((row) => {
        // A row whose payload cannot be parsed is still *held*; naming it with an
        // empty sender and content is better than hiding it from the listing that
        // exists to surface exactly this.
        let payload: { readonly externalSenderId: string; readonly content?: string | undefined } | undefined;
        try {
          payload = parseJsonColumn(StoredHeldPayloadSchema, row.payload_json, "tavi_messaging_inbox.payload_json");
        } catch {
          payload = undefined;
        }
        const externalSenderId = payload?.externalSenderId ?? "";
        // Resolved at read time so the listing can say which rows are now
        // admissible, which is the whole question an operator has.
        const actor = senderActorFromBinding(
          new SqliteMessagingIdentityBindingRepository(this.#store).get(row.connection_id, externalSenderId),
          row.connection_id,
        );
        return {
          connectionId: row.connection_id,
          providerEventId: row.provider_event_id,
          receivedAt: row.received_at,
          externalSenderId,
          content: (payload?.content ?? "").slice(0, 200),
          resolvedPrincipalId: actor?.principalId ?? null,
        };
      }),
    };
  }

  markProcessed(connectionId: string, providerEventId: string): void {
    this.#store.handle
      .prepare(
        `UPDATE tavi_messaging_inbox SET state = 'processed', replay_claimed_at = NULL
          WHERE connection_id = ? AND provider_event_id = ? AND state = 'received'`,
      )
      .run(connectionId, providerEventId);
  }

  claimForReplay(input: {
    readonly connectionId: string;
    readonly providerEventId: string;
    readonly now: string;
    readonly staleBefore: string;
  }): boolean {
    // Compare-and-set: only a `received` row with no *fresh* claim can be taken,
    // so two replays cannot both admit the same message, and a claim older than
    // the staleness window is retryable — a crashed replay must not strand the
    // row the way a third `state` value would.
    const result = this.#store.handle
      .prepare(
        `UPDATE tavi_messaging_inbox SET replay_claimed_at = @now
          WHERE connection_id = @connectionId AND provider_event_id = @providerEventId
            AND state = 'received'
            AND (replay_claimed_at IS NULL OR replay_claimed_at < @staleBefore)`,
      )
      .run({ ...input });
    return result.changes === 1;
  }

  releaseReplayClaim(connectionId: string, providerEventId: string): void {
    this.#store.handle
      .prepare(
        `UPDATE tavi_messaging_inbox SET replay_claimed_at = NULL
          WHERE connection_id = ? AND provider_event_id = ? AND state = 'received'`,
      )
      .run(connectionId, providerEventId);
  }

  get(
    connectionId: string,
    providerEventId: string,
  ): { readonly state: "received" | "processed"; readonly payload: InboundEvent } | undefined {
    const row = this.#store.handle
      .prepare(`SELECT * FROM tavi_messaging_inbox WHERE connection_id = ? AND provider_event_id = ?`)
      .get(connectionId, providerEventId) as MessagingInboxRow | undefined;
    if (row === undefined) return undefined;
    return { state: row.state, payload: parseJsonColumn(StoredInboundEventSchema, row.payload_json, "tavi_messaging_inbox.payload_json") };
  }
}

interface MessagingInboxRow {
  readonly connection_id: string;
  readonly provider_event_id: string;
  readonly kind: string;
  readonly payload_json: string;
  readonly state: "received" | "processed";
  readonly received_at: string;
}

export class SqliteMessagingOutboxRepository implements MessagingOutboxRepositoryPort {
  readonly #store: StoreContext;

  constructor(store: StoreContext) {
    this.#store = store;
  }

  begin(input: {
    readonly effectId: string;
    readonly connectionId: string;
    readonly message: OutboundMessage;
    readonly now: () => string;
  }): { readonly created: boolean } {
    const result = this.#store.handle
      .prepare(
        `INSERT INTO tavi_messaging_outbox (effect_id, connection_id, message_json, state, created_at)
         VALUES (@effectId, @connectionId, @messageJson, 'pending', @createdAt)
         ON CONFLICT (effect_id) DO NOTHING`,
      )
      .run({
        effectId: input.effectId,
        connectionId: input.connectionId,
        messageJson: JSON.stringify(input.message),
        createdAt: input.now(),
      });
    return { created: result.changes > 0 };
  }

  resolve(input: { readonly effectId: string; readonly outcome: SendOutcome; readonly now: () => string }): void {
    // Checked by the schema every read uses, so a connector's malformed
    // outcome fails the send that produced it, not every later read of the row.
    const checked = StoredSendOutcomeSchema.safeParse(input.outcome);
    if (!checked.success) {
      const owner = this.#store.handle.prepare("SELECT connection_id FROM tavi_messaging_outbox WHERE effect_id = ?").get(input.effectId) as
        | { readonly connection_id: string }
        | undefined;
      const issues = zodIssues(checked.error, "<root>");
      throw new TaviError(
        "INTERNAL",
        `Connection ${owner?.connection_id ?? "(unknown)"} returned a malformed send outcome: ${issues.join("; ")}`,
        { details: { effectId: input.effectId, ...(owner === undefined ? {} : { connectionId: owner.connection_id }), issues } },
      );
    }
    this.#store.transaction(() => {
      const resolved = this.#store.handle
        .prepare(
          `UPDATE tavi_messaging_outbox SET state = 'resolved', outcome_json = @outcomeJson, resolved_at = @resolvedAt
            WHERE effect_id = @effectId AND state = 'pending'`,
        )
        .run({ effectId: input.effectId, outcomeJson: JSON.stringify(input.outcome), resolvedAt: input.now() });
      if (resolved.changes === 0) return;
      // Each part accepted under a provider message id, so a later delivery status finds its send.
      const row = this.#store.handle.prepare("SELECT connection_id FROM tavi_messaging_outbox WHERE effect_id = ?").get(input.effectId) as {
        readonly connection_id: string;
      };
      const sent = this.#store.handle.prepare(
        "INSERT INTO tavi_messaging_deliveries (connection_id, provider_message_id, effect_id) VALUES (?, ?, ?) ON CONFLICT (connection_id, provider_message_id) DO NOTHING",
      );
      for (const part of input.outcome.parts) {
        if (part.status === "accepted" && part.providerMessageId !== undefined)
          sent.run(row.connection_id, part.providerMessageId, input.effectId);
      }
    });
  }

  recordDelivery(input: {
    readonly connectionId: string;
    readonly providerMessageId: string;
    readonly status: DeliveryEventStatus;
    readonly at: string;
    readonly detail?: string;
  }): { readonly effectId: string } | undefined {
    const row = this.#store.handle
      .prepare("SELECT effect_id, status FROM tavi_messaging_deliveries WHERE connection_id = ? AND provider_message_id = ?")
      .get(input.connectionId, input.providerMessageId) as
      | { readonly effect_id: string; readonly status: DeliveryEventStatus | null }
      | undefined;
    if (row === undefined) return undefined;
    // Only forward: delivered, then read; a bounce or failure ends it.
    if (row.status === null || DELIVERY_RANK[input.status] > DELIVERY_RANK[row.status]) {
      this.#store.handle
        .prepare(
          "UPDATE tavi_messaging_deliveries SET status = ?, status_at = ?, detail = ? WHERE connection_id = ? AND provider_message_id = ?",
        )
        .run(input.status, input.at, input.detail?.slice(0, 500) ?? null, input.connectionId, input.providerMessageId);
    }
    return { effectId: row.effect_id };
  }

  get(
    effectId: string,
  ): { readonly state: "pending" | "resolved"; readonly outcome?: SendOutcome; readonly delivery?: MessagingDelivery } | undefined {
    const row = this.#store.handle.prepare(`SELECT * FROM tavi_messaging_outbox WHERE effect_id = ?`).get(effectId) as
      | MessagingOutboxRow
      | undefined;
    if (row === undefined) return undefined;
    // The newest status any of its parts reached.
    const delivery = this.#store.handle
      .prepare(
        "SELECT status, status_at, detail FROM tavi_messaging_deliveries WHERE effect_id = ? AND status IS NOT NULL ORDER BY status_at DESC LIMIT 1",
      )
      .get(effectId) as { readonly status: DeliveryEventStatus; readonly status_at: string; readonly detail: string | null } | undefined;
    return {
      state: row.state,
      ...(row.outcome_json === null
        ? {}
        : { outcome: parseJsonColumn(StoredSendOutcomeSchema, row.outcome_json, "tavi_messaging_outbox.outcome_json") }),
      ...(delivery === undefined
        ? {}
        : {
            delivery: { status: delivery.status, at: delivery.status_at, ...(delivery.detail === null ? {} : { detail: delivery.detail }) },
          }),
    };
  }

  listPending(
    limit: number,
    connectionId?: string,
  ): readonly { readonly effectId: string; readonly connectionId: string; readonly message: OutboundMessage }[] {
    const rows = (
      connectionId === undefined
        ? this.#store.handle.prepare(`SELECT * FROM tavi_messaging_outbox WHERE state = 'pending' ORDER BY created_at LIMIT ?`).all(limit)
        : this.#store.handle
            .prepare(`SELECT * FROM tavi_messaging_outbox WHERE state = 'pending' AND connection_id = ? ORDER BY created_at LIMIT ?`)
            .all(connectionId, limit)
    ) as MessagingOutboxRow[];
    return rows.map((row) => ({
      effectId: row.effect_id,
      connectionId: row.connection_id,
      message: parseJsonColumn(StoredOutboundMessageSchema, row.message_json, "tavi_messaging_outbox.message_json"),
    }));
  }
}

const DELIVERY_RANK: Readonly<Record<DeliveryEventStatus, number>> = { delivered: 1, read: 2, bounced: 3, failed: 3 };

interface MessagingOutboxRow {
  readonly effect_id: string;
  readonly connection_id: string;
  readonly message_json: string;
  readonly state: "pending" | "resolved";
  readonly outcome_json: string | null;
  readonly created_at: string;
  readonly resolved_at: string | null;
}

export class SqliteMessagingIdentityBindingRepository implements MessagingIdentityBindingRepositoryPort {
  readonly #store: StoreContext;

  constructor(store: StoreContext) {
    this.#store = store;
  }

  bind(binding: MessagingIdentityBinding): void {
    // Transactional check-then-write: `bind`'s contract needs to distinguish "already bound to this same principal"
    // (idempotent no-op) from "already bound to a DIFFERENT principal"
    // (CONFLICT) — a plain `INSERT ... ON CONFLICT` can express "replace"
    // or "do nothing" but not "do nothing if X, else refuse," so the two
    // cases are told apart explicitly before writing. This is a genuine
    // read-compare-write (the same shape `transactionImmediate`'s own doc
    // comment exists for), not a plain read-only transaction — a deferred
    // `transaction()` here would let two concurrent `bind()` calls both
    // read "no existing row" before either writes, surfacing a raw
    // SQLITE_BUSY/constraint failure instead of a typed CONFLICT.
    this.#store.transactionImmediate(() => {
      const existing = this.get(binding.connectionId, binding.externalSenderId);
      if (existing !== undefined) {
        if (existing.principalId !== binding.principalId) {
          throw new TaviError(
            "CONFLICT",
            `${binding.connectionId}/${binding.externalSenderId} is already bound to a different principal; unbind it first`,
          );
        }
        // Identical re-bind: idempotent, matches this file's other ON CONFLICT
        // DO NOTHING precedents — but a name given now replaces the one before.
        if (binding.displayName !== undefined && binding.displayName !== existing.displayName) this.#nameEverywhere(binding);
        return;
      }
      this.#store.handle
        .prepare(
          `INSERT INTO tavi_messaging_identity_bindings
             (connection_id, external_sender_id, workspace_id, principal_id, approved_by, created_at, display_name)
           VALUES (@connectionId, @externalSenderId, @workspaceId, @principalId, @approvedBy, @createdAt, @displayName)`,
        )
        .run({
          connectionId: binding.connectionId,
          externalSenderId: binding.externalSenderId,
          workspaceId: binding.workspaceId,
          principalId: binding.principalId,
          approvedBy: binding.approvedBy,
          createdAt: binding.createdAt,
          displayName: binding.displayName ?? null,
        });
      if (binding.displayName !== undefined) this.#nameEverywhere(binding);
    });
  }

  /** A person has one name: it is written to every binding of theirs in the workspace. */
  #nameEverywhere(binding: MessagingIdentityBinding): void {
    this.#store.handle
      .prepare(`UPDATE tavi_messaging_identity_bindings SET display_name = ? WHERE workspace_id = ? AND principal_id = ?`)
      .run(binding.displayName ?? null, binding.workspaceId, binding.principalId);
  }

  setTrustUnverified(connectionId: string, externalSenderId: string, trust: MessagingTrustUnverified | null): boolean {
    const result = this.#store.handle
      .prepare(
        `UPDATE tavi_messaging_identity_bindings SET trust_unverified_by = ?, trust_unverified_at = ? WHERE connection_id = ? AND external_sender_id = ?`,
      )
      .run(trust?.setBy ?? null, trust?.setAt ?? null, connectionId, externalSenderId);
    return result.changes > 0;
  }

  unbind(connectionId: string, externalSenderId: string): void {
    this.#store.handle
      .prepare(`DELETE FROM tavi_messaging_identity_bindings WHERE connection_id = ? AND external_sender_id = ?`)
      .run(connectionId, externalSenderId);
  }

  get(connectionId: string, externalSenderId: string): MessagingIdentityBinding | undefined {
    const row = this.#store.handle
      .prepare(`SELECT * FROM tavi_messaging_identity_bindings WHERE connection_id = ? AND external_sender_id = ?`)
      .get(connectionId, externalSenderId) as MessagingIdentityBindingRow | undefined;
    return row === undefined ? undefined : toMessagingIdentityBinding(row);
  }

  list(workspaceId: string): readonly MessagingIdentityBinding[] {
    const rows = this.#store.handle
      .prepare(`SELECT * FROM tavi_messaging_identity_bindings WHERE workspace_id = ?`)
      .all(workspaceId) as MessagingIdentityBindingRow[];
    return rows.map(toMessagingIdentityBinding);
  }

  senderOf(connectionId: string, principalId: string): string | undefined {
    const row = this.#store.handle
      .prepare(
        `SELECT external_sender_id FROM tavi_messaging_identity_bindings WHERE connection_id = ? AND principal_id = ? ORDER BY created_at, external_sender_id LIMIT 1`,
      )
      .get(connectionId, principalId) as { readonly external_sender_id: string } | undefined;
    return row?.external_sender_id;
  }
}

function toMessagingIdentityBinding(row: MessagingIdentityBindingRow): MessagingIdentityBinding {
  return {
    connectionId: row.connection_id,
    externalSenderId: row.external_sender_id,
    workspaceId: row.workspace_id,
    principalId: row.principal_id,
    approvedBy: row.approved_by,
    createdAt: row.created_at,
    ...(typeof row.display_name === "string" && row.display_name !== "" ? { displayName: row.display_name } : {}),
    ...(typeof row.trust_unverified_by === "string" && typeof row.trust_unverified_at === "string"
      ? { trustUnverified: { setBy: row.trust_unverified_by, setAt: row.trust_unverified_at } }
      : {}),
  };
}

interface MessagingIdentityBindingRow {
  readonly connection_id: string;
  readonly external_sender_id: string;
  readonly workspace_id: string;
  readonly principal_id: string;
  readonly approved_by: string;
  readonly created_at: string;
  readonly display_name: string | null;
  readonly trust_unverified_by: string | null;
  readonly trust_unverified_at: string | null;
}

export class SqliteMessagingConversationRepository implements MessagingConversationRepositoryPort {
  readonly #store: StoreContext;

  constructor(store: StoreContext) {
    this.#store = store;
  }

  record(mapping: MessagingConversationTask): void {
    // Same read-compare-write shape as `SqliteMessagingIdentityBindingRepository.bind`
    // — `transactionImmediate`, not `transaction`, since this is a
    // genuine compare-and-set: two concurrent `record` calls for the same
    // (connectionId, externalConversationId) under a deferred transaction
    // could both observe "no existing row" before either writes.
    this.#store.transactionImmediate(() => {
      // A task already recorded for an ended epoch is not recorded again (a retried admission's record).
      const ended = this.getByTask(mapping.taskId);
      if (
        ended !== undefined &&
        ended.connectionId === mapping.connectionId &&
        ended.externalConversationId === mapping.externalConversationId
      )
        return;
      const existing = this.get(mapping.connectionId, mapping.externalConversationId);
      if (existing !== undefined) {
        if (existing.taskId !== mapping.taskId) {
          throw new TaviError(
            "CONFLICT",
            `${mapping.connectionId}/${mapping.externalConversationId} is already mapped to a different task`,
          );
        }
        return; // Identical re-record (e.g. a retried admission): idempotent.
      }
      // An earlier epoch's provider and kind carry over when a record leaves them out.
      const earlier =
        mapping.providerId === undefined || mapping.conversationKind === undefined
          ? this.newest(mapping.connectionId, mapping.externalConversationId)
          : undefined;
      this.#store.handle
        .prepare(
          `INSERT INTO tavi_messaging_conversation_tasks
             (connection_id, external_conversation_id, epoch, active, task_id, created_at, reply_to_json, provider_id, conversation_kind)
           VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)`,
        )
        .run(
          mapping.connectionId,
          mapping.externalConversationId,
          this.nextEpoch(mapping.connectionId, mapping.externalConversationId),
          mapping.taskId,
          mapping.createdAt,
          mapping.replyTo === undefined ? null : JSON.stringify(mapping.replyTo),
          mapping.providerId ?? earlier?.providerId ?? null,
          mapping.conversationKind ?? earlier?.conversationKind ?? null,
        );
    });
  }

  get(connectionId: string, externalConversationId: string): MessagingConversationTask | undefined {
    const row = this.#store.handle
      .prepare(`SELECT * FROM tavi_messaging_conversation_tasks WHERE connection_id = ? AND external_conversation_id = ? AND active = 1`)
      .get(connectionId, externalConversationId) as MessagingConversationTaskRow | undefined;
    return row === undefined ? undefined : toConversationTask(row);
  }

  nextEpoch(connectionId: string, externalConversationId: string): number {
    const row = this.#store.handle
      .prepare(
        `SELECT max(epoch) AS newest, max(active) AS open FROM tavi_messaging_conversation_tasks WHERE connection_id = ? AND external_conversation_id = ?`,
      )
      .get(connectionId, externalConversationId) as { readonly newest: number | null; readonly open: number | null };
    if (row.newest === null) return 0;
    return row.open === 1 ? row.newest : row.newest + 1;
  }

  newest(connectionId: string, externalConversationId: string): MessagingConversationTask | undefined {
    const row = this.#store.handle
      .prepare(
        `SELECT * FROM tavi_messaging_conversation_tasks WHERE connection_id = ? AND external_conversation_id = ? ORDER BY epoch DESC LIMIT 1`,
      )
      .get(connectionId, externalConversationId) as MessagingConversationTaskRow | undefined;
    return row === undefined ? undefined : toConversationTask(row);
  }

  reopen(connectionId: string, externalConversationId: string, taskId: string, at: string): MessagingConversationTask | undefined {
    return this.#store.transactionImmediate(() => {
      const active = this.get(connectionId, externalConversationId);
      if (active !== undefined) return active.taskId === taskId ? active : undefined;
      const newest = this.newest(connectionId, externalConversationId);
      if (newest === undefined || newest.taskId !== taskId) return undefined;
      const epoch = (newest.epoch ?? 0) + 1;
      this.#store.handle
        .prepare(
          `INSERT INTO tavi_messaging_conversation_tasks
             (connection_id, external_conversation_id, epoch, active, task_id, created_at, reply_to_json, provider_id, conversation_kind)
           VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)`,
        )
        .run(
          connectionId,
          externalConversationId,
          epoch,
          taskId,
          at,
          newest.replyTo === undefined ? null : JSON.stringify(newest.replyTo),
          newest.providerId ?? null,
          newest.conversationKind ?? null,
        );
      return this.get(connectionId, externalConversationId);
    });
  }

  reset(connectionId: string, externalConversationId: string, at: string): MessagingConversationTask | undefined {
    return this.#store.transactionImmediate(() => {
      const active = this.get(connectionId, externalConversationId);
      if (active === undefined) return undefined;
      this.#store.handle
        .prepare(
          `UPDATE tavi_messaging_conversation_tasks SET active = 0, reset_at = ? WHERE connection_id = ? AND external_conversation_id = ? AND active = 1`,
        )
        .run(at, connectionId, externalConversationId);
      return active;
    });
  }

  markWithdrawn(connectionId: string, externalConversationId: string, epoch: number, at: string): boolean {
    return (
      this.#store.handle
        .prepare(
          `UPDATE tavi_messaging_conversation_tasks SET withdrawn_at = ?
           WHERE connection_id = ? AND external_conversation_id = ? AND epoch = ? AND active = 0 AND reset_at IS NOT NULL AND withdrawn_at IS NULL`,
        )
        .run(at, connectionId, externalConversationId, epoch).changes > 0
    );
  }

  listUnwithdrawn(): readonly MessagingConversationTask[] {
    const rows = this.#store.handle
      .prepare(
        `SELECT * FROM tavi_messaging_conversation_tasks e
         WHERE e.active = 0 AND e.reset_at IS NOT NULL AND e.withdrawn_at IS NULL
           AND NOT EXISTS (SELECT 1 FROM tavi_messaging_conversation_tasks a WHERE a.task_id = e.task_id AND a.active = 1)
         ORDER BY e.reset_at, e.connection_id, e.external_conversation_id, e.epoch LIMIT 200`,
      )
      .all() as MessagingConversationTaskRow[];
    return rows.map(toConversationTask);
  }

  directTasksOf(workspaceId: string, principalId: string): readonly MessagingConversationTask[] {
    // A direct conversation's active task that is the person's, whose sender is bound to them.
    const rows = this.#store.handle
      .prepare(
        `SELECT c.* FROM tavi_messaging_conversation_tasks c
         JOIN tavi_tasks t ON t.task_id = c.task_id
         JOIN tavi_messaging_identity_bindings b ON b.connection_id = c.connection_id
           AND b.external_sender_id = json_extract(c.reply_to_json, '$.externalSenderId')
         WHERE c.active = 1 AND c.conversation_kind = 'direct' AND json_valid(c.reply_to_json)
           AND t.workspace_id = @workspaceId AND t.principal_id = @principalId
           AND b.workspace_id = @workspaceId AND b.principal_id = @principalId
         ORDER BY c.created_at DESC, c.connection_id, c.external_conversation_id`,
      )
      .all({ workspaceId, principalId }) as MessagingConversationTaskRow[];
    return rows.map(toConversationTask);
  }

  connectionProviders(): readonly { readonly connectionId: string; readonly providerId: string }[] {
    const rows = this.#store.handle
      .prepare(
        `SELECT connection_id, min(provider_id) AS provider_id FROM tavi_messaging_conversation_tasks WHERE provider_id IS NOT NULL GROUP BY connection_id ORDER BY connection_id`,
      )
      .all() as { readonly connection_id: string; readonly provider_id: string }[];
    return rows.map((row) => ({ connectionId: row.connection_id, providerId: row.provider_id }));
  }

  getByTask(taskId: string): MessagingConversationTask | undefined {
    const row = this.#store.handle
      .prepare(`SELECT * FROM tavi_messaging_conversation_tasks WHERE task_id = ? ORDER BY created_at LIMIT 1`)
      .get(taskId) as MessagingConversationTaskRow | undefined;
    return row === undefined ? undefined : toConversationTask(row);
  }
}

interface MessagingConversationTaskRow {
  readonly connection_id: string;
  readonly external_conversation_id: string;
  readonly epoch: number;
  readonly task_id: string;
  readonly created_at: string;
  readonly reply_to_json: string | null;
  readonly provider_id: string | null;
  readonly conversation_kind: string | null;
}

/** The fields a reply target is announced by; its optional ones are kept as stored. */
const StoredReplyToSchema = z.looseObject({
  connectionId: z.string(),
  externalConversationId: z.string(),
  externalSenderId: z.string(),
}) as unknown as z.ZodType<NonNullable<MessagingConversationTask["replyTo"]>>;

function toConversationTask(row: MessagingConversationTaskRow): MessagingConversationTask {
  let replyTo: MessagingConversationTask["replyTo"];
  try {
    replyTo =
      row.reply_to_json === null
        ? undefined
        : parseJsonColumn(StoredReplyToSchema, row.reply_to_json, "tavi_messaging_conversation_tasks.reply_to_json");
  } catch {
    // An unreadable reply target leaves the mapping usable without one (and the error, which quotes nothing, is dropped).
    replyTo = undefined;
  }
  return {
    connectionId: row.connection_id,
    externalConversationId: row.external_conversation_id,
    taskId: row.task_id,
    createdAt: row.created_at,
    epoch: row.epoch,
    ...(replyTo === undefined ? {} : { replyTo }),
    ...(typeof row.provider_id === "string" ? { providerId: row.provider_id } : {}),
    ...(row.conversation_kind === "direct" || row.conversation_kind === "group" || row.conversation_kind === "thread"
      ? { conversationKind: row.conversation_kind }
      : {}),
  };
}
