import type { ApprovalRoundRepositoryPort, ApprovalLinkRepositoryPort } from "./internal-contracts.js";
import {
  ApprovalEventRecordSchema,
  MAX_APPROVAL_PIN_ATTEMPTS,
  type ApprovalPinConsumption,
  ApprovalLinkRecordSchema,
  ApprovalRoundRecordSchema,
  TaviError,
  decodeRoundRisk,
  encodeRoundRisk,
  type ApprovalLinkRecord,
  type ApprovalEventRecord,
  type ApprovalRoundRecord,
} from "@tavi/contracts";

import type { Database } from "./sqlite-loader.js";

interface RoundRow {
  readonly task_id: string;
  readonly steps: number;
  readonly token: string;
  readonly workspace_id: string;
  readonly connection_id: string | null;
  readonly conversation_id: string | null;
  readonly message_ids_json: string;
  readonly expires_at: string | null;
  readonly settled_at: string | null;
  readonly created_at: string;
  /** The round's risk, which decides what a reply may do. */
  readonly risk: string | null;
  /** The scopes the gate offered each call of the round. */
  readonly call_scopes_json: string | null;
}

interface EventRow {
  readonly event_id: number;
  readonly task_id: string;
  readonly steps: number;
  readonly kind: string;
  readonly via: string | null;
  readonly actor: string | null;
  readonly detail_json: string | null;
  readonly at: string;
}

function toRound(row: RoundRow): ApprovalRoundRecord {
  return ApprovalRoundRecordSchema.parse({
    taskId: row.task_id,
    steps: row.steps,
    token: row.token,
    workspaceId: row.workspace_id,
    ...(row.connection_id === null ? {} : { connectionId: row.connection_id }),
    ...(row.conversation_id === null ? {} : { conversationId: row.conversation_id }),
    messageIds: JSON.parse(row.message_ids_json) as unknown,
    ...(row.expires_at === null ? {} : { expiresAt: row.expires_at }),
    ...(row.settled_at === null ? {} : { settledAt: row.settled_at }),
    // The level, and the context label's summary with it (`encodeRoundRisk`).
    ...(() => {
      const { level, label } = decodeRoundRisk(row.risk);
      return { ...(level === undefined ? {} : { risk: level }), ...(label === undefined ? {} : { riskLabel: label }) };
    })(),
    ...(row.call_scopes_json === null ? {} : { callScopes: JSON.parse(row.call_scopes_json) as unknown }),
    createdAt: row.created_at,
  });
}

function toEvent(row: EventRow): ApprovalEventRecord {
  return ApprovalEventRecordSchema.parse({
    eventId: row.event_id,
    taskId: row.task_id,
    steps: row.steps,
    kind: row.kind,
    ...(row.via === null ? {} : { via: row.via }),
    ...(row.actor === null ? {} : { actor: row.actor }),
    ...(row.detail_json === null ? {} : { detail: JSON.parse(row.detail_json) as unknown }),
    at: row.at,
  });
}

/** Approval rounds as the channels see them, and their audit trail. */
export class SqliteApprovalRoundRepository implements ApprovalRoundRepositoryPort {
  readonly #db: () => Database;

  constructor(db: () => Database) {
    this.#db = db;
  }

