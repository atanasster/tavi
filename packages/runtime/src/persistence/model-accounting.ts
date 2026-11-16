import { providerRevision } from "../plugin-host/provider-bindings.js";
import {
  ModelPriceSheetSchema,
  ProviderOperationRecordSchema,
  type ProviderOperation,
  type ProviderOperationRecord,
  ProviderAttemptSchema,
  snapshotModelRequest,
  DEFAULT_KEPT_MODEL_REQUESTS,
  MAX_KEPT_MODEL_REQUESTS,
  type ModelRequestRetention,
  TaviError,
  TimestampSchema,
  estimateModelCost,
  systemText,
  type ModelPriceSheet,
  type ModelUsage,
  ModelUsageSchema,
  type ProviderAttempt,
  type ProviderAttemptCostTotals,
  type ProviderAttemptSummary,
} from "@tavi/contracts";
import { sha256Hex } from "@tavi/node-kit";
import type { Database } from "./sqlite-loader.js";
import { stmt } from "./statement-cache.js";

/**
 * The first 16 hex digits of the SHA-256 of a request's `systemText` — the text
 * the model adapters lift into the leading instructions.
 */
function systemHashOf(messages: readonly { readonly role: string; readonly text: string }[]): string {
  return sha256Hex(systemText(messages)).slice(0, 16);
}

/** The first 16 hex digits of the SHA-256 of a request's tool descriptors, in the order they were offered. */
function toolsHashOf(tools: readonly unknown[]): string {
  return sha256Hex(JSON.stringify(tools)).slice(0, 16);
}

/** Provider-call accounting independent of UI event delivery and workflow summaries. */
export class ModelAccounting {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  reserveOperation(operation: ProviderOperation, ownerSession: string): void {
    const record = ProviderOperationRecordSchema.parse({ operation, ownerSession, state: "started" });
    if (providerRevision(record.operation.binding) !== record.operation.bindingHash)
      throw new TaviError("INVALID_INPUT", "Provider operation binding hash is inconsistent");
    stmt(this.db, "INSERT INTO tavi_provider_operations (run_id, attempt_id, owner_session, state, data) VALUES (?, ?, ?, ?, ?)").run(
      operation.runId,
      operation.attemptId,
      ownerSession,
      record.state,
      JSON.stringify(record),
    );
  }
  finishOperation(runId: string, attemptId: string, state: "completed" | "uncertain"): void {
    const row = stmt(this.db, "SELECT data FROM tavi_provider_operations WHERE run_id=? AND attempt_id=? AND state='started'").get(
      runId,
      attemptId,
    ) as { data: string } | undefined;
    if (row === undefined) throw new TaviError("CONFLICT", "Provider operation is no longer pending");
    const record = ProviderOperationRecordSchema.parse({ ...JSON.parse(row.data), state });
    stmt(this.db, "UPDATE tavi_provider_operations SET state=?, data=? WHERE run_id=? AND attempt_id=? AND state='started'").run(
      state,
      JSON.stringify(record),
      runId,
      attemptId,
    );
  }
  operations(runId: string): readonly ProviderOperationRecord[] {
    return (stmt(this.db, "SELECT data FROM tavi_provider_operations WHERE run_id=? ORDER BY rowid").all(runId) as { data: string }[]).map(
      (row) => ProviderOperationRecordSchema.parse(JSON.parse(row.data)),
    );
  }
  putPrice(input: ModelPriceSheet): void {
    const price = ModelPriceSheetSchema.parse(input);
    const existing = stmt(this.db, "SELECT data FROM tavi_model_price_sheets WHERE revision=?").get(price.revision) as
      | { data: string }
      | undefined;
    const data = JSON.stringify(price);
    if (existing !== undefined) {
      if (existing.data !== data) throw new TaviError("CONFLICT", "A price revision is immutable");
      return;
    }
    stmt(this.db, "INSERT INTO tavi_model_price_sheets VALUES (?, ?, ?, ?, ?)").run(
      price.revision,
      price.connectionId,
      price.model,
      price.effectiveAt,
      data,
    );
  }

  price(connectionId: string, model: string, at: string): ModelPriceSheet | undefined {
    const instant = new Date(TimestampSchema.parse(at)).toISOString();
    const row = stmt(
      this.db,
      "SELECT data FROM tavi_model_price_sheets WHERE connection_id=? AND model=? AND effective_at<=? ORDER BY effective_at DESC, revision DESC LIMIT 1",
    ).get(connectionId, model, instant) as { data: string } | undefined;
    return row === undefined ? undefined : ModelPriceSheetSchema.parse(JSON.parse(row.data));
  }

