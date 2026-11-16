import {
  HEARTBEAT_LIMITS,
  HeartbeatConfigSchema,
  HeartbeatItemSchema,
  HeartbeatProposedActionSchema,
  HeartbeatTickRecordSchema,
  TaviError,
  defaultHeartbeatConfig,
  type HeartbeatConfig,
  type HeartbeatHistoryRemoved,
  type HeartbeatInstructionsRevision,
  type HeartbeatFailedRoutineRun,
  type HeartbeatFailedSend,
  type HeartbeatInboundNote,
  type HeartbeatLedgerRow,
  type HeartbeatUnansweredMessage,
  type HeartbeatLedgerState,
  type HeartbeatPause,
  type HeartbeatState,
  type HeartbeatTickRecord,
  type HeartbeatUsage,
  type RecordHeartbeatTickInput,
  type SaveHeartbeatInput,
  type TellHeartbeatItem,
  heartbeatTickLooked,
} from "@tavi/contracts";

import type { HeartbeatRepositoryPort } from "./internal-contracts.js";
import { parseJsonColumn } from "./json-column.js";
import { deleteHookEventsForTasks } from "./plugin-repository.js";
import { purgePlumbingTasks } from "./plumbing-tasks.js";
import type { Database } from "./sqlite-loader.js";

interface HeartbeatRow {
  workspace_id: string;
  principal_id: string;
  enabled: number;
  config_json: string;
  revision: number;
  paused_reason: string | null;
  paused_until: string | null;
  next_tick_at: string | null;
  last_deep_tick_at: string | null;
  last_tick_at: string | null;
  memo: string | null;
  offer_dismissed_at: string | null;
  provider_since: string | null;
  forgot_usage_json: string | null;
  created_at: string;
  updated_at: string;
}

interface ItemRow {
  item_id: string;
  workspace_id: string;
  principal_id: string;
  item_key: string;
  hash: string;
  signal_keys_json: string;
  urgency: "now" | "later";
  held_back: number;
  title: string;
  body: string | null;
  sources_json: string;
  instruction_line: number | null;
  proposed_action_json: string | null;
  state: HeartbeatLedgerState;
  snoozed_until: string | null;
  feedback: "up" | "down" | null;
  button_token: string | null;
  first_told_at: string;
  last_told_at: string;
  digested_at: string | null;
  updated_at: string;
}

const ledgerRowOf = (row: ItemRow): HeartbeatLedgerRow => ({
  itemId: row.item_id,
  workspaceId: row.workspace_id,
  principalId: row.principal_id,
  key: row.item_key,
  hash: row.hash,
  signalKeys: JSON.parse(row.signal_keys_json) as string[],
  urgency: row.urgency,
  heldBack: row.held_back === 1,
  title: row.title,
  ...(row.body === null ? {} : { body: row.body }),
  sources: parseJsonColumn(HeartbeatItemSchema.shape.sources, row.sources_json, "tavi_heartbeat_items.sources_json"),
  ...(row.instruction_line === null ? {} : { instructionLine: row.instruction_line }),
  ...(row.proposed_action_json === null
    ? {}
    : {
        proposedAction: parseJsonColumn(
          HeartbeatProposedActionSchema,
          row.proposed_action_json,
          "tavi_heartbeat_items.proposed_action_json",
        ),
      }),
  state: row.state,
  ...(row.snoozed_until === null ? {} : { snoozedUntil: row.snoozed_until }),
  ...(row.feedback === null ? {} : { feedback: row.feedback }),
  ...(row.button_token === null ? {} : { buttonToken: row.button_token }),
  firstToldAt: row.first_told_at,
  lastToldAt: row.last_told_at,
  ...(row.digested_at === null ? {} : { digestedAt: row.digested_at }),
  updatedAt: row.updated_at,
});

interface TickRow {
  tick_id: string;
  workspace_id: string;
  principal_id: string;
  kind: string | null;
  wake_reason: string | null;
  outcome: string;
  reason: string | null;
  pause_reason: string | null;
  provider_id: string | null;
  task_id: string | null;
  items_now: number;
  items_later: number;
  items_retracted: number;
  inputs_json: string | null;
  hook_decisions_json: string | null;
  tokens: number;
  cache_read_tokens: number;
  cost_usd: number | null;
  duration_ms: number;
  error: string | null;
  provider_dev: number;
  created_at: string;
}

/** The row that marks a heartbeat's signals as seeded: never a signal's key (keys start with a letter or digit). */
const SEEDED_KEY = "~seeded";
/** The hash of a signal a failed check was given: no source answers it, so its next sighting is new. */
const UNSEEN_HASH = "~unseen";
/** The first-collection marker's hash. */
const PER_SOURCE = "per-source";

/** The config fields stored in their own columns; everything else is `config_json`. */
type ColumnFields = "enabled" | "paused" | "revision";
type StoredConfig = Omit<HeartbeatConfig, ColumnFields>;

const parseJson = (text: string | null): unknown => {
  if (text === null) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
};

const storedConfigOf = (config: HeartbeatConfig): StoredConfig => {
  const { enabled: _enabled, paused: _paused, revision: _revision, ...stored } = config;
  return stored;
};

/** What forgotten checks spent, kept by Forget; undefined for none or a row that does not parse. */
function forgottenUsage(stored: string | null): (HeartbeatUsage & { readonly since: string }) | undefined {
  if (stored === null) return undefined;
  const value = parseJson(stored) as Partial<Record<"since" | "modelTicks" | "tokens" | "usd" | "pricedUsd", unknown>> | undefined;
  if (
    value === undefined ||
    value === null ||
    typeof value.since !== "string" ||
    typeof value.modelTicks !== "number" ||
    typeof value.tokens !== "number" ||
    typeof value.pricedUsd !== "number" ||
    (value.usd !== null && typeof value.usd !== "number")
  )
    return undefined;
  return { since: value.since, modelTicks: value.modelTicks, tokens: value.tokens, usd: value.usd ?? null, pricedUsd: value.pricedUsd };
}