  create(round: Omit<ApprovalRoundRecord, "messageIds" | "settledAt"> & { readonly messageIds?: readonly string[] }): {
    readonly round: ApprovalRoundRecord;
    readonly created: boolean;
  } {
    const parsed = ApprovalRoundRecordSchema.safeParse({ ...round, messageIds: [...(round.messageIds ?? [])] });
    if (!parsed.success) {
      throw new TaviError("INVALID_INPUT", "Invalid approval round", {
        details: { issues: parsed.error.issues.map((issue) => issue.message) },
      });
    }
    const value = parsed.data;
    const inserted = this.#db()
      .prepare(
        `INSERT INTO tavi_approval_rounds
           (task_id, steps, token, workspace_id, connection_id, conversation_id, message_ids_json, expires_at, settled_at, created_at, risk, call_scopes_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)
         ON CONFLICT (task_id, steps) DO NOTHING`,
      )
      .run(
        value.taskId,
        value.steps,
        value.token,
        value.workspaceId,
        value.connectionId ?? null,
        value.conversationId ?? null,
        JSON.stringify(value.messageIds),
        value.expiresAt ?? null,
        value.createdAt,
        value.risk === undefined ? null : encodeRoundRisk(value.risk, value.riskLabel),
        value.callScopes === undefined ? null : JSON.stringify(value.callScopes),
      );
    const stored = this.get(value.taskId, value.steps);
    if (stored === undefined) throw new TaviError("INTERNAL", `approval round ${value.taskId}/${value.steps} was not stored`);
    return { round: stored, created: inserted.changes > 0 };
  }

  get(taskId: string, steps: number): ApprovalRoundRecord | undefined {
    const row = this.#db().prepare("SELECT * FROM tavi_approval_rounds WHERE task_id = ? AND steps = ?").get(taskId, steps) as
      | RoundRow
      | undefined;
    return row === undefined ? undefined : toRound(row);
  }

  getByToken(token: string): ApprovalRoundRecord | undefined {
    const row = this.#db().prepare("SELECT * FROM tavi_approval_rounds WHERE token = ?").get(token) as RoundRow | undefined;
    return row === undefined ? undefined : toRound(row);
  }

  listForTask(taskId: string): readonly ApprovalRoundRecord[] {
    const rows = this.#db().prepare("SELECT * FROM tavi_approval_rounds WHERE task_id = ? ORDER BY steps").all(taskId) as RoundRow[];
    return rows.map(toRound);
  }

  addMessageIds(taskId: string, steps: number, messageIds: readonly string[]): void {
    const round = this.get(taskId, steps);
    if (round === undefined || messageIds.length === 0) return;
    const merged = [...new Set([...round.messageIds, ...messageIds])].slice(0, 16);
    this.#db()
      .prepare("UPDATE tavi_approval_rounds SET message_ids_json = ? WHERE task_id = ? AND steps = ?")
      .run(JSON.stringify(merged), taskId, steps);
  }

  settle(taskId: string, steps: number, at: string): boolean {
    return (
      this.#db()
        .prepare("UPDATE tavi_approval_rounds SET settled_at = ? WHERE task_id = ? AND steps = ? AND settled_at IS NULL")
        .run(at, taskId, steps).changes > 0
    );
  }

  listExpired(now: string, limit: number): readonly ApprovalRoundRecord[] {
    const rows = this.#db()
      // Only a round its chat was shown: one never delivered is not denied for going unseen.
      .prepare(
        `SELECT r.* FROM tavi_approval_rounds r
          WHERE r.settled_at IS NULL AND r.expires_at IS NOT NULL AND r.expires_at <= ?
            AND EXISTS (SELECT 1 FROM tavi_approval_events e WHERE e.task_id = r.task_id AND e.steps = r.steps AND e.kind = 'announced')
          ORDER BY r.expires_at LIMIT ?`,
      )
      .all(now, Math.max(1, Math.min(limit, 500))) as RoundRow[];
    return rows.map(toRound);
  }

  listUnannounced(limit: number): readonly ApprovalRoundRecord[] {
    const rows = this.#db()
      .prepare(
        `SELECT r.* FROM tavi_approval_rounds r
          WHERE r.settled_at IS NULL AND r.connection_id IS NOT NULL
            AND EXISTS (SELECT 1 FROM tavi_approval_events e WHERE e.task_id = r.task_id AND e.steps = r.steps AND e.kind = 'announce_failed')
            AND NOT EXISTS (SELECT 1 FROM tavi_approval_events e WHERE e.task_id = r.task_id AND e.steps = r.steps AND e.kind = 'announced')
          ORDER BY r.created_at LIMIT ?`,
      )
      .all(Math.max(1, Math.min(limit, 500))) as RoundRow[];
    return rows.map(toRound);
  }