  begin(input: Omit<ProviderAttempt, "state" | "usage" | "finishedAt" | "estimatedUsd">): void {
    const { requestSha256: _supplied, systemHash: _hash, toolsHash: _tools, step: _step, ...fields } = input;
    const attempt = ProviderAttemptSchema.parse({ ...fields, state: "started", usage: {} });
    if (attempt.request !== undefined) {
      attempt.request = snapshotModelRequest(attempt.request);
      // The ledger's own digest, so a stripped attempt still names the request it sent.
      attempt.requestSha256 = sha256Hex(JSON.stringify(attempt.request));
      // The cache-hit measurement's inputs, kept after the request is stripped.
      attempt.systemHash = systemHashOf(attempt.request.messages);
      attempt.toolsHash = toolsHashOf(attempt.request.tools);
      if (attempt.request.step !== undefined) attempt.step = attempt.request.step;
      if (
        attempt.request.runId !== attempt.runId ||
        attempt.request.attemptId !== attempt.attemptId ||
        attempt.request.connectionId !== attempt.connectionId ||
        attempt.request.model !== attempt.model ||
        (attempt.request.purpose ?? "generation") !== attempt.purpose
      )
        throw new TaviError("INVALID_INPUT", "Model request snapshot does not match its attempt");
    }
    if (
      attempt.operation !== undefined &&
      (attempt.operation.runId !== attempt.runId ||
        attempt.operation.attemptId !== attempt.attemptId ||
        attempt.operation.binding.kind !== "model" ||
        attempt.operation.purpose !== attempt.purpose)
    )
      throw new TaviError("INVALID_INPUT", "Model attempt operation identity is inconsistent");
    this.db
      .transaction(() => {
        if (
          stmt(this.db, "SELECT 1 FROM tavi_provider_attempts WHERE run_id=? AND attempt_id=?").get(attempt.runId, attempt.attemptId) !==
          undefined
        )
          throw new TaviError("CONFLICT", "Provider attempt has already been reserved");
        if (attempt.operation !== undefined) this.reserveOperation(attempt.operation, attempt.ownerSession);
        // The request lives beside the attempt, so the attempt row stays small.
        const { request, ...row } = attempt;
        stmt(
          this.db,
          "INSERT INTO tavi_provider_attempts (call_id, run_id, attempt_id, owner_session, state, started_at, purpose, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        ).run(
          attempt.callId,
          attempt.runId,
          attempt.attemptId,
          attempt.ownerSession,
          attempt.state,
          attempt.startedAt,
          attempt.purpose,
          JSON.stringify(row),
        );
        if (request !== undefined)
          stmt(this.db, "INSERT INTO tavi_provider_attempt_requests (call_id, run_id, started_at, request) VALUES (?, ?, ?, ?)").run(
            attempt.callId,
            attempt.runId,
            attempt.startedAt,
            JSON.stringify(request),
          );
      })
      .immediate();
  }

  beginPriced(input: Omit<ProviderAttempt, "state" | "usage" | "finishedAt" | "estimatedUsd" | "priceRevision">): void {
    const price = this.price(input.connectionId, input.model, input.startedAt);
    this.begin({ ...input, ...(price === undefined ? {} : { priceRevision: price.revision }) });
  }