/** The contract's config from a row's columns and JSON; undefined when it no longer parses. */
const configOf = (row: HeartbeatRow): HeartbeatConfig | undefined => {
  const stored = parseJson(row.config_json);
  if (stored === null || typeof stored !== "object" || Array.isArray(stored)) return undefined;
  const paused =
    row.paused_reason === null
      ? undefined
      : { reason: row.paused_reason, ...(row.paused_until === null ? {} : { until: row.paused_until }) };
  const parsed = HeartbeatConfigSchema.safeParse({
    ...stored,
    enabled: row.enabled === 1,
    ...(paused === undefined ? {} : { paused }),
    revision: row.revision,
  });
  return parsed.success ? parsed.data : undefined;
};

const stateOf = (row: HeartbeatRow, config: HeartbeatConfig): HeartbeatState => ({
  workspaceId: row.workspace_id,
  principalId: row.principal_id,
  config,
  ...(row.next_tick_at === null ? {} : { nextTickAt: row.next_tick_at }),
  ...(row.last_tick_at === null ? {} : { lastTickAt: row.last_tick_at }),
  ...(row.last_deep_tick_at === null ? {} : { lastDeepTickAt: row.last_deep_tick_at }),
  ...(row.memo === null ? {} : { memo: row.memo }),
  ...(row.offer_dismissed_at === null ? {} : { offerDismissedAt: row.offer_dismissed_at }),
  ...(row.provider_since === null ? {} : { providerSince: row.provider_since }),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

/** A row whose config no longer parses: its revision is in the details, so a save can replace it. */
const unreadable = (row: Pick<HeartbeatRow, "workspace_id" | "principal_id" | "revision">): TaviError =>
  new TaviError(
    "UNAVAILABLE",
    `The heartbeat stored for ${row.workspace_id}/${row.principal_id} cannot be read; save its settings again to replace it.`,
    { details: { workspaceId: row.workspace_id, principalId: row.principal_id, revision: row.revision } },
  );

/** A record row as the contract reads it; undefined when it no longer parses, so one bad row cannot hide the log. */
const toTick = (row: TickRow): HeartbeatTickRecord | undefined => {
  const parsed = HeartbeatTickRecordSchema.safeParse({
    tickId: row.tick_id,
    workspaceId: row.workspace_id,
    principalId: row.principal_id,
    kind: row.kind,
    wakeReason: row.wake_reason,
    outcome: row.outcome,
    reason: row.reason,
    pauseReason: row.pause_reason,
    providerId: row.provider_id,
    taskId: row.task_id,
    itemsNow: row.items_now,
    itemsLater: row.items_later,
    itemsRetracted: row.items_retracted,
    inputs: parseJson(row.inputs_json) ?? null,
    hookDecisions: parseJson(row.hook_decisions_json) ?? null,
    tokens: row.tokens,
    cacheReadTokens: row.cache_read_tokens,
    costUsd: row.cost_usd,
    durationMs: row.duration_ms,
    error: row.error,
    providerDev: row.provider_dev === 1,
    createdAt: row.created_at,
  });
  return parsed.success ? parsed.data : undefined;
};

const utf8Bytes = (text: string): number => new TextEncoder().encode(text).length;

/**
 * Heartbeats. A row's
 * `enabled`, pause and `revision` live in columns, the rest of its config as
 * JSON; `save` is compare-and-set on the revision the writer read, in an
 * immediate transaction, and `claimTick` is the per-heartbeat lock — like a
 * schedule's `claimFire`, the one operation that must be atomic.
 */
export class SqliteHeartbeatRepository implements HeartbeatRepositoryPort {
  readonly #db: () => Database;
  readonly #transaction: <T>(work: () => T) => T;

  constructor(db: () => Database, transaction: <T>(work: () => T) => T) {
    this.#db = db;
    this.#transaction = transaction;
  }

  get(workspaceId: string, principalId: string): HeartbeatState | undefined {
    const row = this.#row(workspaceId, principalId);
    if (row === undefined) return undefined;
    const config = configOf(row);
    if (config === undefined) throw unreadable(row);
    return stateOf(row, config);
  }

  save(input: SaveHeartbeatInput): HeartbeatState {
    if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 0) {
      throw new TaviError("INVALID_INPUT", "The revision a save expects is a non-negative integer");
    }
    const next = HeartbeatConfigSchema.safeParse({ ...input.config, revision: input.expectedRevision + 1 });
    if (!next.success)
      throw new TaviError("INVALID_INPUT", "A heartbeat's settings are outside their bounds", {
        details: { issues: next.error.issues.slice(0, 5).map((issue) => issue.message) },
      });
    const config = next.data;
    return this.#transaction(() => {
      const db = this.#db();
      const current = this.#row(input.workspaceId, input.principalId);
      const currentRevision = current?.revision ?? 0;
      if (currentRevision !== input.expectedRevision) {
        throw new TaviError("CONFLICT", "The heartbeat's settings changed since they were read", {
          details: { expectedRevision: input.expectedRevision, currentRevision },
        });
      }
      const previous = current === undefined ? undefined : configOf(current);
      const previousInstructions = current === undefined ? "" : previous?.instructions;
      if (current === undefined) {
        db.prepare(`INSERT INTO tavi_heartbeats (workspace_id, principal_id, enabled, config_json, revision, paused_reason, paused_until, next_tick_at, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          input.workspaceId,
          input.principalId,
          config.enabled ? 1 : 0,
          JSON.stringify(storedConfigOf(config)),
          config.revision,
          config.paused?.reason ?? null,
          config.paused?.until ?? null,
          input.nextTickAt ?? null,
          input.now,
          input.now,
        );
      } else {
        // A pause is column-backed and written by `setPaused`: a settings save keeps the one stored.
        db.prepare(`UPDATE tavi_heartbeats SET enabled = ?, config_json = ?, revision = ?, next_tick_at = ?, updated_at = ?
          WHERE workspace_id = ? AND principal_id = ?`).run(
          config.enabled ? 1 : 0,
          JSON.stringify(storedConfigOf(config)),
          config.revision,
          input.nextTickAt ?? null,
          input.now,
          input.workspaceId,
          input.principalId,
        );
        // Another provider: its memo goes, and it is shown only what is told from now on.
        if (previous?.providerId !== config.providerId) {
          db.prepare("UPDATE tavi_heartbeats SET memo = NULL, provider_since = ? WHERE workspace_id = ? AND principal_id = ?").run(
            input.now,
            input.workspaceId,
            input.principalId,
          );
        }
      }
      if (previousInstructions !== config.instructions) {
        db.prepare(
          "INSERT INTO tavi_heartbeat_instructions (workspace_id, principal_id, revision, text, author, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        ).run(input.workspaceId, input.principalId, config.revision, config.instructions, input.author, input.now);
      }
      const saved = this.#row(input.workspaceId, input.principalId);
      const savedConfig = saved === undefined ? undefined : configOf(saved);
      if (saved === undefined || savedConfig === undefined)
        throw unreadable({ workspace_id: input.workspaceId, principal_id: input.principalId, revision: config.revision });
      return stateOf(saved, savedConfig);
    });
  }

  listDue(now: string, limit: number): { readonly due: readonly HeartbeatState[]; readonly unreadable: readonly string[] } {
    const rows = this.#db()
      .prepare(
        "SELECT * FROM tavi_heartbeats WHERE enabled = 1 AND next_tick_at IS NOT NULL AND next_tick_at <= ? ORDER BY next_tick_at LIMIT ?",
      )
      .all(now, Math.max(1, limit)) as HeartbeatRow[];
    const due: HeartbeatState[] = [];
    const bad: string[] = [];
    for (const row of rows) {
      const config = configOf(row);
      if (config === undefined) bad.push(`${row.workspace_id}/${row.principal_id}`);
      else due.push(stateOf(row, config));
    }
    return { due, unreadable: bad };
  }

  claimTick(input: {
    readonly workspaceId: string;
    readonly principalId: string;
    readonly expectedNextTickAt: string;
    readonly nextTickAt: string;
    readonly now: string;
  }): boolean {
    const result = this.#db()
      .prepare(
        "UPDATE tavi_heartbeats SET next_tick_at = ?, updated_at = ? WHERE workspace_id = ? AND principal_id = ? AND next_tick_at = ?",
      )
      .run(input.nextTickAt, input.now, input.workspaceId, input.principalId, input.expectedNextTickAt);
    return result.changes === 1;
  }

  setNextTick(input: {
    readonly workspaceId: string;
    readonly principalId: string;
    readonly nextTickAt: string | null;
    readonly now: string;
  }): void {
    const result = this.#db()
      .prepare("UPDATE tavi_heartbeats SET next_tick_at = ?, updated_at = ? WHERE workspace_id = ? AND principal_id = ?")
      .run(input.nextTickAt, input.now, input.workspaceId, input.principalId);
    if (result.changes === 0) throw new TaviError("NOT_FOUND", "There is no heartbeat to schedule");
  }

  setPaused(input: {
    readonly workspaceId: string;
    readonly principalId: string;
    readonly paused: HeartbeatPause | null;
    readonly now: string;
  }): void {
    const result = this.#db()
      .prepare("UPDATE tavi_heartbeats SET paused_reason = ?, paused_until = ?, updated_at = ? WHERE workspace_id = ? AND principal_id = ?")
      .run(input.paused?.reason ?? null, input.paused?.until ?? null, input.now, input.workspaceId, input.principalId);
    if (result.changes === 0) throw new TaviError("NOT_FOUND", "There is no heartbeat to pause or resume");
  }

  clearPause(input: {
    readonly workspaceId: string;
    readonly principalId: string;
    readonly paused: HeartbeatPause;
    readonly now: string;
  }): boolean {
    return (
      this.#db()
        .prepare(
          "UPDATE tavi_heartbeats SET paused_reason = NULL, paused_until = NULL, updated_at = ? WHERE workspace_id = ? AND principal_id = ? AND paused_reason IS ? AND paused_until IS ?",
        )
        .run(input.now, input.workspaceId, input.principalId, input.paused.reason, input.paused.until ?? null).changes > 0
    );
  }

  setMemo(input: { readonly workspaceId: string; readonly principalId: string; readonly memo: string | null; readonly now: string }): void {
    if (input.memo !== null && utf8Bytes(input.memo) > HEARTBEAT_LIMITS.memoBytes) {
      throw new TaviError("INVALID_INPUT", `A heartbeat memo is at most ${HEARTBEAT_LIMITS.memoBytes} bytes`);
    }
    const result = this.#db()
      .prepare("UPDATE tavi_heartbeats SET memo = ?, updated_at = ? WHERE workspace_id = ? AND principal_id = ?")
      .run(input.memo, input.now, input.workspaceId, input.principalId);
    if (result.changes === 0) throw new TaviError("NOT_FOUND", "There is no heartbeat to keep a memo for");
  }

  dismissOffer(input: { readonly workspaceId: string; readonly principalId: string; readonly now: string }): void {
    const defaults = defaultHeartbeatConfig();
    this.#db()
      .prepare(`INSERT INTO tavi_heartbeats (workspace_id, principal_id, enabled, config_json, revision, offer_dismissed_at, created_at, updated_at)
      VALUES (?, ?, 0, ?, ?, ?, ?, ?)
      ON CONFLICT (workspace_id, principal_id) DO UPDATE SET offer_dismissed_at = coalesce(tavi_heartbeats.offer_dismissed_at, excluded.offer_dismissed_at), updated_at = excluded.updated_at`)
      .run(
        input.workspaceId,
        input.principalId,
        JSON.stringify(storedConfigOf(defaults)),
        defaults.revision,
        input.now,
        input.now,
        input.now,
      );
  }

  recordTick(input: RecordHeartbeatTickInput): HeartbeatTickRecord {
    const { now, advancesLastTick, advancesDeepTick, ...record } = input;
    const parsed = HeartbeatTickRecordSchema.safeParse({ ...record, createdAt: now });
    if (!parsed.success)
      throw new TaviError("INVALID_INPUT", "A heartbeat record row is outside its bounds", {
        details: { issues: parsed.error.issues.slice(0, 5).map((issue) => issue.message) },
      });
    const tick = parsed.data;
    return this.#transaction(() => {
      const db = this.#db();
      db.prepare(`INSERT INTO tavi_heartbeat_ticks (tick_id, workspace_id, principal_id, kind, wake_reason, outcome, reason, pause_reason, provider_id, task_id,
          items_now, items_later, items_retracted, inputs_json, hook_decisions_json, tokens, cache_read_tokens, cost_usd, duration_ms, error, provider_dev, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        tick.tickId,
        tick.workspaceId,
        tick.principalId,
        tick.kind,
        tick.wakeReason,
        tick.outcome,
        tick.reason,
        tick.pauseReason,
        tick.providerId,
        tick.taskId,
        tick.itemsNow,
        tick.itemsLater,
        tick.itemsRetracted,
        tick.inputs === null ? null : JSON.stringify(tick.inputs),
        tick.hookDecisions === null ? null : JSON.stringify(tick.hookDecisions),
        tick.tokens,
        tick.cacheReadTokens,
        tick.costUsd,
        tick.durationMs,
        tick.error,
        tick.providerDev ? 1 : 0,
        tick.createdAt,
      );
      if (advancesLastTick) {
        // A deep look counts only once it looked: a failed, timed-out or over-budget one is due again.
        const looked = tick.kind === "deep" && heartbeatTickLooked(tick.outcome) && advancesDeepTick !== false;
        db.prepare(`UPDATE tavi_heartbeats SET last_tick_at = ?, last_deep_tick_at = CASE WHEN ? THEN ? ELSE last_deep_tick_at END, updated_at = ?
          WHERE workspace_id = ? AND principal_id = ?`).run(now, looked ? 1 : 0, now, now, tick.workspaceId, tick.principalId);
      }
      return tick;
    });
  }

  listTicks(input: {
    readonly workspaceId: string;
    readonly principalId: string;
    readonly since?: string;
    readonly ranOnly?: boolean;
    readonly oldestFirst?: boolean;
    readonly limit: number;
  }): readonly HeartbeatTickRecord[] {
    const ran = input.ranOnly === true ? " AND kind IN ('signal', 'deep') AND outcome NOT IN ('skipped', 'deferred')" : "";
    const order = input.oldestFirst === true ? "created_at ASC, rowid ASC" : "created_at DESC, rowid DESC";
    const rows = this.#db()
      .prepare(`SELECT * FROM tavi_heartbeat_ticks WHERE workspace_id = ? AND principal_id = ? AND (? IS NULL OR created_at >= ?)${ran}
        ORDER BY ${order} LIMIT ?`)
      .all(
        input.workspaceId,
        input.principalId,
        input.since ?? null,
        input.since ?? null,
        Math.max(1, Math.min(input.limit, 500)),
      ) as TickRow[];
    return rows.flatMap((row) => toTick(row) ?? []);
  }

  instructionsHistory(input: {
    readonly workspaceId: string;
    readonly principalId: string;
    readonly limit: number;
  }): readonly HeartbeatInstructionsRevision[] {
    const rows = this.#db()
      .prepare(
        "SELECT revision, text, author, created_at FROM tavi_heartbeat_instructions WHERE workspace_id = ? AND principal_id = ? ORDER BY revision DESC LIMIT ?",
      )
      .all(input.workspaceId, input.principalId, Math.max(1, Math.min(input.limit, 100))) as {
      revision: number;
      text: string;
      author: string;
      created_at: string;
    }[];
    return rows.map((row) => ({ revision: row.revision, text: row.text, author: row.author, createdAt: row.created_at }));
  }

  usageSince(input: { readonly workspaceId: string; readonly principalId: string; readonly since: string }): HeartbeatUsage {
    const db = this.#db();
    // A tick that ran a model turn names its first turn's task; one that ran past its time, or whose provider stopped in it, may have run one unnamed.
    const modelTicks = (
      db
        .prepare(
          "SELECT count(*) AS n FROM tavi_heartbeat_ticks WHERE workspace_id = ? AND principal_id = ? AND created_at >= ? AND (task_id IS NOT NULL OR reason IN ('timeout', 'provider-stopped'))",
        )
        .get(input.workspaceId, input.principalId, input.since) as { n: number }
    ).n;
    // Every heartbeat turn is a task of its own, from the heartbeat: all of them count, not only each tick's first.
    const spent = db
      .prepare(`SELECT
        coalesce(sum(coalesce(json_extract(a.data, '$.usage.totalTokens'), coalesce(json_extract(a.data, '$.usage.inputTokens'), 0) + coalesce(json_extract(a.data, '$.usage.outputTokens'), 0))), 0) AS tokens,
        coalesce(sum(json_extract(a.data, '$.estimatedUsd')), 0) AS usd,
        sum(CASE WHEN json_extract(a.data, '$.usage') IS NOT NULL AND json_extract(a.data, '$.estimatedUsd') IS NULL THEN 1 ELSE 0 END) AS unpriced
      FROM tavi_provider_attempts a
      WHERE a.run_id IN (SELECT t.task_id FROM tavi_tasks t WHERE t.workspace_id = ? AND t.principal_id = ? AND t.created_at >= ? AND t.origin IS 'heartbeat')`)
      .get(input.workspaceId, input.principalId, input.since) as { tokens: number; usd: number; unpriced: number | null };
    const usage: HeartbeatUsage = {
      modelTicks,
      tokens: spent.tokens,
      usd: (spent.unpriced ?? 0) > 0 ? null : spent.usd,
      pricedUsd: spent.usd,
    };
    // What forgotten checks spent in the window still counts (Forget keeps the day's budget).
    const forgot = forgottenUsage(this.#row(input.workspaceId, input.principalId)?.forgot_usage_json ?? null);
    if (forgot === undefined || forgot.since < input.since) return usage;
    return {
      modelTicks: usage.modelTicks + forgot.modelTicks,
      tokens: usage.tokens + forgot.tokens,
      usd: usage.usd === null || forgot.usd === null ? null : usage.usd + forgot.usd,
      pricedUsd: usage.pricedUsd + forgot.pricedUsd,
    };
  }

  observeSignals(input: {
    readonly workspaceId: string;
    readonly principalId: string;
    readonly signals: readonly { readonly key: string; readonly hash: string; readonly source: string }[];
    readonly keep?: readonly string[];
    readonly sources?: readonly string[];
    readonly now: string;
  }): { readonly seeded: boolean; readonly fresh: readonly string[]; readonly gone: readonly string[] } {
    return this.#transaction(() => {
      const db = this.#db();
      const seen = new Map(
        (
          db
            .prepare("SELECT signal_key, hash FROM tavi_heartbeat_signals WHERE workspace_id = ? AND principal_id = ?")
            .all(input.workspaceId, input.principalId) as { signal_key: string; hash: string }[]
        ).map((row) => [row.signal_key, row.hash]),
      );
      // The first collection is marked by a row of its own, so a heartbeat that has seen no signal yet is still seeded once.
      const seeded = !seen.has(SEEDED_KEY);
      const upsert =
        db.prepare(`INSERT INTO tavi_heartbeat_signals (workspace_id, principal_id, signal_key, hash, source, first_seen_at, last_seen_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (workspace_id, principal_id, signal_key) DO UPDATE SET hash = excluded.hash, source = excluded.source, last_seen_at = excluded.last_seen_at`);
      if (seeded) upsert.run(input.workspaceId, input.principalId, SEEDED_KEY, PER_SOURCE, "tavi", input.now, input.now);
      const sourceOf = (key: string): string => key.slice(0, Math.max(0, key.indexOf(":")));
      /**
       * Each source is seeded on its own first collection (a plugin source
       * installed later, one back after a month's rest): its own marker,
       * refreshed each collection and swept like any row. One that saw signals
       * before its marker existed is not seeded again.
       */
      const seedingSource = new Set<string>();
      const keptSources = new Set((input.keep ?? []).filter((prefix) => prefix.endsWith(":")).map((prefix) => prefix.slice(0, -1)));
      const answered = new Set(input.signals.map((signal) => sourceOf(signal.key)));
      for (const id of input.sources ?? []) {
        const marker = `${SEEDED_KEY}:${id}`;
        // A source that saw only part and found nothing (a watched page not read yet) is not seeded yet: its first real answer is.
        if (!seen.has(marker) && keptSources.has(id) && !answered.has(id)) continue;
        if (!seeded && !seen.has(marker) && ![...seen.keys()].some((key) => sourceOf(key) === id)) seedingSource.add(id);
        upsert.run(input.workspaceId, input.principalId, marker, "-", "tavi", input.now, input.now);
      }
      const marker = (key: string): boolean => key === SEEDED_KEY || key.startsWith(`${SEEDED_KEY}:`);
      const present = new Set<string>();
      const fresh: string[] = [];
      for (const signal of input.signals) {
        if (marker(signal.key) || present.has(signal.key)) continue;
        present.add(signal.key);
        if (!seeded && !seedingSource.has(sourceOf(signal.key)) && seen.get(signal.key) !== signal.hash) fresh.push(signal.key);
        upsert.run(input.workspaceId, input.principalId, signal.key, signal.hash, signal.source, input.now, input.now);
      }
      const kept = (key: string): boolean => (input.keep ?? []).some((prefix) => key.startsWith(prefix));
      // Only a source collected this time can say a key is gone: one not installed now keeps what it saw.
      const collected = (key: string): boolean => input.sources === undefined || input.sources.includes(sourceOf(key));
      const gone = seeded ? [] : [...seen.keys()].filter((key) => !marker(key) && !present.has(key) && !kept(key) && collected(key));
      const forget = db.prepare("DELETE FROM tavi_heartbeat_signals WHERE workspace_id = ? AND principal_id = ? AND signal_key = ?");
      for (const key of gone) forget.run(input.workspaceId, input.principalId, key);
      return { seeded, fresh, gone };
    });
  }

  unseeSignals(input: { readonly workspaceId: string; readonly principalId: string; readonly keys: readonly string[] }): void {
    if (input.keys.length === 0) return;
    // Kept, with a hash no source answers: new again next time, and still gone if it leaves before then.
    this.#db()
      .prepare(
        "UPDATE tavi_heartbeat_signals SET hash = ? WHERE workspace_id = ? AND principal_id = ? AND signal_key IN (SELECT value FROM json_each(?))",
      )
      .run(UNSEEN_HASH, input.workspaceId, input.principalId, JSON.stringify(input.keys));
  }

  ledgerRows(input: {
    readonly workspaceId: string;
    readonly principalId: string;
    readonly keys: readonly string[];
  }): readonly HeartbeatLedgerRow[] {
    if (input.keys.length === 0) return [];
    const rows = this.#db()
      .prepare(
        "SELECT * FROM tavi_heartbeat_items WHERE workspace_id = ? AND principal_id = ? AND item_key IN (SELECT value FROM json_each(?))",
      )
      .all(input.workspaceId, input.principalId, JSON.stringify(input.keys)) as ItemRow[];
    return rows.map(ledgerRowOf);
  }

  itemByToken(token: string): HeartbeatLedgerRow | undefined {
    const row = this.#db().prepare("SELECT * FROM tavi_heartbeat_items WHERE button_token = ?").get(token) as ItemRow | undefined;
    return row === undefined ? undefined : ledgerRowOf(row);
  }

  recentItems(input: {
    readonly workspaceId: string;
    readonly principalId: string;
    readonly since?: string;
    readonly limit: number;
    readonly told?: boolean;
  }): readonly HeartbeatLedgerRow[] {
    const rows = this.#db()
      .prepare(
        "SELECT * FROM tavi_heartbeat_items WHERE workspace_id = ? AND principal_id = ? AND (? IS NULL OR last_told_at >= ?) AND (? = 0 OR state <> 'filtered') ORDER BY last_told_at DESC, item_id LIMIT ?",
      )
      .all(
        input.workspaceId,
        input.principalId,
        input.since ?? null,
        input.since ?? null,
        input.told === true ? 1 : 0,
        Math.max(1, Math.min(input.limit, 500)),
      ) as ItemRow[];
    return rows.map(ledgerRowOf);
  }

  noteInbound(input: HeartbeatInboundNote): void {
    this.#db()
      .prepare(`INSERT INTO tavi_messaging_inbound_activity (connection_id, conversation_key, workspace_id, sender_principal_id, provider_event_id, task_id, received_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (connection_id, conversation_key) DO UPDATE SET workspace_id = excluded.workspace_id, sender_principal_id = excluded.sender_principal_id,
        provider_event_id = excluded.provider_event_id, task_id = excluded.task_id, received_at = excluded.received_at`)
      .run(
        input.connectionId,
        input.conversationKey,
        input.workspaceId,
        input.senderPrincipalId,
        input.providerEventId,
        input.taskId ?? null,
        input.at,
      );
  }

  unansweredMessages(input: {
    readonly workspaceId: string;
    readonly principalId: string;
    readonly since: string;
    readonly before: string;
    readonly limit: number;
  }): readonly HeartbeatUnansweredMessage[] {
    // Its chat: the one noted, else the conversation's own. Answered by a turn saved there since, a reply of
    // the inbound path's own (whose effect id ends in the message's id), or a mod's deliberate drop of it.
    const rows = this.#db()
      .prepare(`SELECT a.connection_id, a.conversation_key, a.provider_event_id, a.received_at, COALESCE(a.task_id, c.task_id) AS chat
      FROM tavi_messaging_inbound_activity a
      LEFT JOIN tavi_messaging_conversation_tasks c ON c.connection_id = a.connection_id AND c.external_conversation_id = a.conversation_key AND c.active = 1
      JOIN tavi_messaging_connections n ON n.connection_id = a.connection_id AND n.deleted_at IS NULL
      WHERE a.workspace_id = ? AND a.sender_principal_id <> ? AND a.received_at >= ? AND a.received_at <= ?
        AND NOT EXISTS (SELECT 1 FROM tavi_transcript_entries t WHERE t.task_id = COALESCE(a.task_id, c.task_id) AND t.created_at >= a.received_at)
        AND NOT EXISTS (SELECT 1 FROM tavi_plugin_hook_events h WHERE h.task_id = COALESCE(a.task_id, c.task_id) AND h.kind = 'decision' AND h.event = 'prompt.submit' AND h.detail LIKE 'dropped:%' AND h.created_at >= a.received_at)
        AND NOT EXISTS (SELECT 1 FROM tavi_messaging_outbox o WHERE o.connection_id = a.connection_id AND o.created_at >= a.received_at AND o.effect_id LIKE '%:' || a.provider_event_id)
      ORDER BY a.received_at DESC LIMIT ?`)
      .all(input.workspaceId, input.principalId, input.since, input.before, Math.max(1, Math.min(input.limit, 200))) as {
      connection_id: string;
      conversation_key: string;
      provider_event_id: string;
      received_at: string;
      chat: string | null;
    }[];
    return rows.map((row) => ({
      connectionId: row.connection_id,
      conversationKey: row.conversation_key,
      providerEventId: row.provider_event_id,
      receivedAt: row.received_at,
      ...(row.chat === null ? {} : { taskId: row.chat }),
    }));
  }

  failedSends(input: { readonly workspaceId: string; readonly since: string; readonly limit: number }): readonly HeartbeatFailedSend[] {
    const rows = this.#db()
      .prepare(`SELECT d.connection_id, d.provider_message_id, d.status, d.status_at FROM tavi_messaging_deliveries d
      JOIN tavi_messaging_connections c ON c.connection_id = d.connection_id
      WHERE d.status IN ('bounced', 'failed') AND d.status_at >= ? AND c.workspace_id = ? AND c.deleted_at IS NULL
      ORDER BY d.status_at DESC LIMIT ?`)
      .all(input.since, input.workspaceId, Math.max(1, Math.min(input.limit, 200))) as {
      connection_id: string;
      provider_message_id: string;
      status: "bounced" | "failed";
      status_at: string;
    }[];
    return rows.map((row) => ({
      connectionId: row.connection_id,
      providerMessageId: row.provider_message_id,
      status: row.status,
      statusAt: row.status_at,
    }));
  }

  failedRoutineRuns(input: {
    readonly workspaceId: string;
    readonly principalId: string;
    readonly since: string;
    readonly limit: number;
  }): readonly HeartbeatFailedRoutineRun[] {
    const rows = this.#db()
      .prepare(`SELECT r.run_id, r.routine_id, t.name, r.ended_at FROM tavi_routine_runs r JOIN tavi_routines t ON t.routine_id = r.routine_id
      WHERE r.workspace_id = ? AND r.status = 'failed' AND r.ended_at >= ? AND r.principal_id = ?
      ORDER BY r.ended_at DESC LIMIT ?`)
      .all(input.workspaceId, input.since, input.principalId, Math.max(1, Math.min(input.limit, 200))) as {
      run_id: string;
      routine_id: string;
      name: string;
      ended_at: string;
    }[];
    return rows.map((row) => ({ runId: row.run_id, routineId: row.routine_id, name: row.name, endedAt: row.ended_at }));
  }

  ledgerRow(input: {
    readonly workspaceId: string;
    readonly principalId: string;
    readonly itemId: string;
  }): HeartbeatLedgerRow | undefined {
    const row = this.#db()
      .prepare("SELECT * FROM tavi_heartbeat_items WHERE item_id = ? AND workspace_id = ? AND principal_id = ?")
      .get(input.itemId, input.workspaceId, input.principalId) as ItemRow | undefined;
    return row === undefined ? undefined : ledgerRowOf(row);
  }

  tellItems(input: {
    readonly workspaceId: string;
    readonly principalId: string;
    readonly items: readonly TellHeartbeatItem[];
    readonly now: string;
  }): readonly HeartbeatLedgerRow[] {
    return this.#transaction(() => {
      const db = this.#db();
      const upsert =
        db.prepare(`INSERT INTO tavi_heartbeat_items (item_id, workspace_id, principal_id, item_key, hash, signal_keys_json, urgency, held_back, title, body, sources_json, instruction_line, proposed_action_json, state, button_token, first_told_at, last_told_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (workspace_id, principal_id, item_key) DO UPDATE SET hash = excluded.hash, signal_keys_json = excluded.signal_keys_json, urgency = excluded.urgency, held_back = excluded.held_back,
          title = excluded.title, body = excluded.body, sources_json = excluded.sources_json, instruction_line = excluded.instruction_line, proposed_action_json = excluded.proposed_action_json,
          state = excluded.state, snoozed_until = NULL, digested_at = NULL, button_token = excluded.button_token, last_told_at = excluded.last_told_at, updated_at = excluded.updated_at`);
      const read = db.prepare("SELECT * FROM tavi_heartbeat_items WHERE workspace_id = ? AND principal_id = ? AND item_key = ?");
      return input.items.flatMap(({ itemId, item, hash, heldBack, buttonToken, filtered }) => {
        // Muted, or snoozed and not yet out of it, since the plan read the ledger: the person's choice stands, and nothing is told.
        const existing = read.get(input.workspaceId, input.principalId, item.key) as ItemRow | undefined;
        if (
          existing !== undefined &&
          (existing.state === "muted" ||
            (existing.state === "snoozed" && existing.snoozed_until !== null && existing.snoozed_until > input.now))
        )
          return [];
        upsert.run(
          itemId,
          input.workspaceId,
          input.principalId,
          item.key,
          hash,
          JSON.stringify(item.signalKeys ?? []),
          item.urgency,
          heldBack ? 1 : 0,
          item.title,
          item.body ?? null,
          JSON.stringify(item.sources),
          item.instructionLine ?? null,
          item.proposedAction === undefined ? null : JSON.stringify(item.proposedAction),
          filtered === true ? "filtered" : "told",
          buttonToken,
          input.now,
          input.now,
          input.now,
        );
        return [ledgerRowOf(read.get(input.workspaceId, input.principalId, item.key) as ItemRow)];
      });
    });
  }

  nowToldSince(input: { readonly workspaceId: string; readonly principalId: string; readonly since: string }): number {
    return (
      this.#db()
        .prepare(
          "SELECT count(*) AS n FROM tavi_heartbeat_items WHERE workspace_id = ? AND principal_id = ? AND last_told_at >= ? AND urgency = 'now' AND held_back = 0 AND state <> 'filtered'",
        )
        .get(input.workspaceId, input.principalId, input.since) as { n: number }
    ).n;
  }

  resolveItems(input: {
    readonly workspaceId: string;
    readonly principalId: string;
    readonly goneSignalKeys: readonly string[];
    readonly now: string;
  }): readonly HeartbeatLedgerRow[] {
    if (input.goneSignalKeys.length === 0) return [];
    return this.#transaction(() => {
      const db = this.#db();
      // Told or snoozed, naming a gone key, and naming none still seen.
      const rows = db
        .prepare(`SELECT * FROM tavi_heartbeat_items i WHERE i.workspace_id = ? AND i.principal_id = ? AND i.state IN ('told', 'snoozed')
          AND EXISTS (SELECT 1 FROM json_each(i.signal_keys_json) k WHERE k.value IN (SELECT value FROM json_each(?)))
          AND NOT EXISTS (SELECT 1 FROM json_each(i.signal_keys_json) k JOIN tavi_heartbeat_signals s ON s.workspace_id = i.workspace_id AND s.principal_id = i.principal_id AND s.signal_key = k.value)`)
        .all(input.workspaceId, input.principalId, JSON.stringify(input.goneSignalKeys)) as ItemRow[];
      const resolve = db.prepare(
        "UPDATE tavi_heartbeat_items SET state = 'resolved', snoozed_until = NULL, updated_at = ? WHERE item_id = ?",
      );
      for (const row of rows) resolve.run(input.now, row.item_id);
      return rows.map((row) => ledgerRowOf({ ...row, state: "resolved", snoozed_until: null, updated_at: input.now }));
    });
  }

  digestItems(input: {
    readonly workspaceId: string;
    readonly principalId: string;
    readonly since: string;
    readonly limit: number;
  }): readonly HeartbeatLedgerRow[] {
    const rows = this.#db()
      .prepare(`SELECT * FROM tavi_heartbeat_items WHERE workspace_id = ? AND principal_id = ? AND last_told_at >= ? AND urgency = 'later' AND state = 'told' AND digested_at IS NULL
        ORDER BY last_told_at, item_id LIMIT ?`)
      .all(input.workspaceId, input.principalId, input.since, input.limit) as ItemRow[];
    return rows.map(ledgerRowOf);
  }

  markDigested(input: {
    readonly workspaceId: string;
    readonly principalId: string;
    readonly items: readonly { readonly itemId: string; readonly lastToldAt: string }[];
    readonly now: string;
  }): void {
    if (input.items.length === 0) return;
    this.#transaction(() => {
      const mark = this.#db().prepare(
        "UPDATE tavi_heartbeat_items SET digested_at = ?, updated_at = ? WHERE workspace_id = ? AND principal_id = ? AND item_id = ? AND last_told_at = ?",
      );
      for (const item of input.items) mark.run(input.now, input.now, input.workspaceId, input.principalId, item.itemId, item.lastToldAt);
    });
  }

  setItemFeedback(input: {
    readonly workspaceId: string;
    readonly principalId: string;
    readonly itemId: string;
    readonly feedback: "up" | "down" | null;
    readonly now: string;
  }): HeartbeatLedgerRow | undefined {
    const changed = this.#db()
      .prepare("UPDATE tavi_heartbeat_items SET feedback = ?, updated_at = ? WHERE item_id = ? AND workspace_id = ? AND principal_id = ?")
      .run(input.feedback, input.now, input.itemId, input.workspaceId, input.principalId).changes;
    return changed === 0 ? undefined : this.ledgerRow(input);
  }

  setItemState(input: {
    readonly workspaceId: string;
    readonly principalId: string;
    readonly itemId: string;
    readonly state: "told" | "muted" | "snoozed";
    readonly snoozedUntil?: string;
    readonly now: string;
  }): HeartbeatLedgerRow | undefined {
    if ((input.state === "snoozed") !== (input.snoozedUntil !== undefined))
      throw new TaviError("INVALID_INPUT", "a snooze, and only a snooze, names when it ends");
    return this.#transaction(() => {
      const db = this.#db();
      const changed = db
        .prepare(
          "UPDATE tavi_heartbeat_items SET state = ?, snoozed_until = ?, updated_at = ? WHERE item_id = ? AND workspace_id = ? AND principal_id = ?",
        )
        .run(input.state, input.snoozedUntil ?? null, input.now, input.itemId, input.workspaceId, input.principalId).changes;
      return changed === 0 ? undefined : this.ledgerRow(input);
    });
  }

  sweep(input: { readonly olderThan: string }): HeartbeatHistoryRemoved {
    return this.#transaction(() => {
      const db = this.#db();
      // A check that ran no turn filed its hook rows under its own id (`heartbeat:<tickId>`): they go with it.
      deleteHookEventsForTasks(
        db,
        (db.prepare("SELECT tick_id FROM tavi_heartbeat_ticks WHERE created_at < ?").all(input.olderThan) as { tick_id: string }[]).map(
          (row) => `heartbeat:${row.tick_id}`,
        ),
      );
      const ticks = db.prepare("DELETE FROM tavi_heartbeat_ticks WHERE created_at < ?").run(input.olderThan).changes;
      // Everything past retention but a mute: an item whose signals were swept could never resolve, and would stay forever.
      const items = db.prepare(`DELETE FROM tavi_heartbeat_items WHERE last_told_at < ? AND state <> 'muted'`).run(input.olderThan).changes;
      const signals = db
        .prepare("DELETE FROM tavi_heartbeat_signals WHERE last_seen_at < ? AND signal_key <> ?")
        .run(input.olderThan, SEEDED_KEY).changes;
      // The messages source's own notes of who wrote when: older than the history kept, they say nothing it reads.
      db.prepare("DELETE FROM tavi_messaging_inbound_activity WHERE received_at < ?").run(input.olderThan);
      const taskIds = (
        db
          .prepare(
            `SELECT task_id FROM tavi_tasks WHERE origin IS 'heartbeat' AND status IN ('completed', 'failed', 'stopped', 'cancelled') AND created_at < ?`,
          )
          .all(input.olderThan) as { task_id: string }[]
      ).map((row) => row.task_id);
      return { ticks, items, signals, tasks: this.#purgeTasks(taskIds) };
    });
  }

  forget(input: {
    readonly workspaceId: string;
    readonly principalId: string;
    readonly now: string;
    readonly keepUsageSince?: string;
  }): HeartbeatHistoryRemoved {
    return this.#transaction(() => {
      const db = this.#db();
      const scope = [input.workspaceId, input.principalId] as const;
      // Read before anything goes: the day's spend is kept as a total, the checks it came from are not.
      const usageScope =
        input.keepUsageSince === undefined
          ? undefined
          : { workspaceId: input.workspaceId, principalId: input.principalId, since: input.keepUsageSince };
      const before = usageScope === undefined ? undefined : this.usageSince(usageScope);
      deleteHookEventsForTasks(
        db,
        (
          db.prepare("SELECT tick_id FROM tavi_heartbeat_ticks WHERE workspace_id = ? AND principal_id = ?").all(...scope) as {
            tick_id: string;
          }[]
        ).map((row) => `heartbeat:${row.tick_id}`),
      );
      const ticks = db.prepare("DELETE FROM tavi_heartbeat_ticks WHERE workspace_id = ? AND principal_id = ?").run(...scope).changes;
      // A "Don't tell me" stays: forgetting the history never brings back what the person muted (invariant 4).
      const items = db
        .prepare("DELETE FROM tavi_heartbeat_items WHERE workspace_id = ? AND principal_id = ? AND state <> 'muted'")
        .run(...scope).changes;
      // What it had seen goes too: its next collection starts over, recording what is there without telling it.
      const signals = db.prepare("DELETE FROM tavi_heartbeat_signals WHERE workspace_id = ? AND principal_id = ?").run(...scope).changes;
      // The workspace's notes of who messaged when are everyone's to read: they go only with the last heartbeat there.
      db.prepare(
        "DELETE FROM tavi_messaging_inbound_activity WHERE workspace_id = ? AND NOT EXISTS (SELECT 1 FROM tavi_heartbeats WHERE workspace_id = ? AND principal_id <> ?)",
      ).run(input.workspaceId, ...scope);
      db.prepare(
        "UPDATE tavi_heartbeats SET memo = NULL, forgot_usage_json = NULL, updated_at = ? WHERE workspace_id = ? AND principal_id = ?",
      ).run(input.now, ...scope);
      const taskIds = (
        db
          .prepare(
            `SELECT task_id FROM tavi_tasks WHERE origin IS 'heartbeat' AND status IN ('completed', 'failed', 'stopped', 'cancelled') AND workspace_id = ? AND principal_id = ?`,
          )
          .all(input.workspaceId, input.principalId) as { task_id: string }[]
      ).map((row) => row.task_id);
      const tasks = this.#purgeTasks(taskIds);
      if (usageScope !== undefined && before !== undefined) {
        // Kept: what went. A turn still running is not forgotten, and goes on counting for itself.
        const left = this.usageSince(usageScope);
        const kept = {
          since: usageScope.since,
          modelTicks: before.modelTicks - left.modelTicks,
          tokens: before.tokens - left.tokens,
          usd: before.usd === null || left.usd === null ? null : before.usd - left.usd,
          pricedUsd: before.pricedUsd - left.pricedUsd,
        };
        db.prepare("UPDATE tavi_heartbeats SET forgot_usage_json = ? WHERE workspace_id = ? AND principal_id = ?").run(
          JSON.stringify(kept),
          ...scope,
        );
      }
      return { ticks, items, signals, tasks };
    });
  }

  #purgeTasks(taskIds: readonly string[]): number {
    return purgePlumbingTasks(this.#db(), taskIds);
  }

  #row(workspaceId: string, principalId: string): HeartbeatRow | undefined {
    return this.#db().prepare("SELECT * FROM tavi_heartbeats WHERE workspace_id = ? AND principal_id = ?").get(workspaceId, principalId) as
      | HeartbeatRow
      | undefined;
  }
}