  listUnnotified(since: string, limit: number): readonly ApprovalRoundRecord[] {
    const rows = this.#db()
      .prepare(
        `SELECT r.* FROM tavi_approval_rounds r
          WHERE r.settled_at IS NOT NULL AND r.settled_at > ? AND r.connection_id IS NOT NULL
            AND EXISTS (SELECT 1 FROM tavi_approval_events e WHERE e.task_id = r.task_id AND e.steps = r.steps AND e.kind = 'announced')
            AND EXISTS (SELECT 1 FROM tavi_approval_events e WHERE e.task_id = r.task_id AND e.steps = r.steps AND e.kind IN ('settled', 'expired'))
            AND NOT EXISTS (SELECT 1 FROM tavi_approval_events e WHERE e.task_id = r.task_id AND e.steps = r.steps AND e.kind = 'notified')
          ORDER BY r.settled_at LIMIT ?`,
      )
      .all(since, Math.max(1, Math.min(limit, 500))) as RoundRow[];
    return rows.map(toRound);
  }

  setExpiry(taskId: string, steps: number, expiresAt: string): void {
    this.#db()
      .prepare("UPDATE tavi_approval_rounds SET expires_at = ? WHERE task_id = ? AND steps = ? AND settled_at IS NULL")
      .run(expiresAt, taskId, steps);
  }

  appendEvent(event: Omit<ApprovalEventRecord, "eventId">): ApprovalEventRecord {
    const parsed = ApprovalEventRecordSchema.omit({ eventId: true }).safeParse(event);
    if (!parsed.success) {
      throw new TaviError("INVALID_INPUT", "Invalid approval event", {
        details: { issues: parsed.error.issues.map((issue) => issue.message) },
      });
    }
    const value = parsed.data;
    const result = this.#db()
      .prepare("INSERT INTO tavi_approval_events (task_id, steps, kind, via, actor, detail_json, at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(
        value.taskId,
        value.steps,
        value.kind,
        value.via ?? null,
        value.actor ?? null,
        value.detail === undefined ? null : JSON.stringify(value.detail),
        value.at,
      );
    return { ...value, eventId: Number(result.lastInsertRowid) };
  }

  listEvents(taskId: string, steps?: number): readonly ApprovalEventRecord[] {
    const rows = (
      steps === undefined
        ? this.#db().prepare("SELECT * FROM tavi_approval_events WHERE task_id = ? ORDER BY event_id").all(taskId)
        : this.#db().prepare("SELECT * FROM tavi_approval_events WHERE task_id = ? AND steps = ? ORDER BY event_id").all(taskId, steps)
    ) as EventRow[];
    return rows.map(toEvent);
  }
}

interface LinkRow {
  readonly token_hash: string;
  readonly task_id: string;
  readonly kind: string;
  readonly steps: number | null;
  readonly wait_id: string | null;
  readonly choice: string;
  readonly expires_at: string;
  readonly used_at: string | null;
  readonly created_at: string;
}

/** Single-use email links. */
export class SqliteApprovalLinkRepository implements ApprovalLinkRepositoryPort {
  readonly #db: () => Database;

  constructor(db: () => Database) {
    this.#db = db;
  }

  create(link: Omit<ApprovalLinkRecord, "usedAt">): void {
    const value = ApprovalLinkRecordSchema.omit({ usedAt: true }).parse(link);
    this.#db()
      .prepare(
        `INSERT INTO tavi_approval_links (token_hash, task_id, kind, steps, wait_id, choice, expires_at, used_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?) ON CONFLICT (token_hash) DO NOTHING`,
      )
      .run(
        value.tokenHash,
        value.taskId,
        value.kind,
        value.steps ?? null,
        value.waitId ?? null,
        value.choice,
        value.expiresAt,
        value.createdAt,
      );
  }

