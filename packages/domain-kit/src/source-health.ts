import type { DatabaseSync } from "node:sqlite";

import { definedOnly } from "@tavi/contracts/util";

/**
 * A source's health in a domain store: its last success and failure, its
 * failures in a row, how often its answers changed shape, its calls today,
 * and when a pause ends. Kept in the store's `source_health` table
 * (`SOURCE_HEALTH_TABLE_SQL`), so a pause holds across a worker's idle stops.
 */
export interface SourceHealth {
  readonly source: string;
  readonly lastSuccess?: string;
  readonly lastFailure?: string;
  readonly lastError?: string;
  readonly consecutiveFailures: number;
  readonly driftCount: number;
  readonly disabledUntil?: string;
  readonly callsToday: number;
}

/** Consecutive failures that pause a source; then a day's pause, unless the source sets its own (`failurePauseMs`). */
export const SOURCE_PAUSE_FAILURES = 5;
export const SOURCE_PAUSE_MS = 24 * 3_600_000;

/** The table a domain's first migration creates for `createSourceHealth`. */
export const SOURCE_HEALTH_TABLE_SQL = `CREATE TABLE source_health (
  source TEXT PRIMARY KEY,
  last_success TEXT,
  last_failure TEXT,
  last_error TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  drift_count INTEGER NOT NULL DEFAULT 0,
  disabled_until TEXT,
  calls_today INTEGER NOT NULL DEFAULT 0,
  day TEXT
) STRICT;`;

export interface SourceOutcome {
  readonly ok: boolean;
  readonly drift?: boolean;
  readonly error?: string;
  readonly pauseUntil?: string;
  /** How long the source's fifth failure in a row pauses it: its own setting, `SOURCE_PAUSE_MS` (a day) when unset. */
  readonly failurePauseMs?: number;
}

export interface SourceHealthLedger {
  /** A source's health; `callsToday` counts `now`'s UTC day only. */
  health(source: string, now: string): SourceHealth;
  allHealth(now: string): SourceHealth[];
  /** A request's outcome for the source's health: a success resets its failures; the fifth failure in a row pauses it. */
  recordOutcome(source: string, outcome: SourceOutcome, now: string): SourceHealth;
  /** Pauses a source until `until`, whatever its failures; a later pause already set is kept. */
  pause(source: string, until: string, now: string): SourceHealth;
}

type Row = Record<string, unknown>;

const text = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);

/** Source health kept in `db`'s `source_health` table (`SOURCE_HEALTH_TABLE_SQL`). */
export function createSourceHealth(db: DatabaseSync): SourceHealthLedger {
  const read = db.prepare("SELECT * FROM source_health WHERE source = ?");
  const put = db.prepare(
    "INSERT INTO source_health (source, last_success, last_failure, last_error, consecutive_failures, drift_count, disabled_until, calls_today, day) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (source) DO UPDATE SET last_success = excluded.last_success, last_failure = excluded.last_failure, last_error = excluded.last_error, consecutive_failures = excluded.consecutive_failures, drift_count = excluded.drift_count, disabled_until = excluded.disabled_until, calls_today = excluded.calls_today, day = excluded.day",
  );
  const healthOf = (source: string, row: Row | undefined, now: string): SourceHealth => {
    const lastSuccess = text(row?.["last_success"]);
    const lastFailure = text(row?.["last_failure"]);
    const lastError = text(row?.["last_error"]);
    const disabledUntil = text(row?.["disabled_until"]);
    return {
      source,
      ...definedOnly({ lastSuccess, lastFailure, lastError }),
      consecutiveFailures: Number(row?.["consecutive_failures"] ?? 0),
      driftCount: Number(row?.["drift_count"] ?? 0),
      ...(disabledUntil === undefined ? {} : { disabledUntil }),
      callsToday: text(row?.["day"]) === now.slice(0, 10) ? Number(row?.["calls_today"] ?? 0) : 0,
    };
  };
  const health = (source: string, now: string): SourceHealth => healthOf(source, read.get(source) as Row | undefined, now);
  return {
    health,
    allHealth: (now) =>
      (db.prepare("SELECT * FROM source_health ORDER BY source").all() as Row[]).map((row) => healthOf(String(row["source"]), row, now)),
    recordOutcome: (source, outcome, now) => {
      const known = health(source, now);
      const failures = outcome.ok ? 0 : known.consecutiveFailures + 1;
      const pause =
        outcome.pauseUntil ??
        (failures >= SOURCE_PAUSE_FAILURES
          ? new Date(Date.parse(now) + (outcome.failurePauseMs ?? SOURCE_PAUSE_MS)).toISOString()
          : undefined);
      put.run(
        source,
        outcome.ok ? now : (known.lastSuccess ?? null),
        outcome.ok ? (known.lastFailure ?? null) : now,
        outcome.ok ? (known.lastError ?? null) : (outcome.error ?? "failed").slice(0, 300),
        failures,
        known.driftCount + (outcome.drift === true ? 1 : 0),
        pause ?? (known.disabledUntil !== undefined && Date.parse(known.disabledUntil) > Date.parse(now) ? known.disabledUntil : null),
        known.callsToday + 1,
        now.slice(0, 10),
      );
      return health(source, now);
    },
    pause: (source, until, now) => {
      const known = health(source, now);
      const kept = known.disabledUntil !== undefined && Date.parse(known.disabledUntil) > Date.parse(until) ? known.disabledUntil : until;
      put.run(
        source,
        known.lastSuccess ?? null,
        known.lastFailure ?? null,
        known.lastError ?? null,
        known.consecutiveFailures,
        known.driftCount,
        kept,
        known.callsToday,
        now.slice(0, 10),
      );
      return health(source, now);
    },
  };
}