  finish(
    callId: string,
    state: Exclude<ProviderAttempt["state"], "started">,
    usage: ModelUsage,
    at: string,
    retention?: ModelRequestRetention,
  ): void {
    const kept = retention?.keptRequests ?? DEFAULT_KEPT_MODEL_REQUESTS;
    if (!Number.isSafeInteger(kept) || kept < 0 || kept > MAX_KEPT_MODEL_REQUESTS)
      throw new TaviError("INVALID_INPUT", `keptRequests must be an integer from 0 to ${MAX_KEPT_MODEL_REQUESTS}`);
    const attempt = this.get(callId);
    if (attempt === undefined || attempt.state !== "started") throw new TaviError("CONFLICT", "Provider attempt is no longer pending");
    const row =
      attempt.priceRevision === undefined
        ? undefined
        : (stmt(this.db, "SELECT data FROM tavi_model_price_sheets WHERE revision=?").get(attempt.priceRevision) as
            | { data: string }
            | undefined);
    const cost = row === undefined ? undefined : estimateModelCost(usage, ModelPriceSheetSchema.parse(JSON.parse(row.data)));
    const { request, ...settled } = attempt;
    const finished = ProviderAttemptSchema.parse({
      ...settled,
      state,
      usage,
      finishedAt: at,
      ...(cost === undefined ? {} : { estimatedUsd: cost }),
    });
    this.db
      .transaction(() => {
        if (attempt.operation !== undefined)
          this.finishOperation(attempt.runId, attempt.attemptId, state === "completed" ? "completed" : "uncertain");
        stmt(this.db, "UPDATE tavi_provider_attempts SET state=?, input_tokens=?, data=? WHERE call_id=? AND state='started'").run(
          state,
          finished.usage.inputTokens ?? null,
          JSON.stringify(finished),
          callId,
        );
        // Only a call that stored a request prunes: one without (a router call) carries no retention of its own.
        if (request !== undefined) this.stripRequests(attempt.runId, kept);
      })
      .immediate();
  }

  /**
   * Drops the stored request of a run's settled attempts older than its newest
   * `kept`. It reads only the run's few stored requests and its
   * started attempts (through their indexes), never the run's history.
   */
  private stripRequests(runId: string, kept: number): number {
    return stmt(
      this.db,
      `DELETE FROM tavi_provider_attempt_requests
      WHERE call_id IN (SELECT call_id FROM tavi_provider_attempt_requests WHERE run_id=? ORDER BY started_at DESC, call_id DESC LIMIT -1 OFFSET ?)
        AND call_id NOT IN (SELECT call_id FROM tavi_provider_attempts WHERE run_id=? AND state='started')`,
    ).run(runId, kept, runId).changes;
  }

  /** An attempt row and its stored request, if it still has one, as one attempt. */
  private attemptOf(row: { data: string; request: string | null }): ProviderAttempt {
    return ProviderAttemptSchema.parse({ ...JSON.parse(row.data), ...(row.request === null ? {} : { request: JSON.parse(row.request) }) });
  }

  get(callId: string): ProviderAttempt | undefined {
    const row = stmt(
      this.db,
      "SELECT a.data, r.request FROM tavi_provider_attempts a LEFT JOIN tavi_provider_attempt_requests r ON r.call_id = a.call_id WHERE a.call_id=?",
    ).get(callId) as { data: string; request: string | null } | undefined;
    return row === undefined ? undefined : this.attemptOf(row);
  }

  list(runId: string, filter?: { readonly states?: readonly ProviderAttempt["state"][] }): readonly ProviderAttempt[] {
    const states = filter?.states;
    if (states !== undefined && states.length === 0) return [];
    // `+started_at` keeps the planner off the `(run_id, started_at)` index, which
    // would visit every attempt of the run to test its state, and on the
    // `(run_id, state, started_at)` one; few rows match.
    const select =
      "SELECT a.data, r.request FROM tavi_provider_attempts a LEFT JOIN tavi_provider_attempt_requests r ON r.call_id = a.call_id";
    const rows =
      states === undefined
        ? stmt(this.db, `${select} WHERE a.run_id=? ORDER BY a.started_at, a.call_id`).all(runId)
        : this.db
            .prepare(`${select} WHERE a.run_id=? AND a.state IN (${states.map(() => "?").join(", ")}) ORDER BY +a.started_at, a.call_id`)
            .all(runId, ...states);
    return (rows as { data: string; request: string | null }[]).map((row) => this.attemptOf(row));
  }