  get(tokenHash: string): ApprovalLinkRecord | undefined {
    const row = this.#db().prepare("SELECT * FROM tavi_approval_links WHERE token_hash = ?").get(tokenHash) as LinkRow | undefined;
    if (row === undefined) return undefined;
    return ApprovalLinkRecordSchema.parse({
      tokenHash: row.token_hash,
      taskId: row.task_id,
      kind: row.kind,
      ...(row.steps === null ? {} : { steps: row.steps }),
      ...(row.wait_id === null ? {} : { waitId: row.wait_id }),
      choice: row.choice,
      expiresAt: row.expires_at,
      ...(row.used_at === null ? {} : { usedAt: row.used_at }),
      createdAt: row.created_at,
    });
  }

  consume(tokenHash: string, at: string): boolean {
    const db = this.#db();
    return db
      .transaction(() => {
        const spent =
          db
            .prepare("UPDATE tavi_approval_links SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?")
            .run(at, tokenHash, at).changes > 0;
        if (!spent) return false;
        const link = this.get(tokenHash);
        if (link === undefined) return false;
        // Its siblings go with it: one decision per round or question.
        if (link.kind === "round") {
          db.prepare(
            "UPDATE tavi_approval_links SET used_at = ? WHERE task_id = ? AND kind = 'round' AND steps = ? AND used_at IS NULL",
          ).run(at, link.taskId, link.steps ?? -1);
        } else {
          db.prepare("UPDATE tavi_approval_links SET used_at = ? WHERE kind = 'question' AND wait_id = ? AND used_at IS NULL").run(
            at,
            link.waitId ?? "",
          );
        }
        return true;
      })
      .immediate();
  }

  consumeWithPin(input: { readonly tokenHash: string; readonly pinMatches: boolean; readonly at: string }): ApprovalPinConsumption {
    return this.#db()
      .transaction((): ApprovalPinConsumption => {
        const link = this.get(input.tokenHash);
        if (
          link === undefined ||
          link.kind !== "round" ||
          link.steps === undefined ||
          link.usedAt !== undefined ||
          link.expiresAt <= input.at
        )
          return { status: "unavailable" };
        const rounds = new SqliteApprovalRoundRepository(this.#db);
        const round = rounds.get(link.taskId, link.steps);
        if (round === undefined || round.settledAt !== undefined) return { status: "unavailable" };
        const wrong = rounds
          .listEvents(link.taskId, link.steps)
          .filter((event) => event.kind === "decision_refused" && event.detail?.["reason"] === "wrong-pin").length;
        if (wrong >= MAX_APPROVAL_PIN_ATTEMPTS) return { status: "unavailable" };
        if (!input.pinMatches) {
          rounds.appendEvent({
            taskId: link.taskId,
            steps: link.steps,
            kind: "decision_refused",
            via: "link",
            detail: { reason: "wrong-pin" },
            at: input.at,
          });
          const remaining = MAX_APPROVAL_PIN_ATTEMPTS - wrong - 1;
          if (remaining === 0) this.consume(link.tokenHash, input.at);
          return { status: "wrong-pin", remaining };
        }
        return { status: this.consume(link.tokenHash, input.at) ? "consumed" : "unavailable" };
      })
      .immediate();
  }

  release(tokenHash: string, at: string): void {
    const link = this.get(tokenHash);
    if (link === undefined) return;
    const db = this.#db();
    if (link.kind === "round") {
      db.prepare("UPDATE tavi_approval_links SET used_at = NULL WHERE task_id = ? AND kind = 'round' AND steps = ? AND used_at = ?").run(
        link.taskId,
        link.steps ?? -1,
        at,
      );
    } else {
      db.prepare("UPDATE tavi_approval_links SET used_at = NULL WHERE kind = 'question' AND wait_id = ? AND used_at = ?").run(
        link.waitId ?? "",
        at,
      );
    }
  }
}