  summaries(runId: string, options?: { readonly last?: number }): readonly ProviderAttemptSummary[] {
    const last = options?.last;
    if (last !== undefined && (!Number.isSafeInteger(last) || last < 0))
      throw new TaviError("INVALID_INPUT", "last must be a non-negative integer");
    if (last === 0) return [];
    // connectionId, model, usage and estimatedUsd are read from `data` only for the rows selected.
    const select = `SELECT call_id, attempt_id, state, started_at, coalesce(purpose, json_extract(data, '$.purpose')) AS purpose,
        json_extract(data, '$.connectionId') AS connection_id, json_extract(data, '$.model') AS model,
        json_extract(data, '$.usage') AS usage, json_extract(data, '$.estimatedUsd') AS estimated_usd
      FROM tavi_provider_attempts WHERE run_id=?`;
    const rows = (
      last === undefined
        ? stmt(this.db, `${select} ORDER BY started_at, call_id`).all(runId)
        : stmt(this.db, `${select} ORDER BY started_at DESC, call_id DESC LIMIT ?`).all(runId, last).reverse()
    ) as {
      call_id: string;
      attempt_id: string;
      state: ProviderAttempt["state"];
      started_at: string;
      purpose: ProviderAttempt["purpose"];
      connection_id: string;
      model: string;
      usage: string;
      estimated_usd: number | null;
    }[];
    return rows.map((row) => ({
      callId: row.call_id,
      attemptId: row.attempt_id,
      connectionId: row.connection_id,
      model: row.model,
      state: row.state,
      purpose: row.purpose,
      usage: ModelUsageSchema.parse(JSON.parse(row.usage)),
      ...(row.estimated_usd === null ? {} : { estimatedUsd: row.estimated_usd }),
      startedAt: row.started_at,
    }));
  }

  /**
   * The connections a run's generation calls went to, each once, reading only
   * the run's attempt rows (no stored request): what a chat's locality is judged by.
   */
  usedConnections(runId: string): readonly string[] {
    return (
      stmt(
        this.db,
        `SELECT DISTINCT json_extract(data, '$.connectionId') AS connection_id FROM tavi_provider_attempts
      WHERE run_id=? AND coalesce(purpose, json_extract(data, '$.purpose'))='generation'`,
      ).all(runId) as { connection_id: string }[]
    ).map((row) => row.connection_id);
  }

  /** `usedConnections` for many runs in one statement: one entry per distinct run asked, in the order asked. */
  usedConnectionsOf(runIds: readonly string[]): readonly { readonly runId: string; readonly connections: readonly string[] }[] {
    const asked = [...new Set(runIds)];
    if (asked.length === 0) return [];
    const byRun = new Map<string, string[]>(asked.map((runId) => [runId, []]));
    const rows = stmt(
      this.db,
      `SELECT DISTINCT run_id, json_extract(data, '$.connectionId') AS connection_id FROM tavi_provider_attempts
      WHERE run_id IN (SELECT value FROM json_each(?)) AND coalesce(purpose, json_extract(data, '$.purpose'))='generation'`,
    ).all(JSON.stringify(asked)) as { run_id: string; connection_id: string }[];
    for (const row of rows) byRun.get(row.run_id)?.push(row.connection_id);
    return asked.map((runId) => ({ runId, connections: byRun.get(runId) ?? [] }));
  }

  costTotals(runId: string): ProviderAttemptCostTotals {
    const row = stmt(
      this.db,
      `SELECT count(*) AS attempts, count(usd) AS priced, coalesce(sum(usd), 0) AS usd
      FROM (SELECT json_extract(data, '$.estimatedUsd') AS usd FROM tavi_provider_attempts WHERE run_id=? ORDER BY started_at, call_id)`,
    ).get(runId) as { attempts: number; priced: number; usd: number };
    return { attempts: row.attempts, priced: row.priced, usd: row.usd };
  }

  /** Run only under directory ownership; a replaced owner's pending calls have unknown billing. */
  recoverPreviousOwner(ownerSession: string, at: string): number {
    return this.db
      .transaction(() => {
        const rows = stmt(this.db, "SELECT call_id FROM tavi_provider_attempts WHERE state='started' AND owner_session<>?").all(
          ownerSession,
        ) as { call_id: string }[];
        for (const row of rows) this.finish(row.call_id, "uncertain", {}, at);
        const pending = stmt(
          this.db,
          "SELECT run_id, attempt_id FROM tavi_provider_operations WHERE state='started' AND owner_session<>?",
        ).all(ownerSession) as { run_id: string; attempt_id: string }[];
        for (const row of pending) this.finishOperation(row.run_id, row.attempt_id, "uncertain");
        return rows.length + pending.length;
      })
      .immediate();
  }

  /** Deletes a task's ledger when its associated task data is explicitly removed. */
  deleteRun(runId: string): number {
    return this.db
      .transaction(() => {
        stmt(this.db, "DELETE FROM tavi_provider_operations WHERE run_id=?").run(runId);
        return stmt(this.db, "DELETE FROM tavi_provider_attempts WHERE run_id=?").run(runId).changes;
      })
      .immediate();
  }
}
